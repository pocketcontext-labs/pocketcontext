#!/usr/bin/env python3
"""Root-side Wiki production checkpoint. Default validates only; never thaws.

Outputs contain credentials and private evidence. Retain and encrypt them. A
successful capture is not a verified off-host recovery checkpoint. Activation
requires a separately verified ingress fence across old-image thaw/replacement.
"""
import argparse
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import tarfile

HOST = 'wiki.pocketcontext.com'
LOCKS = (Path('/run/lock/pocketcontext-env-update.lock'), Path('/run/once-deploy') / (HOST + '.lock'))
PENDING = Path('/var/lib/once-deploy') / (HOST + '.pending')


class CaptureError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise CaptureError(code)


def run(argv, payload=None, timeout=900):
    result = subprocess.run(argv, input=payload, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    require(result.returncode == 0, 'command_failed')
    return result.stdout


def trusted(path, directory=False, private=False):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'unsafe_path')
    for parent in (path, *path.parents):
        require(not parent.is_symlink(), 'symlink_refused')
    info = path.stat()
    require(info.st_uid == os.geteuid(), 'wrong_owner')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'unsafe_type')
    require(not info.st_mode & (0o077 if private else 0o022), 'unsafe_permissions')
    if not directory:
        require(info.st_nlink == 1, 'hardlink_refused')
    return path


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    sync_dir(path.parent)


@contextmanager
def locks(paths=LOCKS):
    with ExitStack() as stack:
        for path in paths:
            if path.parent == Path('/run/lock'):
                info = path.parent.stat()
                require(not path.parent.is_symlink() and info.st_uid == 0 and stat.S_ISDIR(info.st_mode) and bool(info.st_mode & stat.S_ISVTX), 'unsafe_lock_parent')
            else:
                trusted(path.parent, directory=True)
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            stream = stack.enter_context(os.fdopen(fd, 'a'))
            trusted(path)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def validate(cfg):
    require(re.fullmatch(r'[0-9a-f]{64}', cfg.container_id), 'invalid_container')
    require(re.fullmatch(r'ghcr.io/pocketcontext/wikicontext@sha256:[0-9a-f]{64}', cfg.image), 'invalid_image')
    require(re.fullmatch(r'[0-9a-f]{40}', cfg.revision), 'invalid_revision')
    require(cfg.output.is_absolute() and '..' not in cfg.output.parts, 'invalid_output')
    trusted(cfg.output.parent, directory=True, private=True)
    require(not cfg.output.exists() and not cfg.output.is_symlink(), 'output_exists')


def inspect_source(cfg):
    row, = json.loads(run(['docker', 'inspect', cfg.container_id]))
    require(row['Id'] == cfg.container_id and row['State']['Running'], 'source_mismatch')
    settings = json.loads(row['Config']['Labels']['once'])
    require(settings.get('host') == HOST and settings.get('autoUpdate') is False, 'once_mismatch')
    require(settings.get('image') == cfg.image, 'once_image_not_pinned')
    image, = json.loads(run(['docker', 'image', 'inspect', row['Image']]))
    require(cfg.image in image.get('RepoDigests', []), 'image_mismatch')
    require(image.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == cfg.revision, 'revision_mismatch')
    mounts = [m for m in row['Mounts'] if m.get('Destination') == '/storage']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['RW'], 'mount_mismatch')
    mount = mounts[0]
    volume, = json.loads(run(['docker', 'volume', 'inspect', mount['Name']]))
    require(volume['Driver'] == 'local' and not volume.get('Options') and volume['Mountpoint'] == mount['Source'], 'volume_mismatch')
    source = trusted(Path(mount['Source']), directory=True)
    require(not cfg.output.is_relative_to(source) and not source.is_relative_to(cfg.output), 'source_overlap')
    ids = run(['docker', 'ps', '-q', '--no-trunc']).decode().split()
    for other in json.loads(run(['docker', 'inspect', *ids])) if ids else []:
        if other['Id'] != cfg.container_id:
            require(not any(m.get('Name') == mount['Name'] or m.get('Source') == mount['Source'] for m in other.get('Mounts', [])), 'shared_writer')
    return source, mount['Name'], row['Image']


