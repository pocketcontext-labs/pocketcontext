#!/usr/bin/env python3
"""Cross-package handoff: mocked Gemini, real isolated Wiki, exact-file recovery.

Run with --gemini-python /path/to/gemini-transcribe/.venv/bin/python.
Only synthetic audio/text and local test authentication are used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
from unittest.mock import patch

from integration import server, credentials
from wikicontext_client import cli as wc, ingest, exporter

PRODUCE = r'''
import json, os, sys, wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from gemini_transcribe import cli
root = Path(sys.argv[1])
audio = root/'synthetic.wav'
with wave.open(str(audio),'wb') as f:
    f.setnchannels(2); f.setsampwidth(2); f.setframerate(16000)
    f.writeframes(b'\0' * 16000 * 2 * 2 * 2)
transcript = {'language':'English','segments':[
    {'start':0.0,'end':0.9,'speaker':'SPEAKER_01','text':'We agreed to deliver the report on Monday.'},
    {'start':1.0,'end':1.8,'speaker':'SPEAKER_02','text':'I will send it.'}],
    'audio_annotations':[{'start':0.9,'end':1.0,'kind':'pause','description':'Brief pause between turns.','speakers':[]}],
    'uncertainties':[], 'tone':[{'segment_ids':['seg000002'],'label':'neutral','cues':'Even delivery.','subjective':True}]}
analysis = {'summary':[{'text':'The speakers discuss delivering a report.','segment_ids':['seg000001','seg000002']}],
    'topics':[{'title':'Report','text':'Report delivery timing.','segment_ids':['seg000001']}],
    'decisions':[{'text':'Deliver on Monday.','segment_ids':['seg000001']}],
    'action_items':[{'task':'Send the report.','owner':'SPEAKER_02','deadline':'Monday','segment_ids':['seg000001','seg000002']}],
    'questions':[], 'speaker_mappings':[{'speaker':'SPEAKER_01','name':'Alice','status':'explicit','segment_ids':['seg000001']},{'speaker':'SPEAKER_02','name':'Bob','status':'tentative','segment_ids':['seg000002']}]}
translation = {'target_language':'Italian','segments':[
    {'segment_id':'seg000001','text':'Abbiamo concordato di consegnare il rapporto lunedì.'},
    {'segment_id':'seg000002','text':'Lo invierò io.'}]}
client=MagicMock()
client.__enter__.return_value=client
client.files.upload.return_value=SimpleNamespace(name='files/synthetic',uri='fake://synthetic',state='ACTIVE',mime_type='audio/wav')
client.interactions.create.side_effect=[SimpleNamespace(status='completed',output_text=json.dumps(x)) for x in (transcript,analysis,translation)]
with patch.dict(os.environ,{'GEMINI_API_KEY':'synthetic-key'}),patch.object(cli.genai,'Client',return_value=client):
    code=cli.main([str(audio),'--output-dir',str(root/'outputs'),'--translation-language','Italian','--json'])
assert code==0
assert client.interactions.create.call_count==3
client.files.delete.assert_called_once_with(name='files/synthetic')
'''


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--binary',required=True)
    parser.add_argument('--gemini-python',required=True)
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='gemini-wiki-handoff-') as temp:
        root=Path(temp)
        generated=subprocess.run([str(Path(args.gemini_python).absolute()),'-c',PRODUCE,str(root)],
                                 cwd=root,capture_output=True,text=True,timeout=60)
        assert generated.returncode==0, generated.stderr
        receipt=json.loads(generated.stdout)
        assert receipt['status']=='complete'
        manifest_path=Path(receipt['manifest_path'])
        manifest=json.loads(manifest_path.read_text())
        audio=root/'synthetic.wav'
        originals={'audio':audio.read_bytes(),'manifest':manifest_path.read_bytes()}
        originals.update({a['role']:(manifest_path.parent/a['path']).read_bytes() for a in manifest['artifacts']})
        with server(args.binary) as request, patch.dict(os.environ,{'XDG_CACHE_HOME':str(root/'cache')}):
            _,_,token=credentials(request)
            cfg={'url':request.base_url,'email':'agent@example.com','password':'SyntheticUserPassword123!'}
            wc.save_session(cfg,{'url':cfg['url'],'email':cfg['email'],'token':token})
            with patch.object(ingest,'transcribe',side_effect=AssertionError('Unexpected provider request')):
                result=ingest.ingest(cfg,audio,audio_storage='original',transcript_bundle=manifest_path,version='gemini-v1')
                assert result==ingest.ingest(cfg,audio,audio_storage='original',transcript_bundle=manifest_path,version='gemini-v1')
            assert result['status']=='extracted'
            first=ingest.rows(cfg,"SELECT body, locator FROM passages WHERE id = '"+result['segment_passages']['seg000001'][0]+"'")[0]
            second=ingest.rows(cfg,"SELECT body FROM passages WHERE id = '"+result['segment_passages']['seg000002'][0]+"'")[0]
            assert first['body'].startswith('Alice (SPEAKER_01):')
            assert 'segment seg000001; seconds 0.000-0.900' in first['locator']
            assert second['body'].startswith('SPEAKER_02:')
            assert b'Alice (SPEAKER_01)' in originals['transcript_txt']
            assert b'Alice (SPEAKER_01)' in originals['translation_txt']
            canonical=json.loads(originals['transcript'])
            assert canonical['segments'][0]['speaker']=='SPEAKER_01'
            assert set(result['segment_passages'])=={'seg000001','seg000002'}
            assert set(result['annotation_passages'])=={'ann000001'}
            assert set(result['observation_passages'])=={'tone000001'}
            observation=ingest.rows(cfg,"SELECT body FROM passages WHERE id = '"+result['observation_passages']['tone000001'][0]+"'")[0]['body']
            assert 'Even delivery.' in observation and 'subjective' in observation.lower()
            assert set(result['artifact_sources'])==set(originals)-{'audio'}
            ids={'audio':result['source'],**result['artifact_sources']}
            protected=request('POST','/api/files/token',{},token)['token']
            for role,ident in ids.items():
                source=exporter.one(cfg,'sources','id,title,original_name,original,sha256',ident)
                assert source['sha256']==hashlib.sha256(originals[role]).hexdigest()
                url=request.base_url+'/api/files/sources/'+ident+'/'+source['original']+'?token='+protected
                with urllib.request.urlopen(url,timeout=20) as response:
                    assert response.read()==originals[role],role
            assert not ingest.rows(cfg,'SELECT id FROM publications')
            def create(collection,data): return wc.must(cfg,'POST',wc.records(collection),data)
            run=create('ingestion_runs',{'key':'gemini-fixture','status':'staging','description':'Synthetic cross-package bundle','sources':list(set(ids.values()))})
            pages = {}
            for slug,kind,body,segment in [
                ('synthetic-transcript','transcript','Alice (SPEAKER_01): We agreed to deliver the report on Monday.[^1]','seg000001'),
                ('synthetic-summary','summary','The speakers agreed to deliver a report on Monday.[^1]','seg000001'),
                ('synthetic-translation','transcript','Italian translation: Lo invierò io.[^1]','seg000002')]:
                page=create('pages',{'slug':slug,'kind':kind})
                pages[slug] = page
                revision=create('page_revisions',{'run':run['id'],'page':page['id'],'base_revision':'','title':slug,'summary':'Synthetic test.','body':body})
                create('citations',{'page_revision':revision['id'],'passage':result['segment_passages'][segment][0],'marker':'1'})
            recording = create('pages', {'slug': 'synthetic-recording', 'kind': 'entity'})
            properties = {'catalog_type': 'audio_recording', 'audio_source_id': result['source'],
                'selected_bundle_rendition_id': result['bundle_rendition'], 'recorded_at': '2026-10-13',
                'duration_seconds': 2, 'language': 'English', 'transcript_pages': [pages['synthetic-transcript']['id']],
                'summary_pages': [pages['synthetic-summary']['id']]}
            recording_revision = create('page_revisions', {'run': run['id'], 'page': recording['id'],
                'title': 'Synthetic recording', 'summary': 'Synthetic complete audio catalog.',
                'body': 'The speakers discuss a report.[^1]', 'properties': properties})
            create('citations', {'page_revision': recording_revision['id'], 'passage': result['segment_passages']['seg000001'][0], 'marker': '1'})
            for linked in properties['transcript_pages'] + properties['summary_pages']:
                create('page_links', {'page_revision': recording_revision['id'], 'target': linked})
            wc.must(cfg,'PATCH',wc.records('ingestion_runs',run['id']),{'expected_revision':run['revision'],'status':'published'})
            assert len(ingest.rows(cfg,'SELECT id FROM publications'))==1
            # A catalog selection must bind the complete receipt to its own audio and space.
            invalid_run = create('ingestion_runs', {'key': 'invalid-audio-catalog', 'status': 'staging', 'description': 'Synthetic invalid selections'})
            def rejected(props, expected=400):
                request('POST', '/api/collections/page_revisions/records', {'run': invalid_run['id'], 'page': recording['id'],
                    'base_revision': recording_revision['id'], 'title': 'Invalid recording', 'body': '[needs verification]',
                    'properties': props}, token, expected)
            wrong = create('renditions', {'source': result['artifact_sources']['transcript'], 'kind': 'transcript-bundle',
                'processor': 'synthetic', 'version_label': 'wrong-source', 'notes': '{}'})
            rejected({**properties, 'selected_bundle_rendition_id': wrong['id']})
            original_bundle = exporter.one(cfg, 'renditions', 'id,notes', result['bundle_rendition'])
            notes = json.loads(original_bundle['notes'])
            def forged(label, notes):
                return create('renditions', {'source': result['source'], 'kind': 'transcript-bundle', 'processor': 'synthetic',
                    'version_label': label, 'notes': json.dumps(notes)})['id']
            rejected({**properties, 'selected_bundle_rendition_id': forged('wrong-hash', {**notes, 'bundle_sha256': '0' * 64})})
            transcript_record = exporter.one(cfg, 'renditions', 'id,notes', result['rendition'])
            foreign_notes = {**json.loads(transcript_record['notes']), 'bundle_sha256': 'f' * 64}
            wrong_transcript = create('renditions', {'source': result['source'], 'kind': 'transcript',
                'processor': 'synthetic', 'version_label': 'other-extraction', 'notes': json.dumps(foreign_notes)})
            rejected({**properties, 'selected_bundle_rendition_id': forged('mixed-extraction', {**notes, 'transcript_rendition': wrong_transcript['id']})})

            personal = request('POST', '/api/wiki/spaces/personal', {}, token)
            personal_space = personal.get('space', personal)
            personal_id = personal_space['id'] if isinstance(personal_space, dict) else personal_space
            personal_cfg = {**cfg, 'space': personal_id, 'space_checked': False}
            private_source = ingest.upload_source(personal_cfg, Path('private.txt'), b'Synthetic private artifact',
                hashlib.sha256(b'Synthetic private artifact').hexdigest(), 'Synthetic private artifact')
            forged_notes = {**notes, 'artifact_sources': {**notes['artifact_sources'], 'analysis': private_source['id']}}
            rejected({**properties, 'selected_bundle_rendition_id': forged('foreign-artifact', forged_notes)}, 404)
            assert len(ingest.rows(cfg, 'SELECT id FROM publications')) == 1
            destination=root/'export'
            exporter.export(cfg,destination)
            for role,ident in ids.items():
                source=exporter.one(cfg,'sources','id,title,original_name,original,sha256',ident)
                assert (destination/exporter.source_path(source)).read_bytes()==originals[role],role
            assert (destination/'wiki/synthetic-summary.md').exists()
            assert 'audio_recording' in (destination/'wiki/synthetic-recording.md').read_text()
    print('PASS real Gemini bundle -> immutable Wiki evidence -> cited publication -> byte-exact export')


if __name__=='__main__': main()
