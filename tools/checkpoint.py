#!/usr/bin/env python3
"""Encrypted, complete offline recovery checkpoints. Never stops or changes a service."""
import argparse
from contextlib import closing
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import uuid

class CheckpointError(Exception):
    pass

def checked_path(path, *, private=False, directory=False):
    path = Path(os.path.abspath(path))
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            raise CheckpointError('Symlink path component refused')
    checked = path if path.exists() else path.parent
    if private:
        st = checked.stat()
        if st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise CheckpointError('Private current-user-owned path required')
    if directory and not path.is_dir():
        raise CheckpointError('Directory required')
    return path

def backup_key(ident, leaf):
    prefix = os.environ.get('WIKICONTEXT_BACKUP_PREFIX', 'checkpoints').strip('/')
    safe_name(prefix)
    return prefix + '/' + str(uuid.UUID(ident)) + '/' + leaf

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def safe_name(name):
    p = Path(name)
    if not name or p.is_absolute() or '..' in p.parts or '\\' in name or '\x00' in name or str(p) != name:
        raise CheckpointError('Unsafe archive path')
    return p

def files(root):
    if root.is_symlink() or not root.is_dir():
        raise CheckpointError('Invalid checkpoint directory')
    result = {}
    for p in sorted(root.rglob('*')):
        if p.is_symlink() or not (p.is_file() or p.is_dir()):
            raise CheckpointError('Only regular files and directories are supported')
        if p.is_file():
            result[p.relative_to(root).as_posix()] = {'sha256': sha(p), 'size': p.stat().st_size}
    return result

def private_json(path, value):
    with open(path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
        json.dump(value, f, sort_keys=True)
        f.write('\n')

def database(path):
    if not path.is_file() or path.is_symlink():
        raise CheckpointError('Stopped database required')
    conn = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    if conn.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        conn.close()
        raise CheckpointError('Database integrity failed')
    return conn

def validate_data(root, objects):
    source = root / 'pb_data'
    before = files(source)
    # SQLite may create/update SHM when reading WAL, so it only sees a disposable
    # second copy. Raw checkpoint and ONCE bytes never enter SQLite directly.
    with tempfile.TemporaryDirectory(prefix='.sqlite-validation-', dir=root.parent) as temp:
        data = Path(temp) / 'pb_data'
        shutil.copytree(source, data)
        validate_databases(data, objects)
    if files(source) != before:
        raise CheckpointError('Checkpoint changed during database validation')

def validate_databases(data, objects):
    if json.loads((data / 'maintenance.json').read_text()).get('readOnly') is not True:
        raise CheckpointError('Frozen maintenance state required')
    with closing(database(data / 'auxiliary.db')):
        pass
    found = False
    with closing(database(data / 'data.db')) as conn:
        quote = lambda s: '"' + s.replace('"', '""') + '"'
        for collection, name, kind, fields_json in conn.execute('SELECT id,name,type,fields FROM _collections'):
            if kind == 'view':
                continue
            for field in json.loads(fields_json):
                if field['type'] != 'file':
                    continue
                original = name == 'sources' and field['name'] == 'original'
                found |= original
                sql = 'SELECT id,' + quote(field['name']) + (',sha256' if original else '') + ' FROM ' + quote(name)
                for row in conn.execute(sql):
                    if not row[1]:
                        if original:
                            raise CheckpointError('Missing original reference')
                        continue
                    names = json.loads(row[1]) if field.get('maxSelect', 1) > 1 else [row[1]]
                    for name in names:
                        key = '/'.join((collection, row[0], name))
                        entry = objects.get(key)
                        if entry is None or (original and entry['sha256'] != row[2]):
                            raise CheckpointError('Referenced object missing or checksum mismatch')
    if not found:
        raise CheckpointError('Wiki original schema missing')

def listing(client, bucket):
    out = {}
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket):
        for obj in page.get('Contents', []):
            key = obj['Key']
            out[key] = {'size': obj['Size'], 'etag': obj.get('ETag'), 'modified': str(obj.get('LastModified'))}
    return out

def validate_archives(once, image_archive, source_files, image_id):
    # ONCE settings stay private and are not interpreted or executed here.
    with tarfile.open(once, 'r:*') as archive:
        members = {m.name: m for m in archive.getmembers()}
        if len(members) != len(archive.getmembers()) or 'once.application.json' not in members:
            raise CheckpointError('Invalid ONCE archive')
        for member in members.values():
            safe_name(member.name.rstrip('/'))
            if not (member.isfile() or member.isdir()):
                raise CheckpointError('Unsafe ONCE archive member')
        for name, expected in source_files.items():
            member = members.get('data/pb_data/' + name)
            if member is None or not member.isfile() or member.size != expected['size']:
                raise CheckpointError('ONCE archive does not contain the exact checkpoint')
            with archive.extractfile(member) as stream:
                h = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
            if h.hexdigest() != expected['sha256']:
                raise CheckpointError('ONCE archive checkpoint mismatch')
    with tarfile.open(image_archive, 'r:*') as archive:
        names = set(archive.getnames())
        if 'manifest.json' not in names:
            raise CheckpointError('docker save image archive required')
        with archive.extractfile('manifest.json') as stream:
            manifest = json.load(stream)
        if len(manifest) != 1 or any(entry.get('Config') not in names or not entry.get('Layers') or any(layer not in names for layer in entry['Layers']) for entry in manifest):
            raise CheckpointError('Incomplete saved image archive')
        with archive.extractfile(manifest[0]['Config']) as stream:
            actual_id = 'sha256:' + hashlib.sha256(stream.read()).hexdigest()
        if actual_id != image_id:
            raise CheckpointError('Saved image config does not match inspected image ID')

