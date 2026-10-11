#!/usr/bin/env python3
"""Checks of the WikiContext container image. Python 3 standard library and the docker CLI only.

  python3 docker/smoke.py smoke   --image IMAGE   start as ONCE does, provision an user, exercise REST and SQL, stop, start again
  python3 docker/smoke.py config  --image IMAGE   startup errors for missing or unusable Litestream configuration
  python3 docker/smoke.py restore --image IMAGE   replicate to MinIO, destroy container and volume, restore into an empty volume

Every step prints a `==>` line before it runs and every docker command is printed. Secrets reach docker through the
environment (`-e NAME`), never through the command line, and are masked in everything this script prints. On failure
the script prints the masked logs of every container it started, then removes its containers, volumes, and network.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
# Official binary images were withdrawn. Build the pinned upstream sources locally
# for this isolated test; see minio.Dockerfile for immutable source/base pins.
MINIO_IMAGE = 'wikicontext-minio-fixture:9e49d5e-7394ce0'
STOP_LIMIT = 55  # seconds. `docker stop` waits 10 seconds by default before it kills.
JWT = re.compile(r'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}')

hidden = []      # secret values: masked in output, searched for in container logs
containers = []  # every container started, for the failure report and cleanup
volumes = []
networks = []


class Failure(Exception):
    pass


def secret(value):
    """Register a secret value. Returns it."""
    if value and value not in hidden:
        hidden.append(value)
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            print(f'::add-mask::{value}', flush=True)
    return value


def mask(text):
    for value in hidden:
        text = text.replace(value, '***')
    return JWT.sub('***JWT***', text)


def say(text=''):
    print(mask(text), flush=True)


def step(text):
    say(f'==> {text}')


def check(condition, text):
    if not condition:
        raise Failure(text)
    say(f'    ok: {text}')


def docker(*args, env=None, ok=True, timeout=300):
    """Run docker. Returns (exit status, stdout + stderr). `env` adds variables to docker's own environment."""
    say('    $ docker ' + ' '.join(args))
    try:
        done = subprocess.run(['docker', *args], env={**os.environ, **(env or {})}, text=True, errors='replace',
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise Failure(f'docker {args[0]} did not finish within {timeout} seconds. Output so far:\n{error.stdout or ""}')
    if ok and done.returncode != 0:
        raise Failure(f'docker {args[0]} exited with status {done.returncode}:\n{done.stdout}')
    return done.returncode, done.stdout


def logs(name):
    return docker('logs', name, ok=False)[1]


def state(name):
    """Returns (running, exit status)."""
    status, text = docker('inspect', '-f', '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}', name, ok=False)
    if status != 0:
        raise Failure(f'container {name} cannot be inspected:\n{text}')
    running, code, oom = text.split()
    check(oom == 'false', f'{name} was not killed for memory')
    return running == 'true', int(code)


def run_app(image, name, volume, env, network=None, command=()):
    """Start the image detached with a named volume at /storage and port 80 published on a free local port."""
    docker('volume', 'create', volume)
    if volume not in volumes:
        volumes.append(volume)
    args = ['run', '-d', '--name', name, '-p', '127.0.0.1::80', '-v', f'{volume}:/storage']
    if network:
        args += ['--network', network]
    for key in env:
        args += ['-e', key]
    containers.append(name)
    docker(*args, image, *command, env=env)


def http(method, url, body=None, token=None, headers=None):
    """Returns (status, headers, parsed JSON or text). Status 0 means no HTTP response."""
    request = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode())
    if body is not None:
        request.add_header('Content-Type', 'application/json')
    if token:
        request.add_header('Authorization', token)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status, reply, raw = response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        status, reply, raw = error.code, error.headers, error.read()
    except (OSError, urllib.error.URLError) as error:
        return 0, {}, str(error)
    text = raw.decode(errors='replace')
    try:
        return status, reply, json.loads(text)
    except ValueError:
        return status, reply, text


