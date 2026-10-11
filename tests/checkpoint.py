#!/usr/bin/env python3
"""Synthetic checkpoint tests: real age encryption, in-memory object store."""
import importlib.util
import io
import tarfile
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('checkpoint', Path(__file__).resolve().parents[1] / 'tools/checkpoint.py')
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)

class Store:
    def __init__(self): self.data = {'originals': {'sources/record/original.txt': b'synthetic evidence', 'users/user/avatar.png': b'synthetic avatar', 'unreferenced/object': b'retain too'}, 'backup': {}}
    def get_paginator(self, name): return self
    def paginate(self, Bucket):
        yield {'Contents': [{'Key': k, 'Size': len(v), 'ETag': cp.hashlib.sha256(v).hexdigest(), 'LastModified': 'stable'} for k, v in self.data[Bucket].items()]}
    def get_object(self, Bucket, Key, IfMatch=None):
        data = self.data[Bucket][Key]
        if IfMatch and cp.hashlib.sha256(data).hexdigest() != IfMatch: raise RuntimeError('changed')
        return {'Body': io.BytesIO(data)}
    def put_object(self, Bucket, Key, Body, ContentLength, IfNoneMatch):
        if Key in self.data[Bucket]: raise RuntimeError('duplicate')
        assert IfNoneMatch == '*'
        self.data[Bucket][Key] = Body.read()

@unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'age tools required')
class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir(mode=0o700)
        self.store = Store()
        with closing(sqlite3.connect(self.source / 'data.db')) as db:
            db.executescript('CREATE TABLE _collections(id TEXT,name TEXT,type TEXT,fields TEXT); CREATE TABLE sources(id TEXT,original TEXT,sha256 TEXT); CREATE TABLE users(id TEXT,avatar TEXT);')
            db.execute('INSERT INTO _collections VALUES(?,?,?,?)', ('sources', 'sources', 'base', json.dumps([{'name':'original','type':'file'}])))
            db.execute('INSERT INTO _collections VALUES(?,?,?,?)', ('users', 'users', 'auth', json.dumps([{'name':'avatar','type':'file'}])))
            db.execute('INSERT INTO sources VALUES(?,?,?)', ('record', 'original.txt', cp.hashlib.sha256(b'synthetic evidence').hexdigest()))
            db.execute('INSERT INTO users VALUES(?,?)', ('user', 'avatar.png'))
            db.commit()
        with closing(sqlite3.connect(self.source / 'auxiliary.db')) as db: db.execute('CREATE TABLE metadata(value TEXT)')
        (self.source / 'maintenance.json').write_text('{"readOnly":true}')
        self.once = self.root / 'once.tar.gz'; 
        with tarfile.open(self.once, 'w:gz') as tar:
            value = b'{}'; item = tarfile.TarInfo('once.application.json'); item.size = len(value); tar.addfile(item, io.BytesIO(value))
            for file in self.source.iterdir(): tar.add(file, arcname='data/pb_data/' + file.name)
        self.image = self.root / 'image.tar'; 
        with tarfile.open(self.image, 'w') as tar:
            for name, value in {'manifest.json': json.dumps([{'Config':'config.json','Layers':['layer.tar']}]).encode(), 'config.json':b'{}', 'layer.tar':b'fixture'}.items():
                item = tarfile.TarInfo(name); item.size = len(value); tar.addfile(item, io.BytesIO(value))
        self.identity = self.root / 'identity'
        subprocess.run(['age-keygen', '-o', str(self.identity)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.recipient = subprocess.check_output(['age-keygen', '-y', str(self.identity)], text=True).strip()
        self.once.chmod(0o600); self.image.chmod(0o600)
        self.image_id = 'sha256:' + cp.hashlib.sha256(b'{}').hexdigest()
        self.output = self.root / 'output'
    def tearDown(self): self.temp.cleanup()
    def capture(self): return cp.capture(self.source, self.once, self.image, 'ghcr.io/example/wiki@sha256:' + 'a'*64, self.output, self.recipient, self.store, 'originals', image_id=self.image_id)
    def ready(self):
        receipt = self.capture(); key = cp.upload(self.output, self.store, 'backup'); return receipt, key
    def test_round_trip_all_objects_and_recovery_files(self):
        self.ready()
        dest = self.root / 'recovery'
        result = cp.verify(self.output / 'receipt.json', dest, self.identity, self.store, 'backup')
        self.assertTrue(result['remote_verified'])
        manifest = json.loads((dest / 'manifest.json').read_text())
        self.assertEqual(set(manifest['objects']), set(self.store.data['originals']))
        self.assertEqual(cp.files(dest / 'pb_data'), cp.files(self.source))
        self.assertEqual((dest / 'once.tar.gz').read_bytes(), self.once.read_bytes())
        self.assertFalse(any(self.output.glob('.checkpoint-*')))
    def test_duplicate_upload_refused(self):
        self.ready()
        with self.assertRaises(RuntimeError): cp.upload(self.output, self.store, 'backup')
    def test_remote_corruption_refused_without_destination(self):
        _, key = self.ready(); self.store.data['backup'][key] += b'corrupt'
        with self.assertRaises(cp.CheckpointError): cp.verify(self.output / 'receipt.json', self.root / 'recovery', self.identity, self.store, 'backup')
        self.assertFalse((self.root / 'recovery').exists())
    def test_missing_mutable_file_refused(self):
        del self.store.data['originals']['users/user/avatar.png']
        with self.assertRaises(cp.CheckpointError): self.capture()
        self.assertFalse(self.output.exists())
    def test_wrong_original_hash_refused(self):
        self.store.data['originals']['sources/record/original.txt'] = b'changed'
        with self.assertRaises(cp.CheckpointError): self.capture()
    def test_symlink_refused(self):
        (self.source / 'link').symlink_to(self.once)
        with self.assertRaises(cp.CheckpointError): self.capture()
    def test_wal_refused(self):
        (self.source / 'data.db-wal').write_bytes(b'pending')
        with self.assertRaises(cp.CheckpointError): self.capture()
    def test_not_frozen_refused(self):
        (self.source / 'maintenance.json').write_text('{"readOnly":false}')
        with self.assertRaises(cp.CheckpointError): self.capture()
    def test_wrong_key_refused(self):
        self.ready(); other = self.root / 'other'
        subprocess.run(['age-keygen', '-o', str(other)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with self.assertRaises((cp.CheckpointError, cp.tarfile.ReadError)): cp.verify(self.output / 'receipt.json', self.root / 'recovery', other, self.store, 'backup')
        self.assertFalse((self.root / 'recovery').exists())
    def test_committed_wal_preserved_and_verified(self):
        db = sqlite3.connect(self.source / 'data.db')
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('INSERT INTO users VALUES(?,?)', ('wal-user', ''))
        db.commit()
        self.assertGreater((self.source / 'data.db-wal').stat().st_size, 0)
        # Keep connection open solely to prevent close-time checkpointing in this
        # synthetic fixture; no writes happen during capture.
        with tarfile.open(self.once, 'w:gz') as tar:
            item = tarfile.TarInfo('once.application.json'); item.size = 2; tar.addfile(item, io.BytesIO(b'{}'))
            for file in self.source.iterdir(): tar.add(file, arcname='data/pb_data/' + file.name)
        before = cp.files(self.source)
        try:
            self.ready()
            dest = self.root / 'wal-recovery'
            cp.verify(self.output / 'receipt.json', dest, self.identity, self.store, 'backup')
            self.assertEqual(before, cp.files(self.source))
            self.assertEqual(before, cp.files(dest / 'pb_data'))
            with closing(sqlite3.connect(dest / 'pb_data/data.db')) as restored:
                self.assertEqual(restored.execute("SELECT count(*) FROM users WHERE id='wal-user'").fetchone()[0], 1)
        finally:
            db.close()
    def test_image_id_mismatch_refused(self):
        self.image_id = 'sha256:' + 'f' * 64
        with self.assertRaises(cp.CheckpointError): self.capture()
    def test_ancestor_symlink_refused(self):
        link = self.root / 'linked'; link.symlink_to(self.root, target_is_directory=True)
        self.output = link / 'unsafe-output'
        with self.assertRaises(cp.CheckpointError): self.capture()
    def test_public_source_refused(self):
        self.source.chmod(0o755)
        with self.assertRaises(cp.CheckpointError): self.capture()
    def test_custom_prefix(self):
        from unittest.mock import patch
        with patch.dict(os.environ, {'WIKICONTEXT_BACKUP_PREFIX':'once-v2/wikicontext-production/checkpoints'}):
            _, key = self.ready()
            self.assertTrue(key.startswith('once-v2/wikicontext-production/checkpoints/'))
            result = cp.verify(self.output / 'receipt.json', self.root / 'restored', self.identity, self.store, 'backup')
            self.assertTrue(result['remote_verified'])
    def test_path_rejections(self):
        for name in ('../escape', '/absolute', 'a/../b', 'a\\b', './a'):
            with self.assertRaises(cp.CheckpointError): cp.safe_name(name)

if __name__ == '__main__': unittest.main()
