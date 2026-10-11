#!/usr/bin/env python3
"""Restore-only production replica verification after capture. Never starts a publisher.

Run beside capture_checkpoint.py on the source host. Default is validation-only.
No database content or credentials are emitted. Original source remains stopped.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import capture_checkpoint as capture

# Same complete logical comparator as tests/object_storage_recovery.py.
def database_digest(path):
    """Compare logical database content without exposing rows or changing the DB.

    Use stopped databases or consistent SQLite snapshots. Physical pages, WAL
    layout and freelists may differ after Litestream restores equivalent data.
    Schema, all persisted table rows, user_version and application_id are covered.
    """
    digest = hashlib.sha256()
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as conn:
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



def source_state(cfg):
    receipt = json.loads(capture.trusted(cfg.checkpoint / 'receipt.json', private=True).read_text())
    capture.require(receipt.get('status') == 'captured_source_stopped_not_offhost_verified', 'checkpoint_not_captured')
    row, = json.loads(capture.run(['docker', 'inspect', receipt['container_id']]))
    capture.require(row['Id'] == receipt['container_id'] and not row['State']['Running'] and row['HostConfig']['RestartPolicy']['Name'] == 'no', 'source_not_fenced')
    capture.require(row['Image'] == receipt['image_id'], 'source_image_mismatch')
    fence = json.loads(capture.trusted(capture.PENDING, private=True).read_text())
    capture.require(fence.get('container_id') == receipt['container_id'], 'delivery_not_fenced')
    for name, expected in receipt['artifacts'].items():
        if name.startswith('pb_data/'):
            relative = Path(name)
            capture.require(not relative.is_absolute() and '..' not in relative.parts, 'invalid_manifest_path')
            path = capture.trusted(cfg.checkpoint / relative, private=True)
            capture.require(path.stat().st_size == expected['bytes'] and capture.digest(path) == expected['sha256'], 'checkpoint_bytes_changed')
    names = ('BUCKET', 'PATH', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'ENDPOINT', 'REGION', 'SYNC_INTERVAL')
    env = dict(item.split('=', 1) for item in row['Config']['Env'] if '=' in item)
    selected = {f'LITESTREAM_{name}': env.get(f'LITESTREAM_{name}', '') for name in names}
    for name in ('BUCKET', 'PATH', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'):
        capture.require(bool(selected['LITESTREAM_' + name]), 'replica_config_missing')
    selected['LITESTREAM_SYNC_INTERVAL'] = selected['LITESTREAM_SYNC_INTERVAL'] or '10s'
    capture.require(all('\n' not in value and '\r' not in value for value in selected.values()), 'invalid_environment')
    return receipt, selected


def verify(cfg):
    capture.require(os.geteuid() == 0, 'root_required')
    capture.trusted(cfg.checkpoint, directory=True, private=True)
    capture.require(not cfg.output.exists() and not cfg.output.is_symlink(), 'output_exists')
    capture.trusted(cfg.output.parent, directory=True, private=True)
    with capture.locks():
        receipt, env = source_state(cfg)
        if not cfg.execute:
            return {'status': 'validated_restore_not_started'}
        cfg.output.mkdir(mode=0o700)
        with tempfile.TemporaryDirectory(prefix='replica-credentials-', dir=cfg.output) as scratch:
            private = Path(scratch)
            envfile = private / 'replica.env'
            fd = os.open(envfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(''.join(key + '=' + value + '\n' for key, value in env.items()))
            # Entrypoint override is mandatory: no PocketContext or replicate starts.
            capture.run(['docker', 'run', '--rm', '--read-only', '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--env-file', str(envfile),
                '--mount', 'type=bind,src=' + str(cfg.output) + ',dst=/restore',
                '--entrypoint', '/usr/local/bin/litestream', receipt['image'],
                'restore', '-config', '/etc/litestream.yml', '-o', '/restore/data.db',
                '-integrity-check', 'full', '/storage/pb_data/data.db'], timeout=1800)
            source = private / 'source'
            capture.copy_tree(cfg.checkpoint / 'pb_data', source)
            verify_equivalent(source / 'data.db', cfg.output / 'data.db')
        source_state(cfg)
        report = {'status': 'replica_restore_logically_equal', 'source_container': receipt['container_id'],
                  'image': receipt['image'], 'restored_sha256': capture.digest(cfg.output / 'data.db')}
        capture.save(cfg.output / 'verification.json', report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    cfg = parser.parse_args()
    try:
        os.umask(0o077)
        print(json.dumps(verify(cfg)))
    except Exception:
        print('Replica verification failed; output suppressed; stopped source and capture retained.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
