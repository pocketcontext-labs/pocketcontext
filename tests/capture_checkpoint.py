#!/usr/bin/env python3
"""Synthetic safety tests for production capture; never contacts Docker or host."""
import importlib.util
from contextlib import nullcontext
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('capture', Path(__file__).resolve().parents[1] / 'tools/capture_checkpoint.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cfg = SimpleNamespace(container_id='a' * 64, image='ghcr.io/pocketcontext/wikicontext@sha256:' + 'b' * 64, revision='c' * 40, output=self.root / 'capture')

    def test_private_token_auth_does_not_require_password(self):
        token = self.root / 'operator.token'; token.write_text('header.payload.signature'); token.chmod(0o600)
        self.cfg.operator_token_file = token
        self.assertEqual(capture.login_payload(self.cfg), {'step': 'login', 'token': 'header.payload.signature'})
        token.chmod(0o644)
        with self.assertRaises(capture.CaptureError): capture.login_payload(self.cfg)

    def test_exact_identity_and_new_private_destination(self):
        capture.validate(self.cfg)
        self.cfg.container_id = 'a' * 12
        with self.assertRaises(capture.CaptureError): capture.validate(self.cfg)
        self.cfg.container_id = 'a' * 64
        self.cfg.output.mkdir()
        with self.assertRaises(capture.CaptureError): capture.validate(self.cfg)

    def test_refuses_symlink_and_hardlink(self):
        p = self.root / 'file'; p.write_text('private'); p.chmod(0o600)
        link = self.root / 'link'; link.symlink_to(p)
        with self.assertRaises(capture.CaptureError): capture.trusted(link)
        link.unlink(); os.link(p, link)
        with self.assertRaises(capture.CaptureError): capture.trusted(p)

    def test_save_refuses_overwrite_and_is_private(self):
        p = self.root / 'receipt.json'
        capture.save(p, {'safe': True})
        self.assertEqual(p.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError): capture.save(p, {'safe': False})
        self.assertEqual(json.loads(p.read_text()), {'safe': True})

    def test_copy_preserves_bytes_and_rejects_links(self):
        source = self.root / 'source'; source.mkdir(mode=0o700)
        (source / 'data.db-wal').write_bytes(b'wal')
        (source / 'maintenance.json').write_bytes(b'{"readOnly":true}')
        for entry in source.iterdir(): entry.chmod(0o600)
        target = self.root / 'copy'; capture.copy_tree(source, target)
        self.assertEqual((target / 'data.db-wal').read_bytes(), b'wal')
        self.assertEqual((target / 'data.db-wal').stat().st_mode & 0o777, 0o600)
        (source / 'link').symlink_to(source / 'data.db-wal')
        with self.assertRaises(capture.CaptureError): capture.copy_tree(source, self.root / 'bad')

    def test_sqlite_integrity_includes_wal(self):
        connections = []
        for name in ('data.db', 'auxiliary.db'):
            db = sqlite3.connect(self.root / name); connections.append(db)
            db.execute('PRAGMA journal_mode=WAL'); db.execute('CREATE TABLE sample(value)'); db.execute('INSERT INTO sample VALUES (42)'); db.commit()
        try:
            capture.check_databases(self.root)
        finally:
            for db in connections: db.close()

    def test_command_errors_never_expose_output(self):
        with patch.object(capture.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout=b'secret', stderr=b'secret')):
            with self.assertRaisesRegex(capture.CaptureError, '^command_failed$'):
                capture.run(['false'])

    def test_freeze_failure_stops_source_and_retains_fence_and_token(self):
        pending = self.root / 'pending'
        source = self.root / 'source'; source.mkdir()
        with patch.object(capture, 'validate'), patch.object(capture.os, 'geteuid', return_value=0), \
             patch.object(capture, 'locks', return_value=nullcontext()), \
             patch.object(capture, 'inspect_source', return_value=(source, 'volume', 'sha256:' + 'b' * 64)), \
             patch.object(capture, 'trusted', side_effect=lambda path, **kw: Path(path)), \
             patch.object(capture, 'PENDING', pending), \
             patch.object(capture, 'run', side_effect=[b'v0.3.3\n', b'']), \
             patch.object(capture, 'api', side_effect=[{'token': 'synthetic', 'generation': 4}, RuntimeError('freeze failed')]), \
             patch.object(capture, 'stop') as stop:
            with self.assertRaisesRegex(capture.CaptureError, 'capture_failed_source_stopped_fences_retained'):
                capture.capture(self.cfg)
        stop.assert_called_once_with(self.cfg.container_id)
        self.assertTrue(pending.exists())
        self.assertEqual(json.loads((self.cfg.output / 'recovery-control.json').read_text())['token'], 'synthetic')
        self.assertFalse((self.cfg.output / 'receipt.json').exists())

    def test_stop_requires_clean_exit_and_no_restart(self):
        row = {'State': {'Running': False, 'ExitCode': 137, 'OOMKilled': False}, 'HostConfig': {'RestartPolicy': {'Name': 'no'}}}
        with patch.object(capture, 'run', side_effect=[b'', b'', json.dumps([row]).encode()]):
            with self.assertRaisesRegex(capture.CaptureError, 'stop_unverified'):
                capture.stop('a' * 64)


if __name__ == '__main__':
    unittest.main()