API_CODE = r'''import json,os,sys,urllib.request
c=json.load(sys.stdin)
def api(method,path,body=None,token=None):
 h={'Content-Type':'application/json'}
 if token:h['Authorization']=token
 req=urllib.request.Request('http://127.0.0.1:80'+path,method=method,headers=h,data=None if body is None else json.dumps(body).encode())
 with urllib.request.urlopen(req,timeout=60) as response:return json.load(response)
if c['step']=='login':
 token=c.get('token') or api('POST','/api/collections/_superusers/auth-with-password',{'identity':c.get('email') or os.environ['WIKICONTEXT_SUPERUSER_EMAIL'],'password':c.get('password') or os.environ['WIKICONTEXT_SUPERUSER_PASSWORD']})['token']
 state=api('GET','/api/context/maintenance',token=token)
 assert state['state']=='writable'
 print(json.dumps({'token':token,'generation':state['generation']}))
else:
 state=api('PUT','/api/context/maintenance',{'readOnly':True,'expectedGeneration':c['generation']},c['token'])
 assert state['state']=='read_only'
 print(json.dumps({'state':state['state'],'generation':state['generation']}))
'''


def api(container, payload):
    return json.loads(run(['docker', 'exec', '-i', container, 'python3', '-c', API_CODE], json.dumps(payload).encode()))


def stop(container):
    run(['docker', 'update', '--restart=no', container])
    run(['docker', 'stop', '--time', '300', container], timeout=360)
    row, = json.loads(run(['docker', 'inspect', container]))
    require(not row['State']['Running'] and row['State']['ExitCode'] == 0 and not row['State'].get('OOMKilled') and row['HostConfig']['RestartPolicy']['Name'] == 'no', 'stop_unverified')


def copy_tree(source, target):
    trusted(source, directory=True)
    target.mkdir(mode=0o700)
    for entry in source.iterdir():
        require(not entry.is_symlink(), 'symlink_refused')
        if entry.is_dir():
            copy_tree(entry, target / entry.name)
        else:
            trusted(entry)
            fd = os.open(target / entry.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with entry.open('rb') as src, os.fdopen(fd, 'wb') as dst:
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())
            require(digest(entry) == digest(target / entry.name), 'copied_bytes_mismatch')
    sync_dir(target)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def check_databases(path):
    for name in ('data.db', 'auxiliary.db'):
        # Read only; do not use immutable because the copied WAL may hold commits.
        connection = sqlite3.connect((path / name).as_uri() + '?mode=ro', uri=True)
        try:
            require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'database_integrity')
        finally:
            connection.close()


def login_payload(cfg):
    payload = {'step': 'login'}
    if getattr(cfg, 'operator_token_file', None):
        token = trusted(cfg.operator_token_file, private=True).read_text().strip()
        require(bool(re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token)), 'invalid_operator_token')
        payload['token'] = token
    elif getattr(cfg, 'operator_input', None):
        value = cfg.operator_input
        require(set(value) == {'email', 'password'} and all(isinstance(v, str) and v for v in value.values()), 'invalid_operator_credentials')
        payload.update(value)
    elif getattr(cfg, 'operator_credentials', None):
        value = json.loads(trusted(cfg.operator_credentials, private=True).read_text())
        require(set(value) == {'email', 'password'} and all(isinstance(v, str) and v for v in value.values()), 'invalid_operator_credentials')
        payload.update(value)
    return payload


def preflight(cfg):
    validate(cfg)
    require(os.geteuid() == 0, 'root_required')
    source, volume, image_id = inspect_source(cfg)
    require(run(['once', 'version']).decode().strip() == 'v0.3.3', 'once_version_mismatch')
    for marker in (PENDING,):
        require(not marker.exists() and not marker.is_symlink(), 'existing_fence')
    token = api(cfg.container_id, login_payload(cfg))
    require(isinstance(token.get('token'), str) and token['token'], 'login_failed')
    return {'status': 'preflight_passed_no_freeze', 'container_id': cfg.container_id, 'image_id': image_id, 'volume': volume}


