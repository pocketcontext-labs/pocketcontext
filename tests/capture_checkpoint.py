#!/usr/bin/env python3
"""Synthetic safety tests for production capture; never contacts Docker or host."""
import importlib.util
from contextlib import nullcontext
import json
import hashlib
import io
import os
from pathlib import Path
import sqlite3
import tempfile
import tarfile
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

    def image_archive(self, corrupt=False, extra=None):
        layer = b'synthetic uncompressed layer'
        layer_hash = 'sha256:' + hashlib.sha256(layer).hexdigest()
        config = {'os': 'linux', 'architecture': 'arm64', 'config': {'Labels': {'org.opencontainers.image.revision': self.cfg.revision}}, 'rootfs': {'diff_ids': [layer_hash]}}
        encoded = json.dumps(config).encode()
        self.cfg.image_config_digest = 'sha256:' + hashlib.sha256(encoded).hexdigest()
        self.cfg.image_archive = self.root / 'old-image.tar'
        members = {'manifest.json': json.dumps([{'Config': 'config.json', 'Layers': ['layer.tar']}]).encode(), 'config.json': encoded, 'layer.tar': layer + (b'changed' if corrupt else b'')}
        if extra: members[extra] = b'unsafe'
        with tarfile.open(self.cfg.image_archive, 'w') as archive:
            for name, data in members.items():
                info = tarfile.TarInfo(name); info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        self.cfg.image_archive.chmod(0o600)
        return {'RepoDigests': [self.cfg.image], 'Os': 'linux', 'Architecture': 'arm64', 'Config': config['config'], 'RootFS': {'Layers': [layer_hash]}}

    def test_prebuilt_archive_matches_config_and_runtime_layers(self):
        image = self.image_archive()
        capture.validate(self.cfg)
        with patch.object(capture, 'run', return_value=json.dumps([image]).encode()):
            result = capture.verify_image_archive(self.cfg, self.cfg.image_archive)
        self.assertEqual(result['image_config_digest'], self.cfg.image_config_digest)
        self.assertEqual(result['image_platform'], 'linux/arm64')
        self.assertEqual(result['sha256'], capture.digest(self.cfg.image_archive))

    def test_skopeo_layer_aliases_are_internal_regular_members_only(self):
        for target, accepted in [('../layer.tar', True), ('../../outside.tar', False), ('/layer.tar', False), ('../missing', False)]:
            with self.subTest(target=target):
                image = self.image_archive()
                with tarfile.open(self.cfg.image_archive, 'a') as archive:
                    alias = tarfile.TarInfo('legacy/layer.tar')
                    alias.type = tarfile.SYMTYPE; alias.linkname = target
                    archive.addfile(alias)
                with patch.object(capture, 'run', return_value=json.dumps([image]).encode()):
                    if accepted:
                        capture.verify_image_archive(self.cfg, self.cfg.image_archive)
                    else:
                        with self.assertRaisesRegex(capture.CaptureError, 'unsafe_image_alias'):
                            capture.verify_image_archive(self.cfg, self.cfg.image_archive)

    def test_archive_requires_explicit_verified_config_digest(self):
        self.image_archive()
        self.cfg.image_config_digest = None
        with self.assertRaisesRegex(capture.CaptureError, 'image_archive_requires_config_digest'):
            capture.validate(self.cfg)

    def test_corrupt_archive_rejected_before_freeze_or_fence(self):
        image = self.image_archive(corrupt=True)
        with patch.object(capture, 'locks', return_value=nullcontext()), \
             patch.object(capture.os, 'geteuid', return_value=0), \
             patch.object(capture, 'trusted', side_effect=lambda path, **kw: Path(path)), \
             patch.object(capture, 'inspect_source', return_value=(self.root, 'volume', 'sha256:synthetic')), \
             patch.object(capture, 'run', return_value=json.dumps([image]).encode()), \
             patch.object(capture, 'api') as api:
            with self.assertRaisesRegex(capture.CaptureError, 'image_layer_hash_mismatch'):
                capture.capture(self.cfg)
        api.assert_not_called()
        self.assertFalse(self.cfg.output.exists())

    def test_prebuilt_archive_rejects_wrong_config_runtime_or_unsafe_member(self):
        for mismatch in ('config', 'runtime', 'member'):
            with self.subTest(mismatch=mismatch):
                image = self.image_archive(extra='../unsafe' if mismatch == 'member' else None)
                if mismatch == 'config': self.cfg.image_config_digest = 'sha256:' + '0' * 64
                if mismatch == 'runtime': image['RootFS']['Layers'] = ['sha256:' + '0' * 64]
                with patch.object(capture, 'run', return_value=json.dumps([image]).encode()):
                    with self.assertRaises(capture.CaptureError):
                        capture.verify_image_archive(self.cfg, self.cfg.image_archive)

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
