#!/usr/bin/env python3
"""Real HTTP evidence ingestion with synthetic data and isolated storage."""
import argparse
import hashlib
import json
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import shutil
import subprocess
import wave
import urllib.error
import urllib.request
from unittest.mock import patch
from integration import server, credentials

from wikicontext_client import cli as wc
from wikicontext_client import exporter
from wikicontext_client import ingest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    with server(args.binary) as request, tempfile.TemporaryDirectory(prefix='wikicontext-ingest-test-') as folder:
        admin, user, token = credentials(request)
        cfg = {'url': request.base_url, 'email': 'agent@example.com', 'password': 'SyntheticUserPassword123!'}
        with patch.dict(os.environ, {'XDG_CACHE_HOME': str(Path(folder) / 'cache')}):
            source = Path(folder) / 'synthetic-notes.md'
            content = ('Synthetic cited evidence.\n' * 3000).encode()
            source.write_bytes(content)
            real_must = wc.must
            def interrupted(cfg, method, url, body=None):
                if url == wc.records('passages') and body['ordinal'] == 2:
                    raise wc.Fail(1, 'simulated lost client connection before second passage')
                return real_must(cfg, method, url, body)
            with patch.object(wc, 'must', side_effect=interrupted):
                try:
                    ingest.ingest(cfg, source)
                except wc.Fail as error:
                    assert str(error).startswith('simulated lost client'), str(error)
                else:
                    raise AssertionError('Expected interrupted ingestion')
            result = ingest.ingest(cfg, source)
            assert result == ingest.ingest(cfg, source)
            assert result['sha256'] == hashlib.sha256(content).hexdigest()
            stored = ingest.rows(cfg, 'SELECT id, original, sha256 FROM sources')
            assert len(stored) == 1
            passages = ingest.rows(cfg, "SELECT id, ordinal, body FROM passages WHERE rendition = '%s' ORDER BY ordinal" % result['rendition'])
            assert len(passages) == 4
            assert ''.join(p['body'] for p in passages).encode() == content
            file_path = '/api/files/sources/' + stored[0]['id'] + '/' + stored[0]['original']
            try:
                urllib.request.urlopen(request.base_url + file_path)
            except urllib.error.HTTPError as error:
                assert error.code in (403, 404)
            else:
                raise AssertionError('Anonymous original download succeeded')
            file_token = request('POST', '/api/files/token', {}, token)['token']
            with urllib.request.urlopen(request.base_url + file_path + '?token=' + file_token) as response:
                assert response.read() == content
            run = real_must(cfg, 'POST', wc.records('ingestion_runs'), {'key': 'ingestion-fixture', 'description': 'Synthetic ingestion', 'status': 'staging', 'sources': [result['source']]})
            page = real_must(cfg, 'POST', wc.records('pages'), {'slug': 'synthetic-evidence', 'kind': 'summary'})
            revision = real_must(cfg, 'POST', wc.records('page_revisions'), {'run': run['id'], 'page': page['id'], 'base_revision': '', 'title': 'Synthetic evidence', 'summary': 'Synthetic test.', 'body': 'The fixture contains evidence.[^1]'})
            real_must(cfg, 'POST', wc.records('citations'), {'page_revision': revision['id'], 'passage': passages[0]['id'], 'marker': '1'})
            real_must(cfg, 'PATCH', wc.records('ingestion_runs', run['id']), {'expected_revision': 1, 'status': 'published'})
            assert len(ingest.rows(cfg, 'SELECT id FROM publications')) == 1
            assert source.read_bytes() == content
            if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
                raise AssertionError('FFmpeg and ffprobe are required for normalized-audio integration coverage')
            audio = Path(folder) / 'synthetic-meeting.wav'
            with wave.open(str(audio), 'wb') as fixture:
                fixture.setnchannels(2)
                fixture.setsampwidth(2)
                fixture.setframerate(48000)
                fixture.writeframes(b'\0' * 48000 * 2 * 2)
            original_audio = audio.read_bytes()
            sent = []
            def provider(audio_path, original_duration):
                sent.append(audio_path.read_bytes())
                if len(sent) == 1:
                    raise wc.Fail(1, 'synthetic provider failure')
                return [{'locator': 'seconds 0-1', 'body': 'Synthetic meeting transcript.'}]
            with patch.object(ingest, 'send_transcription', side_effect=provider), \
                    patch.dict(os.environ, {'WIKICONTEXT_GROQ_API_KEY': 'synthetic-key'}):
                try:
                    ingest.ingest(cfg, audio)
                except wc.Fail as error:
                    assert str(error) == 'synthetic provider failure', str(error)
                else:
                    raise AssertionError('Expected synthetic provider failure')
                normalized = ingest.ingest(cfg, audio)
                assert normalized == ingest.ingest(cfg, audio)
            assert len(sent) == 2 and sent[0] == sent[1]
            assert audio.read_bytes() == original_audio
            stored_audio = ingest.rows(cfg, "SELECT id, original, original_name, sha256 FROM sources WHERE id = '%s'" % normalized['source'])[0]
            assert stored_audio['original_name'] == 'synthetic-meeting.normalized.ogg'
            assert stored_audio['sha256'] == hashlib.sha256(sent[0]).hexdigest()
            assert len(ingest.rows(cfg, 'SELECT id FROM sources')) == 2
            file_token = request('POST', '/api/files/token', {}, token)['token']
            audio_file_path = '/api/files/sources/' + stored_audio['id'] + '/' + stored_audio['original']
            with urllib.request.urlopen(request.base_url + audio_file_path + '?token=' + file_token) as response:
                assert response.read() == sent[0]
            # Reviewed images retain exact originals, supplement an existing source,
            # and enter the same citation/publication/export contract as text.
            from PIL import Image, ImageDraw
            image_sources = []
            image_passages = []
            originals = {}
            for sequence, suffix in enumerate(('png', 'jpg', 'webp'), 1):
                image_path = Path(folder) / ('synthetic-slide.' + suffix)
                fixture = Image.new('RGB', (96, 64), 'white')
                ImageDraw.Draw(fixture).rectangle((4, 4, 40, 30), fill='blue')
                fixture.save(image_path)
                original = image_path.read_bytes()
                review = {'processor': 'synthetic review / 1',
                          'source_sha256': hashlib.sha256(original).hexdigest(),
                          'width': 96, 'height': 64, 'related_source': result['source'],
                          'sequence': sequence, 'notes': 'Synthetic supplemental slide.',
                          'passages': [
                              {'kind': 'transcription', 'body': 'Synthetic slide text.', 'region': [0, 0, 48, 32]},
                              {'kind': 'description', 'body': 'A blue rectangle.', 'region': [4, 4, 37, 27]}]}
                review_path = Path(folder) / ('review-' + suffix + '.json')
                review_path.write_text(json.dumps(review))
                if suffix == 'png':
                    with patch.object(wc, 'must', side_effect=interrupted):
                        try:
                            ingest.ingest(cfg, image_path, image_review=review_path)
                        except wc.Fail as error:
                            assert str(error).startswith('simulated lost client'), str(error)
                        else:
                            raise AssertionError('Expected interrupted image ingestion')
                reviewed = ingest.ingest(cfg, image_path, image_review=review_path)
                assert reviewed == ingest.ingest(cfg, image_path, image_review=review_path)
                cli = subprocess.run([sys.executable, '-m', 'wikicontext_client', 'ingest',
                    str(image_path), '--image-review', str(review_path)], capture_output=True, text=True,
                    env={**os.environ, 'WIKICONTEXT_URL': cfg['url'],
                         'WIKICONTEXT_USER_EMAIL': cfg['email'], 'WIKICONTEXT_USER_PASSWORD': cfg['password']})
                assert cli.returncode == 0, cli.stderr
                assert json.loads(cli.stdout) == reviewed
                assert reviewed['sha256'] == hashlib.sha256(original).hexdigest()
                assert image_path.read_bytes() == original
                record = exporter.one(cfg, 'sources', 'id,title,original_name,original,sha256', reviewed['source'])
                image_sources.append(record)
                originals[record['id']] = original
                reviewed_passages = ingest.rows(cfg, "SELECT id, ordinal, locator, body FROM passages WHERE rendition = '%s' ORDER BY ordinal" % reviewed['rendition'])
                assert len(reviewed_passages) == 2
                assert json.loads(reviewed_passages[0]['locator'])['region'] == [0, 0, 48, 32]
                image_passages.append(reviewed_passages[0]['id'])
                rendition = ingest.rows(cfg, "SELECT notes FROM renditions WHERE id = '%s'" % reviewed['rendition'])[0]
                metadata = json.loads(rendition['notes'])['image']
                assert metadata['related_source'] == result['source']
                assert metadata['sequence'] == sequence
                review['passages'][0]['body'] = 'Changed reviewed text.'
                review_path.write_text(json.dumps(review))
                try:
                    ingest.ingest(cfg, image_path, image_review=review_path)
                except wc.Fail as error:
                    assert error.code == 4
                else:
                    raise AssertionError('Complete reviewed image accepted conflicting evidence')
                image_url = request.base_url + '/api/files/sources/' + record['id'] + '/' + record['original']
                try:
                    urllib.request.urlopen(image_url)
                except urllib.error.HTTPError as error:
                    assert error.code in (403, 404)
                else:
                    raise AssertionError('Anonymous image download succeeded')
                with urllib.request.urlopen(image_url + '?token=' + file_token) as response:
                    assert response.read() == original
            assert len(ingest.rows(cfg, 'SELECT id FROM sources')) == 5
            image_run = real_must(cfg, 'POST', wc.records('ingestion_runs'), {
                'key': 'reviewed-image-fixture', 'description': 'Synthetic reviewed images',
                'status': 'staging', 'sources': [s['id'] for s in image_sources]})
            image_page = real_must(cfg, 'POST', wc.records('pages'), {'slug': 'synthetic-slide-review', 'kind': 'summary'})
            image_revision = real_must(cfg, 'POST', wc.records('page_revisions'), {
                'run': image_run['id'], 'page': image_page['id'], 'base_revision': '',
                'title': 'Synthetic slide review', 'summary': 'Reviewed image evidence.',
                'body': 'Three selected synthetic slides contain text.[^1][^2][^3]'})
            for marker, passage in enumerate(image_passages, 1):
                real_must(cfg, 'POST', wc.records('citations'), {
                    'page_revision': image_revision['id'], 'passage': passage, 'marker': str(marker)})
            real_must(cfg, 'PATCH', wc.records('ingestion_runs', image_run['id']), {'expected_revision': 1, 'status': 'published'})
            assert len(ingest.rows(cfg, 'SELECT id FROM publications')) == 2
            destination = Path(folder) / 'image-vault'
            exporter.export(cfg, destination)
            rendered = (destination / 'wiki/synthetic-slide-review.md').read_text()
            for record in image_sources:
                assert (destination / exporter.source_path(record)).read_bytes() == originals[record['id']]
                assert record['original_name'] in rendered
            personal = real_must(cfg, 'POST', '/api/wiki/spaces/personal', {})['id']
            private_cfg = dict(cfg, space=personal, space_checked=False)
            private = ingest.ingest(private_cfg, source)
            assert private['source'] != result['source'] and private['space'] == personal
            assert private['sha256'] == result['sha256']
            assert ingest.ingest(cfg, source)['source'] == result['source']
            assert ingest.ingest(private_cfg, source)['source'] == private['source']
    print('PASS: original/hash/dedup/retry, protected downloads, cited publication/export, normalized audio recovery, PNG/JPEG/WebP reviewed evidence and conflicts')


if __name__ == '__main__':
    main()
