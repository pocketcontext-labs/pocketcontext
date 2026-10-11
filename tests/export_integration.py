#!/usr/bin/env python3
"""Live synthetic SQL/REST/protected-file export regression test."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

from integration import server, credentials, ROOT
from wikicontext_client import exporter
from wikicontext_client import ingest
from wikicontext_client import cli as wc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='wikicontext-export-test-') as temp, server(args.binary) as request:
        folder = Path(temp)
        env = dict(os.environ, XDG_CACHE_HOME=str(folder / 'cache'), WIKICONTEXT_URL=request.base_url,
                   WIKICONTEXT_USER_EMAIL='agent@example.com', WIKICONTEXT_USER_PASSWORD='SyntheticUserPassword123!')
        with patch.dict(os.environ, env):
            admin, user, token = credentials(request)
            cfg = wc.config()
            wc.save_session(cfg, {'url': cfg['url'], 'email': cfg['email'], 'token': token})
            source_file = folder / 'original [synthetic].txt'
            original = b'The synthetic observatory opened in 2026.\n'
            source_file.write_bytes(original)
            evidence = ingest.ingest(cfg, source_file, title='Synthetic Observatory')
            source = exporter.one(cfg, 'sources', 'id,title,original_name,original,sha256', evidence['source'])
            passage = exporter.query(cfg, "SELECT id FROM passages WHERE rendition = '" + evidence['rendition'] + "'")[0]
            def create(table, body):
                return request('POST', wc.records(table), body, token)
            def run(key):
                return create('ingestion_runs', {'key': key, 'status': 'staging', 'description': 'Synthetic ' + key, 'sources': [source['id']]})
            def revision(run, page, base='', archived=False, owner=None):
                record = create('page_revisions', {'run': run['id'], 'page': page['id'], 'base_revision': base,
                    'title': 'Synthetic observatory', 'summary': 'Synthetic sourced fact.',
                    'body': 'The observatory opened in 2026.[^1]', 'archived': archived,
                    'properties': {'catalog_type': 'resource', 'accountable_owner': owner},
                    'property_evidence': {'catalog_type': ['1']}})
                create('citations', {'page_revision': record['id'], 'passage': passage['id'], 'marker': '1', 'note': 'Opening date.'})
                return record
            def publish(run):
                return request('PATCH', wc.records('ingestion_runs', run['id']), {'expected_revision': run['revision'], 'status': 'published'}, token)
            page = create('pages', {'slug': 'observatory', 'kind': 'entity'})
            first = run('first'); rev1 = revision(first, page); publish(first)
            destination = folder / 'vault'
            exporter.export(cfg, destination)
            manifest_path = destination / exporter.MANIFEST
            migrated = json.loads(manifest_path.read_text())
            assert migrated.pop('space') == wc.COMPANY_SPACE
            manifest_path.write_text(json.dumps(migrated))
            exporter.export(cfg, destination)
            assert json.loads(manifest_path.read_text())['space'] == wc.COMPANY_SPACE
            md = destination / 'wiki/observatory.md'
            original_render = md.read_bytes()
            assert b'[^1]: [original \\[synthetic\\].txt]' in original_render, original_render
            attachment = destination / exporter.source_path(source)
            assert attachment.read_bytes() == original
            assert '../raw/' in md.read_text()
            # Restore of damaged local output is refused; authoritative files remain intact.
            attachment.write_bytes(b'local corruption')
            try:
                exporter.export(cfg, destination)
            except wc.Fail as error:
                assert 'Local edit' in str(error)
            else:
                raise AssertionError('Corrupt local original was silently replaced')
            assert md.read_bytes() == original_render
            attachment.write_bytes(original)
            # New publication does not alter historical export or its recorded sequence.
            second = run('second'); rev2 = revision(second, page, rev1['id'], owner='Synthetic owner'); publish(second)
            exporter.export(cfg, destination, sequence=1)
            assert md.read_bytes() == original_render
            assert json.loads((destination / exporter.MANIFEST).read_text())['sequence'] == 1
            # Exercise the real portable CLI and its environment/session integration.
            result = subprocess.run([sys.executable, '-m', 'wikicontext_client',
                'export-obsidian', str(destination), '--sequence', '2'], env=env, capture_output=True, text=True)
            assert result.returncode == 0, result.stderr
            assert json.loads(result.stdout)['sequence'] == 2
            assert rev2['id'] in md.read_text()
            assert 'accountable_owner: "Synthetic owner"' in md.read_text()
            assert b'accountable_owner: null' in original_render
            assert b'## Property evidence' in original_render
            (destination / '.obsidian').mkdir()
            (destination / '.obsidian/app.json').write_text('{}')
            (destination / 'wiki/personal.md').write_text('Local note')
            third = run('archive'); revision(third, page, rev2['id'], archived=True); publish(third)
            exporter.export(cfg, destination)
            assert not md.exists()
            assert attachment.read_bytes() == original
            assert (destination / 'wiki/personal.md').read_text() == 'Local note'
            assert (destination / '.obsidian/app.json').read_text() == '{}'
            # A broken restored original on the isolated server fails hash verification
            # before the previously exported presentation is touched.
            stored = list(request.data_dir.rglob(source['original']))
            assert len(stored) == 1, stored
            stored[0].write_bytes(b'synthetic restore corruption')
            before = (destination / exporter.MANIFEST).read_bytes()
            try:
                exporter.export(cfg, destination, sequence=1)
            except wc.Fail as error:
                assert 'hash or size' in str(error)
            else:
                raise AssertionError('Corrupt restored original was exported')
            assert (destination / exporter.MANIFEST).read_bytes() == before
            assert not md.exists()
            stored[0].write_bytes(original)
    print('PASS: live protected-original export, citation escaping, pinned history, CLI, archive, corruption rejection')


if __name__ == '__main__':
    main()
