#!/usr/bin/env python3
"""Real Litestream recovery with synthetic S3 originals and a deleted source volume.

Requires local MinIO, WIKICONTEXT_S3_* and LITESTREAM_* credentials, plus boto3.
Both bucket names must be explicitly confirmed as dedicated synthetic buckets.
The replica uses a fresh unique prefix; this test never reads an existing replica.
"""
import argparse
from contextlib import contextmanager
import hashlib
import sqlite3
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import tempfile
import time
import urllib.request

import boto3
from botocore.config import Config
import importlib.util
ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module



def object_client(prefix):
    endpoint = os.environ[prefix + 'ENDPOINT']
    if '://' not in endpoint:
        endpoint = 'https://' + endpoint
    return boto3.client('s3', endpoint_url=endpoint,
        region_name=os.environ.get(prefix + 'REGION', 'us-east-1'),
        aws_access_key_id=os.environ[prefix + 'ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ[prefix + 'SECRET_ACCESS_KEY'],
        config=Config(s3={'addressing_style': 'path'}))


def database_digest(path):
    """Compare logical database content without exposing rows or changing the DB.

    Use stopped databases or consistent SQLite snapshots. Physical pages, WAL
    layout and freelists may differ after Litestream restores equivalent data.
    Schema, all persisted table rows, user_version and application_id are covered.
    """
    digest = hashlib.sha256()
    with sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True) as conn:
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')
        if conn.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise RuntimeError('database integrity check failed')
        for pragma in ('user_version', 'application_id'):
            digest.update(json.dumps([pragma, conn.execute('PRAGMA ' + pragma).fetchone()[0]]).encode())
        schema = conn.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
        digest.update(json.dumps(schema, ensure_ascii=True).encode())
        for kind, name, _, _ in schema:
            if kind != 'table':
                continue
            quoted = '"' + name.replace('"', '""') + '"'
            rows = []
            try:
                records = conn.execute('SELECT rowid,* FROM ' + quoted)
            except sqlite3.OperationalError:
                records = conn.execute('SELECT * FROM ' + quoted)  # WITHOUT ROWID tables
            for row in records:
                typed = [('blob', value.hex()) if isinstance(value, bytes)
                         else (type(value).__name__, value) for value in row]
                rows.append(json.dumps(typed, ensure_ascii=True, separators=(',', ':')))
            digest.update(json.dumps(name).encode())
            for row in sorted(rows):
                digest.update(row.encode())
                digest.update(b'\n')
    return digest.digest()


def verify_equivalent(source, restored):
    if database_digest(source) != database_digest(restored):
        raise RuntimeError('recovered database differs from the stopped source; migration refused')


def check_unavailable_replica(litestream):
    """Pin the 0.5.17 clean-exit hazard and prove stale state fails the gate."""
    with tempfile.TemporaryDirectory(prefix='wikicontext-failed-sync-') as td:
        root = Path(td)
        source, stale = root / 'source.db', root / 'stale.db'
        with sqlite3.connect(source) as conn:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('CREATE TABLE synthetic_test(value TEXT, payload BLOB)')
            conn.commit()
            with sqlite3.connect(stale) as target:
                conn.backup(target)
            conn.execute('INSERT INTO synthetic_test VALUES (?, ?)', ('late commit', b'\x00\xff'))
            conn.commit()
            # A bound but non-listening socket guarantees an unavailable local endpoint.
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                endpoint = 'http://127.0.0.1:' + str(sock.getsockname()[1])
                config = root / 'litestream.yml'
                config.write_text(json.dumps({'dbs': [{'path': str(source), 'replica': {
                    'type': 's3', 'bucket': 'synthetic', 'path': 'data', 'region': 'us-east-1',
                    'endpoint': endpoint, 'sync-interval': '1h'}}]}))
                env = {**os.environ, 'LITESTREAM_ACCESS_KEY_ID': 'synthetic',
                       'LITESTREAM_SECRET_ACCESS_KEY': 'synthetic'}
                with (root / 'replicate.log').open('w') as log:
                    proc = subprocess.Popen([litestream, 'replicate', '-config', str(config)],
                                            stdout=log, stderr=log, env=env)
                    try:
                        time.sleep(2)
                        proc.terminate()
                        proc.wait(timeout=30)
                    finally:
                        if proc.poll() is None:
                            proc.kill()
                            proc.wait()
                assert proc.returncode == 0, 'pinned Litestream clean-exit behavior changed; review the regression'
        # Both databases are now stopped; a clean process exit must not authorize migration.
        verify_equivalent(source, source)
        try:
            verify_equivalent(source, stale)
        except RuntimeError:
            pass
        else:
            raise AssertionError('stale recovered database passed the migration gate')
        print('PASS: unavailable replica can exit zero; full database comparison refuses stale recovery')


