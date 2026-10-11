#!/usr/bin/env python3
"""Synthetic HTTP concurrency and committed-response-loss ingestion checks."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
from unittest.mock import patch

from integration import server, credentials
from wikicontext_client import cli as wc
from wikicontext_client import ingest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    with server(args.binary) as request, tempfile.TemporaryDirectory(prefix='wiki-ingest-concurrency-') as folder:
        credentials(request)
        cfg = {'url': request.base_url, 'email': 'agent@example.com', 'password': 'SyntheticUserPassword123!'}
        # Initialize authentication before sharing the ordinary client with workers.
        wc.must(cfg, 'POST', '/api/context/query', {'sql': 'SELECT 1'})
        source = Path(folder) / 'concurrent.md'
        source.write_text('Concurrent synthetic evidence.\n' * 1600)
        real_rows = ingest.rows
        barrier = threading.Barrier(2)
        seen = threading.local()

        def racing_rows(config, sql):
            result = real_rows(config, sql)
            # Both clients observe absence before either can start its upload.
            if 'FROM sources WHERE sha256 =' in sql and not getattr(seen, 'waited', False):
                seen.waited = True
                assert not result
                barrier.wait(timeout=30)
            return result

        with patch.object(ingest, 'rows', side_effect=racing_rows):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: ingest.ingest(cfg, source), range(2)))
        assert results[0] == results[1], 'Concurrent identical ingestion diverged'
        assert real_rows(cfg, 'SELECT COUNT(*) AS n FROM sources')[0]['n'] == 1
        assert real_rows(cfg, 'SELECT COUNT(*) AS n FROM renditions')[0]['n'] == 1
        assert real_rows(cfg, 'SELECT COUNT(*) AS n FROM passages')[0]['n'] == results[0]['passages']

        # Exercise the real multipart upload handler after the server has committed
        # a source, while making only its HTTP response disappear from the client.
        lost_source = Path(folder) / 'lost-source.md'
        lost_source.write_text('Synthetic committed upload with a lost response.')
        real_open = wc.opener.open
        lost = {'source': False}

        def lose_upload_response(req, *a, **kw):
            response = real_open(req, *a, **kw)
            if req.full_url.endswith(wc.records('sources')) and req.get_method() == 'POST' and not lost['source']:
                lost['source'] = True
                response.close()
                raise OSError('synthetic lost committed source response')
            return response

        with patch.object(wc.opener, 'open', side_effect=lose_upload_response):
            recovered = ingest.ingest(cfg, lost_source)
        assert lost['source']
        assert recovered == ingest.ingest(cfg, lost_source)

        # Rendition and passage writes also reconcile committed but lost responses
        # through SQL. A cache must observe every one of these REST commits.
        lost_parts = Path(folder) / 'lost-parts.md'
        lost_parts.write_text('Synthetic committed extraction response.\n' * 1700)
        real_must = wc.must
        lost_tables = set()

        def lose_create_response(config, method, url, body=None):
            result = real_must(config, method, url, body)
            for table in ('renditions', 'passages'):
                if method == 'POST' and url == wc.records(table) and table not in lost_tables:
                    lost_tables.add(table)
                    raise wc.Fail(1, 'synthetic lost committed create response')
            return result

        with patch.object(wc, 'must', side_effect=lose_create_response):
            recovered_parts = ingest.ingest(cfg, lost_parts)
        assert lost_tables == {'renditions', 'passages'}
        assert recovered_parts == ingest.ingest(cfg, lost_parts)

        # A concurrent competing extractor may win rendition creation. Its
        # different immutable extraction must never be silently reused.
        incompatible = Path(folder) / 'incompatible.md'
        incompatible.write_text('Synthetic competing extraction input.')
        injected = False

        def competing_rendition(config, method, url, body=None):
            nonlocal injected
            if method == 'POST' and url == wc.records('renditions') and not injected:
                injected = True
                competing = dict(body, notes='{"different":"synthetic extraction"}')
                real_must(config, method, url, competing)
                # Real second create proves the database uniqueness constraint.
                return real_must(config, method, url, body)
            return real_must(config, method, url, body)

        with patch.object(wc, 'must', side_effect=competing_rendition):
            try:
                ingest.ingest(cfg, incompatible)
            except wc.Fail as error:
                assert 'different extracted content' in str(error), str(error)
            else:
                raise AssertionError('Incompatible concurrent extraction was reused')
        assert injected
    print('PASS: concurrent source deduplication, lost committed source/rendition/passage responses, incompatible extraction rejection')


if __name__ == '__main__':
    main()
