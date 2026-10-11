#!/usr/bin/env python3
"""Prepare a NEW private clone volume from a stopped, frozen Wiki checkpoint.

Linux only. Preparation runs in a new loopback-only network namespace, with no
application hooks, migrations, container entrypoint or replica publisher. Existing
PocketBase APIs thaw maintenance, replace settings and revoke copied identities.
The existing superuser is authenticated through a five-minute nonrefreshable
PocketBase token created by a temporary supported local JS command. No token or
credential is printed. This is not a database/originals backup or an ONCE deploy.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


class PreparationError(Exception):
    pass


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def private_json(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise PreparationError('Private configuration must be a regular mode-0600 file')
    return json.loads(path.read_text())


def checked_config(value):
    if not isinstance(value, dict) or set(value) - {'clone_url', 'operator_email', 'operator_password', 's3', 'test_users'}:
        raise PreparationError('Unexpected clone configuration fields')
    url = urllib.parse.urlsplit(value.get('clone_url', ''))
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        raise PreparationError('Invalid clone URL')
    if url.hostname.rstrip('.').lower() == 'pocketcontext.com' or url.hostname.rstrip('.').lower().endswith('.pocketcontext.com'):

        raise PreparationError('Use an isolated clone hostname outside the production domain')
    if not isinstance(value.get('operator_email'), str) or '@' not in value['operator_email'] or len(value.get('operator_password', '')) < 20:
        raise PreparationError('An existing operator identity and new clone password of at least 20 characters are required')
    s3 = value.get('s3')
    if not isinstance(s3, dict) or set(s3) != {'enabled', 'bucket', 'endpoint', 'region', 'accessKey', 'secret', 'forcePathStyle'}:
        raise PreparationError('Clone s3 settings must be explicit and complete')
    if not isinstance(s3['enabled'], bool) or not isinstance(s3['forcePathStyle'], bool):
        raise PreparationError('Clone storage flags must be booleans')
    if s3['enabled'] and not all(isinstance(s3[k], str) and s3[k] for k in ('bucket', 'endpoint', 'region', 'accessKey', 'secret')):
        raise PreparationError('Clone S3 bindings must be complete')
    if not s3['enabled'] and any(s3[k] for k in ('bucket', 'endpoint', 'region', 'accessKey', 'secret')):
        raise PreparationError('Disabled clone storage must not retain credentials')
    users = value.get('test_users', [])
    if not isinstance(users, list) or any(not isinstance(u, dict) or set(u) != {'email', 'password'} or '@' not in u['email'] or len(u['password']) < 20 for u in users):
        raise PreparationError('Test users require existing emails and new passwords of at least 20 characters')
    if len({u['email'].lower() for u in users}) != len(users):
        raise PreparationError('Duplicate test user')
    return value


def allowed_files(source):
    selected = []
    for path in source.rglob('*'):
        relative = path.relative_to(source)
        if path.is_symlink():
            raise PreparationError('Checkpoint must not contain symbolic links')
        if not path.is_file():
            continue
        if relative.parts[0] == 'storage' or str(relative) in {'data.db', 'data.db-wal', 'data.db-shm', 'auxiliary.db', 'auxiliary.db-wal', 'auxiliary.db-shm', 'maintenance.json'}:
            selected.append(relative)
    return selected


DOMAIN = ('sources', 'renditions', 'passages', 'ingestion_runs', 'pages', 'page_revisions',
          'citations', 'page_links', 'publications', 'audit_log', 'spaces', 'space_members')


def domain_hashes(data):
    # Recovery comparison only, through a read-only connection. No content is
    # emitted; only equality fingerprints of fixed domain tables leave memory.
    with closing(sqlite3.connect((data / 'data.db').as_uri() + '?mode=ro', uri=True)) as database:
        existing = {r[0] for r in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        results = {}
        for table in DOMAIN:
            if table not in existing:continue
            cursor = database.execute('SELECT * FROM ' + table + ' ORDER BY id')
            body = json.dumps([list(c[0] for c in cursor.description), cursor.fetchall()], separators=(',', ':'), ensure_ascii=False)
            results[table] = hashlib.sha256(body.encode()).hexdigest()
        return results


def check_integrity(data):
    for name in ('data.db', 'auxiliary.db'):
        with closing(sqlite3.connect((data / name).as_uri() + '?mode=ro', uri=True)) as database:
            if database.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise PreparationError('Copied database integrity check failed')


def prepare(binary, checkpoint, destination, config_path):
    binary, source, destination, config_path = [Path(p).resolve() for p in (binary, checkpoint, destination, config_path)]
    checked_config(private_json(config_path))
    if not binary.is_file() or not source.is_dir() or destination.exists() or destination.is_relative_to(source) or source.is_relative_to(destination):
        raise PreparationError('Choose an existing binary/checkpoint and a new separate destination')
    marker = private_json(source / 'maintenance.json')
    if marker.get('readOnly') is not True or not (source / 'data.db').is_file() or not (source / 'auxiliary.db').is_file():
        raise PreparationError('A stopped frozen checkpoint with both databases is required')
    files = allowed_files(source)
    before = {str(p): digest(source / p) for p in files}
    destination.mkdir(mode=0o700, parents=False)
    try:
        for relative in files:
            target = destination / relative
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copyfile(source / relative, target)
            target.chmod(0o600)
        if before != {str(p): digest(source / p) for p in files} or before != {str(p): digest(destination / p) for p in files}:
            raise PreparationError('Checkpoint changed during copying; preserve the failed destination and recapture a stopped checkpoint')
        check_integrity(destination)
        source_domain = domain_hashes(destination)
        with tempfile.TemporaryDirectory(prefix='wiki-clone-control-') as directory:
            control = Path(directory)
            request_path = control / 'request.json'
            request_path.write_text(json.dumps({'binary': str(binary), 'data': str(destination), 'config': str(config_path),
                                               'owner_uid': os.getuid(), 'owner_gid': os.getgid(), 'source_netns': os.readlink('/proc/self/ns/net'), 'receipt': str(control / 'receipt.json')}))
            request_path.chmod(0o600)
            command = ['unshare', '--net', '--', sys.executable, str(Path(__file__).resolve()), '_worker', str(request_path)]
            if os.geteuid() != 0:
                command = ['sudo', '-n'] + command
            result = subprocess.run(command, env={'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}, capture_output=True)
            if result.returncode:
                raise PreparationError('Isolated clone preparation failed; destination remains private and must not be started')
            receipt = json.loads((control / 'receipt.json').read_text())
        if before != {str(p): digest(source / p) for p in files}:
            raise PreparationError('Source checkpoint changed during preparation')
        check_integrity(destination)
        if domain_hashes(destination) != source_domain:
            raise PreparationError('Clone preparation changed immutable domain data')
        receipt.update(source_unchanged=True, source_database_sha256=before['data.db'],
                       prepared_database_sha256=digest(destination / 'data.db'), binary_sha256=digest(binary),
                       original_files_unchanged=all(digest(destination / p) == checksum for p, checksum in before.items() if p.startswith('storage/')))
        if not receipt['original_files_unchanged']:
            raise PreparationError('Clone preparation changed local originals')
        # JSVM emits developer type declarations during bootstrap. They were not
        # copied from the checkpoint and are not application recovery state.
        generated = destination / 'types.d.ts'
        if generated.is_symlink():
            raise PreparationError('Unexpected generated symlink')
        generated.unlink(missing_ok=True)
        actual = {str(p.relative_to(destination)) for p in destination.rglob('*') if p.is_file()}
        if actual != {str(p) for p in allowed_files(destination)}:
            raise PreparationError('Unexpected prepared-volume files require review')
        receipt.update(domain_unchanged=True, database_integrity_verified=True, domain_sha256=source_domain,
                       prepared_files={str(p): digest(destination / p) for p in allowed_files(destination)})
        receipt_path = destination.parent / (destination.name + '.preparation.json')
        with receipt_path.open('x') as output:
            os.chmod(receipt_path, 0o600)
            json.dump(receipt, output, indent=2)
            output.write('\n')
        return receipt
    except BaseException:
        # Never promote, delete or silently reuse a partial clone.
        raise


def worker(request_path):
    request = private_json(request_path)
    if os.readlink('/proc/self/ns/net') == request['source_netns'] or {name for _, name in socket.if_nameindex()} != {'lo'}:
        raise PreparationError('Preparation requires a new network namespace containing only loopback')
    subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    config = checked_config(private_json(request['config']))
    data = Path(request['data'])
    with tempfile.TemporaryDirectory(prefix='wiki-clone-worker-') as temporary:
        work = Path(temporary)
        hooks, migrations = work / 'hooks', work / 'migrations'
        hooks.mkdir(); migrations.mkdir()
        token_file = work / 'operator-token'
        (work / 'pocketcontext.json').write_text(json.dumps({'authCollection': 'users', 'tables': {'pages': ['id']}}))
        # Trusted local extension only; never installed in the prepared application.
        (hooks / 'operator.pb.js').write_text('''// Temporary loopback-only maintenance authority, never persisted.
onBootstrap(e => { e.next(); e.app.settings().superuserIPs = ['127.0.0.1']; });
$app.rootCmd.addCommand(new Command({
 use: 'clone-maintenance-token',
 run: () => {
  const desired = %s;
  const stored = $app.settings().s3;
  if (stored.enabled && (!desired.enabled || stored.accessKey === desired.accessKey || stored.secret === desired.secret || stored.bucket.toLowerCase() === desired.bucket.toLowerCase())) throw new Error('Clone storage must use separate credentials and a separate bucket or endpoint');
  if ($app.settings().meta.appURL === %s) throw new Error('Clone URL must differ from source');
  const operator = $app.findAuthRecordByEmail('_superusers', %s);
  if (operator.validatePassword(%s)) throw new Error('Clone operator password must differ from source');
  for (const test of %s) {
    const user = $app.findAuthRecordByEmail('users', test.email);
    if (user.validatePassword(test.password)) throw new Error('Clone test password must differ from source');
  }
  $os.writeFile(%s, operator.newStaticAuthToken(300000000000), 384);
 }
}));\n''' % (json.dumps(config['s3']), json.dumps(config['clone_url']), json.dumps(config['operator_email']), json.dumps(config['operator_password']), json.dumps(config.get('test_users', [])), json.dumps(str(token_file))))
        (hooks / 'operator.pb.js').chmod(0o600)
        common = [request['binary'], '--dir', str(data), '--hooksDir', str(hooks), '--migrationsDir', str(migrations), '--contextConfig', str(work / 'pocketcontext.json')]
        result = subprocess.run(common + ['clone-maintenance-token'], cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode or not token_file.is_file():
            raise PreparationError('Existing operator could not mint a temporary maintenance token')
        token = token_file.read_text()
        token_file.unlink()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
        process = subprocess.Popen(common + ['serve', '--http', f'127.0.0.1:{port}'], cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def api(method, path, body=None, bearer=None):
            payload = None if body is None else json.dumps(body).encode()
            call = urllib.request.Request(f'http://127.0.0.1:{port}' + path, data=payload, method=method,
                headers={'Content-Type': 'application/json', 'Authorization': token if bearer is None else bearer})
            try:
                with urllib.request.urlopen(call, timeout=20) as response:
                    return json.load(response) if response.status != 204 else None
            except urllib.error.HTTPError as error:
                raise PreparationError(f'Clone API operation failed with HTTP {error.code}') from None
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise PreparationError('Old compatible server failed to start')
                try:
                    state = api('GET', '/api/context/maintenance')
                    break
                except (OSError, PreparationError):
                    time.sleep(.1)
            else:
                raise PreparationError('Isolated maintenance startup timed out')
            if state['state'] != 'read_only':
                raise PreparationError('Copied checkpoint was not frozen')
            state = api('PUT', '/api/context/maintenance', {'readOnly': False, 'expectedGeneration': state['generation']})
            if state['state'] != 'writable':
                raise PreparationError('Explicit maintenance thaw failed')
            settings = api('GET', '/api/settings')
            previous_s3 = settings.get('s3', {})
            if previous_s3.get('enabled') and (not config['s3']['enabled'] or config['s3']['bucket'].lower() == previous_s3.get('bucket', '').lower()):
                raise PreparationError('Remote originals require a different clone bucket or endpoint')
            api('PATCH', '/api/settings', {'meta': {'appURL': config['clone_url']}, 's3': config['s3'], 'superuserIPs': [],
                'smtp': {'enabled': False, 'host': '', 'port': 587, 'username': '', 'password': '', 'authMethod': 'PLAIN', 'tls': False, 'localName': ''},
                'backups': {'cron': '', 's3': {'enabled': False, 'bucket': '', 'endpoint': '', 'region': '', 'accessKey': '', 'secret': '', 'forcePathStyle': False}}})
            collection = api('GET', '/api/collections/users')
            alternative_auth = {'oauth2': {'enabled': False, 'providers': []}, 'otp': {'enabled': False}, 'mfa': {'enabled': False}, 'passwordAuth': {'enabled': True, 'identityFields': ['email']}}
            security = dict(alternative_auth)
            for name in ('authToken', 'passwordResetToken', 'emailChangeToken', 'verificationToken', 'fileToken'):
                security[name] = dict(collection[name], secret=secrets.token_urlsafe(40))
            api('PATCH', '/api/collections/users', security)
            allowed = {u['email'].lower(): u['password'] for u in config.get('test_users', [])}
            found, page = set(), 1
            while True:
                users = api('GET', f'/api/collections/users/records?page={page}&perPage=200')
                for user in users['items']:
                    password = allowed.get(user['email'].lower())
                    change = {'disabled': password is None}
                    if password:
                        found.add(user['email'].lower()); change.update(password=password, passwordConfirm=password)
                    api('PATCH', '/api/collections/users/records/' + user['id'], change)
                if page >= users['totalPages']:break
                page += 1
            if found != set(allowed):
                raise PreparationError('A selected test identity does not exist in the checkpoint')
            operator_collection = api('GET', '/api/collections/_superusers')
            api('PATCH', '/api/collections/_superusers', alternative_auth)
            operators, page = [], 1
            while True:
                records = api('GET', f'/api/collections/_superusers/records?page={page}&perPage=200')
                operators.extend(records['items'])
                if page >= records['totalPages']:break
                page += 1
            selected = None
            for operator in operators:
                if operator['email'].lower() == config['operator_email'].lower():
                    selected = operator
                    continue
                password = secrets.token_urlsafe(40)
                api('PATCH', '/api/collections/_superusers/records/' + operator['id'], {'password': password, 'passwordConfirm': password})
            if selected is None:raise PreparationError('Selected operator disappeared')
            # Password reset revokes the temporary token. Authenticate the new
            # clone password, then rotate all copied signing authority last.
            api('PATCH', '/api/collections/_superusers/records/' + selected['id'],
                {'password': config['operator_password'], 'passwordConfirm': config['operator_password']})
            refreshed = api('POST', '/api/collections/_superusers/auth-with-password', {'identity': config['operator_email'], 'password': config['operator_password']}, bearer='')
            token = refreshed['token']
            operator_security = {}
            for name in ('authToken', 'passwordResetToken', 'emailChangeToken', 'verificationToken', 'fileToken'):
                operator_security[name] = dict(operator_collection[name], secret=secrets.token_urlsafe(40))
            api('PATCH', '/api/collections/_superusers', operator_security)
            receipt = {'version': 1, 'network_isolation': 'new-loopback-only-namespace', 'maintenance': 'writable',
                       'maintenance_generation': state['generation'], 'application_hooks_executed': False,
                       'replica_publisher_started': False, 'smtp_disabled': True, 'oauth_disabled': True,
                       'copied_sessions_revoked': True, 'test_users_enabled': len(found), 'remote_originals_verified': False,
                       'ready_for_public_traffic': False, 'clone_url': config['clone_url'],
                       'storage_binding_sha256': hashlib.sha256(json.dumps(config['s3'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
        finally:
            token = ''
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
        Path(request['receipt']).write_text(json.dumps(receipt))
        Path(request['receipt']).chmod(0o600)
        os.chown(request['receipt'], request['owner_uid'], request['owner_gid'])
        for path in [data, *data.rglob('*')]:
            os.chown(path, request['owner_uid'], request['owner_gid'])


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '_worker':
        worker(sys.argv[2]); return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, help='Exact old compatible PocketContext binary')
    parser.add_argument('--checkpoint', required=True, help='Stopped frozen checkpoint pb_data directory')
    parser.add_argument('--destination', required=True, help='New separate clone pb_data directory')
    parser.add_argument('--private-config', required=True, help='Mode-0600 clone bindings JSON')
    args = parser.parse_args()
    receipt = prepare(args.binary, args.checkpoint, args.destination, args.private_config)
    print(json.dumps({key: receipt[key] for key in ('version', 'network_isolation', 'maintenance', 'source_unchanged', 'domain_unchanged', 'original_files_unchanged', 'copied_sessions_revoked', 'ready_for_public_traffic')}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except PreparationError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Native/API exception text can carry persisted credentials. Emit no raw
        # exception, subprocess output, settings object or request/response body.
        print('Clone preparation failed; preserve the private destination and review prerequisites.', file=sys.stderr)
        sys.exit(1)
