#!/usr/bin/env python3
"""Migrate a populated synthetic shared wiki without rewriting original history."""
import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASELINE = '7cf5d4548fd22a7cb250adbd4034f1060c9bd53e'
DOMAIN = ['sources', 'renditions', 'passages', 'ingestion_runs', 'pages', 'page_revisions',
          'citations', 'page_links', 'publications', 'audit_log']
ADMIN = {'identity': 'admin@example.com', 'password': 'SyntheticAdminPassword123!'}
PASSWORD = 'SyntheticMigrationPassword123!'


@contextlib.contextmanager
def serve(binary, application, data):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    common = [binary, '--dir', str(data), '--migrationsDir', str(application / 'pb_migrations'),
              '--hooksDir', str(application / 'pb_hooks')]
    result = subprocess.run(common + ['superuser', 'upsert', ADMIN['identity'], ADMIN['password']],
                            cwd=application, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    with tempfile.TemporaryFile(mode='w+') as log:
        proc = subprocess.Popen(common + ['serve', '--http', f'127.0.0.1:{port}'], cwd=application, stdout=log, stderr=log)
        base = f'http://127.0.0.1:{port}'
        def request(method, path, body=None, token=None, expected=200, content_type='application/json'):
            headers = {'Content-Type': content_type}
            if token:
                headers['Authorization'] = token
            raw = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(base + path, data=raw, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=20) as response:
                    status, raw = response.status, response.read()
            except urllib.error.HTTPError as error:
                status, raw = error.code, error.read()
            assert status == expected, (method, path, status, raw)
            return json.loads(raw) if raw else None
        try:
            for _ in range(150):
                try:
                    request('GET', '/api/health')
                    break
                except (OSError, AssertionError):
                    if proc.poll() is not None:
                        log.seek(0)
                        raise AssertionError(log.read())
                    time.sleep(.1)
            else:
                raise AssertionError('Server startup timed out')
            yield request
        finally:
            proc.terminate()
            proc.wait(timeout=15)


def snapshot(data):
    # Read only, synthetic fixture: compare every historical column exactly.
    with sqlite3.connect(f'file:{data / "data.db"}?mode=ro', uri=True) as db:
        rows = {}
        for table in DOMAIN:
            columns = [row[1] for row in db.execute(f'PRAGMA table_info({table})') if row[1] != 'space']
            rows[table] = (columns, db.execute('SELECT ' + ','.join('"' + c + '"' for c in columns) + f' FROM {table} ORDER BY id').fetchall())
        return rows


def files(data):
    return {str(p.relative_to(data)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (data / 'storage').rglob('*') if p.is_file()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    with tempfile.TemporaryDirectory(prefix='wiki-spaces-migration-') as tmp:
        temporary = Path(tmp)
        legacy = temporary / 'legacy'
        legacy.mkdir()
        archived = subprocess.check_output(['git', 'archive', BASELINE, 'pb_hooks', 'pb_migrations', 'pocketcontext.json'], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archived)) as archive:
            archive.extractall(legacy, filter='data')
        data = temporary / 'pb_data'
        path = lambda table: '/api/collections/' + table + '/records'
        with serve(binary, legacy, data) as request:
            admin = request('POST', '/api/collections/_superusers/auth-with-password', ADMIN)['token']
            identities = []
            for name, disabled in [('active', False), ('disabled', True)]:
                user = request('POST', path('users'), {'name': 'Synthetic ' + name, 'email': name + '@example.test', 'password': PASSWORD,
                               'passwordConfirm': PASSWORD, 'disabled': disabled}, admin)
                identities.append(user)
            token = request('POST', '/api/collections/users/auth-with-password', {'identity': 'active@example.test', 'password': PASSWORD})['token']
            create = lambda table, body: request('POST', path(table), body, token)
            boundary = 'synthetic-migration-boundary'
            payload = b''
            for name, value in {'title': 'Preserved evidence', 'original_name': 'evidence.txt', 'media_type': 'text/plain'}.items():
                payload += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            payload += f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode() + b'Synthetic preserved original.\n' + f'\r\n--{boundary}--\r\n'.encode()
            source = request('POST', path('sources'), payload, token, content_type='multipart/form-data; boundary=' + boundary)
            rendition = create('renditions', {'source': source['id'], 'kind': 'text', 'processor': 'synthetic', 'version_label': 'v1'})
            passage = create('passages', {'rendition': rendition['id'], 'ordinal': 1, 'locator': 'document', 'body': 'Synthetic evidence.'})
            page = create('pages', {'slug': 'preserved-page', 'kind': 'concept'})
            run = create('ingestion_runs', {'key': 'published', 'status': 'staging', 'description': 'Synthetic migration', 'sources': [source['id']], 'home': page['id'], 'home_base': ''})
            revision = create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': 'Preserved', 'summary': 'Synthetic summary', 'body': 'Synthetic claim.[^1]'})
            create('citations', {'page_revision': revision['id'], 'passage': passage['id'], 'marker': '1'})
            create('page_links', {'page_revision': revision['id'], 'target': page['id']})
            request('PATCH', path('ingestion_runs') + '/' + run['id'], {'status': 'published', 'expected_revision': 1}, token)
            draft = create('ingestion_runs', {'key': 'draft', 'status': 'staging', 'description': 'Synthetic migration'})
            create('page_revisions', {'run': draft['id'], 'page': page['id'], 'base_revision': revision['id'], 'title': 'Draft', 'summary': 'Synthetic summary', 'body': 'Draft [needs verification].'})
        before, original_files = snapshot(data), files(data)
        assert original_files
        # Inject a failure after the backfill to prove the migration is atomic.
        failing = temporary / 'failure'
        failing.mkdir()
        shutil.copytree(ROOT / 'pb_migrations', failing / 'pb_migrations')
        shutil.copytree(ROOT / 'pb_hooks', failing / 'pb_hooks')
        shutil.copyfile(ROOT / 'pocketcontext.json', failing / 'pocketcontext.json')
        migration = failing / 'pb_migrations' / '1791500000_spaces.js'
        migration.write_text(migration.read_text().replace("}, () => { throw", "  throw new Error('Synthetic migration failure');\n}, () => { throw"))
        failed = subprocess.run([binary, '--dir', str(data), '--migrationsDir', str(failing / 'pb_migrations'),
                                 '--hooksDir', str(failing / 'pb_hooks'), 'migrate', 'up'],
                                cwd=failing, capture_output=True, text=True)
        assert failed.returncode != 0 and 'Synthetic migration failure' in failed.stdout + failed.stderr
        assert snapshot(data) == before and files(data) == original_files
        with sqlite3.connect(f'file:{data / "data.db"}?mode=ro', uri=True) as db:
            assert not db.execute("SELECT name FROM sqlite_master WHERE name = 'spaces'").fetchall()
        with serve(binary, ROOT, data) as request:
            assert snapshot(data) == before, 'Migration changed original historical fields'
            assert files(data) == original_files, 'Migration changed originals'
            admin = request('POST', '/api/collections/_superusers/auth-with-password', ADMIN)['token']
            token = request('POST', '/api/collections/users/auth-with-password', {'identity': 'active@example.test', 'password': PASSWORD})['token']
            def rows(sql):
                result = request('POST', '/api/context/query', {'sql': sql}, token)
                return [dict(zip(result['columns'], row)) for row in result['rows']]
            for table in DOMAIN:
                assert rows(f"SELECT count(*) AS n FROM {table} WHERE space != 'companyspace001'") == [{'n': 0}]
            assert rows("SELECT id, kind FROM spaces") == [{'id': 'companyspace001', 'kind': 'group'}]
            memberships = request('GET', path('space_members'), token=admin)['items']
            assert {(m['account'], m['active'], m['role']) for m in memberships} == {(identities[0]['id'], True, 'editor'), (identities[1]['id'], False, 'editor')}
            member = next(m for m in memberships if m['active'])
            request('PATCH', path('space_members') + '/' + member['id'], {'active': False, 'expected_revision': 1}, admin)
            request('POST', '/api/collections/users/auth-refresh', {}, token)
            assert rows('SELECT id FROM spaces') == []
            request('PATCH', path('space_members') + '/' + member['id'], {'active': True, 'expected_revision': 2}, admin)
            assert rows('SELECT id FROM pages') == [{'id': page['id']}]
        after = snapshot(data)
        with serve(binary, ROOT, data):
            assert snapshot(data) == after, 'Restart changed history'
            assert files(data) == original_files
    print('PASS: populated company-space migration preserves every original domain field and file; active/disabled membership, revocation, operator restoration and restart')


if __name__ == '__main__':
    main()
