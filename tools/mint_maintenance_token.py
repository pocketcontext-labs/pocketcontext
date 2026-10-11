#!/usr/bin/env python3
"""Mint a one-hour nonrefreshable maintenance token from an isolated DB snapshot.

Requires trusted root host authority. Does not alter live users, passwords or
settings. Operator email is explicit stdin JSON, never selected automatically.
Copied private databases remain sensitive. Only a private token file is written;
stdout contains a status receipt without identity or token. No server is started.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import socket
import shutil
import sqlite3
import subprocess
import sys
import capture_checkpoint as capture


def snapshot(source, target):
    capture.trusted(source)
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(target)) as dst:
        src.backup(dst)
        capture.require(dst.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'snapshot_integrity')
    with target.open('rb') as stream:
        os.fsync(stream.fileno())


def worker(request_file):
    request = json.loads(capture.trusted(request_file, private=True).read_text())
    capture.require(os.geteuid() == 0 and os.readlink('/proc/self/ns/net') != request['source_netns'] and {name for _, name in socket.if_nameindex()} == {'lo'}, 'network_isolation_required')
    work = capture.trusted(Path(request['work']), directory=True, private=True)
    capture.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'])
    hooks, migrations = work / 'hooks', work / 'migrations'
    hooks.mkdir(mode=0o700); migrations.mkdir(mode=0o700)
    capture.save(work / 'pocketcontext.json', {'authCollection': 'users', 'tables': {'pages': ['id']}})
    script = '''// Trusted isolated maintenance command; no application hooks/migrations.
$app.rootCmd.addCommand(new Command({use:'checkpoint-maintenance-token',run:()=>{
 const operator=$app.findAuthRecordByEmail('_superusers',%s);
 $os.writeFile(%s,operator.newStaticAuthToken(3600000000000),384);
}}));
''' % (json.dumps(request['email']), json.dumps(str(work / 'operator.token')))
    hook = hooks / 'maintenance.pb.js'
    fd = os.open(hook, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output: output.write(script)
    # Bare command bootstraps the COPIED databases only; never run `serve`.
    result = subprocess.run([str(work / 'pocketcontext'), '--dir', str(work / 'pb_data'),
        '--hooksDir', str(hooks), '--migrationsDir', str(migrations),
        '--contextConfig', str(work / 'pocketcontext.json'), 'checkpoint-maintenance-token'],
        cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    capture.require(result.returncode == 0, 'token_mint_failed')
    token = capture.trusted(work / 'operator.token', private=True)
    capture.require(bool(token.read_text().strip()), 'empty_token')
    capture.sync_dir(work)


def mint(cfg, email):
    capture.require(os.geteuid() == 0, 'root_required')
    capture.validate(cfg)
    capture.require(isinstance(email, str) and '@' in email and '\n' not in email and len(email) < 255, 'explicit_operator_required')
    with capture.locks():
        source, _, image_id = capture.inspect_source(cfg)
        cfg.output.mkdir(mode=0o700)
        data = cfg.output / 'pb_data'; data.mkdir(mode=0o700)
        for name in ('data.db', 'auxiliary.db'):
            snapshot(source / 'pb_data' / name, data / name)
        # Require exact supplied account before bootstrap; no fallback account.
        with closing(sqlite3.connect((data / 'data.db').as_uri() + '?mode=ro', uri=True)) as db:
            count = db.execute('SELECT count(*) FROM _superusers WHERE lower(email)=lower(?)', (email,)).fetchone()[0]
            capture.require(count == 1, 'configured_operator_not_found')
        binary = cfg.output / 'pocketcontext'
        capture.run(['docker', 'cp', cfg.container_id + ':/usr/local/bin/pocketcontext', str(binary)])
        binary.chmod(0o700)
        expected = capture.run(['docker', 'exec', cfg.container_id, 'sha256sum', '/usr/local/bin/pocketcontext']).decode().split()[0]
        capture.require(capture.digest(binary) == expected, 'binary_mismatch')
        request = cfg.output / 'request.json'
        capture.save(request, {'email': email, 'work': str(cfg.output), 'source_netns': os.readlink('/proc/self/ns/net')})
        capture.run(['unshare', '--net', '--', sys.executable, str(Path(__file__).resolve()), '_worker', str(request)], timeout=180)
        capture.inspect_source(cfg)
        for name in ('pb_data', 'hooks', 'migrations'):
            shutil.rmtree(cfg.output / name)
        for name in ('pocketcontext', 'pocketcontext.json', 'request.json'):
            (cfg.output / name).unlink()
        capture.sync_dir(cfg.output)
        return {'status': 'maintenance_token_minted_private_file', 'ttl_seconds': 3600, 'image_id': image_id, 'binary_sha256': expected}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '_worker':
        try:
            worker(Path(sys.argv[2])); return 0
        except Exception:
            return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container-id', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', type=Path, required=True)
    cfg = parser.parse_args()
    try:
        os.umask(0o077)
        value = json.load(sys.stdin)
        capture.require(set(value) == {'email'}, 'explicit_operator_required')
        print(json.dumps(mint(cfg, value['email'])))
    except Exception:
        print('Maintenance token preparation failed; private diagnostics suppressed.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__': sys.exit(main())
