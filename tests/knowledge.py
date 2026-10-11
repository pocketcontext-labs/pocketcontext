#!/usr/bin/env python3
"""Synthetic SQL fixtures exercise pinned publication traversal and response limits."""
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

from wikicontext_client import knowledge
from wikicontext_client import cli as wc


SPACE = 'space0000000001'


def ident(number):
    return f'{number:015d}'


class Knowledge(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE publications(id TEXT PRIMARY KEY, sequence INTEGER, manifest TEXT,
                space TEXT DEFAULT 'space0000000001');
            CREATE TABLE pages(id TEXT PRIMARY KEY, slug TEXT, kind TEXT);
            CREATE TABLE page_revisions(id TEXT PRIMARY KEY, page TEXT, title TEXT,
                summary TEXT, body TEXT, archived INTEGER);
            CREATE TABLE page_links(id TEXT PRIMARY KEY, page_revision TEXT, target TEXT);
            CREATE TABLE citations(id TEXT PRIMARY KEY, page_revision TEXT, marker INTEGER);
        ''')
        self.calls, self.byte_limit, self.row_limit = [], 1024 * 1024, 500
        self.http413 = False
        self.search_response, self.search_requests = None, []
        for patcher in (patch.object(wc, 'must', side_effect=self.query),
                        patch.object(wc, 'space_id', return_value=SPACE)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def query(self, cfg, method, path, body):
        if path == '/api/context/search':
            self.assertEqual(method, 'POST')
            self.search_requests.append(body)
            if isinstance(self.search_response, Exception):
                raise self.search_response
            return self.search_response
        self.assertEqual((method, path), ('POST', '/api/context/query'))
        sql = body['sql']
        self.calls.append(sql)
        cursor = self.db.execute(sql)
        columns = [column[0] for column in cursor.description]
        result, size = [], 0
        for row in cursor:
            size += len(json.dumps(row).encode())
            if len(result) >= self.row_limit or size > self.byte_limit:
                if self.http413:
                    raise wc.Fail(1, 'HTTP 413 from POST /api/context/query')
                return dict(columns=columns, rows=result, truncated=True)
            result.append(row)
        return dict(columns=columns, rows=result, truncated=False)

    def fixture(self, count=3, body='Evidence [needs verification].'):
        manifest = {}
        for index in range(count):
            page, revision = ident(index + 1), ident(index + 10001)
            self.db.execute('INSERT INTO pages VALUES (?,?,?)', (page, f'page-{index:04}', 'concept'))
            self.db.execute('INSERT INTO page_revisions VALUES (?,?,?,?,?,?)',
                            (revision, page, f'Title {index}', 'Summary', body, 0))
            manifest[page] = revision
        self.db.execute('INSERT INTO publications(id, sequence, manifest) VALUES (?,1,?)', (ident(90000), json.dumps(manifest)))
        return manifest

    def test_empty(self):
        self.assertEqual(knowledge.search({}, 'anything'), {'space': SPACE, 'publication': None, 'generation': None, 'pages': [], 'hasMore': False, 'nextOffset': None})
        self.assertEqual(knowledge.lint({})['findings'], [])

    def test_bounded_pages_and_large_manifest(self):
        manifest = self.fixture(601, body='Tuesday ' + 'x' * 2500)
        # The manifest itself cannot fit in one response, but no query returns it.
        self.byte_limit = 16000
        self.assertGreater(len(json.dumps(manifest)), self.byte_limit)
        _, pages = knowledge.published({})
        result = {'pages': pages}
        self.assertEqual(len(result['pages']), 601)
        self.assertEqual(len({page['id'] for page in result['pages']}), 601)
        self.assertLess(len(self.calls), 150)
        self.assertFalse(any('SELECT id, sequence, manifest' in sql for sql in self.calls))

    def test_http413_retries_and_single_row_failure(self):
        self.fixture(4, body='x' * 1000)
        self.byte_limit, self.http413 = 1500, True
        self.assertEqual(len(knowledge.published({})[1]), 4)
        self.byte_limit = 500
        with self.assertRaisesRegex(wc.Fail, 'HTTP 413'):
            knowledge.published({})

    def test_truncated_single_row_fails_closed(self):
        self.fixture(1, body='x' * 3000)
        self.byte_limit = 1000
        with self.assertRaisesRegex(wc.Fail, 'truncated'):
            knowledge.published({})

    def test_manifest_corruption(self):
        manifest = self.fixture()
        key, value = next(iter(manifest.items()))
        corrupt = ['invalid-json', '[]', 'null', '42', '"text"',
                   json.dumps({key: None}), json.dumps({key: 10001}),
                   json.dumps({key: {}}), json.dumps({'bad': value}),
                   json.dumps({'abcdefghijklmno': value}),
                   json.dumps({key: 'missingrevision'}),
                   json.dumps({key: ident(10002)}),
                   '{' + f'"{key}":"{value}","{key}":"{value}"' + '}']
        for data in corrupt:
            with self.subTest(manifest=data):
                self.db.execute('UPDATE publications SET manifest=?', (data,))
                with self.assertRaisesRegex(wc.Fail, 'publication manifest'):
                    knowledge.published({})

    def test_empty_manifest_and_archive_validation(self):
        self.fixture(0)
        self.assertEqual(knowledge.published({})[1], [])
        self.db.execute('DELETE FROM publications')
        manifest = self.fixture(1)
        self.db.execute('UPDATE page_revisions SET archived=1')
        self.assertEqual(knowledge.published({})[1], [])
        self.db.execute('DELETE FROM pages')
        with self.assertRaisesRegex(wc.Fail, 'incomplete publication'):
            knowledge.published({})

    def test_lint_batches_relationships_excludes_drafts_and_archives(self):
        manifest = self.fixture(120)
        pairs = list(manifest.items())
        for index, (page, revision) in enumerate(pairs):
            self.db.execute('INSERT INTO page_links VALUES (?,?,?)',
                            (ident(20000 + index), revision, pairs[(index + 1) % len(pairs)][0]))
            self.db.execute('INSERT INTO citations VALUES (?,?,1)', (ident(30000 + index), revision))
        # Many relationships for one revision require their own keyset pages.
        for index in range(550):
            self.db.execute('INSERT INTO page_links VALUES (?,?,?)',
                            (ident(40000 + index), pairs[0][1], pairs[1][0]))
        self.db.execute('INSERT INTO page_revisions VALUES (?,?,?,?,?,0)',
                        (ident(80000), pairs[0][0], 'Draft', '', 'draft'))
        self.db.execute('INSERT INTO page_links VALUES (?,?,?)', (ident(81000), ident(80000), 'missing'))
        self.db.execute('UPDATE page_revisions SET archived=1 WHERE id=?', (pairs[-1][1],))
        self.db.execute('INSERT INTO page_links VALUES (?,?,?)', (ident(81001), pairs[-1][1], 'missing'))
        result = knowledge.lint({})
        self.assertEqual(len([r for r in result['findings'] if r['kind'] == 'broken-link']), 1)
        self.assertFalse(any(r['kind'] == 'no-citations' for r in result['findings']))
        self.assertEqual(len([r for r in result['findings'] if r['kind'] == 'needs-verification']), 119)
        self.assertLess(len(self.calls), 20)

    def test_property_relationships_and_evidence(self):
        self.fixture(2)
        self.db.execute('ALTER TABLE page_revisions ADD COLUMN properties TEXT')
        self.db.execute('ALTER TABLE page_revisions ADD COLUMN property_evidence TEXT')
        self.db.execute('UPDATE page_revisions SET properties=?,property_evidence=? WHERE id=?',
                        (json.dumps({'resources': [ident(2)], 'provider': 'synthetic'}),
                         json.dumps({'provider': ['1', '2']}), ident(10001)))
        self.db.execute('INSERT INTO citations VALUES (?,?,1)', (ident(30001), ident(10001)))
        findings = knowledge.lint({})['findings']
        self.assertNotIn({'page': 'page-0001', 'kind': 'orphan'}, findings)
        self.assertIn({'page': 'page-0000', 'kind': 'missing-property-citation',
                       'property': 'provider', 'marker': '2'}, findings)
        self.db.execute('UPDATE page_revisions SET archived=1 WHERE id=?', (ident(10002),))
        self.assertIn({'page': 'page-0000', 'kind': 'broken-link', 'target': ident(2)},
                      knowledge.lint({})['findings'])

    def test_publication_selection_is_per_space(self):
        self.fixture(1)
        self.db.execute("INSERT INTO publications VALUES (?,7,'{}','other000000001')", (ident(90009),))
        self.assertEqual(knowledge.select_publication({})['id'], ident(90000))
        with self.assertRaises(wc.Fail):
            knowledge.select_publication({}, sequence=7)
        with self.assertRaises(wc.Fail):
            knowledge.select_publication({}, publication_id=ident(90009))

    def test_new_publication_during_reads_does_not_change_pin(self):
        self.fixture(2)
        query = self.query
        def advancing(*args):
            result = query(*args)
            if len(self.calls) == 1:
                self.db.execute('INSERT INTO publications(id, sequence, manifest) VALUES (?,2,?)', (ident(90001), '{}'))
            return result
        with patch.object(wc, 'must', side_effect=advancing):
            publication, pages = knowledge.published({})
        self.assertEqual(publication['id'], ident(90000))
        self.assertEqual(len(pages), 2)


    def ranked(self, ids, more=False):
        return {'index': 'pages', 'scope': ident(90000), 'generation': 'generation-1',
                'hits': [{'id': record_id, 'score': -10 + i, 'excerpt': '<script>literal</script>'}
                         for i, record_id in enumerate(ids)], 'hasMore': more, 'truncated': more}

    def test_search_preserves_rank_and_hydrates_only_selected_hits(self):
        self.fixture(3)
        self.search_response = self.ranked([ident(10003), ident(10001)], True)
        result = knowledge.search({}, 'Title', limit=2)
        self.assertEqual([p['id'] for p in result['pages']], [ident(10003), ident(10001)])
        self.assertEqual(result['pages'][0]['excerpt'], '<script>literal</script>')
        self.assertEqual(result['nextOffset'], 2)
        self.assertEqual(self.search_requests[0]['scope'], ident(90000))
        self.assertFalse(any('r.*' in sql for sql in self.calls))
        self.search_response = self.ranked([ident(10002)])
        tail = knowledge.search({}, 'Title', publication_id=result['publication'], limit=2,
                                offset=2, generation=result['generation'])
        self.assertIsNone(tail['nextOffset'])
        self.assertEqual(self.search_requests[-1]['expectedGeneration'], 'generation-1')

    def test_search_rejects_cross_publication_and_archived_hits(self):
        self.fixture(2)
        self.db.execute('UPDATE page_revisions SET archived=1 WHERE id=?', (ident(10002),))
        for record_id in [ident(10002), ident(80000)]:
            self.search_response = self.ranked([record_id])
            with self.assertRaisesRegex(wc.Fail, 'absent from the selected publication'):
                knowledge.search({}, 'Title')

    def test_search_conflict_requires_explicit_restart(self):
        self.fixture()
        self.search_response = wc.Fail(4, 'HTTP 409')
        with self.assertRaisesRegex(wc.Fail, 'Discard prior result pages') as error:
            knowledge.search({}, 'Title', sequence=1, offset=2, generation='generation-1')
        self.assertEqual(error.exception.code, 4)
        self.assertEqual(len(self.search_requests), 1)

    def test_invalid_search_and_continuations_do_not_send_requests(self):
        for kwargs in [{'offset': 1}, {'offset': 1, 'generation': 'g'}, {'limit': 101},
                       {'generation': 'bad\x00generation'}, {'sequence': -1}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(wc.Fail):
                knowledge.search({}, 'Title', **kwargs)
        for term in ['', ' ', 'a ' * 17, 'é' * 2049]:
            with self.assertRaises(wc.Fail):
                knowledge.search({}, term)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.search_requests, [])

    def test_invalid_search_response_fails_closed(self):
        self.fixture(2)
        valid = self.ranked([ident(10001)])
        cases = [dict(valid, scope=ident(90001)), dict(valid, generation=''),
                 dict(valid, hits=valid['hits'] * 2), dict(valid, hasMore=True),
                 dict(valid, hits=[dict(valid['hits'][0], score=float('nan'))])]
        for result in cases:
            self.search_response = result
            with self.subTest(result=result), self.assertRaises(wc.Fail):
                knowledge.search({}, 'Title')


if __name__ == '__main__':
    unittest.main()
