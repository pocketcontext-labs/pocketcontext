#!/usr/bin/env python3
"""Synthetic isolated proof of frozen-clone preparation and session isolation."""
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from integration import ROOT, credentials

spec = importlib.util.spec_from_file_location('prepare_clone', ROOT / 'tools/prepare_clone.py')
clone = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clone)


@contextlib.contextmanager
def serve(binary, app, data, *, initialize=False, env=None):
    common = [str(Path(binary).resolve()), '--dir', str(data), '--hooksDir', str(app / 'pb_hooks'), '--migrationsDir', str(app / 'pb_migrations')]
    if initialize:
        result = subprocess.run(common + ['superuser', 'upsert', 'admin@example.com', 'SyntheticAdminPassword123!'], cwd=app, capture_output=True)
        assert result.returncode == 0, 'synthetic server setup failed'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    process = subprocess.Popen(common + ['serve', '--http', f'127.0.0.1:{port}'], cwd=app, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def request(method, path, body=None, token=None, expected=200):
        call = urllib.request.Request(f'http://127.0.0.1:{port}' + path, data=None if body is None else json.dumps(body).encode(), method=method,
            headers={'Content-Type': 'application/json', 'Authorization': token or ''})
        try:
            with urllib.request.urlopen(call, timeout=20) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as error:status, raw = error.code, error.read()
        assert status in (expected if isinstance(expected, tuple) else (expected,)), (method, path, status)
        return json.loads(raw) if raw else None
    request.base_url = f'http://127.0.0.1:{port}'
    try:
        for _ in range(100):
            assert process.poll() is None, 'synthetic server failed startup'
            try:request('GET', '/api/health');break
            except (OSError, AssertionError):time.sleep(.1)
        else:raise AssertionError('synthetic startup timeout')
        yield request
    finally:
        process.terminate(); process.wait(timeout=15)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--binary', required=True); parser.add_argument('--fixture-app', type=Path, default=ROOT); args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='wiki-clone-test-') as temporary:
        directory = Path(temporary)
        source, checkpoint = directory / 'source', directory / 'checkpoint'
        with serve(args.binary, args.fixture_app, source, initialize=True) as request:
            admin, user, token = credentials(request)
            other = request('POST', '/api/collections/users/records', {'name': 'Disabled in clone', 'email': 'other@example.com', 'password': 'SyntheticOtherPassword123!', 'passwordConfirm': 'SyntheticOtherPassword123!'}, admin)
            other_token = request('POST', '/api/collections/users/auth-with-password', {'identity': 'other@example.com', 'password': 'SyntheticOtherPassword123!'})['token']
            record = request('POST', '/api/collections/pages/records', {'slug': 'clone-evidence', 'kind': 'concept'}, token)
            boundary = 'clone-synthetic-evidence'
            payload = b''
            for name, value in {'title': 'Synthetic clone original', 'original_name': 'evidence.txt', 'media_type': 'text/plain'}.items():
                payload += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            payload += f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\nSynthetic clone original.\r\n--{boundary}--\r\n'.encode()
            upload = urllib.request.Request(request.base_url + '/api/collections/sources/records', data=payload, headers={'Authorization': token, 'Content-Type': 'multipart/form-data; boundary=' + boundary}, method='POST')
            with urllib.request.urlopen(upload, timeout=20) as response:json.load(response)
            request('PATCH', '/api/settings', {'meta': {'appURL': 'https://production.invalid'}, 'smtp': {'enabled': True, 'host': 'production.invalid', 'port': 587, 'username': 'synthetic-production-smtp', 'password': 'synthetic-production-secret', 'authMethod': 'PLAIN', 'tls': True},
                'backups': {'cron': '', 's3': {'enabled': True, 'bucket': 'production-backups', 'endpoint': 'https://production.invalid', 'region': 'auto', 'accessKey': 'synthetic-backup-key', 'secret': 'synthetic-backup-secret'}}}, admin)
            for collection in ('users', '_superusers'):
                request('PATCH', '/api/collections/' + collection, {'oauth2': {'enabled': True, 'providers': [{'name': 'google', 'clientId': 'synthetic-production-client', 'clientSecret': 'synthetic-production-oauth-secret'}]}, 'otp': {'enabled': True}, 'mfa': {'enabled': True, 'rule': ''}}, admin)
            status = request('GET', '/api/context/maintenance', token=admin)
            frozen = request('PUT', '/api/context/maintenance', {'readOnly': True, 'expectedGeneration': status['generation']}, admin)
            assert frozen['state'] == 'read_only'
        # Only capture once the source server has stopped and drained SQLite.
        domain = clone.domain_hashes(source)
        shutil.copytree(source, checkpoint)
        private = directory / 'clone.json'
        config = {'clone_url': 'http://wiki-clone.localhost', 'operator_email': 'admin@example.com',
            'operator_password': 'SyntheticCloneOperatorPassword123!',
            's3': {'enabled': False, 'bucket': '', 'endpoint': '', 'region': '', 'accessKey': '', 'secret': '', 'forcePathStyle': False},
            'test_users': [{'email': 'agent@example.com', 'password': 'SyntheticCloneReaderPassword123!'}]}
        private.write_text(json.dumps(config)); private.chmod(0o600)
        before = {str(p.relative_to(checkpoint)): clone.digest(p) for p in checkpoint.rglob('*') if p.is_file()}
        receipt = clone.prepare(args.binary, checkpoint, directory / 'prepared', private)
        assert receipt['source_unchanged'] and receipt['original_files_unchanged'] and receipt['domain_unchanged']
        assert receipt['network_isolation'] == 'new-loopback-only-namespace'
        assert receipt['maintenance_generation'] == frozen['generation'] + 1
        assert receipt['copied_sessions_revoked'] and not receipt['ready_for_public_traffic']
        assert before == {str(p.relative_to(checkpoint)): clone.digest(p) for p in checkpoint.rglob('*') if p.is_file()}
        assert domain == clone.domain_hashes(directory / 'prepared')
        assert json.loads((checkpoint / 'maintenance.json').read_text())['readOnly'] is True
        assert json.loads((directory / 'prepared/maintenance.json').read_text())['readOnly'] is False
        # Inspect exact persisted synthetic secret-bearing fields only inside this process.
        with sqlite3.connect((directory / 'prepared/data.db').as_uri() + '?mode=ro', uri=True) as database:
            settings = json.loads(database.execute("SELECT value FROM _params WHERE id='settings'").fetchone()[0])
            assert not settings['smtp']['enabled'] and not settings['smtp']['password'] and not settings['smtp']['username']
            assert not settings['backups']['s3']['enabled'] and not settings['backups']['s3'].get('secret') and not settings['backups']['s3']['accessKey']
        # No helper superuser-upsert here: new clone password must really work.
        with serve(args.binary, args.fixture_app, directory / 'prepared') as request:
            request('POST', '/api/context/query', {'sql': 'SELECT id FROM pages'}, token, (401, 403))
            request('POST', '/api/context/query', {'sql': 'SELECT id FROM pages'}, other_token, (401, 403))
            request('GET', '/api/context/maintenance', token=admin, expected=(401, 403))
            new_admin = request('POST', '/api/collections/_superusers/auth-with-password', {'identity': 'admin@example.com', 'password': config['operator_password']})['token']
            assert request('GET', '/api/collections/users/records/' + other['id'], token=new_admin)['disabled']
            for collection in ('users', '_superusers'):
                metadata = request('GET', '/api/collections/' + collection, token=new_admin)
                assert not metadata['oauth2']['enabled'] and not metadata['oauth2']['providers']
                assert not metadata['otp']['enabled'] and not metadata['mfa']['enabled']
            restored = request('POST', '/api/collections/users/auth-with-password', {'identity': 'agent@example.com', 'password': 'SyntheticCloneReaderPassword123!'})['token']
            assert request('POST', '/api/context/query', {'sql': 'SELECT id FROM pages'}, restored)['rows'] == [[record['id']]]
        # A separate frozen fixture has remote production-like bindings, but no
        # network request is needed to prepare it or reject reused authority.
        remote_source = directory / 'remote-source'
        shutil.copytree(checkpoint, remote_source)
        production_storage = {'enabled': True, 'bucket': 'production-originals', 'endpoint': 'https://production.invalid', 'region': 'auto', 'accessKey': 'synthetic-source-access', 'secret': 'synthetic-source-secret', 'forcePathStyle': True}
        with serve(args.binary, args.fixture_app, remote_source) as request:
            state = request('GET', '/api/context/maintenance', token=admin)
            request('PUT', '/api/context/maintenance', {'readOnly': False, 'expectedGeneration': state['generation']}, admin)
            request('PATCH', '/api/settings', {'s3': production_storage}, admin)
            state = request('GET', '/api/context/maintenance', token=admin)
            request('PUT', '/api/context/maintenance', {'readOnly': True, 'expectedGeneration': state['generation']}, admin)
        clone_storage = dict(production_storage, bucket='clone-originals', endpoint='https://clone.invalid', accessKey='synthetic-clone-access', secret='synthetic-clone-secret')
        remote_config = dict(config, s3=clone_storage)
        private.write_text(json.dumps(remote_config))
        remote_receipt = clone.prepare(args.binary, remote_source, directory / 'remote-prepared', private)
        assert remote_receipt['source_unchanged'] and not remote_receipt['remote_originals_verified']
        for field in ('bucket', 'accessKey', 'secret'):
            bad = dict(remote_config, s3=dict(clone_storage, **{field: production_storage[field]}))
            private.write_text(json.dumps(bad))
            try:clone.prepare(args.binary, remote_source, directory / ('reused-' + field), private);raise AssertionError('reused source storage authority accepted')
            except clone.PreparationError:pass
            assert not (directory / ('reused-' + field + '.preparation.json')).exists()
        for label, bad in [('operator', dict(config, operator_password='SyntheticAdminPassword123!')),
                           ('reader', dict(config, test_users=[{'email': 'agent@example.com', 'password': 'SyntheticUserPassword123!'}]))]:
            private.write_text(json.dumps(bad))
            try:clone.prepare(args.binary, checkpoint, directory / ('same-password-' + label), private);raise AssertionError('source password reused')
            except clone.PreparationError:pass
        private.write_text(json.dumps(config))
        for target, mutate in [('prepared', lambda: None), ('unsafe', lambda: private.chmod(0o644))]:
            mutate()
            try:clone.prepare(args.binary, checkpoint, directory / target, private);raise AssertionError('unsafe preparation accepted')
            except clone.PreparationError:pass
        private.chmod(0o600)
        for url in ('https://wiki.pocketcontext.com', 'https://wiki-demo.pocketcontext.com.', 'https://other.pocketcontext.com'):
            try:clone.checked_config(dict(config, clone_url=url));raise AssertionError('production-domain origin accepted')
            except clone.PreparationError:pass
        wrong = dict(config, operator_email='absent@example.com')
        private.write_text(json.dumps(wrong))
        try:clone.prepare(args.binary, checkpoint, directory / 'failed', private);raise AssertionError('absent operator accepted')
        except clone.PreparationError:pass
        assert not (directory / 'failed.preparation.json').exists()
    print('PASS: stopped frozen clone, fresh private maintenance authentication, API thaw/rebind, source/domain/original equality, all copied sessions revoked, alternate auth disabled and failed preflight guards')


if __name__ == '__main__':main()