def capture(cfg):
    validate(cfg)
    require(os.geteuid() == 0, 'root_required')
    os.umask(0o077)
    with locks():
        source, volume, image_id = inspect_source(cfg)
        require(run(['once', 'version']).decode().strip() == 'v0.3.3', 'once_version_mismatch')
        for marker in (PENDING,):
            require(not marker.exists() and not marker.is_symlink(), 'existing_fence')
            trusted(marker.parent, directory=True)
        cfg.output.mkdir(mode=0o700)
        sync_dir(cfg.output.parent)
        token = api(cfg.container_id, login_payload(cfg))
        require(isinstance(token.get('token'), str) and token['token'], 'login_failed')
        save(cfg.output / 'recovery-control.json', dict(token, container_id=cfg.container_id, image=cfg.image))
        fence = {'purpose': 'wikicontext-predeployment-checkpoint', 'output': str(cfg.output), 'container_id': cfg.container_id}
        save(PENDING, fence)
        try:
            run(['docker', 'update', '--restart=no', cfg.container_id])
            frozen = api(cfg.container_id, dict(token, step='freeze'))
            marker = trusted(source / 'pb_data/maintenance.json', private=True)
            require(json.loads(marker.read_text()) == {'readOnly': True, 'generation': frozen['generation']}, 'maintenance_mismatch')
            stop(cfg.container_id)
            copy_tree(source / 'pb_data', cfg.output / 'pb_data')
            with tempfile.TemporaryDirectory(prefix='verify-', dir=cfg.output) as scratch:
                copied = Path(scratch) / 'pb_data'
                copy_tree(cfg.output / 'pb_data', copied)
                check_databases(copied)
            run(['once', 'backup', HOST, str(cfg.output / 'once.tar.gz')])
            run(['docker', 'image', 'save', '--output', str(cfg.output / 'old-image.tar'), cfg.image])
            stop(cfg.container_id)
            with tarfile.open(cfg.output / 'old-image.tar') as archive:
                manifests = json.load(archive.extractfile('manifest.json'))
                require(len(manifests) == 1, 'image_archive_manifest')
                config_bytes = archive.extractfile(manifests[0]['Config']).read()
                image_config_digest = 'sha256:' + hashlib.sha256(config_bytes).hexdigest()
            artifacts = {}
            for p in cfg.output.rglob('*'):
                if p.is_file():
                    trusted(p, private=True)
                    artifacts[str(p.relative_to(cfg.output))] = {'sha256': digest(p), 'bytes': p.stat().st_size}
            receipt = {'status': 'captured_source_stopped_not_offhost_verified', 'captured_at': datetime.now(timezone.utc).isoformat(), 'container_id': cfg.container_id, 'image': cfg.image, 'image_id': image_id, 'image_config_digest': image_config_digest, 'revision': cfg.revision, 'volume': volume, 'maintenance_generation': frozen['generation'], 'artifacts': artifacts}
            save(cfg.output / 'receipt.json', receipt)
            return {'status': receipt['status'], 'artifact_count': len(artifacts), 'generation': frozen['generation']}
        except BaseException:
            try:
                stop(cfg.container_id)
            except BaseException:
                raise CaptureError('capture_failed_source_stop_unverified') from None
            raise CaptureError('capture_failed_source_stopped_fences_retained') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--execute', action='store_true')
    modes.add_argument('--preflight', action='store_true')
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument('--operator-credentials', type=Path)
    auth.add_argument('--operator-stdin', action='store_true')
    auth.add_argument('--operator-token-file', type=Path)
    parser.add_argument('--container-id', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', type=Path, required=True)
    cfg = parser.parse_args()
    try:
        if cfg.operator_stdin:
            cfg.operator_input = json.load(sys.stdin)
        validate(cfg)
        print(json.dumps(capture(cfg) if cfg.execute else preflight(cfg) if cfg.preflight else {'status': 'arguments_validated_no_capture'}))
    except Exception:
        print('Checkpoint capture failed; private diagnostics suppressed; inspect preserved state and fences.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
