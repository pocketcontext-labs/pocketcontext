#!/usr/bin/env python3
"""Synthetic exporter tests; no network or production files."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

from wikicontext_client import exporter as exp
from wikicontext_client import cli as wc


class ExportTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(wc, 'space_id', return_value='companyspace001')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'vault'
        self.metadata = {'version': 1, 'server': 'https://wiki.invalid', 'space': wc.COMPANY_SPACE, 'publication': 'p' * 15, 'sequence': 1}
        self.files = {'wiki/a.md': b'alpha', 'raw/source.txt': b'original'}

    def publish(self, files=None):
        return exp.publish(self.root, files or self.files, self.metadata)

    def test_legacy_export_adopts_company_once(self):
        self.publish()
        manifest = self.root / exp.MANIFEST
        legacy = json.loads(manifest.read_text())
        del legacy['space']
        manifest.write_text(json.dumps(legacy))
        with self.assertRaisesRegex(wc.Fail, 'Legacy export'):
            exp.publish(self.root, self.files, dict(self.metadata, space='personal0000001'))
        self.assertEqual(json.loads(manifest.read_text()), legacy)
        self.publish()
        self.assertEqual(json.loads(manifest.read_text())['space'], wc.COMPANY_SPACE)
        with self.assertRaisesRegex(wc.Fail, 'different WikiContext space'):
            exp.publish(self.root, self.files, dict(self.metadata, space='personal0000001'))
        self.assertEqual((self.root / 'wiki/a.md').read_bytes(), b'alpha')

    def test_repeatable_preserves_unrelated_and_cleans_owned(self):
        self.publish()
        first = (self.root / exp.MANIFEST).read_bytes()
        (self.root / '.obsidian').mkdir()
        (self.root / '.obsidian/app.json').write_text('{}')
        (self.root / 'wiki/personal.md').write_text('local')
        self.publish()
        self.assertEqual(first, (self.root / exp.MANIFEST).read_bytes())
        self.publish({'wiki/b.md': b'beta'})
        self.assertFalse((self.root / 'wiki/a.md').exists())
        self.assertFalse((self.root / 'raw/source.txt').exists())
        self.assertEqual((self.root / 'wiki/personal.md').read_text(), 'local')
        self.assertTrue((self.root / '.obsidian/app.json').exists())

    def test_edits_and_deletions_conflict_before_writes(self):
        self.publish()
        page = self.root / 'wiki/a.md'
        page.write_text('edited')
        with self.assertRaises(wc.Fail):
            self.publish({'wiki/b.md': b'new'})
        self.assertFalse((self.root / 'wiki/b.md').exists())
        self.assertEqual(page.read_text(), 'edited')
        page.unlink()
        with self.assertRaises(wc.Fail):
            self.publish()

    def test_unrelated_collision_and_symlink_refused(self):
        self.root.mkdir()
        (self.root / 'wiki').symlink_to(Path(self.temp.name))
        with self.assertRaises(wc.Fail):
            self.publish()
        (self.root / 'wiki').unlink()
        (self.root / 'wiki').mkdir()
        (self.root / 'wiki/a.md').write_text('my own')
        with self.assertRaises(wc.Fail):
            self.publish()
        with self.assertRaises(wc.Fail):
            exp.publish(self.root, {'../outside': b'oops'}, self.metadata)

    def test_failed_commit_rolls_back_existing_files(self):
        self.publish()
        original = exp.atomic_write
        calls = []
        def fail_once(path, content):
            calls.append(path.name)
            if path.name == 'b.md' and calls.count('b.md') == 1:
                raise OSError('simulated write failure')
            return original(path, content)
        with patch.object(exp, 'atomic_write', side_effect=fail_once):
            with self.assertRaises(OSError):
                self.publish({'wiki/a.md': b'changed', 'wiki/b.md': b'new'})
        self.assertEqual((self.root / 'wiki/a.md').read_bytes(), b'alpha')
        self.assertEqual((self.root / 'raw/source.txt').read_bytes(), b'original')
        self.assertFalse((self.root / exp.JOURNAL).exists())

    def test_pinned_render_and_originals(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        schemas = {
            'publications': "id,run,sequence INTEGER,manifest,created,space DEFAULT 'companyspace001'",
            'pages': 'id,slug,kind',
            'page_revisions': 'id,page,run,title,summary,body,archived INTEGER,created,properties,property_evidence',
            'citations': 'id,page_revision,passage,marker,note',
            'page_links': 'id,page_revision,target',
            'passages': 'id,rendition,locator',
            'renditions': 'id,source',
            'sources': 'id,title,original_name,original,sha256',
            'ingestion_runs': 'id,description,sources',
        }
        for name, schema in schemas.items():
            db.execute(f'CREATE TABLE {name} ({schema})')
        def put(table, values):
            columns = [column.split()[0] for column in schemas[table].split(',')][:len(values)]
            db.execute(f'INSERT INTO {table} ({",".join(columns)}) VALUES ({",".join("?" for _ in values)})', values)
        pid, rid, run, sid = 'a'*15, 'b'*15, 'c'*15, 'd'*15
        put('publications', ('p'*15, run, 1, json.dumps({pid: rid, 'h'*15: 'i'*15, 'j'*15: 'k'*15}), '2026-01-01'))
        put('publications', ('q'*15, 'z'*15, 2, '{}', '2026-01-02'))
        put('pages', (pid, 'example', 'concept'))
        put('page_revisions', (rid, pid, run, 'Example', 'Summary', 'Evidence [^1].', 0, '2026-01-01', json.dumps({'catalog_type': 'resource', 'resources': [pid], 'accountable_owners': ['h'*15], 'backup_owners': ['h'*15], 'accountable_owner': None, 'exact_name': 'yes\n---\ntitle: forged', 'enabled': True}), json.dumps({'exact_name': ['1']})))
        put('pages', ('h'*15, 'core', 'entity'))
        put('pages', ('j'*15, 'person', 'entity'))
        put('page_revisions', ('i'*15, 'h'*15, run, 'Core', 'Group', '[needs verification]', 0, '2026-01-01', json.dumps({'catalog_type': 'group', 'members': ['j'*15]}), '{}'))
        put('page_revisions', ('k'*15, 'j'*15, run, 'Person', 'Person', '[needs verification]', 0, '2026-01-01', json.dumps({'catalog_type': 'person'}), '{}'))
        put('citations', ('e'*15, rid, 'f'*15, '1', 'supports example'))
        put('passages', ('f'*15, 'g'*15, 'page 1'))
        put('renditions', ('g'*15, sid))
        put('sources', (sid, 'Original', '[bad](url).txt', 'file.txt', exp.digest(b'source')))
        put('ingestion_runs', (run, 'First publication', json.dumps([sid])))
        calls = []
        def sql(cfg, method, path, body):
            self.assertEqual((method, path), ('POST', '/api/context/query'))
            calls.append(body['sql'])
            cursor = db.execute(body['sql'])
            return {'columns': [c[0] for c in cursor.description], 'rows': cursor.fetchall(), 'truncated': False}
        with patch.object(wc, 'must', side_effect=sql), patch.object(exp, 'download', return_value=b'source') as download:
            files, metadata = exp.render({'url': 'https://wiki.invalid'}, 1)
            again, again_meta = exp.render({'url': 'https://wiki.invalid'}, 1)
        self.assertEqual((files, metadata), (again, again_meta))
        self.assertEqual(metadata['sequence'], 1)
        self.assertIn('wiki/example.md', files)
        self.assertIn(f'raw/original-{sid}.txt', files)
        self.assertIn(b'\\[bad\\]\\(url\\).txt', files['wiki/example.md'])
        self.assertNotIn(b'2026-01-02', files['wiki/log.md'])
        self.assertEqual(download.call_count, 2)
        markdown = files['wiki/example.md'].decode()
        header = markdown.split('---\n', 2)[1]
        frontmatter = {key: json.loads(value) for key, value in (line.split(': ', 1) for line in header.splitlines())}
        self.assertEqual(frontmatter['resources'], ['[[example]]'])
        self.assertEqual(frontmatter['accountable_owners'], ['[[core]]'])
        self.assertEqual(frontmatter['backup_owners'], ['[[core]]'])
        self.assertIn(b'members: ["[[person]]"]', files['wiki/core.md'])
        self.assertIsNone(frontmatter['accountable_owner'])
        self.assertIs(frontmatter['enabled'], True)
        self.assertEqual(frontmatter['exact_name'], 'yes\n---\ntitle: forged')
        self.assertIn('## Property evidence\n\n- exact\\_name: [^1]', markdown)
        self.assertNotIn('property_evidence', header)

    def test_audio_catalog_properties(self):
        from wikicontext_client import properties
        good = {'catalog_type': 'audio_recording', 'audio_source_id': 'a' * 15,
                'recorded_at': '2026-10-13', 'language': 'en', 'duration_seconds': 1.5,
                'transcript_pages': ['b' * 15], 'summary_pages': ['c' * 15]}
        self.assertEqual(properties.read({'properties': good})[0], good)
        for extra in ({'audio_source_id': 'bad'}, {'recorded_at': '2026-02-30'},
                      {'duration_seconds': 0}, {'duration_seconds': True}, {'language': []},
                      {'selected_bundle_rendition_id': ''}, {'transcript_pages': ['bad']}):
            with self.subTest(extra=extra), self.assertRaises(wc.Fail):
                properties.read({'properties': {**good, **extra}})

    def test_invalid_properties_rejected(self):
        from wikicontext_client import properties
        for value in [{'title': 'override'}, {'nested': {'x': 1}}, {'resources': ['missing']},
                      {'catalog_type': 'invented'}, {'catalog_type': 'person', 'members': []}, {'members': []}, {'number': float('nan')}, {'tags': ['a', 'a']}]:
            with self.subTest(value=value), self.assertRaises(wc.Fail):
                properties.read({'properties': value})
        with self.assertRaises(wc.Fail):
            properties.read({'properties': {'provider': 'cloud'}, 'property_evidence': {'absent': ['1']}})
        self.assertEqual(properties.read({'properties': 'null', 'property_evidence': None}), ({}, {}))

    def test_frontmatter_unicode_and_scalar_types_round_trip(self):
        text = 'Storage 🪣 日本語\u0085---\u2028title: forged\u2029\u007f\u0080\ufeff\nnext'
        for value in (text, [text], None, True, False, 42, 3.5, '2026-10-08', 'yes'):
            encoded = exp.yaml_value(value)
            self.assertEqual(json.loads(encoded), value)
            self.assertEqual(len(encoded.splitlines()), 1)
            self.assertFalse(any(0x7f <= ord(char) <= 0x9f or ord(char) in (0x2028, 0x2029, 0xfeff) for char in encoded))
        self.assertIn('🪣', exp.yaml_value(text))
        self.assertNotIn('\\ud83e', exp.yaml_value(text))

    def test_interrupted_export_recovery_preserves_later_edits(self):
        import base64
        self.publish()
        page = self.root / 'wiki/a.md'
        journal = {'before': {'wiki/a.md': base64.b64encode(b'alpha').decode()},
                   'after': {'wiki/a.md': exp.digest(b'partial')}}
        (self.root / exp.JOURNAL).write_bytes(exp.packed(journal))
        page.write_bytes(b'partial')
        self.publish()
        self.assertEqual(page.read_bytes(), b'alpha')
        (self.root / exp.JOURNAL).write_bytes(exp.packed(journal))
        page.write_bytes(b'user edit after crash')
        with self.assertRaises(wc.Fail):
            self.publish()
        self.assertEqual(page.read_bytes(), b'user edit after crash')
        self.assertTrue((self.root / exp.JOURNAL).exists())

    def test_download_hash_verification(self):
        import io
        source = {'id': 'a'*15, 'original': 'original.txt', 'sha256': exp.digest(b'expected')}
        with patch.object(wc, 'must', return_value={'token': 'secret'}), patch.object(wc.opener, 'open', return_value=io.BytesIO(b'wrong')):
            with self.assertRaises(wc.Fail):
                exp.download({'url': 'https://wiki.invalid'}, source)

    def test_tampered_ownership_cannot_remove_obsidian_or_personal_files(self):
        import base64
        self.publish()
        for forbidden in ('.obsidian/settings.json', 'personal.txt', '../outside'):
            manifest = dict(self.metadata, files={forbidden: exp.digest(b'private')})
            (self.root / exp.MANIFEST).write_bytes(exp.packed(manifest))
            with self.assertRaises(wc.Fail):
                self.publish()
            journal = {'before': {forbidden: base64.b64encode(b'private').decode()},
                       'after': {forbidden: None}}
            (self.root / exp.JOURNAL).write_bytes(exp.packed(journal))
            with self.assertRaises(wc.Fail):
                self.publish()
            (self.root / exp.JOURNAL).unlink()

    def test_pagination_retries_smaller_batches_without_skipping(self):
        queries = []
        def response(cfg, method, path, body):
            sql = body['sql']
            queries.append(sql)
            if sql.endswith('LIMIT 100'):
                return {'truncated': True}
            if "id > ''" in sql:
                return {'truncated': False, 'columns': ['id'], 'rows': [['a'*15], ['b'*15]]}
            return {'truncated': False, 'columns': ['id'], 'rows': []}
        with patch.object(wc, 'must', side_effect=response):
            rows = exp.rows({}, 'citations', 'id')
        self.assertEqual([r['id'] for r in rows], ['a'*15, 'b'*15])
        self.assertTrue(queries[1].endswith('LIMIT 50'))
        self.assertIn("id > '" + 'b'*15 + "'", queries[-1])

    def test_truncated_results_fail_closed(self):
        with patch.object(wc, 'must', return_value={'truncated': True}):
            with self.assertRaises(wc.Fail):
                exp.render({'url': 'https://wiki.invalid'})
        self.assertFalse(self.root.exists())


if __name__ == '__main__':
    unittest.main()
