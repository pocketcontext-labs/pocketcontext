#!/usr/bin/env python3
from contextlib import closing
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
TOOLS = Path(__file__).resolve().parents[1] / 'tools'; sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location('mint', TOOLS / 'mint_maintenance_token.py')
mint = importlib.util.module_from_spec(spec); spec.loader.exec_module(mint)


class MintTests(unittest.TestCase):
    def test_live_wal_snapshot_keeps_committed_record_without_changing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / 'live.db'; target = root / 'snapshot.db'
            with closing(sqlite3.connect(source)) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE sample(value)'); db.execute('INSERT INTO sample VALUES (42)'); db.commit()
                source.chmod(0o600)
                before = {p.name: p.read_bytes() for p in root.iterdir() if p.name != 'live.db-shm'}
                mint.snapshot(source, target)
                with closing(sqlite3.connect(target)) as restored:
                    self.assertEqual(restored.execute('SELECT value FROM sample').fetchall(), [(42,)])
                after = {p.name: p.read_bytes() for p in root.iterdir() if p.name not in ('live.db-shm', 'snapshot.db')}
                self.assertEqual(before, after)

    def test_worker_requires_new_network_namespace_before_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'request.json'
            mint.capture.save(path, {'source_netns': mint.os.readlink('/proc/self/ns/net')})
            with patch.object(mint.os, 'geteuid', return_value=0), patch.object(mint.capture, 'trusted', return_value=path), patch.object(mint.subprocess, 'run') as run:
                with self.assertRaisesRegex(mint.capture.CaptureError, 'network_isolation_required'):
                    mint.worker(path)
                run.assert_not_called()

    def test_snapshot_refuses_existing_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'db'; p.touch(mode=0o600)
            with self.assertRaises(FileExistsError): mint.snapshot(p, p)


if __name__ == '__main__': unittest.main()