def capture(source, once, image_archive, image_digest, output, recipient, client, bucket, age='age', *, image_id):
    source = checked_path(source, private=True, directory=True)
    once = checked_path(once, private=True)
    image_archive = checked_path(image_archive, private=True)
    output = checked_path(output)
    checked_path(output.parent, private=True, directory=True)
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise CheckpointError('Exact inspected image ID required')
    if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', image_digest) or not recipient.startswith('age1'):
        raise CheckpointError('Exact image digest and age public recipient required')
    if output.exists() or output.resolve().is_relative_to(source.resolve()):
        raise CheckpointError('New separate output required')
    for p in (once, image_archive):
        if p.is_symlink() or not p.is_file():
            raise CheckpointError('ONCE backup and saved image archive required')
    before = files(source)
    validate_archives(once, image_archive, before, image_id)
    inputs = {str(p): sha(p) for p in (once, image_archive)}
    output.mkdir(mode=0o700)
    try:
        with tempfile.TemporaryDirectory(prefix='.checkpoint-', dir=output) as temp:
            root = Path(temp)
            shutil.copytree(source, root / 'pb_data')
            shutil.copyfile(once, root / 'once.tar.gz')
            shutil.copyfile(image_archive, root / 'image.tar')
            (root / 'objects').mkdir(mode=0o700)
            initial = listing(client, bucket)
            objects = {}
            for key, meta in initial.items():
                name = 'objects/' + hashlib.sha256(key.encode()).hexdigest()
                path = root / name
                response = client.get_object(Bucket=bucket, Key=key, IfMatch=meta['etag'])
                with closing(response['Body']) as stream, path.open('xb') as dest:
                    shutil.copyfileobj(stream, dest, 1024 * 1024)
                if path.stat().st_size != meta['size']:
                    raise CheckpointError('Object size changed')
                objects[key] = {'path': name, 'size': meta['size'], 'sha256': sha(path)}
            if initial != listing(client, bucket) or before != files(source) or any(sha(Path(p)) != h for p, h in inputs.items()):
                raise CheckpointError('Source changed during capture')
            if files(root / 'pb_data') != before:
                raise CheckpointError('Copied database state differs')
            validate_data(root, objects)
            manifest = {'version': 1, 'id': str(uuid.uuid4()), 'image_digest': image_digest, 'image_id': image_id, 'image_digest_operator_attested': True, 'files': files(root), 'objects': objects}
            private_json(root / 'manifest.json', manifest)
            cipher = output / 'checkpoint.tar.age'
            with open(cipher, 'xb', opener=lambda p, f: os.open(p, f, 0o600)) as dest:
                proc = subprocess.Popen([age, '--encrypt', '--recipient', recipient], stdin=subprocess.PIPE, stdout=dest, stderr=subprocess.DEVNULL)
                try:
                    with tarfile.open(fileobj=proc.stdin, mode='w|') as tar:
                        for name in sorted(files(root)):
                            tar.add(root / name, arcname=name, recursive=False)
                    proc.stdin.close()
                    if proc.wait() != 0:
                        raise CheckpointError('Encryption failed')
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait()
            receipt = {'version': 1, 'id': manifest['id'], 'cipher_sha256': sha(cipher), 'cipher_size': cipher.stat().st_size, 'objects': len(objects), 'remote_verified': False}
            private_json(output / 'receipt.json', receipt)
            return receipt
    except Exception:
        shutil.rmtree(output)
        raise

def upload(directory, client, bucket):
    directory = checked_path(directory, private=True, directory=True)
    receipt = json.loads((directory / 'receipt.json').read_text())
    ident = str(uuid.UUID(receipt['id']))
    cipher = directory / 'checkpoint.tar.age'
    if sha(cipher) != receipt['cipher_sha256'] or cipher.stat().st_size != receipt['cipher_size']:
        raise CheckpointError('Ciphertext differs from receipt')
    if cipher.stat().st_size > 5 * 1024**3:
        raise CheckpointError('Checkpoint exceeds supported 5 GiB single-upload bound')
    key = backup_key(ident, 'checkpoint.tar.age')
    with cipher.open('rb') as stream:
        client.put_object(Bucket=bucket, Key=key, Body=stream, ContentLength=cipher.stat().st_size, IfNoneMatch='*')
    payload = json.dumps(receipt, sort_keys=True).encode()
    client.put_object(Bucket=bucket, Key=backup_key(ident, 'receipt.json'), Body=io.BytesIO(payload), ContentLength=len(payload), IfNoneMatch='*')
    return key

