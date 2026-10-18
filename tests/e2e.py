#!/usr/bin/env python3
"""End-to-end test of the wikicontext binary with synthetic notes.

Runs on Linux, macOS and Windows with the standard library only. Every run uses
a temporary project folder, home and cache, and a free loopback port.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
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


if __name__ == '__main__':
    try:
        main()
    except AssertionError as error:
        print('FAIL -', error)
        sys.exit(1)
