#!/usr/bin/env python3
"""Synthetic catalog staging, using an in-memory SQL stand-in for authenticated reads."""
import copy
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
from wikicontext_client import audio_catalog as catalog, cli as wc


class Catalog(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        schema = json.loads((Path(__file__).parents[1] / 'src/wikicontext_client/schema.json').read_text())
        tables = schema['tables']
        for table in tables:
            fields = ','.join('"' + c['name'] + '" ' + c['type'] for c in table['columns'])
            self.db.execute('CREATE TABLE ' + table['name'] + ' (' + fields + ')')
        self.space = 'companyspace001'
        self.run, self.source, self.bundle, self.transcript, self.passage = [c * 15 for c in 'rsbtp']
        self.tp, self.sp = [c * 15 for c in 'uv']
        self.published = []
        self.counter = 0
        self.writes = []
        self.insert('ingestion_runs', id=self.run, space=self.space, status='staging')
        self.insert('sources', id=self.source, space=self.space, media_type='audio/ogg')
        self.insert('renditions', id=self.transcript, source=self.source, kind='transcript')
        self.insert('renditions', id=self.bundle, source=self.source, kind='transcript-bundle',
                    notes={'transcript_rendition': self.transcript})
        self.insert('passages', id=self.passage, rendition=self.transcript)
        for page, kind in ((self.tp, 'transcript'), (self.sp, 'summary')):
            self.insert('pages', id=page, space=self.space, kind=kind)
            self.insert('page_revisions', id=page, page=page, run=self.run, archived=False)
        self.receipt = dict(space=self.space, source=self.source, rendition=self.transcript,
                            bundle_rendition=self.bundle, segment_passages={'seg000001': [self.passage]})
        for target, replacement in ((catalog.k, 'rows'),):
            patcher = patch.object(target, replacement, side_effect=self.rows)
            patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(catalog.k, 'published', side_effect=lambda cfg: (None, copy.deepcopy(self.published)))
        patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(wc, 'must', side_effect=self.write)
        patcher.start(); self.addCleanup(patcher.stop)
        self.addCleanup(self.db.close)

    def insert(self, table, **data):
        self.db.execute('INSERT INTO ' + table + ' (' + ','.join(data) + ') VALUES (' +
                        ','.join('?' for _ in data) + ')',
                        [json.dumps(v) if isinstance(v, (dict, list)) else v for v in data.values()])

    def rows(self, cfg, query):
        return [dict(r) for r in self.db.execute(query)]

    def write(self, cfg, method, path, payload):
        self.assertEqual(method, 'POST')
        self.counter += 1
        self.writes.append((path, copy.deepcopy(payload)))
        record = dict(payload, id=f'{self.counter:015d}')
        self.insert(path.split('/')[3], **record)
        return record

    def stage(self, **kwargs):
        return catalog.stage({'space': self.space, 'space_checked': True}, self.run, self.receipt, self.tp, self.sp, **kwargs)

    def test_stage_retry_and_partial_write_recovery(self):
        original = self.write
        failed = False
        def uncertain(*args):
            nonlocal failed
            result = original(*args)
            if not failed:
                failed = True
                raise wc.Fail(1, 'connection lost after commit')
            return result
        with patch.object(wc, 'must', side_effect=uncertain):
            first = self.stage(language='Italian', duration_seconds=2)
        count = len(self.writes)
        self.assertEqual(first, self.stage(language='Italian', duration_seconds=2))
        self.assertEqual(len(self.writes), count)
        self.assertEqual(first['status'], 'staged')
        revision = self.rows({}, "SELECT * FROM page_revisions WHERE id='" + first['revision'] + "'")[0]
        properties = json.loads(revision['properties'])
        self.assertEqual(properties['selected_bundle_rendition_id'], self.bundle)
        self.assertEqual(properties['language'], 'Italian')
        self.assertNotIn('duration_seconds', json.loads(revision['property_evidence']))

    def test_changed_retry_fails_without_overwrite(self):
        self.stage(title='Reviewed title')
        count = len(self.writes)
        with self.assertRaises(wc.Fail): self.stage(title='Changed title')
        self.assertEqual(len(self.writes), count)

    def test_bad_receipt_ids_fail_before_writes(self):
        for key in ('source', 'rendition', 'bundle_rendition'):
            saved = self.receipt[key]
            self.receipt[key] = "' OR 1=1 --"
            with self.assertRaises(wc.Fail): self.stage()
            self.receipt[key] = saved
        self.assertEqual(self.writes, [])

    def test_other_space_receipt_is_rejected(self):
        self.receipt['space'] = 'z' * 15
        with self.assertRaises(wc.Fail): self.stage()
        self.assertEqual(self.writes, [])

    def test_other_space_run_is_rejected(self):
        self.db.execute("UPDATE ingestion_runs SET space='other'")
        with self.assertRaises(wc.Fail): self.stage()
        self.assertEqual(self.writes, [])

    def test_closed_run_is_rejected(self):
        self.db.execute("UPDATE ingestion_runs SET status='published'")
        with self.assertRaises(wc.Fail): self.stage()
        self.assertEqual(self.writes, [])

    def test_mismatched_bundle_transcript_is_rejected(self):
        self.db.execute("UPDATE renditions SET notes='{}' WHERE kind='transcript-bundle'")
        with self.assertRaises(wc.Fail): self.stage()
        self.assertEqual(self.writes, [])

    def test_foreign_passage_is_rejected(self):
        self.receipt['segment_passages'] = {'seg000001': ['z' * 15]}
        with self.assertRaises(wc.Fail): self.stage()
        self.assertEqual(self.writes, [])

    def test_reviewed_page_kind_and_space(self):
        self.db.execute("UPDATE pages SET kind='entity' WHERE kind='summary'")
        with self.assertRaises(wc.Fail): self.stage()
        self.assertEqual(self.writes, [])

    def test_existing_selection_preserves_history_and_custom_properties(self):
        page, revision = 'a' * 15, 'b' * 15
        self.insert('pages', id=page, space=self.space, kind='entity', slug='reviewed-audio')
        old = dict(id=revision, page=page, title='Reviewed title', summary='Reviewed summary',
                   body='Reviewed content.[^3]', archived=False,
                   properties={'catalog_type': 'audio_recording', 'audio_source_id': self.source,
                               'selected_bundle_rendition_id': 'o' * 15,
                               'custom_context': 'Keep', 'language': 'Italian'},
                   property_evidence={'custom_context': ['3']})
        self.published = [old]
        self.insert('citations', page_revision=revision, marker='3', passage=self.passage, note='Keep note')
        result = self.stage()
        self.assertEqual(result['page'], page)
        record = self.rows({}, "SELECT * FROM page_revisions WHERE id='" + result['revision'] + "'")[0]
        self.assertEqual(record['base_revision'], revision)
        self.assertEqual(record['body'], old['body'])
        self.assertEqual(json.loads(record['properties'])['custom_context'], 'Keep')
        self.assertEqual(old['properties']['selected_bundle_rendition_id'], 'o' * 15)
        self.assertEqual(self.rows({}, "SELECT note FROM citations WHERE marker='3' AND page_revision='" + result['revision'] + "'")[0]['note'], 'Keep note')
        count = len(self.writes)
        self.assertEqual(result, self.stage())
        self.assertEqual(len(self.writes), count)
        self.published[0]['id'] = 'c' * 15
        with self.assertRaises(wc.Fail): self.stage()
        self.assertEqual(len(self.writes), count)


if __name__ == '__main__':
    unittest.main()