def wait_up(name, limit=120):
    """Wait for GET /up. Fails early when the container exits. Returns the base URL."""
    step(f'waiting up to {limit} seconds for GET /up on {name}')
    deadline, last = time.time() + limit, ''
    while time.time() < deadline:
        running, code = state_quiet(name)
        if not running:
            raise Failure(f'{name} exited with status {code} before /up answered')
        base = base_url_quiet(name)
        if base:
            status, _, body = http('GET', base + '/up')
            last = f'status {status}, body {str(body)[:200]!r}'
            if status == 200:
                check(True, f'/up answered 200 without credentials at {base}')
                return base
        time.sleep(1)
    raise Failure(f'/up did not answer 200 within {limit} seconds; last answer: {last}')


def state_quiet(name):
    done = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', name], text=True, capture_output=True)
    if done.returncode != 0:
        raise Failure(f'container {name} cannot be inspected: {done.stderr}')
    running, code = done.stdout.split()
    return running == 'true', int(code)


def base_url_quiet(name):
    done = subprocess.run(['docker', 'port', name, '80/tcp'], text=True, capture_output=True)
    match = re.search(r'127\.0\.0\.1:(\d+)', done.stdout)
    return f'http://127.0.0.1:{match.group(1)}' if match else ''


def superuser_token(base, email, password):
    status, _, body = http('POST', base + '/api/collections/_superusers/auth-with-password', {'identity': email, 'password': password})
    if status != 200 or not isinstance(body, dict) or not body.get('token'):
        raise Failure(f'superuser login answered {status}: {str(body)[:500]}')
    check(True, 'superuser login with WIKICONTEXT_SUPERUSER_EMAIL and WIKICONTEXT_SUPERUSER_PASSWORD')
    return secret(body['token'])


def provision_user(base, token, email, password):
    status, _, body = http('POST', base + '/api/collections/users/records', token=token,
                           body={'name': 'Image check user', 'email': email, 'password': password, 'passwordConfirm': password})
    if status != 200 or not isinstance(body, dict) or not body.get('id'):
        raise Failure(f'creating the user with the superuser token answered {status}: {str(body)[:500]}')
    check(True, 'user created with the superuser token')
    return body['id']


class Client:
    """An ordinary default-users identity using REST writes and authenticated SQL reads."""

    def __init__(self, base, email, password, home):
        self.base = base
        status, _, body = http('POST', base + '/api/collections/users/auth-with-password',
                               {'identity': email, 'password': password})
        check(status == 200 and bool(body.get('token')), 'provisioned user can authenticate')
        self.token = secret(body['token'])
        self.user = body['record']

    def run(self, command, *args):
        if command == 'whoami':
            return json.dumps(self.user)
        if command == 'check':
            status, _, body = http('GET', self.base + '/api/context/schema', token=self.token)
        elif command == 'create':
            status, _, body = http('POST', self.base + '/api/collections/' + args[0] + '/records',
                                   json.loads(args[1]), token=self.token)
        else:
            raise Failure('unsupported smoke client operation')
        check(status == 200, f'{command} answered 200')
        return json.dumps(body)

    def sql(self, query):
        status, _, body = http('POST', self.base + '/api/context/query', {'sql': query}, token=self.token)
        check(status == 200, 'authenticated SQL query succeeded')
        return body['rows']


EVIDENCE = b'Synthetic knowledge source. No real wiki data.\n'


def write_record(client, user_id, space='companyspace001'):
    boundary = 'wikicontext-' + secrets.token_hex(12)
    body = bytearray()
    for name, value in {'space': space, 'title': 'Synthetic knowledge source', 'original_name': 'source.txt', 'media_type': 'text/plain'}.items():
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="source.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode())
    evidence = EVIDENCE + secrets.token_hex(12).encode()
    body.extend(evidence)
    body.extend(f'\r\n--{boundary}--\r\n'.encode())
    request = urllib.request.Request(client.base + '/api/collections/sources/records', data=bytes(body),
        headers={'Authorization': client.token, 'Content-Type': 'multipart/form-data; boundary=' + boundary})
    with urllib.request.urlopen(request, timeout=15) as response:
        record = json.load(response)
    # Persist searchable knowledge too so every populated restore gate verifies FTS.
    def create(table, data):
        return json.loads(client.run('create', table, json.dumps(data)))
    run = create('ingestion_runs', {'space': space, 'key': 'restore-' + record['id'], 'status': 'staging',
        'description': 'Synthetic search recovery fixture'})
    page = create('pages', {'space': space, 'slug': 'restore-' + record['id'], 'kind': 'concept'})
    create('page_revisions', {'run': run['id'], 'page': page['id'],
        'title': 'Synthetic searchable recovery', 'summary': 'Synthetic restoration check',
        'body': 'recoverycheck' + record['id'] + ' [needs verification]'})
    status, _, published = http('PATCH', client.base + '/api/collections/ingestion_runs/records/' + run['id'],
        {'status': 'published', 'expected_revision': run['revision']}, token=client.token)
    check(status == 200 and published.get('status') == 'published', 'synthetic search fixture published')
    return record['id'], (record['collectionId'], record['original'], evidence)


