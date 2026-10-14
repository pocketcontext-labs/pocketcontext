#!/usr/bin/env python3
"""Synthetic private-search benchmark with publication history and evidence.

All fixture writes use authenticated REST in an isolated application. Defaults
approximate 350 pages, 800 revisions, 190 publications, 4.24 MB revision bodies
and 2.59 MB passage bodies. Four distinct company readers exercise concurrency.
SQL cold/warm requests and direct private-search requests are timed separately.
Request wall time includes transport and execution; it is not snapshot build time.
"""
import argparse
import concurrent.futures
import contextlib
import json
from pathlib import Path
import statistics
import tempfile
import time
import urllib.request

from integration import credentials
from search_integration import Fixture, running


def identifier(prefix, number):
    return prefix + f'{number:014d}'


def padded(text, size):
    suffix = ' [needs verification]'
    return (text + ' Synthetic evidence and publication history.' * (size // 40 + 1))[:size - len(suffix)] + suffix


def timed_query(fixture, sql, expected):
    started = time.perf_counter()
    assert fixture.query(sql) == expected
    return round((time.perf_counter() - started) * 1000, 2)


def measure_snapshot(fixture, passages, repeats):
    # This identity has never issued SQL, including publication lookup or corpus
    # counts. No preceding query can accidentally warm its requester snapshot.
    sql = 'SELECT count(*) AS n FROM passages'
    expected = [{'n': passages}]
    cold = timed_query(fixture, sql, expected)
    warm = [timed_query(fixture, sql, expected) for _ in range(repeats)]
    # A visible write invalidates the snapshot on the pinned server. A future
    # dependency-aware implementation may refresh only affected tables, so name
    # this by its controlled trigger rather than claiming another full rebuild.
    fixture.run('snapshot-invalidation')
    after_write = timed_query(fixture, sql, expected)
    return {'first_request_fresh_identity_ms': cold,
            'warm_median_ms': round(statistics.median(warm), 2), 'warm_samples_ms': warm,
            'first_request_after_visible_write_ms': after_write}


def measure_search(fixtures, publication, repeats):
    queries = {}
    for query in ['topic3', 'evidence', 'nonexistentterm']:
        elapsed = []
        for _ in range(repeats + 1):
            started = time.perf_counter()
            result = fixtures[0].search(publication, query, limit=20)
            assert result['truncated'] == result['hasMore']
            elapsed.append((time.perf_counter() - started) * 1000)
        queries[query] = {'first_ms': round(elapsed[0], 2), 'warm_median_ms': round(statistics.median(elapsed[1:]), 2), 'hits': len(result['hits'])}
    def reader(number):
        started = time.perf_counter()
        result = fixtures[number % 4].search(publication, 'evidence', limit=20)
        assert result['truncated'] == result['hasMore']
        assert len(result['hits']) == 20
        return (time.perf_counter() - started) * 1000
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        elapsed = list(pool.map(reader, range(12)))
    return {'endpoint': '/api/context/search',
            'source': 'Authorized source transaction plus separate private FTS cache; no SQL snapshot',
            'first_index_query': 'topic3',
            'queries': queries, 'concurrent_distinct_readers': 4, 'concurrent_requests': 12,
            'concurrent_median_ms': round(statistics.median(elapsed), 2), 'concurrent_max_ms': round(max(elapsed), 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--pages', type=int, default=350)
    parser.add_argument('--revisions', type=int, default=800)
    parser.add_argument('--publications', type=int, default=190)
    parser.add_argument('--body-chars', type=int, default=5300)
    parser.add_argument('--passages', type=int, default=6400)
    parser.add_argument('--passage-chars', type=int, default=405)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--track-changes', action='store_true', help='Enable candidate server transactional tracking only in the isolated fixture')
    parser.add_argument('--fixture', type=Path, help='Retain synthetic fixture in a new directory outside the repository')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    drafts = min(20, args.pages)
    assert 20 <= args.pages <= 10000 and args.revisions >= args.pages + drafts
    assert 1 <= args.publications <= args.revisions - args.pages - drafts + 1
    assert args.body_chars >= 100 and args.passage_chars >= 100 and args.repeats >= 1
    if args.fixture and args.fixture.exists() and any(args.fixture.iterdir()):
        raise ValueError('Choose a new empty fixture directory')
    manager = contextlib.nullcontext(args.fixture) if args.fixture else tempfile.TemporaryDirectory(prefix='wikicontext-private-benchmark-')
    with manager as temporary:
        work = Path(temporary) / 'app'
        with running(args.binary, work, track_changes=args.track_changes) as request:
            admin, user, token = credentials(request)
            f = Fixture(request, token)
            fixtures = [f]
            for number in range(3):
                email = f'reader{number}@example.test'
                password = 'SyntheticBenchmarkPassword123!'
                request('POST', '/api/collections/users/records', {'name': f'Synthetic reader {number}', 'email': email, 'password': password, 'passwordConfirm': password}, admin)
                other = request('POST', '/api/collections/users/auth-with-password', {'identity': email, 'password': password})['token']
                fixtures.append(Fixture(request, other))
            def post(table, body):
                return {'method': 'POST', 'url': '/api/collections/' + table + '/records', 'body': body}
            def batch(items):
                for start in range(0, len(items), 20):
                    response = request('POST', '/api/batch', {'requests': items[start:start + 20]}, token)
                    assert all(item['status'] == 200 for item in response), response
            def revision_body(number, page, run, base=''):
                return dict(id=identifier('r', number), run=run['id'], page=identifier('p', page), base_revision=base,
                            title=f'topic{page % 20} guide {page}', summary='Synthetic benchmark evidence',
                            body=padded(f'topic{page % 20} published evidence.', args.body_chars))
            started = time.perf_counter()
            initial = f.run('initial')
            items = []
            bases = {}
            for number in range(args.pages):
                items += [post('pages', dict(id=identifier('p', number), slug=f'synthetic-{number}', kind='concept')),
                          post('page_revisions', revision_body(number, number, initial))]
                bases[number] = identifier('r', number)
            batch(items)
            publish_times = []
            before = time.perf_counter()
            publication = f.publish(initial)
            publish_times.append((time.perf_counter() - before) * 1000)
            revision_number = args.pages
            history = args.revisions - args.pages - drafts
            for number in range(1, args.publications):
                run = f.run(f'history-{number}')
                count = history // (args.publications - 1) + (number <= history % (args.publications - 1))
                items = []
                for _ in range(count):
                    page = (revision_number - args.pages) % args.pages
                    items.append(post('page_revisions', revision_body(revision_number, page, run, bases[page])))
                    bases[page] = identifier('r', revision_number)
                    revision_number += 1
                batch(items)
                before = time.perf_counter()
                publication = f.publish(run)
                publish_times.append((time.perf_counter() - before) * 1000)
            draft = f.run('drafts')
            batch([post('page_revisions', dict(revision_body(revision_number + number, number, draft, bases[number]),
                                              body=padded('draftsecret unpublished.', args.body_chars))) for number in range(drafts)])
            # Evidence participates in every SQL snapshot even though search indexes only revisions.
            if args.passages:
                boundary = 'synthetic-search-evidence-boundary'
                payload = b''
                for name, value in {'title': 'Synthetic benchmark original', 'original_name': 'evidence.txt', 'media_type': 'text/plain'}.items():
                    payload += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
                payload += f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\nSynthetic benchmark original.\r\n--{boundary}--\r\n'.encode()
                upload = urllib.request.Request(request.base_url + '/api/collections/sources/records', data=payload,
                    headers={'Authorization': token, 'Content-Type': 'multipart/form-data; boundary=' + boundary}, method='POST')
                with urllib.request.urlopen(upload, timeout=60) as response:
                    source = json.load(response)
                rendition = f.create('renditions', dict(source=source['id'], kind='text', processor='synthetic', version_label='v1'))
                batch([post('passages', dict(rendition=rendition['id'], ordinal=number + 1, locator='synthetic ' + str(number),
                                            body=padded('Synthetic passage evidence.', args.passage_chars))) for number in range(args.passages)])
            seed_seconds = time.perf_counter() - started
            print(f'Seeded synthetic corpus in {seed_seconds:.1f}s', flush=True)
            snapshot_measurements = measure_snapshot(fixtures[1], args.passages, args.repeats)
            counts = f.query('''SELECT
              (SELECT count(*) FROM pages) AS pages,
              (SELECT count(*) FROM page_revisions) AS revisions,
              (SELECT count(*) FROM publications) AS publications,
              (SELECT sum(length(body)) FROM page_revisions) AS revision_body_characters,
              (SELECT count(*) FROM passages) AS passages,
              (SELECT sum(length(body)) FROM passages) AS passage_body_characters''')[0]
            assert counts['revisions'] == args.revisions
            measurements = measure_search(fixtures, publication, args.repeats)
            assert not f.search(publication, 'draftsecret')['hits']
            result = dict(counts, track_changes=args.track_changes, seed_seconds=round(seed_seconds, 2), publication_median_ms=round(statistics.median(publish_times), 2),
                          publication_max_ms=round(max(publish_times), 2),
                          measurement='HTTP request wall time, not isolated snapshot/index construction',
                          publication_operation='REST publish plus authenticated SQL publication lookup',
                          sql_count_query=snapshot_measurements, private_search=measurements,
                          database_bytes=(request.data_dir / 'data.db').stat().st_size, repeats=args.repeats)
    rendered = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(rendered + '\n')
    print(rendered)


if __name__ == '__main__':
    main()