@contextmanager
def fixture_server(binary, data, log_path):
    data.mkdir()
    common = [binary, '--dir', str(data), '--hooksDir', str(ROOT / 'pb_hooks'),
              '--migrationsDir', str(ROOT / 'pb_migrations')]
    result = subprocess.run(common + ['superuser', 'upsert', 'admin@example.com', 'SyntheticAdminPassword123!'],
                            cwd=ROOT, capture_output=True)
    assert result.returncode == 0, 'synthetic provisioning failed (output suppressed)'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    with log_path.open('w+') as log:
        proc = subprocess.Popen(common + ['serve', '--http', f'127.0.0.1:{port}'], cwd=ROOT, stdout=log, stderr=log)
        try:
            for _ in range(150):
                try:
                    urllib.request.urlopen(base + '/up', timeout=1).close()
                    break
                except OSError:
                    if proc.poll() is not None:
                        raise AssertionError('source startup failed')
                    time.sleep(.1)
            else:
                raise AssertionError('source startup timed out')
            yield base
        finally:
            proc.terminate()
            proc.wait(timeout=15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary')
    parser.add_argument('--verify-source', type=Path)
    parser.add_argument('--verify-restored', type=Path)
    parser.add_argument('--litestream')
    parser.add_argument('--synthetic-files-bucket')
    parser.add_argument('--synthetic-replica-bucket')
    args = parser.parse_args()
    if args.verify_source or args.verify_restored:
        if not (args.verify_source and args.verify_restored):
            parser.error('both verification paths are required')
        verify_equivalent(args.verify_source, args.verify_restored)
        print('PASS: logical schema and all table contents match')
        return
    if not all((args.binary, args.litestream, args.synthetic_files_bucket, args.synthetic_replica_bucket)):
        parser.error('recovery drill requires binary, litestream and both synthetic buckets')
    assert args.synthetic_files_bucket == os.environ['WIKICONTEXT_S3_BUCKET']
    assert args.synthetic_replica_bucket == os.environ['LITESTREAM_BUCKET']
    binary = str(Path(args.binary).resolve())
    litestream = str(Path(args.litestream).resolve())
    check_unavailable_replica(litestream)
    verifier = load('remote_entrypoint', ROOT / 'docker/entrypoint.py')
    smoke = load('remote_smoke', ROOT / 'docker/smoke.py')
    files, replicas = object_client('WIKICONTEXT_S3_'), object_client('LITESTREAM_')
    uploaded_keys = []
    with tempfile.TemporaryDirectory(prefix='wikicontext-litestream-') as td:
        tmp = Path(td)
        prefix = tmp.name + '/data'
        try:
            source_data = tmp / 'source'
            with fixture_server(binary, source_data, tmp / 'source.log') as source_base:
                admin = smoke.superuser_token(source_base, 'admin@example.com', 'SyntheticAdminPassword123!')
                password = 'SyntheticRecoveryPassword123!'
                user = smoke.provision_user(source_base, admin, 'recovery@example.test', password)
                client = smoke.Client(source_base, 'recovery@example.test', password, None)
                config = tmp / 'litestream.yml'
                # JSON is valid YAML and prevents endpoint/path interpolation into YAML syntax.
                config.write_text(json.dumps({'dbs': [{'path': str(source_data / 'data.db'),
                    'replica': {'type': 's3', 'bucket': args.synthetic_replica_bucket, 'path': prefix,
                        'region': os.environ.get('LITESTREAM_REGION', 'us-east-1'),
                        'endpoint': os.environ['LITESTREAM_ENDPOINT'], 'sync-interval': '1h'}}]}))
                with (tmp / 'replicate.log').open('w+') as log:
                    proc = subprocess.Popen([litestream, 'replicate', '-config', str(config)], stdout=log, stderr=log)
                    try:
                        # Give replication its initial snapshot before the late API writes.
                        deadline = time.monotonic() + 30
                        while time.monotonic() < deadline:
                            objects = replicas.list_objects_v2(Bucket=args.synthetic_replica_bucket, Prefix=prefix)
                            if objects.get('Contents'):
                                break
                            if proc.poll() is not None:
                                raise AssertionError('Litestream exited before initial replication')
                            time.sleep(.2)
                        else:
                            raise AssertionError('initial replication did not complete')
                        doc, meta = smoke.write_record(client, user)
                        uploaded_keys.append('/'.join((meta[0], doc, meta[1])))
                        smoke.check_records(client, doc, meta)
                        assert not list((source_data / 'storage').rglob('*'))
                        verifier.verify(source_data)
                    finally:
                        proc.terminate()
                        proc.wait(timeout=30)
                    assert proc.returncode == 0, 'Litestream did not shut down successfully'
                restored = tmp / 'restored'
                restored.mkdir()
                result = subprocess.run([litestream, 'restore', '-config', str(config),
                    '-o', str(restored / 'data.db'), str(source_data / 'data.db')], capture_output=True, text=True)
                assert result.returncode == 0, 'Litestream restore failed (output suppressed)'

            # The source has stopped: compare every logical record before starting a restored writer.
            verify_equivalent(source_data / 'data.db', restored / 'data.db')
            shutil.rmtree(source_data)
            assert not source_data.exists()
            assert not (restored / 'storage').exists()
            verifier.verify(restored)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            with (tmp / 'restored.log').open('w+') as log:
                proc = subprocess.Popen([binary, 'serve', '--dir', str(restored), '--http', f'127.0.0.1:{port}',
                    '--hooksDir', str(ROOT / 'pb_hooks'), '--migrationsDir', str(ROOT / 'pb_migrations')],
                    cwd=ROOT, stdout=log, stderr=log)
                try:
                    for _ in range(150):
                        try:
                            urllib.request.urlopen(base + '/up', timeout=1).close()
                            break
                        except OSError:
                            if proc.poll() is not None:
                                raise AssertionError('restored server failed to start')
                            time.sleep(.1)
                    else:
                        raise AssertionError('restored server startup timed out')
                    restored_client = smoke.Client(base, 'recovery@example.test', password, None)
                    smoke.check_records(restored_client, doc, meta)
                finally:
                    proc.terminate()
                    proc.wait(timeout=15)
            print('PASS: final Litestream sync retains late API writes; fresh-volume SQLite recovery, '
                  'S3 originals, protected downloads and FTS; no complete archive')
        finally:
            for key in uploaded_keys:
                files.delete_object(Bucket=args.synthetic_files_bucket, Key=key)
            for page in replicas.get_paginator('list_objects_v2').paginate(Bucket=args.synthetic_replica_bucket, Prefix=prefix):
                for item in page.get('Contents', []):
                    replicas.delete_object(Bucket=args.synthetic_replica_bucket, Key=item['Key'])


if __name__ == '__main__':
    main()