def check_records(client, document, metadata, space='companyspace001'):
    rows = client.sql(f"SELECT title FROM sources WHERE id = '{document}'")
    check(rows == [['Synthetic knowledge source']], 'synthetic source survives persistence and restore')
    selected = client.sql(f"""SELECT pub.id,r.id FROM publications pub
        JOIN json_each(pub.manifest) member
        JOIN pages p ON p.id=member.key
        JOIN page_revisions r ON r.id=member.value AND r.page=p.id
        WHERE pub.space='{space}' AND p.slug='restore-{document}' AND r.archived=false ORDER BY pub.sequence DESC LIMIT 1""")
    check(len(selected) == 1, 'published revision survives persistence and restore')
    status, headers, results = http('POST', client.base + '/api/context/search',
        {'index': 'pages', 'scope': selected[0][0], 'query': 'recoverycheck' + document}, token=client.token)
    check(status == 200 and bool(re.fullmatch(r'[0-9a-f]{64}', results.get('generation', '')))
          and results.get('scope') == selected[0][0]
          and [hit['id'] for hit in results.get('hits', [])] == [selected[0][1]]
          and not results.get('hasMore'), 'scoped FTS result and generation recovered')
    status, _, continuation = http('POST', client.base + '/api/context/search',
        {'index': 'pages', 'scope': selected[0][0], 'query': 'recoverycheck' + document,
         'offset': 1, 'expectedGeneration': results['generation']}, token=client.token)
    check(status == 200 and continuation.get('generation') == results['generation']
          and continuation.get('hits') == [], 'restored search generation supports consistent pagination')
    collection, filename, evidence = metadata
    status, _, token = http('POST', client.base + '/api/files/token', {}, token=client.token)
    check(status == 200, 'admitted user receives protected file token')
    path = f'/api/files/{collection}/{document}/{filename}'
    status, _, _ = http('GET', client.base + path)
    check(status in (400, 403, 404), 'anonymous original download is denied')
    with urllib.request.urlopen(client.base + path + '?token=' + token['token'], timeout=15) as response:
        check(response.read() == evidence, 'protected original bytes recovered exactly')


