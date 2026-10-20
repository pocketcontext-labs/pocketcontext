#!/usr/bin/env python3
"""End-to-end test of the wikicontext binary with synthetic notes.

Runs on Linux, macOS and Windows with the standard library only. Every run uses
a temporary project folder, home and cache, and a free loopback port.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

PASSWORD = 'synthetic test password'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Wiki:
    def __init__(self, binary, root):
        self.binary, self.root = binary, root
        self.project = root / 'Cloud Drive' / 'WikiContext'
        self.project.mkdir(parents=True)
        self.db = self.project / 'wiki.db'
        home = root / 'home'
        home.mkdir()
        self.env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), XDG_CACHE_HOME=str(home / 'cache'),
                        LOCALAPPDATA=str(home / 'AppData' / 'Local'), WIKICONTEXT_DB='', WIKICONTEXT_SPACE='')
        self.env.pop('WIKICONTEXT_BUNDLE_URL', None)
        self.port = free_port()
        self.url = f'http://127.0.0.1:{self.port}'

    def run(self, *args, stdin=None, expect=0):
        result = subprocess.run([str(self.binary), '--db', str(self.db), *args], input=stdin, capture_output=True,
                                text=True, encoding='utf-8', env=self.env, timeout=120)
        if result.returncode != expect:
            raise AssertionError(f'{args}: exit {result.returncode}, expected {expect}\n{result.stdout}\n{result.stderr}')
        return result

    def json(self, *args, **kwargs):
        return json.loads(self.run(*args, **kwargs).stdout)

    def http(self, method, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()


class Remote:
    """Another computer: its own home and cache, an empty working folder and no project."""

    def __init__(self, binary, root, url):
        self.binary, self.root, self.url = binary, root, url
        home = root / 'home'
        self.work = root / 'work'
        home.mkdir(parents=True)
        self.work.mkdir()
        self.env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), XDG_CACHE_HOME=str(home / 'cache'),
                        LOCALAPPDATA=str(home / 'AppData' / 'Local'), WIKICONTEXT_DB='', WIKICONTEXT_SPACE='')
        self.env.pop('WIKICONTEXT_BUNDLE_URL', None)

    def run(self, *args, stdin=None, expect=0, url=None, env=None):
        flags = [] if url is False else ['--url', url or self.url]
        result = subprocess.run([str(self.binary), *args, *flags], input='' if stdin is None else stdin,
                                capture_output=True, text=True, encoding='utf-8', env={**self.env, **(env or {})},
                                cwd=self.work, timeout=120)
        if expect is not None and result.returncode != expect:
            raise AssertionError(f'remote {args}: exit {result.returncode}, expected {expect}\n{result.stdout}\n{result.stderr}')
        return result

    def json(self, *args, **kwargs):
        return json.loads(self.run(*args, **kwargs).stdout)

    def session(self):
        sessions = [p for p in self.root.rglob('session.json') if p.parent.name.startswith('remote-')]
        if len(sessions) != 1:
            raise AssertionError(f'expected one remote session, found {sessions}')
        return sessions[0]


class Forward:
    """A loopback TCP forward from a different local port, like a tunnel on the wrong port."""

    def __init__(self, target):
        self.target = target
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(16)
        self.listener.settimeout(0.2)
        self.port = self.listener.getsockname()[1]
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        with self.listener:
            while not self.stopped.is_set():
                try:
                    client, _ = self.listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                self.connect(client)

    def connect(self, client):
        client.settimeout(None)
        try:
            upstream = socket.create_connection(('127.0.0.1', self.target), timeout=10)
            upstream.settimeout(None)
        except OSError:
            client.close()
            return
        for src, dst in ((client, upstream), (upstream, client)):
            threading.Thread(target=self.pipe, args=(src, dst), daemon=True).start()

    @staticmethod
    def pipe(src, dst):
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            for sock in (src, dst):
                try:
                    sock.close()
                except OSError:
                    pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stopped.set()
        self.thread.join(timeout=5)


def http_status(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=2):
            return True
    except OSError:
        return False


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print('ok -', message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True, type=Path)
    binary = parser.parse_args().binary.resolve()
    with tempfile.TemporaryDirectory(prefix='wikicontext-e2e-') as temp:
        w = Wiki(binary, Path(temp))
        try:
            scenario(w)
            remote_scenario(w, Remote(binary, Path(temp) / 'other-computer', w.url))
        finally:
            subprocess.run([str(binary), '--db', str(w.db), 'stop'], env=w.env, capture_output=True, timeout=60)
    print('all end-to-end checks passed')


def scenario(w):
    init = w.json('init', '--email', 'tester@wiki.localhost', '--name', 'Tester', '--port', str(w.port),
                  '--password-stdin', stdin=PASSWORD + '\n')
    check(init['accountCreated'] and init['url'] == w.url, 'init creates the account and starts the server')
    check(w.db.exists(), 'init writes the database to the project folder')
    check('OK:' in w.run('check').stdout, 'live schema matches the reference schema')

    notes = w.root / 'notes'
    notes.mkdir()
    note = notes / 'coffee.md'
    note.write_text('# Coffee policy\n\nThe espresso machine is descaled every Friday. Café ✓ 😀\n', encoding='utf-8')
    first = w.json('ingest', str(note), '--title', 'Coffee policy')
    second = w.json('ingest', str(note))
    check(first['status'] == 'extracted' and first['passages'] == 1, 'ingest stores a text note and extracts passages')
    check(first['source'] == second['source'] and first['rendition'] == second['rendition'], 'repeated ingest deduplicates')
    image = notes / 'photo.png'
    image.write_bytes(b'\x89PNG\r\n')
    rejected = w.run('ingest', str(image), expect=2)
    check('text notes only' in rejected.stderr, 'non-text sources are rejected before upload')

    passage = w.json('sql', f"SELECT id FROM passages WHERE rendition = '{first['rendition']}' LIMIT 1")['rows'][0][0]
    run = w.json('create', 'ingestion_runs', json.dumps({'key': 'coffee-v1', 'status': 'staging', 'description': 'Coffee', 'sources': [first['source']]}))
    page = w.json('create', 'pages', '{"slug":"coffee-policy","kind":"summary"}')
    revision = w.json('create', 'page_revisions', '-', stdin=json.dumps({
        'run': run['id'], 'page': page['id'], 'base_revision': '', 'title': 'Coffee policy',
        'summary': 'Espresso machine maintenance.', 'body': 'The espresso machine is descaled every Friday.[^1]'}))
    w.json('create', 'citations', json.dumps({'page_revision': revision['id'], 'passage': passage, 'marker': '1'}))
    current = w.json('get', 'ingestion_runs', run['id'])
    published = w.json('publish', run['id'], '--expected-revision', str(current['revision']))
    check(published['status'] == 'published', 'a cited page publishes atomically')
    stale = w.run('publish', run['id'], '--expected-revision', str(current['revision']), expect=4)
    check('409' in stale.stderr, 'a stale revision is rejected with exit 4')
    results = w.json('search', 'espresso descaled')
    check([p['slug'] for p in results['pages']] == ['coffee-policy'], 'full-text search finds the published page')
    lint = w.json('lint')
    check({f['kind'] for f in lint['findings']} == {'orphan'}, 'lint reports structure only')

    status, _ = w.http('GET', '/')
    check(status == 200, 'the reader is served')
    status, _ = w.http('GET', '/api/bundle/instance', headers={'Host': f'attacker.example:{w.port}'})
    check(status == 403, 'foreign Host headers are refused')
    status, _ = w.http('POST', '/api/context/query', {'sql': 'SELECT 1'})
    check(status == 401, 'SQL requires authentication')
    status, _ = w.http('POST', '/api/bundle/token')
    check(status == 403, 'local tokens require the private key')
    link = w.json('open', '--no-browser')['signInLink']
    code = link.split('#', 1)[1]
    status, body = w.http('POST', '/api/bundle/redeem', {'code': code})
    check(status == 200 and json.loads(body)['record']['email'] == 'tester@wiki.localhost', 'the sign-in link signs in')
    status, _ = w.http('POST', '/api/bundle/redeem', {'code': code})
    check(status == 401, 'the sign-in link is single-use')
    status, _ = w.http('POST', '/api/collections/users/auth-with-password', {'identity': 'tester@wiki.localhost', 'password': PASSWORD})
    check(status == 200, 'the reader password works')

    w.json('stop')
    names = sorted(p.name for p in w.project.iterdir())
    check(names == ['storage', 'wiki.db', 'wikicontext.json'], f'only the project files remain after stop: {names}')
    originals = [p for p in (w.project / 'storage').rglob('*') if p.is_file() and not p.name.endswith('.attrs')]
    check(len(originals) == 1 and originals[0].read_bytes() == note.read_bytes(), 'the original is stored beside the database')
    again = w.json('search', 'espresso')
    check(len(again['pages']) == 1, 'knowledge survives a restart')

    # Another computer is using the project.
    w.json('stop')
    w.db.with_name('wiki.db.lease').write_text(json.dumps({'host': 'other-laptop', 'pid': 1, 'heartbeat': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}))
    blocked = w.run('ensure-running', expect=1)
    check('other-laptop' in blocked.stderr, 'a fresh lease from another computer blocks start')
    w.json('ensure-running', '--take-over')
    check(w.json('status')['running'], '--take-over starts the server')

    skills = w.root / 'skill'
    installed = w.json('skill', '--dir', str(skills))
    text = (skills / 'SKILL.md').read_text(encoding='utf-8')
    check(str(w.binary) in text and str(w.db) in text and '{{' not in text, 'the skill names the absolute binary and database')
    check(installed["binary"] == str(w.binary), 'skill install reports the binary')


def remote_scenario(w, r):
    instance = json.loads((w.project / 'wikicontext.json').read_text(encoding='utf-8'))['instance']
    user_password = 'synthetic user password'
    account = w.json('account', '--email', 'user@wiki.localhost', '--name', 'User', '--password-stdin', stdin='first password\n')
    check(account['created'] and account['email'] == 'user@wiki.localhost', 'account creates another server account')
    again = w.json('account', '--email', 'user@wiki.localhost', '--name', 'User', '--password-stdin', stdin=user_password + '\n')
    check(not again['created'] and again['id'] == account['id'], 'account resets the password of an existing account')

    missing = r.run('whoami', expect=2)
    check('wikicontext login' in missing.stderr, 'remote data commands require login')
    status = r.json('status')
    check(status['url'] == w.url and status['reachable'] and not status['loggedIn'], 'remote status reports reachable and logged out')
    r.run('login', '--email', 'user@wiki.localhost', '--password-stdin', stdin='wrong password\n', expect=1)
    login = r.json('login', '--email', 'user@wiki.localhost', '--password-stdin', stdin=user_password + '\n')
    check(login == {'url': w.url, 'email': 'user@wiki.localhost', 'instance': instance}, 'remote login reports the instance')
    session = r.session()
    check(session.parent.name == 'remote-' + hashlib.sha256(w.url.encode()).hexdigest()[:16], 'the session is keyed by the URL')
    if os.name != 'nt':
        check(session.stat().st_mode & 0o777 == 0o600, 'the remote session is private')
    status = r.json('status')
    check(status['loggedIn'] and status['email'] == 'user@wiki.localhost' and status['instance'] == instance, 'remote status reports the session')
    env_status = r.json('status', url=False, env={'WIKICONTEXT_BUNDLE_URL': w.url})
    check(env_status['url'] == w.url and env_status['loggedIn'], 'WIKICONTEXT_BUNDLE_URL selects remote mode')

    me = r.json('whoami')
    check(me['email'] == 'user@wiki.localhost' and me['id'] == account['id'] and me['url'] == w.url and 'db' not in me,
          'remote whoami reports the account without a database')
    check(me['space'] == 'companyspace001', 'remote commands default to the company space')
    spaces = {s['id']: s for s in r.json('spaces')}
    check(spaces.get('companyspace001', {}).get('role') == 'editor', 'new accounts are company space editors')

    # A note only the other computer has, named relative to its working folder.
    (r.work / 'tea.md').write_text('# Tea policy\n\nRooibosquartz tea is restocked every Monday. Thé ✓\n', encoding='utf-8')
    source = r.json('ingest', 'tea.md', '--title', 'Tea policy')
    check(source['status'] == 'extracted' and source['passages'] == 1, 'remote ingest uploads a local note')
    creator = r.json('query', f"SELECT created_by FROM sources WHERE id = '{source['source']}'")['rows'][0][0]
    check(creator == account['id'], 'the remote source is attributed to the signed-in account')
    passage = r.json('query', f"SELECT id FROM passages WHERE rendition = '{source['rendition']}' AND body LIKE '%Rooibosquartz%'")['rows'][0][0]
    run = r.json('create', 'ingestion_runs', json.dumps({'key': 'tea-v1', 'status': 'staging', 'description': 'Tea', 'sources': [source['source']]}))
    page = r.json('create', 'pages', '{"slug":"tea-policy","kind":"summary"}')
    revision = r.json('create', 'page_revisions', '-', stdin=json.dumps({
        'run': run['id'], 'page': page['id'], 'base_revision': '', 'title': 'Tea policy',
        'summary': 'Tea supplies.', 'body': 'Rooibosquartz tea is restocked every Monday.[^1]'}))
    r.json('create', 'citations', json.dumps({'page_revision': revision['id'], 'passage': passage, 'marker': '1'}))
    current = r.json('get', 'ingestion_runs', run['id'])
    check(r.json('publish', run['id'], '--expected-revision', str(current['revision']))['status'] == 'published', 'remote publish works')
    check([p['slug'] for p in r.json('search', 'rooibosquartz')['pages']] == ['tea-policy'], 'remote search finds the remote page')
    check([p['slug'] for p in w.json('search', 'rooibosquartz')['pages']] == ['tea-policy'], 'the server sees the remote page')

    for args in (['stop'], ['ensure-running'], ['flush'], ['recover'], ['init', '--email', 'x@wiki.localhost'],
                 ['password', '--password-stdin'], ['account', '--email', 'x@wiki.localhost', '--password-stdin']):
        refused = r.run(*args, expect=2)
        check('not available with --url' in refused.stderr, f'{args[0]} is refused in remote mode')
    check(w.json('status')['running'], 'the server keeps running after refused remote commands')
    check(r.run('whoami', '--db', str(w.db), expect=None).returncode == 2, '--url with --db is refused')
    for url in ('http://example.com:8096', 'http://10.0.0.1:8096'):
        check(r.run('status', url=url, expect=None).returncode == 2, f'non-loopback URL {url} is refused')

    with Forward(w.port) as forward:
        via = f'http://127.0.0.1:{forward.port}'
        check(http_status(via + '/api/bundle/instance') == 403, 'a forward on a different port fails the Host check')
        check(not r.json('status', url=via)['reachable'], 'remote status through a wrong-port forward is not reachable')
        check(r.run('whoami', url=via, expect=None).returncode == 1, 'remote whoami through a wrong-port forward fails')
        login = r.run('login', '--email', 'user@wiki.localhost', '--password-stdin', stdin=user_password + '\n', url=via, expect=None)
        check(login.returncode == 1, 'remote login through a wrong-port forward fails')

    closed = free_port()
    unreachable = r.run('whoami', url=f'http://127.0.0.1:{closed}', expect=1)
    check('not reachable' in unreachable.stderr, 'an unreachable server is reported')
    check(not listening(closed), 'remote mode never starts a server')

    original = session.read_text(encoding='utf-8')
    forged = json.loads(original)
    forged['instance'] = 'f' * len(instance)
    session.write_text(json.dumps(forged), encoding='utf-8')
    other = r.run('whoami', expect=1)
    check('different WikiContext' in other.stderr, 'a session for another instance is refused')
    session.write_text(original, encoding='utf-8')
    check(r.json('whoami')['id'] == account['id'], 'the restored session works again')

    skills = r.root / 'skill'
    r.json('skill', '--dir', str(skills))
    text = (skills / 'SKILL.md').read_text(encoding='utf-8')
    check(w.url in text and '--url' in text and '--db' not in text and 'ensure-running' not in text,
          'the remote skill names the URL and no local lifecycle')
    opened = r.json('open', '--no-browser')
    check(opened['url'] == w.url and opened.get('note'), 'remote open prints the server URL')

    check(r.json('logout') == {'url': w.url, 'loggedOut': True}, 'remote logout ends the session')
    r.run('whoami', expect=2)
    check(not r.json('status')['loggedIn'], 'after logout the remote is logged out')

    leftovers = [p for p in r.root.rglob('*') if p.name in ('wiki.db', 'wikicontext.json', 'local.key') or p.suffix in ('.db', '.lease')]
    check(not leftovers, f'remote mode creates no database, project or key: {leftovers}')
    check(sorted(p.name for p in r.work.iterdir()) == ['tea.md'], 'remote mode writes nothing to the working folder')


if __name__ == '__main__':
    try:
        main()
    except AssertionError as error:
        print('FAIL -', error)
        sys.exit(1)
