#!/usr/bin/env python3
"""Synthetic exact-copy, historical selection and output safety checks."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from wikicontext_client import repository_files as rf, properties, cli


class RepositoryFiles(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(cli, 'space_id', return_value='space0000000001')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.destination = 'd' * 15
        self.document = 'a' * 15
        self.manifest = {self.destination: 'e' * 15, self.document: 'b' * 15}
        self.props = {'catalog_type': 'repository_document', 'document_type': 'copyright', 'output_mode': 'exact_copy', 'source_id': 's' * 15}
        self.target = {'catalog_type': 'repository_destination', 'documents': [self.document], 'github_repository': 'owner/repo', 'github_branch': 'main', 'github_path': 'COPYRIGHT'}

    def one(self, cfg, table, columns, record):
        if table == 'sources':
            return {'id': record, 'original': 'COPYRIGHT', 'sha256': '0' * 64}
        destination = record == self.manifest[self.destination]
        return {'id': record, 'page': self.destination if destination else self.document, 'archived': False,
                'body': self.body, 'properties': self.target if destination else self.props}

    def render(self, body='Approved copyright\r\n'):
        self.body = body
        with patch.object(rf.exp, 'query', return_value=[{'id': 'p' * 15, 'manifest': self.manifest}]) as query, patch.object(rf.exp, 'one', side_effect=self.one), patch.object(rf.exp, 'download', return_value=b'Copyright\r\n\xff'):
            result = rf.render({}, self.destination, 12)
            self.assertIn('sequence = 12', query.call_args.args[1])
            return result

    def test_exact_original_and_receipt(self):
        content, receipt = self.render()
        self.assertEqual(content, b'Copyright\r\n\xff')
        self.assertEqual(receipt['document_revision'], self.manifest[self.document])
        self.assertEqual(receipt['rendered_sha256'], rf.exp.digest(content))

    def test_portable_markdown_and_refusal(self):
        self.props['output_mode'] = 'markdown'
        self.assertEqual(self.render('# README\n')[0], b'# README\n')
        for body in ('[[Private]]', 'Claim[^1]', '[needs verification]', '> [!NOTE]', '>   [!NOTE]', '>[!NOTE]'):
            with self.assertRaises(cli.Fail):
                self.render(body)

    def test_properties_reject_unsafe_destinations(self):
        for key, values in {'github_path': ['../LICENSE', '/LICENSE', '.git/config', 'a//b', 'a\\b'], 'github_branch': ['../main', 'a.lock', '-main', 'a b']}.items():
            for value in values:
                with self.assertRaises(cli.Fail):
                    properties.read({'properties': dict(self.target, **{key: value})})

    def test_sync_shape_and_calendar_validation(self):
        p = {'catalog_type': 'repository_sync', 'destinations': [self.destination],
             'synced_document_revision': 'r' * 15, 'synced_destination_revision': 'v' * 15,
             'rendered_sha256': 'a' * 64, 'checked_at': '2026-10-10T12:00:00Z', 'sync_status': 'pending'}
        properties.read({'properties': p})
        for changes in ({'checked_at': '2026-02-30T12:00:00Z'}, {'sync_status': 'current'},
                        {'synced_destination_revision': None}):
            with self.assertRaises(cli.Fail):
                properties.read({'properties': dict(p, **changes)})

    def test_protected_hash_failure_creates_no_output(self):
        import io
        source = {'id': 's' * 15, 'original': 'LICENSE', 'sha256': '0' * 64}
        with patch.object(rf.exp.wc, 'must', return_value={'token': 'synthetic-token'}), patch.object(rf.exp.wc.opener, 'open', return_value=io.BytesIO(b'corrupt')):
            with self.assertRaises(cli.Fail):
                rf.exp.download({'url': 'https://wiki.invalid'}, source)

    def test_create_only_and_symlink_components(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'COPYRIGHT'
            rf.write_new(output, b'approved\r\n')
            with self.assertRaises(cli.Fail):
                rf.write_new(output, b'replacement')
            self.assertEqual(output.read_bytes(), b'approved\r\n')
            (root / 'link').symlink_to(root, target_is_directory=True)
            with self.assertRaises(cli.Fail):
                rf.write_new(root / 'link' / 'new', b'new')
            self.assertFalse((root / 'new').exists())
            with self.assertRaises(cli.Fail):
                rf.write_new(root / 'x' / '..' / 'new', b'new')


if __name__ == '__main__':
    unittest.main()