def maintenance_roundtrip(name, base, admin, client, document, metadata):
    """Exercise the real entrypoint with a durable freeze and existing sessions."""
    step('freezing application writes through the superuser maintenance API')
    endpoint = '/api/context/maintenance'
    status, _, current = http('GET', base + endpoint, token=admin)
    check(status == 200 and current.get('state') == 'writable', 'maintenance starts writable')
    change = {'readOnly': True, 'expectedGeneration': current['generation']}
    status, _, _ = http('PUT', base + endpoint, change, token=client.token)
    check(status in (401, 403), 'ordinary users cannot freeze the application')
    status, _, frozen = http('PUT', base + endpoint, change, token=admin)
    check(status == 200 and frozen.get('state') == 'read_only', 'freeze finishes before acknowledgement')

    def verify_frozen():
        status, _, state = http('GET', client.base + endpoint, token=admin)
        check(status == 200 and state.get('state') == 'read_only'
              and state.get('generation') == frozen['generation'], 'durable freeze generation is preserved')
        check_records(client, document, metadata)
        status, _, refreshed = http('POST', client.base + '/api/collections/users/auth-refresh', {}, token=client.token)
        check(status == 200 and bool(refreshed.get('token')), 'existing user sessions refresh while frozen')
        secret(refreshed['token'])
        for identity in (client.token, admin):
            status, _, _ = http('POST', client.base + '/api/collections/pages/records',
                {'slug': 'blocked-maintenance-write', 'kind': 'concept'}, token=identity)
            check(status == 503, 'ordinary and superuser content writes are blocked')
            status, _, _ = http('POST', client.base + '/api/batch', {'requests': [
                {'method': 'POST', 'url': '/api/collections/pages/records',
                 'body': {'slug': 'blocked-maintenance-batch', 'kind': 'concept'}},
            ]}, token=identity)
            check(status == 503, 'batch writes are blocked during maintenance')
        status, _, _ = http('POST', client.base + '/api/collections/users/auth-with-password', {})
        check(status == 503, 'new password logins are unavailable while frozen')

    verify_frozen()
    stop(name)
    step('restarting the frozen container without provisioning or restoring its database')
    docker('start', name)
    base = wait_up(name)
    # Keep the original sessions: constructing Client would attempt password login.
    client.base = base
    verify_frozen()
    text = check_logs(name)
    check('read-only maintenance state: skipping superuser provisioning' in text,
          'frozen entrypoint skips superuser provisioning')
    status, _, _ = http('PUT', base + endpoint,
        {'readOnly': False, 'expectedGeneration': current['generation']}, token=admin)
    check(status == 409, 'stale generation cannot unfreeze the application')
    status, _, thawed = http('PUT', base + endpoint,
        {'readOnly': False, 'expectedGeneration': frozen['generation']}, token=admin)
    check(status == 200 and thawed.get('state') == 'writable', 'existing operator session explicitly unfreezes')
    status, _, _ = http('POST', base + '/api/collections/pages/records',
        {'slug': 'maintenance-thawed-' + secrets.token_hex(6), 'kind': 'concept'}, token=client.token)
    check(status == 200, 'ordinary content writes resume after explicit unfreeze')
    check_records(client, document, metadata)
    return base


def check_logs(name, text=None):
    text = logs(name) if text is None else text
    found = [index for index, value in enumerate(hidden) if value in text]
    check(not found, f'the logs of {name} contain none of the {len(hidden)} secret values of this run (matches: {len(found)})')
    check(not JWT.search(text), f'the logs of {name} contain no token')
    return text


def stop(name):
    step(f'docker stop {name}: the server must exit by itself within {STOP_LIMIT} seconds with status 0')
    start = time.time()
    docker('stop', '-t', '60', name)
    elapsed = time.time() - start
    running, code = state(name)
    check(not running and elapsed < STOP_LIMIT, f'stopped in {elapsed:.1f} seconds')
    check(code == 0, f'exit status 0 (got {code}; 137 means it was killed, 143 that the signal was not handled)')


def once_env(extra=None):
    """The variables ONCE injects, with throwaway values, plus a superuser."""
    env = {
        'BASE_URL': 'https://wiki.example.test', 'SECRET_KEY_BASE': secret(secrets.token_hex(32)), 'DISABLE_SSL': 'true', 'NUM_CPUS': '2',
        'SMTP_ADDRESS': 'smtp.example.test', 'SMTP_PORT': '587', 'SMTP_USERNAME': 'image-check', 'SMTP_PASSWORD': secret(secrets.token_urlsafe(24)),
        'MAILER_FROM_ADDRESS': 'Info <info@notifications.example.test>',
        'WIKICONTEXT_SUPERUSER_EMAIL': 'operator@example.test', 'WIKICONTEXT_SUPERUSER_PASSWORD': secret('-' + secrets.token_urlsafe(24)),
        'WIKICONTEXT_GOOGLE_CLIENT_ID': 'image-test.apps.googleusercontent.com',
        'WIKICONTEXT_GOOGLE_CLIENT_SECRET': secret(secrets.token_urlsafe(24)),
        'WIKICONTEXT_GOOGLE_WORKSPACE_DOMAIN': 'example.test',
    }
    env.update(extra or {})
    return env


