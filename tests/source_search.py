#!/usr/bin/env python3
"""Ranked source search through the real binary; isolated synthetic evidence only."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from e2e import Project, PASSWORD


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    with tempfile.TemporaryDirectory(prefix='pocketcontext-source-search-') as temp:
        pc = Project(binary, Path(temp))
        try:
            pc.json('init', '--port', str(pc.port), '--password-stdin', stdin=PASSWORD + '\n')
            status, raw = pc.http('POST', '/api/collections/users/auth-with-password',
                                  {'identity': 'me@pocketcontext.localhost', 'password': PASSWORD})
            assert status == 200
            headers = {'Authorization': json.loads(raw)['token']}
            spaces = pc.json('spaces')
            space = next(row['id'] for row in spaces if row['selected'])
            source_ids = set()
            for n, title in enumerate(['Rocket metadata', 'Uncited research', 'Uncited launch report']):
                path = pc.root / f'synthetic-{n}.md'
                # Several matches within one source must occupy only one result.
                path.write_text(f'# Synthetic record {n}\n\nRocket café discovery. <img src=x onerror=unsafe()>\n\n' +
                                ('Additional rocket observations. ' * 180), encoding='utf-8')
                result = pc.json('ingest', str(path), '--title', title)
                source_ids.add(result['source'])
            assert pc.json('sql', 'SELECT count(*) FROM citations')['rows'][0][0] == 0

            def search(**patch):
                return pc.http('POST', '/api/context/search',
                               {'index': 'sources', 'scope': space, 'query': 'rocket', 'limit': 1, **patch}, headers)

            status, raw = search()
            assert status == 200, raw
            first = json.loads(raw)
            assert first['hasMore'] and len(first['hits']) == 1
            found = {first['hits'][0]['id']}
            for offset in [1, 2]:
                status, raw = search(offset=offset, expectedGeneration=first['generation'])
                assert status == 200, raw
                page = json.loads(raw)
                assert page['generation'] == first['generation']
                assert len(page['hits']) == 1 and page['hits'][0]['id'] not in found
                assert bool(page['hasMore']) == (offset == 1)
                found.add(page['hits'][0]['id'])
            assert found == source_ids
            status, raw = search(query='metadata')
            assert status == 200, raw
            assert 'passage' not in json.loads(raw)['hits'][0], 'Metadata-only match must not invent a passage'
            status, raw = search(query='café', limit=20)
            assert status == 200, raw
            for hit in json.loads(raw)['hits']:
                assert hit.get('passage') and 'café' in hit['excerpt']
                relation = pc.json('sql', f"SELECT r.source FROM passages p JOIN renditions r ON r.id=p.rendition WHERE p.id='{hit['passage']}'")
                assert relation['rows'] == [[hit['id']]]
            assert len(json.loads(raw)['hits']) == 3
            status, raw = search(scope='missing00000001')
            assert status == 404
            status, raw = pc.http('POST', '/api/context/search', {'index': 'sources', 'query': 'rocket', 'scope': space})
            assert status == 401
            added = pc.root / 'later.md'
            added.write_text('Rocket later extraction changes generation.', encoding='utf-8')
            pc.json('ingest', str(added))
            status, raw = search(offset=1, expectedGeneration=first['generation'])
            assert status == 409, raw
            print('ranked source search integration passed')
        finally:
            subprocess.run([str(binary), '--db', str(pc.db), 'stop'], env=pc.env,
                           capture_output=True, timeout=60)


if __name__ == '__main__':
    main()
