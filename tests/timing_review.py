#!/usr/bin/env python3
"""Timestamp warnings survive import but require version-bound publication review."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch
from integration import server, credentials
from transcript_bundle import fixture
from wikicontext_client import ingest, audio_catalog


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    with server(args.binary) as request, tempfile.TemporaryDirectory(prefix='wiki-timing-review-') as folder:
        _, _, token = credentials(request)
        cfg = {'url': request.base_url, 'email': 'agent@example.com', 'password': 'SyntheticUserPassword123!'}
        root = Path(folder)
        audio, manifest, metadata = fixture(root)
        transcript = json.loads((root / 'transcript.json').read_text())
        transcript['segments'][0].update(start=0.8, end=0.2)
        transcript['segments'].append(dict(id='seg000002', start=0.1, end=0.5,
                                           speaker='SPEAKER_01', text='Second synthetic segment.'))
        data = json.dumps(transcript).encode()
        (root / 'transcript.json').write_bytes(data)
        metadata['artifacts'][0].update(sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data))
        manifest.write_text(json.dumps(metadata))
        def create(table, body, expected=200):
            return request('POST', '/api/collections/'+table+'/records', body, token, expected)
        def query(sql):
            result = request('POST', '/api/context/query', {'sql': sql}, token)
            assert not result['truncated']
            return [dict(zip(result['columns'], row)) for row in result['rows']]
        def run(key):
            return create('ingestion_runs', dict(key=key, status='staging', description='Synthetic timing review'))
        def publish(staged, expected=200):
            return request('PATCH', '/api/collections/ingestion_runs/records/'+staged['id'],
                           dict(status='published', expected_revision=1), token, expected)
        def revision(staged, page, passage, properties=None, base=''):
            rev = create('page_revisions', dict(run=staged['id'], page=page['id'], base_revision=base,
                         title='Synthetic timing review', summary='Synthetic evidence', body='Evidence.[^1]',
                         properties=properties or {}))
            create('citations', dict(page_revision=rev['id'], passage=passage, marker='1'))
            return rev
        with patch.dict(os.environ, {'XDG_CACHE_HOME': str(root / 'cache')}):
            result = ingest.ingest(cfg, audio, audio_storage='original', transcript_bundle=manifest, version='warning-v1')
            assert result['timing_review']['status'] == 'required'
            passage = result['segment_passages']['seg000001'][0]
            stored = query("SELECT locator FROM passages WHERE id='%s'" % passage)[0]
            assert 'timing unavailable' in stored['locator'] and 'seconds' not in stored['locator']
            tp = create('pages', dict(slug='warning-transcript', kind='transcript'))
            sp = create('pages', dict(slug='warning-summary', kind='summary'))
            staged = run('citation-without-catalog')
            revision(staged, tp, passage)
            publish(staged, 400)
            assert not query('SELECT id FROM publications')
            # Direct REST staging cannot bypass the review gate in the CLI.
            staged = run('unreviewed-recording')
            rp = create('pages', dict(slug='warning-recording', kind='entity'))
            properties = dict(catalog_type='audio_recording', audio_source_id=result['source'],
                              selected_bundle_rendition_id=result['bundle_rendition'])
            revision(staged, rp, passage, properties)
            publish(staged, 400)
            assert not query('SELECT id FROM publications')
            staged = run('reviewed-recording')
            revision(staged, tp, passage)
            revision(staged, sp, passage)
            reviewed = audio_catalog.stage(cfg, staged['id'], result, tp['id'], sp['id'],
                timing_review_note='Reviewed synthetic intervals; invalid interval remains unavailable; ordering retained.')
            publish(staged)
            selected = query("SELECT properties FROM page_revisions WHERE id='%s'" % reviewed['revision'])[0]
            properties = json.loads(selected['properties'])
            assert properties['timing_review_bundle_rendition_id'] == result['bundle_rendition']
            # Same audio with a new extraction needs its own explicit review.
            metadata['run_id'] = 'warning-v2'
            manifest.write_text(json.dumps(metadata))
            second = ingest.ingest(cfg, audio, audio_storage='original', transcript_bundle=manifest, version='warning-v2')
            staged = run('stale-review')
            stale = dict(properties, selected_bundle_rendition_id=second['bundle_rendition'])
            create('page_revisions', dict(run=staged['id'], page=reviewed['page'], base_revision=reviewed['revision'],
                   title='Stale review', body='[needs verification]', properties=stale), 400)
            # A warning citation from another version is not covered by v1 review.
            other = create('pages', dict(slug='other-version-evidence', kind='summary'))
            revision(staged, other, second['segment_passages']['seg000001'][0])
            publish(staged, 400)
            assert len(query('SELECT id FROM publications')) == 1
            # A new reviewed selection retains the already published review of v1.
            staged = run('new-reviewed-selection')
            next_review = audio_catalog.stage(cfg, staged['id'], second, tp['id'], sp['id'],
                timing_review_note='Reviewed second synthetic extraction independently.')
            publish(staged)
            assert len(query('SELECT id FROM publications')) == 2
            # New citations to previously reviewed immutable evidence remain valid.
            staged = run('historically-reviewed-evidence')
            historical = create('pages', dict(slug='historically-reviewed', kind='summary'))
            revision(staged, historical, passage)
            publish(staged)
            assert len(query('SELECT id FROM publications')) == 3
    print('PASS: timing evidence preservation, REST/citation publication gate, version-bound review and rollback')


if __name__ == '__main__':
    main()