def smoke(image, tmp, run_id):
    name, volume = f'wc-smoke-{run_id}', f'wc-smoke-{run_id}'
    network, env = minio_fixture(run_id)
    user_email, user_password = 'user@example.test', secret(secrets.token_urlsafe(24))

    step('explicitly initializing a synthetic database, then starting with S3 and Litestream')
    initialize(image, volume, env, network)
    run_app(image, name, volume, env, network)
    base = wait_up(name)
    step('static reader and bundled assets are available with restrictive browser headers')
    status, headers, html = http('GET', base + '/')
    check(status == 200 and isinstance(html, str) and '<div id="root"' in html, 'reader shell is served')
    check(headers.get('Cache-Control') == 'no-store', 'reader shell is never cached')
    check("script-src 'self'" in headers.get('Content-Security-Policy', '') and
          "frame-ancestors 'none'" in headers.get('Content-Security-Policy', ''), 'reader CSP is present')
    assets = re.findall(r'(?:src|href)="(/assets/[^" ]+)"', html)
    check(bool(assets), 'reader references bundled assets')
    for asset in assets:
        status, headers, body = http('GET', base + asset)
        check(status == 200 and bool(body), 'reader asset loads: ' + asset)
        check(headers.get('X-Content-Type-Options') == 'nosniff', 'asset MIME sniffing is disabled')
    status, _, _ = http('GET', base + '/assets/not-a-real-file.js')
    check(status == 404, 'missing assets do not return the reader shell')
    check(docker('exec', name, 'cat', '/proc/1/comm')[1].strip() == 'tini', 'PID 1 is tini')

    step('settings taken from the environment, read with the superuser token')
    token = superuser_token(base, env['WIKICONTEXT_SUPERUSER_EMAIL'], env['WIKICONTEXT_SUPERUSER_PASSWORD'])
    status, _, settings = http('GET', base + '/api/settings', token=token)
    check(status == 200, f'GET /api/settings answered 200 (got {status})')
    check(settings['meta']['appURL'] == env['BASE_URL'], 'meta.appURL is BASE_URL')
    check(settings['smtp']['enabled'] is True and settings['smtp']['host'] == env['SMTP_ADDRESS'], 'SMTP is enabled with SMTP_ADDRESS as host')
    check(settings['rateLimits']['enabled'] is True, "rate limits are enabled by the image's default WIKICONTEXT_RATE_LIMITS=true")
    check(env['SMTP_PASSWORD'] not in json.dumps(settings), 'the settings API does not return the SMTP password')

    status, _, collection = http('GET', base + '/api/collections/users', token=token)
    check(status == 200 and collection['oauth2']['enabled'], 'Google OAuth is enabled after migrations')
    check(collection['oauth2']['providers'][0]['clientId'] == env['WIKICONTEXT_GOOGLE_CLIENT_ID'], 'Google client ID matches the environment')
    check(env['WIKICONTEXT_GOOGLE_CLIENT_SECRET'] not in json.dumps(collection), 'the collection API does not return the Google secret')
    check(collection['createRule'] == "@request.context = 'oauth2'" and collection['passwordAuth']['enabled'], 'OAuth-only signup rule and password login are preserved')

    status, _, _ = http('POST', base + '/api/collections/users/records',
                         {'email': 'public@example.test', 'name': 'Public signup',
                          'password': 'SyntheticPublicPassword123!', 'passwordConfirm': 'SyntheticPublicPassword123!'})
    check(status in (400, 403), 'public REST signup is denied despite the OAuth-only signup rule')

    step('CORS: only BASE_URL is an allowed origin')
    _, reply, _ = http('GET', base + '/api/health', headers={'Origin': env['BASE_URL']})
    check(reply.get('Access-Control-Allow-Origin') == env['BASE_URL'], 'BASE_URL is allowed')
    _, reply, _ = http('GET', base + '/api/health', headers={'Origin': 'https://other.example.test'})
    check(reply.get('Access-Control-Allow-Origin') is None, 'another origin is not allowed')

    step('provisioning an user and exercising authenticated endpoints against the container')
    user_id = provision_user(base, token, user_email, user_password)
    client = Client(base, user_email, user_password, tmp / 'home-smoke')
    check(json.loads(client.run('whoami'))['id'] == user_id, 'ordinary user login returns the provisioned id')
    client.run('check')
    check(True, "authenticated schema endpoint is available")
    organization, unused = write_record(client, user_id)
    check_records(client, organization, unused)

    check_logs(name)
    stop(name)

    step('starting the same container again: the volume keeps the data and the superuser upsert is repeatable')
    docker('start', name)
    base = wait_up(name)
    client = Client(base, user_email, user_password, tmp / 'home-smoke-2')
    check_records(client, organization, unused)
    text = check_logs(name)
    check('pbinstall' not in text, 'the logs contain no superuser installation link')
    # The ordinary restart intentionally upserts the operator and rotates its token.
    token = superuser_token(base, env['WIKICONTEXT_SUPERUSER_EMAIL'], env['WIKICONTEXT_SUPERUSER_PASSWORD'])
    maintenance_roundtrip(name, base, token, client, organization, unused)
    stop(name)