def verify(receipt_path, destination, identity, client, bucket, age='age'):
    receipt = json.loads(checked_path(receipt_path, private=True).read_text())
    ident = str(uuid.UUID(receipt['id']))
    destination = checked_path(destination)
    checked_path(destination.parent, private=True, directory=True)
    if destination.exists() or destination.is_symlink():
        raise CheckpointError('New recovery destination required')
    identity = checked_path(identity, private=True)
    if identity.is_symlink() or not identity.is_file() or identity.stat().st_mode & 0o077:
        raise CheckpointError('Private age identity file required')
    with tempfile.TemporaryDirectory(prefix='.checkpoint-restore-', dir=destination.parent) as temp:
        temp = Path(temp)
        cipher = temp / 'checkpoint.age'
        response = client.get_object(Bucket=bucket, Key=backup_key(ident, 'checkpoint.tar.age'))
        with closing(response['Body']) as stream, cipher.open('xb') as dest:
            shutil.copyfileobj(stream, dest, 1024 * 1024)
        if sha(cipher) != receipt['cipher_sha256'] or cipher.stat().st_size != receipt['cipher_size']:
            raise CheckpointError('Remote ciphertext mismatch')
        root = temp / 'recovery'
        root.mkdir(mode=0o700)
        proc = subprocess.Popen([age, '--decrypt', '--identity', str(identity), str(cipher)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            seen = set()
            with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:
                for entry in archive:
                    path = safe_name(entry.name)
                    if not entry.isfile() or entry.name in seen:
                        raise CheckpointError('Archive contains unsafe or duplicate entries')
                    seen.add(entry.name)
                    target = root / path
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with archive.extractfile(entry) as src, open(target, 'xb', opener=lambda p, f: os.open(p, f, 0o600)) as dest:
                        shutil.copyfileobj(src, dest, 1024 * 1024)
            # Consume trailing authenticated stream bytes before checking process completion.
            while proc.stdout.read(1024 * 1024):
                pass
            if proc.wait() != 0:
                raise CheckpointError('Decryption failed')
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        manifest = json.loads((root / 'manifest.json').read_text())
        actual = files(root)
        del actual['manifest.json']
        if manifest['version'] != 1 or manifest['id'] != ident or actual != manifest['files']:
            raise CheckpointError('Recovery file manifest mismatch')
        for entry in manifest['objects'].values():
            if actual.get(entry['path']) != {'sha256': entry['sha256'], 'size': entry['size']}:
                raise CheckpointError('Recovery object manifest mismatch')
        validate_data(root, manifest['objects'])
        validate_archives(root / 'once.tar.gz', root / 'image.tar', files(root / 'pb_data'), manifest['image_id'])
        root.rename(destination)
    return {'id': ident, 'remote_verified': True, 'database_integrity_verified': True, 'all_files_verified': True, 'writer_started': False}

def client(prefix):
    import boto3
    from botocore.config import Config
    values = {k: os.environ[prefix + k] for k in ('ENDPOINT', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'BUCKET')}
    if not values['ENDPOINT'].startswith('https://'):
        raise CheckpointError('HTTPS object storage required')
    return boto3.client('s3', endpoint_url=values['ENDPOINT'], region_name=values['REGION'], aws_access_key_id=values['ACCESS_KEY_ID'], aws_secret_access_key=values['SECRET_ACCESS_KEY'], config=Config(connect_timeout=15, read_timeout=120, retries={'max_attempts': 3}, s3={'addressing_style': 'path'})), values['BUCKET']

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('capture')
    for name in ('source', 'once', 'image-archive', 'image-digest', 'image-id', 'output', 'recipient'):
        p.add_argument('--' + name, required=True)
    p = sub.add_parser('upload')
    p.add_argument('--directory', required=True)
    p = sub.add_parser('verify')
    for name in ('receipt', 'destination', 'identity'):
        p.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'capture':
            api, bucket = client('WIKICONTEXT_S3_')
            result = capture(args.source, args.once, args.image_archive, args.image_digest, args.output, args.recipient, api, bucket, image_id=args.image_id)
        else:
            # Backup authority must never be the application's live write authority.
            for field in ('BUCKET', 'ACCESS_KEY_ID'):
                if os.environ.get('WIKICONTEXT_BACKUP_' + field) in {os.environ.get('WIKICONTEXT_S3_' + field), os.environ.get('LITESTREAM_' + field)} - {None}:
                    raise CheckpointError('Dedicated backup bucket and credentials required')
            api, bucket = client('WIKICONTEXT_BACKUP_')
            result = {'uploaded_key': upload(args.directory, api, bucket), 'remote_verified': False} if args.action == 'upload' else verify(args.receipt, args.destination, args.identity, api, bucket)
        print(json.dumps(result))
        return 0
    except Exception:
        print('Checkpoint operation failed; no recovery success recorded. Inspect private inputs locally.', file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
