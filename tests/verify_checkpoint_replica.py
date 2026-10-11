#!/usr/bin/env python3
import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location('replica', TOOLS / 'verify_checkpoint_replica.py')
replica = importlib.util.module_from_spec(spec); spec.loader.exec_module(replica)


class ReplicaTests(unittest.TestCase):
    def test_full_comparison_rejects_stale_and_accepts_equivalent(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, restored = Path(tmp) / 'source.db', Path(tmp) / 'restored.db'
            for p in (source, restored):
                with closing(sqlite3.connect(p)) as db:
                    db.execute('CREATE TABLE records(value BLOB)')
                    db.execute('INSERT INTO records VALUES (?)', (b'one',)); db.commit()
            replica.verify_equivalent(source, restored)
            with closing(sqlite3.connect(source)) as db: db.execute('INSERT INTO records VALUES (?)', (b'two',)); db.commit()
            with self.assertRaises(RuntimeError): replica.verify_equivalent(source, restored)

    def test_refuses_running_source_before_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            replica.capture.save(root / 'receipt.json', {'status': 'captured_source_stopped_not_offhost_verified', 'container_id': 'a' * 64})
            row = {'Id': 'a' * 64, 'State': {'Running': True}}
            with patch.object(replica.capture, 'run', return_value=json.dumps([row]).encode()):
                with self.assertRaisesRegex(replica.capture.CaptureError, 'source_not_fenced'):
                    replica.source_state(SimpleNamespace(checkpoint=root))

    def test_comparator_includes_schema_and_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / 'a.db', Path(tmp) / 'b.db'
            for p in (a, b):
                with closing(sqlite3.connect(p)) as db: db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)')
            with closing(sqlite3.connect(b)) as db: db.execute('PRAGMA user_version=1')
            with self.assertRaises(RuntimeError): replica.verify_equivalent(a, b)


if __name__ == '__main__': unittest.main()