def expect_startup_error(image, title, env, named, not_named=()):
    step(title)
    args = ['run', '--rm']
    for key in env:
        args += ['-e', key]
    status, text = docker(*args, image, env=env, ok=False, timeout=120)
    say('    output: ' + text.strip().replace('\n', '\n            '))
    check(status != 0, f'exit status is not 0 (got {status})')
    for variable in named:
        check(variable in text, f'the error names {variable}')
    for variable in not_named:
        check(variable not in text, f'the error does not name {variable}, which is set')
    check('Server started' not in text, 'the server did not start')
    check_logs('this run', text)


def config(image, tmp, run_id):
    configured = {
        'WIKICONTEXT_S3_BUCKET': 'files', 'WIKICONTEXT_S3_ENDPOINT': 'http://127.0.0.1:9',
        'WIKICONTEXT_S3_REGION': 'us-east-1', 'WIKICONTEXT_S3_ACCESS_KEY_ID': 'synthetic',
        'WIKICONTEXT_S3_SECRET_ACCESS_KEY': secret(secrets.token_hex(24)),
        'LITESTREAM_BUCKET': 'replica', 'LITESTREAM_PATH': 'test/data',
        'LITESTREAM_ENDPOINT': 'http://127.0.0.1:9', 'LITESTREAM_REGION': 'us-east-1',
        'LITESTREAM_ACCESS_KEY_ID': 'synthetic',
        'LITESTREAM_SECRET_ACCESS_KEY': secret(secrets.token_hex(24)),
    }
    for key in ('WIKICONTEXT_S3_BUCKET', 'WIKICONTEXT_S3_ENDPOINT', 'WIKICONTEXT_S3_REGION',
                'WIKICONTEXT_S3_ACCESS_KEY_ID', 'WIKICONTEXT_S3_SECRET_ACCESS_KEY',
                'LITESTREAM_BUCKET', 'LITESTREAM_PATH', 'LITESTREAM_ACCESS_KEY_ID',
                'LITESTREAM_SECRET_ACCESS_KEY'):
        expect_startup_error(image, 'missing required variable ' + key,
                             {name: value for name, value in configured.items() if name != key}, [key])
    expect_startup_error(image, 'replication cannot be disabled',
                         {**configured, 'LITESTREAM_DISABLED': 'true'}, ['LITESTREAM_DISABLED'])
    expect_startup_error(image, 'a superuser email without a password',
                         {**configured, 'WIKICONTEXT_SUPERUSER_EMAIL': 'operator@example.test'},
                         ['WIKICONTEXT_SUPERUSER_PASSWORD'])
    expect_startup_error(image, 'a Google client ID without a secret',
                         {**configured, 'WIKICONTEXT_GOOGLE_CLIENT_ID': 'synthetic.apps.googleusercontent.com'},
                         ['WIKICONTEXT_GOOGLE_CLIENT_SECRET'])
    expect_startup_error(image, 'a Google secret without a client ID',
                         {**configured, 'WIKICONTEXT_GOOGLE_CLIENT_SECRET': secret(secrets.token_hex(24))},
                         ['WIKICONTEXT_GOOGLE_CLIENT_ID'])
    step('unavailable replica must never serve an empty database')
    name = f'wc-config-{run_id}'
    run_app(image, name, name, configured)
    time.sleep(20)
    running, code = state(name)
    text = check_logs(name)
    check('starting server' not in text and 'Server started' not in text,
          'unavailable replica prevents HTTP startup')
    check(running or code != 0, 'unavailable replica retries or fails')
    # SIGTERM while recovery is pending must not leave an orphaned child.
    if running:
        started = time.monotonic()
        docker('stop', '-t', '10', name)
        running, code = state(name)
        check(not running and code != 137 and time.monotonic() - started < 10,
              'interrupted startup terminates without SIGKILL')


def minio_fixture(run_id):
    """Disposable private S3 buckets used only for synthetic container checks."""
    docker('build', '--file', str(ROOT / 'docker/minio.Dockerfile'), '--tag', MINIO_IMAGE,
           str(ROOT / 'docker'), timeout=1200)
    network, minio = 'wc-s3-' + run_id, 'wc-minio-' + run_id
    docker('network', 'create', network)
    networks.append(network)
    access, password = 'synthetic' + run_id, secret(secrets.token_hex(24))
    mc = {'MC_HOST_test': secret(f'http://{access}:{password}@127.0.0.1:9000')}
    containers.append(minio)
    docker('run', '-d', '--name', minio, '--network', network, '-e', 'MINIO_ROOT_USER',
           '-e', 'MINIO_ROOT_PASSWORD', MINIO_IMAGE, 'server', '/data',
           env={'MINIO_ROOT_USER': access, 'MINIO_ROOT_PASSWORD': password})
    for _ in range(60):
        status, _ = docker('exec', '-e', 'MC_HOST_test', minio, 'mc', 'mb', '--ignore-existing',
                           'test/files', 'test/replica', env=mc, ok=False)
        if status == 0:
            break
        time.sleep(1)
    else:
        raise Failure('synthetic MinIO fixture did not become ready')
    return network, once_env({
        'WIKICONTEXT_S3_BUCKET': 'files', 'WIKICONTEXT_S3_ENDPOINT': f'http://{minio}:9000',
        'WIKICONTEXT_S3_REGION': 'us-east-1', 'WIKICONTEXT_S3_ACCESS_KEY_ID': access,
        'WIKICONTEXT_S3_SECRET_ACCESS_KEY': password, 'LITESTREAM_BUCKET': 'replica',
        'LITESTREAM_PATH': 'test/data', 'LITESTREAM_ENDPOINT': f'http://{minio}:9000',
        'LITESTREAM_REGION': 'us-east-1', 'LITESTREAM_ACCESS_KEY_ID': access,
        'LITESTREAM_SECRET_ACCESS_KEY': password})


def initialize(image, volume, env, network):
    docker('volume', 'create', volume)
    if volume not in volumes:
        volumes.append(volume)
    args = ['run', '--rm', '--network', network, '-v', f'{volume}:/storage']
    for key in env:
        args.extend(['-e', key])
    docker(*args, image, 'init', env=env)


def restore(image, tmp, run_id):
    # Keep the historical CI command as an alias for the supported recovery drill.
    docker('build', '--file', str(ROOT / 'docker/minio.Dockerfile'), '--tag', MINIO_IMAGE,
           str(ROOT / 'docker'), timeout=1200)
    result = subprocess.run([sys.executable, str(ROOT / 'docker/object_storage_smoke.py'),
                             '--image', image, '--minio-image', MINIO_IMAGE])
    check(result.returncode == 0, 'S3 originals and strict Litestream recovery drill')


def report_and_clean(failed):
    if failed:
        for name in containers:
            if os.environ.get('GITHUB_ACTIONS') == 'true':
                say(f'::group::logs of {name}')
            text = logs(name)
            say(f'---- logs of {name} (masked) ----')
            say(text)
            say(docker('inspect', '-f', 'running: {{.State.Running}} exit: {{.State.ExitCode}} oom: {{.State.OOMKilled}}', name, ok=False)[1])
            if os.environ.get('GITHUB_ACTIONS') == 'true':
                say('::endgroup::')
    step('cleaning up')
    for name in containers:
        docker('rm', '-f', '-v', name, ok=False)
    for name in volumes:
        docker('volume', 'rm', '-f', name, ok=False)
    for name in networks:
        docker('network', 'rm', name, ok=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['smoke', 'config', 'restore'])
    parser.add_argument('--image', required=True, help='image reference that `docker run` can resolve locally')
    args = parser.parse_args()
    failed = True
    with tempfile.TemporaryDirectory(prefix='wikicontext-image-') as tmp:
        try:
            {'smoke': smoke, 'config': config, 'restore': restore}[args.mode](args.image, Path(tmp), secrets.token_hex(3))
            failed = False
        except Failure as error:
            say(f'\nFAILED: {error}')
        except Exception as error:
            say(f'\nFAILED: unexpected {type(error).__name__}: {error}')
        finally:
            report_and_clean(failed)
    say('FAILED' if failed else f'PASSED: {args.mode}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
