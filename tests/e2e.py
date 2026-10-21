#!/usr/bin/env python3
"""End-to-end test of the pocketcontext binary with synthetic notes.

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
# The retired product name, assembled from parts so this file never contains it.
RETIRED = 'wi' + 'ki'
# Inherited variables of this program and of its predecessor must not leak into the test.
SCRUBBED_PREFIXES = ('POCKETCONTEXT_', RETIRED.upper() + 'CONTEXT_')


def isolated_env(home):
    """The inherited environment with a private home and cache and no product variables."""
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(SCRUBBED_PREFIXES)}
    env.update(HOME=str(home), USERPROFILE=str(home), XDG_CACHE_HOME=str(home / 'cache'),
               LOCALAPPDATA=str(home / 'AppData' / 'Local'))
    return env


def user_cache(home):
    """os.UserCacheDir() for the isolated environment."""
    if sys.platform == 'win32':
        return home / 'AppData' / 'Local'
    if sys.platform == 'darwin':
        return home / 'Library' / 'Caches'
    return home / 'cache'


def retired_names(root):
    """Every file or directory below root (project, homes, caches, skills) named after the retired product."""
    return [str(path) for path in root.rglob('*') if RETIRED in path.name.lower()]


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Project:
    def __init__(self, binary, root):
        self.binary, self.root = binary, root
        self.project = root / 'Cloud Drive' / 'PocketContext'
        self.project.mkdir(parents=True)
        self.db = self.project / 'pocketcontext.db'
        self.home = root / 'home'
        self.home.mkdir()
        self.env = isolated_env(self.home)
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
        self.home = root / 'home'
        self.work = root / 'work'
        self.home.mkdir(parents=True)
        self.work.mkdir()
        self.env = isolated_env(self.home)

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
        sessions = [p for p in self.root.rglob('session.json') if p.parent.name.startswith('remote-')
                    and p.parent.parent == user_cache(self.home) / 'pocketcontext']
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
    with tempfile.TemporaryDirectory(prefix='pocketcontext-e2e-') as temp:
        pc = Project(binary, Path(temp))
        try:
            scenario(pc)
            staging_scenario(pc)
            remote = Remote(binary, Path(temp) / 'other-computer', pc.url)
            remote_scenario(pc, remote)
            codes_scenario(pc, remote)
            lint_scenario(pc)
            pc.json('stop')
            leftovers = retired_names(pc.root)
            check(not leftovers, f'no file or directory name contains the retired product name: {leftovers}')
        finally:
            subprocess.run([str(binary), '--db', str(pc.db), 'stop'], env=pc.env, capture_output=True, timeout=60)
    print('all end-to-end checks passed')


def scenario(pc):
    usage = pc.run('help')
    text = usage.stdout + usage.stderr
    check('pocketcontext' in text and RETIRED not in text.lower(), 'help names pocketcontext and not the retired product')
    batch_help = pc.run('batch', '--help').stdout
    check(batch_help.startswith('usage: pocketcontext batch') and '"method"' in batch_help and '"url"' in batch_help
          and '"body"' in batch_help, 'batch --help documents the request shape')
    check(pc.run('help', 'lint').stdout == pc.run('lint', '-h').stdout and 'unlinked-mention' in pc.run('help', 'lint').stdout,
          'help COMMAND and COMMAND -h print the same help')
    check('unknown command' in pc.run('help', 'no-such-command', expect=2).stderr, 'help refuses an unknown command')

    init = pc.json('init', '--email', 'tester@example.localhost', '--name', 'Tester', '--port', str(pc.port),
                   '--password-stdin', stdin=PASSWORD + '\n')
    check(init['accountCreated'] and init['url'] == pc.url, 'init creates the account and starts the server')
    check(pc.db.exists(), 'init writes the database to the project folder')
    check('OK:' in pc.run('check').stdout, 'live schema matches the reference schema')

    notes = pc.root / 'notes'
    notes.mkdir()
    note = notes / 'coffee.md'
    note.write_text('# Coffee policy\n\nThe espresso machine is descaled every Friday. Café ✓ 😀\n', encoding='utf-8')
    first = pc.json('ingest', str(note), '--title', 'Coffee policy')
    second = pc.json('ingest', str(note))
    check(first['status'] == 'extracted' and first['passages'] == 1, 'ingest stores a text note and extracts passages')
    check(first['source'] == second['source'] and first['rendition'] == second['rendition'], 'repeated ingest deduplicates')
    image = notes / 'photo.png'
    image.write_bytes(b'\x89PNG\r\n')
    rejected = pc.run('ingest', str(image), expect=2)
    check('text notes only' in rejected.stderr, 'non-text sources are rejected before upload')

    passage = pc.json('sql', f"SELECT id FROM passages WHERE rendition = '{first['rendition']}' LIMIT 1")['rows'][0][0]
    run = pc.json('create', 'ingestion_runs', json.dumps({'key': 'coffee-v1', 'status': 'staging', 'description': 'Coffee', 'sources': [first['source']]}))
    page = pc.json('create', 'pages', '{"slug":"coffee-policy","kind":"summary"}')
    revision = pc.json('create', 'page_revisions', '-', stdin=json.dumps({
        'run': run['id'], 'page': page['id'], 'base_revision': '', 'title': 'Coffee policy',
        'summary': 'Espresso machine maintenance.', 'body': 'The espresso machine is descaled every Friday.[^1]'}))
    pc.json('create', 'citations', json.dumps({'page_revision': revision['id'], 'passage': passage, 'marker': '1'}))
    current = pc.json('get', 'ingestion_runs', run['id'])
    published = pc.json('publish', run['id'], '--expected-revision', str(current['revision']))
    check(published['status'] == 'published', 'a cited page publishes atomically')
    stale = pc.run('publish', run['id'], '--expected-revision', str(current['revision']), expect=4)
    check('409' in stale.stderr, 'a stale revision is rejected with exit 4')
    results = pc.json('search', 'espresso descaled')
    check([p['slug'] for p in results['pages']] == ['coffee-policy'], 'full-text search finds the published page')
    lint = pc.json('lint')
    check({(f['kind'], f['page']) for f in lint['findings']} == {('orphan', 'coffee-policy'), ('stub', 'coffee-policy')},
          'lint reports the orphan and the stub only')

    status, _ = pc.http('GET', '/')
    check(status == 200, 'the reader is served')
    status, body = pc.http('GET', '/api/bundle/instance')
    check(status == 200 and json.loads(body).get('app') == 'pocketcontext', 'the instance endpoint reports app pocketcontext')
    cache = user_cache(pc.home) / 'pocketcontext'
    working = [p for p in cache.iterdir() if p.is_dir() and p.name != 'app' and not p.name.startswith('remote-')] if cache.is_dir() else []
    check(len(working) == 1 and any(working[0].iterdir()), f'the working copy lives in the per-machine pocketcontext cache: {working}')
    status, _ = pc.http('GET', '/api/bundle/instance', headers={'Host': f'attacker.example:{pc.port}'})
    check(status == 403, 'foreign Host headers are refused')
    status, _ = pc.http('POST', '/api/context/query', {'sql': 'SELECT 1'})
    check(status == 401, 'SQL requires authentication')
    status, _ = pc.http('POST', '/api/bundle/token')
    check(status == 403, 'local tokens require the private key')
    link = pc.json('open', '--no-browser')['signInLink']
    code = link.split('#', 1)[1]
    status, body = pc.http('POST', '/api/bundle/redeem', {'code': code})
    check(status == 200 and json.loads(body)['record']['email'] == 'tester@example.localhost', 'the sign-in link signs in')
    status, _ = pc.http('POST', '/api/bundle/redeem', {'code': code})
    check(status == 401, 'the sign-in link is single-use')
    status, _ = pc.http('POST', '/api/collections/users/auth-with-password', {'identity': 'tester@example.localhost', 'password': PASSWORD})
    check(status == 200, 'the reader password works')

    pc.json('stop')
    names = sorted(p.name for p in pc.project.iterdir())
    check(names == ['pocketcontext.db', 'pocketcontext.json', 'storage'], f'only the project files remain after stop: {names}')
    originals = [p for p in (pc.project / 'storage').rglob('*') if p.is_file() and not p.name.endswith('.attrs')]
    check(len(originals) == 1 and originals[0].read_bytes() == note.read_bytes(), 'the original is stored beside the database')
    again = pc.json('search', 'espresso')
    check(len(again['pages']) == 1, 'knowledge survives a restart')

    # Another computer is using the project.
    pc.json('stop')
    pc.db.with_name('pocketcontext.db.lease').write_text(json.dumps({'host': 'other-laptop', 'pid': 1, 'heartbeat': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}))
    blocked = pc.run('ensure-running', expect=1)
    check('other-laptop' in blocked.stderr, 'a fresh lease from another computer blocks start')
    pc.json('ensure-running', '--take-over')
    check(pc.json('status')['running'], '--take-over starts the server')
    structured_ingest(pc, notes)

    skills = pc.root / 'skill'
    installed = pc.json('skill', '--dir', str(skills))
    text = (skills / 'SKILL.md').read_text(encoding='utf-8')
    check(str(pc.binary) in text and str(pc.db) in text and '{{' not in text, 'the skill names the absolute binary and database')
    check(installed["binary"] == str(pc.binary), 'skill install reports the binary')
    check((skills / '.pocketcontext').is_file(), 'the skill directory carries the .pocketcontext marker')
    check('name: pocketcontext' in text, 'the skill is named pocketcontext')
    mentions = [str(p) for p in skills.rglob('*') if p.is_file() and RETIRED in p.read_bytes().decode('utf-8', 'replace').lower()]
    check(not mentions, f'no installed skill file mentions the retired product: {mentions}')
    (pc.home / '.claude').mkdir()
    agent = pc.json('skill', '--agent', 'claude-code')
    target = pc.home / '.claude' / 'skills' / 'pocketcontext'
    check(agent['installed'].get('claude-code') == str(target) and (target / 'SKILL.md').is_file()
          and (target / '.pocketcontext').is_file(), 'the Claude Code skill is installed as pocketcontext')


def structured_ingest(pc, notes):
    """Markdown front matter fills title and date; passages follow headings."""
    talk = ' '.join(['The agent runs bash commands only from the whitelist.'] * 50)
    episode = notes / 'episode.md'
    episode.write_text('---\ntitle: "Episode one: agents"\npublished: 2025-06-16\nauthor:\n  - Dan\n  - Ann\n---\n'
                       '# Episode one\n\nIntro.\n\n## Transcript\n\n### Level 1 - Setup\n' + talk + '\n\n'
                       '### Level 4 - Bash Tool + Whitelist\n' + talk + '\n', encoding='utf-8')
    first = pc.json('ingest', str(episode))
    check(first['title'] == 'Episode one: agents' and first['source_date'] == '2025-06-16' and first['version'] == 'v3',
          f'front matter supplies title and source date: {first}')
    row = pc.json('sql', f"SELECT title, source_date FROM sources WHERE id = '{first['source']}'")['rows'][0]
    check(row == ['Episode one: agents', '2025-06-16'], f'sources.source_date is stored: {row}')
    rows = pc.json('sql', f"SELECT locator FROM passages WHERE rendition = '{first['rendition']}' ORDER BY ordinal")['rows']
    want = ['front matter; lines 1-7', '# Episode one; lines 8-15',
            '# Episode one > ## Transcript > ### Level 4 - Bash Tool + Whitelist; lines 17-18']
    check([r[0] for r in rows] == want, f'passages carry heading paths and line ranges: {rows}')
    passages_scenario(pc, notes, first)
    again = pc.json('ingest', str(episode), '--title', 'Other', '--date', '2020-01-01')
    check(again['rendition'] == first['rendition'] and again['source_date'] == '2025-06-16' and 'immutable' in again['note'],
          'repeated ingest reuses the source and rendition and keeps its date')

    # A v1 rendition (fixed 24,000-character cuts) stays valid and resumes with its own splitter.
    # The exact bytes ingest read: on Windows write_text stored CRLF, which read_text would hide.
    text = episode.read_bytes().decode('utf-8')
    v1 = [{'locator': f'document; characters 1-{len(text)}', 'body': text}]
    digest = hashlib.sha256(json.dumps(v1, sort_keys=True).encode()).hexdigest()
    pc.json('create', 'renditions', json.dumps({'source': first['source'], 'kind': 'text', 'processor': 'utf-8 text / pocketcontext-1',
                                                'version_label': 'v1', 'notes': json.dumps({'passages': 1, 'sha256': digest})}))
    legacy = pc.json('ingest', str(episode), '--version', 'v1')
    rows = pc.json('sql', f"SELECT locator FROM passages WHERE rendition = '{legacy['rendition']}'")['rows']
    check(legacy['passages'] == 1 and rows == [[v1[0]['locator']]] and 'v1' in legacy['note'], f'a partial v1 rendition resumes: {legacy}')
    v1_rows = pc.json('sql', f"SELECT id, ordinal, locator, body FROM passages WHERE rendition = '{legacy['rendition']}'")['rows']
    check(pc.run('passages', first['source'], '--version', 'v1').stdout == passages_text(v1_rows), 'passages --version reads another rendition')
    check(pc.run('passages', first['source']).stdout.count('\n=== ') == 2, 'without --version passages prefers the v3 rendition')
    check(pc.json('ingest', str(episode))['rendition'] == first['rendition'], 'without --version ingest prefers the v3 rendition')

    # v3 folds a lone link after the front matter into the next passage; a v2 rendition
    # (released in v0.5.0) keeps it apart and still resumes with the v2 splitter.
    tiny = notes / 'tiny.md'
    talk_lines = ['---', 'title: Tiny lead', '---', '[video](https://video.example/watch/42)', '', '# Talk', '', talk]
    tiny.write_bytes(('\n'.join(talk_lines) + '\n').encode('utf-8'))
    custom = pc.json('ingest', str(tiny), '--version', 'custom')
    rows = pc.json('sql', f"SELECT locator FROM passages WHERE rendition = '{custom['rendition']}' ORDER BY ordinal")['rows']
    check([r[0] for r in rows] == ['front matter; lines 1-3', 'document; lines 4-8'], f'v3 merges a tiny passage into the next: {rows}')
    v2 = [{'locator': 'front matter; lines 1-3', 'body': '\n'.join(talk_lines[:3])},
          {'locator': 'document; line 4', 'body': talk_lines[3]},
          {'locator': '# Talk; lines 6-8', 'body': '\n'.join(talk_lines[5:])}]
    digest = hashlib.sha256(json.dumps(v2, sort_keys=True).encode()).hexdigest()
    pc.json('create', 'renditions', json.dumps({'source': custom['source'], 'kind': 'text', 'processor': 'utf-8 text / pocketcontext-2 structure',
                                                'version_label': 'v2', 'notes': json.dumps({'passages': 3, 'sha256': digest})}))
    old = pc.json('ingest', str(tiny), '--version', 'v2')
    rows = pc.json('sql', f"SELECT locator, body FROM passages WHERE rendition = '{old['rendition']}' ORDER BY ordinal")['rows']
    check(old['passages'] == 3 and rows == [[p['locator'], p['body']] for p in v2] and 'v2' in old['note'],
          f'a partial v2 rendition resumes with the v2 splitter: {old} {[r[0] for r in rows]}')
    text = tiny.read_bytes().decode('utf-8')
    v1 = [{'locator': f'document; characters 1-{len(text)}', 'body': text}]
    digest = hashlib.sha256(json.dumps(v1, sort_keys=True).encode()).hexdigest()
    pc.json('create', 'renditions', json.dumps({'source': custom['source'], 'kind': 'text', 'processor': 'utf-8 text / pocketcontext-1',
                                                'version_label': 'v1', 'notes': json.dumps({'passages': 1, 'sha256': digest})}))
    check(pc.json('ingest', str(tiny))['rendition'] == old['rendition'], 'without --version ingest prefers v2 over a newer rendition')
    check(pc.json('ingest', str(tiny), '--version', 'v3')['passages'] == 2, '--version v3 re-extracts with tiny passages merged')
    check(pc.json('ingest', str(tiny))['version'] == 'v3', 'without --version ingest then prefers the v3 rendition')

    dated = notes / 'dated.md'
    dated.write_text('---\ndate: 2024-02-03\n---\nPlain text without headings.\n', encoding='utf-8')
    source = pc.json('ingest', str(dated), '--date', '2026-01-01')
    check(source['title'] == 'dated' and source['source_date'] == '2026-01-01', f'--date wins over front matter: {source}')


def passages_text(rows):
    """The expected `passages` output for (id, ordinal, locator, body) rows: LF only."""
    blocks = []
    for pid, ordinal, locator, body in rows:
        body = body.replace('\r\n', '\n').replace('\r', '\n').rstrip('\n')
        blocks.append(f'=== {ordinal} · {pid} · {locator}\n{body}\n')
    return '\n'.join(blocks)


def passages_scenario(pc, notes, first):
    """passages prints a source's passages as text in ordinal order, or writes them to a file."""
    rows = pc.json('sql', f"SELECT id, ordinal, locator, body FROM passages WHERE rendition = '{first['rendition']}' ORDER BY ordinal")['rows']
    want = passages_text(rows)
    printed = pc.run('passages', first['source']).stdout
    check(printed == want and printed.startswith('=== 1 · ') and printed.count('\n=== ') == len(rows) - 1,
          f'passages prints every passage after an ordinal, ID and locator line: {printed[:200]!r}')
    out = notes / 'episode-passages.txt'
    summary = pc.json('passages', first['source'], '--out', str(out))
    check(Path(summary.pop('file')).samefile(out) and summary == {'source': first['source'], 'rendition': first['rendition'], 'version': 'v3', 'passages': len(rows)},
          f'passages --out prints a summary: {summary}')
    data = out.read_bytes()
    check(data == want.encode('utf-8') and b'\r' not in data, 'passages --out writes the text as UTF-8 with LF line endings')
    refused = pc.run('passages', first['source'], '--version', 'v9', expect=1)
    check('no text rendition "v9"' in refused.stderr and 'v3' in refused.stderr, 'passages names the renditions when --version matches none')
    check('not found in this space' in pc.run('passages', 'zzzzzzzzzzzzzzz', expect=1).stderr, 'passages refuses an unknown source')
    check('source ID' in pc.run('passages', 'Episode one', expect=2).stderr, 'passages takes a source ID, not a title')


def staging_scenario(pc):
    """stage, check-run and page: a spec in, every problem at once, a page back out."""
    notes = pc.root / 'staging-notes'
    notes.mkdir()
    (notes / 'orbit.md').write_text('# Orbit cadence\n\nThe Zephyrine satellite completes an orbit every 97 minutes.\n', encoding='utf-8')
    (notes / 'lantern.md').write_text('# Lantern protocol\n\nLantern beacons answer the Zephyrine handshake within 4 seconds.\n', encoding='utf-8')
    orbit = pc.json('ingest', str(notes / 'orbit.md'), '--title', 'Orbit cadence')
    lantern = pc.json('ingest', str(notes / 'lantern.md'), '--title', 'Lantern protocol')
    passage = {}
    for name, source in (('orbit', orbit), ('lantern', lantern)):
        passage[name] = pc.json('sql', f"SELECT id FROM passages WHERE rendition = '{source['rendition']}' ORDER BY ordinal LIMIT 1")['rows'][0][0]

    spec_file = notes / 'spec.json'
    spec = {'run_key': 'staging-v1', 'description': 'Zephyrine pages', 'sources': [orbit['source'], lantern['source']], 'home': 'orbit-cadence',
            'pages': [
                {'slug': 'orbit-cadence', 'kind': 'concept', 'title': 'Orbit cadence', 'summary': 'How often Zephyrine orbits.',
                 'body': 'Zephyrine completes an orbit every 97 minutes.[^1] Beacons follow the [[lantern-protocol]].', 'citations': {'1': passage['orbit']}},
                {'slug': 'lantern-protocol', 'kind': 'concept', 'title': 'Lantern protocol', 'summary': 'Beacon handshakes.',
                 'body': 'Beacons answer within 4 seconds.[^1] See [[orbit-cadence|the orbit]].', 'citations': {'1': passage['lantern']}}]}
    spec_file.write_text(json.dumps(spec), encoding='utf-8')
    dry = pc.json('stage', str(spec_file), '--dry-run')
    check(dry['problems'] == [] and dry['run'] is None and sorted(dry['staged']) == ['lantern-protocol', 'orbit-cadence'], 'a clean dry run lists the pages to stage')
    check(pc.json('sql', "SELECT count(*) FROM ingestion_runs WHERE key = 'staging-v1'")['rows'][0][0] == 0, 'a dry run writes nothing')
    staged = pc.json('stage', str(spec_file))
    check(staged['problems'] == [] and staged['staged'] == ['orbit-cadence', 'lantern-protocol'] and staged['skipped'] == [], 'stage writes two linked pages')
    links = pc.json('sql', f"SELECT count(*) FROM page_links l JOIN page_revisions r ON r.id = l.page_revision WHERE r.run = '{staged['run']}'")['rows'][0][0]
    check(links == 2, 'stage derives page_links from [[links]] in the bodies')
    again = pc.json('stage', '-', stdin=json.dumps(spec))
    check(again['run'] == staged['run'] and again['staged'] == [] and sorted(again['skipped']) == ['lantern-protocol', 'orbit-cadence'], 'stage resumes a run by key and skips staged pages')
    checked = pc.json('check-run', staged['run'])
    check(checked == {'run': staged['run'], 'ok': True, 'problems': []}, 'check-run passes a complete run')
    status, _ = pc.http('GET', f"/api/pocketcontext/runs/{staged['run']}/check")
    check(status == 401, 'the run check route requires authentication')
    published = pc.json('publish', staged['run'], '--expected-revision', str(again['revision']))
    check(published['status'] == 'published', 'the staged run publishes')
    home = pc.json('sql', "SELECT p.slug FROM publications pub JOIN pages p ON p.id = pub.home ORDER BY pub.sequence DESC LIMIT 1")['rows'][0][0]
    check(home == 'orbit-cadence', 'the spec home becomes the publication home')
    refused = pc.run('stage', str(spec_file), expect=3)
    check(any(p['kind'] == 'run' for p in json.loads(refused.stdout)['problems']), 'stage refuses to resume a published run')

    broken = {'run_key': 'staging-v2', 'pages': [
        {'slug': 'orbit-cadence', 'append': '## Later\n\nThe cadence matters to [[lantern-protocol]] beacons.[^1]', 'citations': {'1': passage['lantern']}},
        {'slug': 'broken-page', 'kind': 'concept', 'title': 'Broken', 'summary': 'Deliberately wrong.',
         'body': 'Claim.[^1][^2] See [[no-such-page]].\n[^3]: a footnote', 'citations': {'1': 'zzzzzzzzzzzzzzz', '4': passage['orbit']}}]}
    result = pc.run('stage', '-', '--dry-run', stdin=json.dumps(broken), expect=3)
    kinds = {p['kind'] for p in json.loads(result.stdout)['problems'] if p['page'] == 'broken-page'}
    check({'passage', 'missing-marker', 'unused-citation', 'link-target', 'footnote-definition'} <= kinds, f'a dry run lists several problems at once: {sorted(kinds)}')
    check(all(p['page'] == 'broken-page' for p in json.loads(result.stdout)['problems']), 'the append page itself has no problems')
    check(pc.json('sql', "SELECT count(*) FROM ingestion_runs WHERE key = 'staging-v2'")['rows'][0][0] == 0, 'a failing spec writes nothing')

    broken['pages'].pop()
    appended = pc.json('stage', '-', stdin=json.dumps(broken))
    check(appended['problems'] == [] and appended['staged'] == ['orbit-cadence'], 'an append page stages')
    pc.json('publish', appended['run'], '--expected-revision', str(appended['revision']))
    page = pc.json('page', 'orbit-cadence')
    check(page['body'].endswith('beacons.[^2]') and page['citations'] == {'1': passage['orbit'], '2': passage['lantern']}
          and page['kind'] == 'concept' and page['title'] == 'Orbit cadence', 'append renumbers local markers after the existing ones')
    first = pc.json('page', 'orbit-cadence', '--sequence', str(published_sequence(pc) - 1))
    check('Later' not in first['body'], 'page reads an earlier publication')
    roundtrip = pc.json('stage', '-', '--dry-run', stdin=json.dumps({'run_key': 'staging-v3', 'pages': [page]}))
    check(roundtrip['problems'] == [] and roundtrip['staged'] == ['orbit-cadence'], 'page output is a valid spec page')
    edits_scenario(pc, notes, passage)

    # The server reports every problem of a staged run; publish still refuses with its first one.
    run = pc.json('create', 'ingestion_runs', json.dumps({'key': 'staging-broken', 'status': 'staging', 'description': 'Broken'}))
    target = pc.json('sql', "SELECT id FROM pages WHERE slug = 'lantern-protocol'")['rows'][0][0]
    pc.json('create', 'page_revisions', '-', stdin=json.dumps({'run': run['id'], 'page': target, 'base_revision': '', 'title': 'Lantern',
            'summary': 'Stale.', 'body': 'Unsupported.[^1][^2] [[orbit-cadence]]'}))
    report = json.loads(pc.run('check-run', run['id'], expect=3).stdout)
    kinds = sorted(p['kind'] for p in report['problems'])
    check(kinds == ['missing-link-record', 'missing-marker', 'missing-marker', 'stale-base'], f'check-run reports every problem at once: {kinds}')
    stale = pc.run('publish', run['id'], '--expected-revision', '1', expect=4)
    check('Page changed since synthesis' in stale.stderr, 'publish still refuses with the first problem and HTTP 409')

    # An interrupted run: the revision exists but its citation and link do not. Publish names the first
    # problem as before; stage with the same run_key adds only the missing records.
    base = pc.json('sql', f"SELECT m.value FROM publications pub JOIN json_each(pub.manifest) m WHERE m.key = '{target}' ORDER BY pub.sequence DESC LIMIT 1")['rows'][0][0]
    run = pc.json('create', 'ingestion_runs', json.dumps({'key': 'staging-resume', 'status': 'staging', 'description': 'Resume'}))
    body = 'Beacons answer within 4 seconds.[^1] See [[orbit-cadence]].'
    pc.json('create', 'page_revisions', '-', stdin=json.dumps({'run': run['id'], 'page': target, 'base_revision': base, 'title': 'Lantern protocol',
            'summary': 'Beacon handshakes.', 'body': body}))
    missing = pc.run('publish', run['id'], '--expected-revision', '1', expect=1)
    check('Missing citation marker 1' in missing.stderr, 'publish still refuses with the first problem and HTTP 400')
    resumed = pc.json('stage', '-', stdin=json.dumps({'run_key': 'staging-resume', 'pages': [
        {'slug': 'lantern-protocol', 'body': body, 'citations': {'1': passage['lantern']}}]}))
    check(resumed['skipped'] == ['lantern-protocol'] and resumed['problems'] == [], 'a resumed run gets the citations and links it missed')


def edits_scenario(pc, notes, passage):
    """edits change one cited sentence and add another; the replaced marker's citation is dropped."""
    (notes / 'burn.md').write_text('# Orbit burn\n\nAfter the 2026 burn Zephyrine completes an orbit every 95 minutes.\n', encoding='utf-8')
    burn = pc.json('ingest', str(notes / 'burn.md'), '--title', 'Orbit burn')
    burn_passage = pc.json('sql', f"SELECT id FROM passages WHERE rendition = '{burn['rendition']}' ORDER BY ordinal LIMIT 1")['rows'][0][0]
    before = pc.json('page', 'orbit-cadence')
    check(before['body'].startswith('Zephyrine completes an orbit every 97 minutes.[^1]') and before['citations'] == {'1': passage['orbit'], '2': passage['lantern']},
          'the page to edit cites two passages')

    ambiguous = {'run_key': 'staging-edits-bad', 'pages': [{'slug': 'orbit-cadence', 'edits': [
        {'old': '[[lantern-protocol]]', 'new': '[[orbit-cadence]]'}, {'old': 'no such text', 'new': 'x'}]}]}
    result = json.loads(pc.run('stage', '-', '--dry-run', stdin=json.dumps(ambiguous), expect=3).stdout)
    details = sorted(p['detail'] for p in result['problems'] if p['kind'] == 'edit' and p['page'] == 'orbit-cadence')
    check(len(details) == 2 and details[0].startswith('edits[0]: old text occurs more than once') and details[1].startswith('edits[1]: old text not found'),
          f'an edit whose old text does not occur exactly once is refused with its index: {result["problems"]}')

    spec = {'run_key': 'staging-edits', 'sources': [burn['source']], 'pages': [{'slug': 'orbit-cadence', 'edits': [
        {'old': 'Zephyrine completes an orbit every 97 minutes.[^1]', 'new': 'Since its 2026 burn Zephyrine completes an orbit every 95 minutes.[^1]'},
        {'old': 'Beacons follow the [[lantern-protocol]].', 'new': 'Before the burn an orbit took 97 minutes.[^2] Beacons follow the [[lantern-protocol]].'}],
        'citations': {'1': burn_passage, '2': passage['orbit']}}]}
    staged = pc.json('stage', '-', stdin=json.dumps(spec))
    check(staged['problems'] == [] and staged['staged'] == ['orbit-cadence'], f'a page with edits stages: {staged}')
    check(pc.json('check-run', staged['run']) == {'run': staged['run'], 'ok': True, 'problems': []}, 'check-run passes the edited page')
    pc.json('publish', staged['run'], '--expected-revision', str(staged['revision']))
    after = pc.json('page', 'orbit-cadence')
    want = ('Since its 2026 burn Zephyrine completes an orbit every 95 minutes.[^3] Before the burn an orbit took 97 minutes.[^4] '
            'Beacons follow the [[lantern-protocol]].\n\n## Later\n\nThe cadence matters to [[lantern-protocol]] beacons.[^2]')
    check(after['body'] == want, f'edits replace text and renumber local markers after the highest one: {after["body"]!r}')
    check(after['citations'] == {'2': passage['lantern'], '3': burn_passage, '4': passage['orbit']},
          f'the replaced marker loses its citation and the new markers get theirs: {after["citations"]}')
    check(after['title'] == before['title'] and after['summary'] == before['summary'], 'edits keep the published title and summary')


def published_sequence(pc):
    return pc.json('sql', "SELECT max(sequence) FROM publications WHERE space = 'companyspace001'")['rows'][0][0]


def remote_scenario(pc, r):
    instance = json.loads((pc.project / 'pocketcontext.json').read_text(encoding='utf-8'))['instance']
    user_password = 'synthetic user password'
    account = pc.json('account', '--email', 'user@example.localhost', '--name', 'User', '--password-stdin', stdin='first password\n')
    check(account['created'] and account['email'] == 'user@example.localhost', 'account creates another server account')
    again = pc.json('account', '--email', 'user@example.localhost', '--name', 'User', '--password-stdin', stdin=user_password + '\n')
    check(not again['created'] and again['id'] == account['id'], 'account resets the password of an existing account')

    missing = r.run('whoami', expect=2)
    check('pocketcontext login' in missing.stderr, 'remote data commands require login')
    status = r.json('status')
    check(status['url'] == pc.url and status['reachable'] and not status['loggedIn'], 'remote status reports reachable and logged out')
    r.run('login', '--email', 'user@example.localhost', '--password-stdin', stdin='wrong password\n', expect=1)
    login = r.json('login', '--email', 'user@example.localhost', '--password-stdin', stdin=user_password + '\n')
    check(login == {'url': pc.url, 'email': 'user@example.localhost', 'instance': instance}, 'remote login reports the instance')
    session = r.session()
    check(session.parent.name == 'remote-' + hashlib.sha256(pc.url.encode()).hexdigest()[:16], 'the session is keyed by the URL')
    if os.name != 'nt':
        check(session.stat().st_mode & 0o777 == 0o600, 'the remote session is private')
    status = r.json('status')
    check(status['loggedIn'] and status['email'] == 'user@example.localhost' and status['instance'] == instance, 'remote status reports the session')
    env_status = r.json('status', url=False, env={'POCKETCONTEXT_URL': pc.url})
    check(env_status['url'] == pc.url and env_status['loggedIn'], 'POCKETCONTEXT_URL selects remote mode')

    me = r.json('whoami')
    check(me['email'] == 'user@example.localhost' and me['id'] == account['id'] and me['url'] == pc.url and 'db' not in me,
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
    rows = r.json('query', f"SELECT id, ordinal, locator, body FROM passages WHERE rendition = '{source['rendition']}' ORDER BY ordinal")['rows']
    check(r.run('passages', source['source']).stdout == passages_text(rows) and passage in passages_text(rows), 'remote passages prints the source passages')
    summary = r.json('passages', source['source'], '--out', str(r.root / 'tea-passages.txt'))
    check(summary['passages'] == 1 and (r.root / 'tea-passages.txt').read_bytes() == passages_text(rows).encode('utf-8'),
          'remote passages --out writes the file on the other computer')
    run = r.json('create', 'ingestion_runs', json.dumps({'key': 'tea-v1', 'status': 'staging', 'description': 'Tea', 'sources': [source['source']]}))
    page = r.json('create', 'pages', '{"slug":"tea-policy","kind":"summary"}')
    revision = r.json('create', 'page_revisions', '-', stdin=json.dumps({
        'run': run['id'], 'page': page['id'], 'base_revision': '', 'title': 'Tea policy',
        'summary': 'Tea supplies.', 'body': 'Rooibosquartz tea is restocked every Monday.[^1]'}))
    r.json('create', 'citations', json.dumps({'page_revision': revision['id'], 'passage': passage, 'marker': '1'}))
    current = r.json('get', 'ingestion_runs', run['id'])
    check(r.json('publish', run['id'], '--expected-revision', str(current['revision']))['status'] == 'published', 'remote publish works')
    closed = json.loads(r.run('check-run', run['id'], expect=3).stdout)
    check([p['kind'] for p in closed['problems']] == ['run-closed'], 'remote check-run reports a published run as closed')
    check([p['slug'] for p in r.json('search', 'rooibosquartz')['pages']] == ['tea-policy'], 'remote search finds the remote page')
    check([p['slug'] for p in pc.json('search', 'rooibosquartz')['pages']] == ['tea-policy'], 'the server sees the remote page')

    for args in (['stop'], ['ensure-running'], ['flush'], ['recover'], ['init', '--email', 'x@example.localhost'],
                 ['password', '--password-stdin'], ['account', '--email', 'x@example.localhost', '--password-stdin']):
        refused = r.run(*args, expect=2)
        check('not available with --url' in refused.stderr, f'{args[0]} is refused in remote mode')
    check(pc.json('status')['running'], 'the server keeps running after refused remote commands')
    check(r.run('whoami', '--db', str(pc.db), expect=None).returncode == 2, '--url with --db is refused')
    for url in ('http://example.com:8096', 'http://10.0.0.1:8096'):
        check(r.run('status', url=url, expect=None).returncode == 2, f'non-loopback URL {url} is refused')

    with Forward(pc.port) as forward:
        via = f'http://127.0.0.1:{forward.port}'
        check(http_status(via + '/api/bundle/instance') == 403, 'a forward on a different port fails the Host check')
        check(not r.json('status', url=via)['reachable'], 'remote status through a wrong-port forward is not reachable')
        check(r.run('whoami', url=via, expect=None).returncode == 1, 'remote whoami through a wrong-port forward fails')
        login = r.run('login', '--email', 'user@example.localhost', '--password-stdin', stdin=user_password + '\n', url=via, expect=None)
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
    check('different' in other.stderr and 'sign in again' in other.stderr, 'a session for another instance is refused')
    session.write_text(original, encoding='utf-8')
    check(r.json('whoami')['id'] == account['id'], 'the restored session works again')

    skills = r.root / 'skill'
    r.json('skill', '--dir', str(skills))
    text = (skills / 'SKILL.md').read_text(encoding='utf-8')
    check(pc.url in text and '--url' in text and '--db' not in text and 'ensure-running' not in text,
          'the remote skill names the URL and no local lifecycle')
    opened = r.json('open', '--no-browser')
    check(opened['url'] == pc.url and opened.get('note'), 'remote open prints the server URL')

    check(r.json('logout') == {'url': pc.url, 'loggedOut': True}, 'remote logout ends the session')
    r.run('whoami', expect=2)
    check(not r.json('status')['loggedIn'], 'after logout the remote is logged out')

    leftovers = [p for p in r.root.rglob('*') if p.name in ('pocketcontext.db', 'pocketcontext.json', 'local.key') or p.suffix in ('.db', '.lease')]
    check(not leftovers, f'remote mode creates no database, project or key: {leftovers}')
    check(sorted(p.name for p in r.work.iterdir()) == ['tea.md'], 'remote mode writes nothing to the working folder')


def codes_scenario(pc, r):
    """One-time sign-in codes and accounts without a password."""
    # Started first so the 30-second expiry overlaps the other checks.
    expiring = pc.json('login-code', '--email', 'tester@example.localhost', '--ttl', '30')
    expiring_at = time.monotonic()
    check(expiring['email'] == 'tester@example.localhost' and expiring['code'] and expiring['expires'],
          'login-code accepts the minimum lifetime of 30 seconds')

    coder = pc.json('account', '--email', 'coder@example.localhost', '--name', 'Coder', stdin='')
    check(coder['created'] and coder['email'] == 'coder@example.localhost', 'account without a password creates the account')
    coder_again = pc.json('account', '--email', 'coder@example.localhost', '--name', 'Coder', stdin='')
    check(not coder_again['created'] and coder_again['id'] == coder['id'], 'account without a password is repeatable')
    r.run('login', '--email', 'coder@example.localhost', '--password-stdin', stdin='synthetic guess\n', expect=1)
    check(not r.json('status')['loggedIn'], 'an account created without a password has no known password')

    user = pc.json('account', '--email', 'user@example.localhost', stdin='')
    check(not user['created'], 'account without a password finds the existing account')
    login = r.json('login', '--email', 'user@example.localhost', '--password-stdin', stdin='synthetic user password\n')
    check(login['email'] == 'user@example.localhost', 'account without a password keeps the existing password')
    r.json('logout')

    issued = pc.json('login-code', '--email', 'coder@example.localhost')
    check(issued['email'] == 'coder@example.localhost' and issued['code'] and issued['expires'], 'login-code issues a code')
    instance = json.loads((pc.project / 'pocketcontext.json').read_text(encoding='utf-8'))['instance']
    login = r.json('login', '--code-stdin', stdin=issued['code'] + '\n')
    check(login == {'url': pc.url, 'email': 'coder@example.localhost', 'instance': instance}, 'remote login redeems a code')
    me = r.json('whoami')
    check(me['email'] == 'coder@example.localhost' and me['id'] == coder['id'], 'the code signs in its own account')
    rows = r.json('query', "SELECT slug FROM pages WHERE slug = 'tea-policy'")['rows']
    check(rows == [['tea-policy']], 'a code session reads with SQL')
    r.json('logout')
    reused = r.run('login', '--code-stdin', stdin=issued['code'] + '\n', expect=1)
    check('used or expired' in reused.stderr, 'a redeemed code cannot be reused')
    unknown = r.run('login', '--code-stdin', stdin='synthetic-unknown-code\n', expect=1)
    check('used or expired' in unknown.stderr, 'an unknown code is refused')
    check(not r.json('status')['loggedIn'], 'a refused code leaves the remote logged out')

    log = Path(pc.json('status')['log'])
    if log.exists():
        check(issued['code'] not in log.read_text(encoding='utf-8', errors='replace'), 'the server log does not contain the code')

    pc.run('login-code', '--email', 'nobody@example.localhost', expect=1)
    check(True, 'login-code refuses an unknown email')
    for ttl in ('10', '601'):
        pc.run('login-code', '--email', 'coder@example.localhost', '--ttl', ttl, expect=2)
        check(True, f'login-code refuses --ttl {ttl}')

    opened = pc.json('open', '--email', 'coder@example.localhost', '--no-browser')
    check(opened['signInLink'].startswith(pc.url + '/bundle/login#'), 'open --email prints a sign-in link')
    code = opened['signInLink'].split('#', 1)[1]
    status, body = pc.http('POST', '/api/bundle/redeem', {'code': code})
    check(status == 200 and json.loads(body)['record']['email'] == 'coder@example.localhost', 'open --email signs in that account')
    status, _ = pc.http('POST', '/api/bundle/redeem', {'code': code})
    check(status == 401, 'the open --email link is single-use')

    refused = r.run('login-code', '--email', 'coder@example.localhost', expect=2)
    check('not available with --url' in refused.stderr, 'login-code is refused in remote mode')
    r.run('open', '--email', 'coder@example.localhost', '--no-browser', expect=2)
    check(True, 'open --email is refused in remote mode')
    r.run('login', '--code-stdin', '--email', 'coder@example.localhost', stdin=issued['code'] + '\n', expect=2)
    check(True, 'login refuses --code-stdin with --email')

    remaining = 31 - (time.monotonic() - expiring_at)
    if remaining > 0:
        time.sleep(remaining)
    expired = r.run('login', '--code-stdin', stdin=expiring['code'] + '\n', expect=1)
    check('used or expired' in expired.stderr, 'an expired code is refused')
    check(not r.json('status')['loggedIn'], 'an expired code leaves the remote logged out')


def lint_scenario(pc):
    """Editorial lint findings on pages written with one batch."""
    note = pc.root / 'notes' / 'grinder.md'
    note.write_text('# Grinder\n\nThe burr grinder is set to grind size twelve. The tamping station sits beside it.\n', encoding='utf-8')
    source = pc.json('ingest', str(note), '--title', 'Grinder')
    passage = pc.json('sql', f"SELECT id FROM passages WHERE rendition = '{source['rendition']}' LIMIT 1")['rows'][0][0]
    run = pc.json('create', 'ingestion_runs', json.dumps({'key': 'grinder-v1', 'status': 'staging', 'description': 'Grinder',
                                                          'sources': [source['source']]}))
    filler = ' '.join(['The grinder setting is checked each morning before service begins.'] * 9)
    pages = {  # slug: (title, body, markers, link targets[, properties])
        'burr-grinder': ('Burr grinder', f'{filler}[^1] Follow the Coffee policy and the **Tamping station** rules, as Ada Lovelace asked on Monday.[^2]', 2, []),
        'milk-frother': ('Milk frother', 'Placed next to the [[burr-grinder]] and the **Tamping station** by Ada Lovelace on Monday.[^1]', 1, ['burr-grinder']),
        'cleaning-rota': ('Cleaning rota', 'Wipe the burr grinder, the `Milk frother` and the **tamping station** daily; Ada Lovelace checks on Monday.[^1][^2]', 2, []),
        # Short entity pages: only those with a catalog_type are catalog records, not stubs.
        'example-labs': ('Example Labs', 'Recorded from the note.[^1][^2]', 2, [],
                         {'catalog_type': 'organization', 'organization_type': 'lab', 'website': 'https://labs.example.test'}),
        'example-cli': ('Example CLI', 'Recorded from the note.[^1][^2]', 2, [],
                        {'catalog_type': 'product', 'product_type': 'cli', 'provider': 'Example Labs'}),
        'example-model': ('Example Model', 'Recorded from the note.[^1][^2]', 2, [],
                          {'catalog_type': 'model', 'provider': 'Example Labs', 'family': 'Example'}),
        'loose-widget': ('Loose widget', 'Recorded from the note.[^1][^2]', 2, [], {'entity_type': 'product'}),
    }
    ids = {slug: (pc.run('newid').stdout.strip(), pc.run('newid').stdout.strip()) for slug in pages}
    batches = {'concept': [], 'entity': []}  # a batch holds at most 20 requests: entity pages go in a second one
    for slug, (title, body, markers, links, *properties) in pages.items():
        page_id, revision_id = ids[slug]
        kind = 'entity' if properties else 'concept'
        requests = batches[kind]
        requests.append({'method': 'POST', 'url': '/api/collections/pages/records', 'body': {'id': page_id, 'slug': slug, 'kind': kind}})
        requests.append({'method': 'POST', 'url': '/api/collections/page_revisions/records', 'body': {
            'id': revision_id, 'run': run['id'], 'page': page_id, 'base_revision': '', 'title': title, 'summary': title, 'body': body,
            **({'properties': properties[0]} if properties else {})}})
        for marker in range(1, markers + 1):
            requests.append({'method': 'POST', 'url': '/api/collections/citations/records',
                             'body': {'page_revision': revision_id, 'passage': passage, 'marker': str(marker)}})
        for target in links:
            requests.append({'method': 'POST', 'url': '/api/collections/page_links/records',
                             'body': {'page_revision': revision_id, 'target': ids[target][0]}})
    requests, entities = batches['concept'], batches['entity']
    written = pc.json('batch', '-', stdin=json.dumps(requests))
    check(len(written) == len(requests), 'batch writes pages, revisions, citations and links in one request')
    check(len(pc.json('batch', '-', stdin=json.dumps(entities))) == len(entities), 'a second batch writes the entity pages')
    current = pc.json('get', 'ingestion_runs', run['id'])
    check(pc.json('publish', run['id'], '--expected-revision', str(current['revision']))['status'] == 'published',
          'the batch-written run publishes')
    findings = pc.json('lint')['findings']
    mentions = {(f['page'], f['target']) for f in findings if f['kind'] == 'unlinked-mention'}
    check(mentions == {('burr-grinder', 'coffee-policy'), ('cleaning-rota', 'burr-grinder')},
          f'lint reports unlinked mentions, not linked ones or code: {mentions}')
    missing = [(f['term'], f['pages']) for f in findings if f['kind'] == 'missing-page']
    check(missing == [('Ada Lovelace', ['burr-grinder', 'cleaning-rota', 'milk-frother']),
                      ('Tamping station', ['burr-grinder', 'cleaning-rota', 'milk-frother'])],
          f'lint reports a bold term and a capitalized name on three pages without a page, not a weekday: {missing}')
    stubbed = {f['page'] for f in findings if f['kind'] == 'stub'}
    check({'milk-frother', 'cleaning-rota'} <= stubbed and 'burr-grinder' not in stubbed, f'lint reports short pages as stubs: {stubbed}')
    check('loose-widget' in stubbed and not stubbed & {'example-labs', 'example-cli', 'example-model'},
          f'lint exempts only entity pages with a catalog_type from stub: {stubbed}')
    published = pc.json('sql', "SELECT p.slug, json_extract(r.properties, '$.catalog_type') FROM page_revisions r "
                        f"JOIN pages p ON p.id = r.page WHERE r.run = '{run['id']}' AND p.slug LIKE 'example-%' ORDER BY p.slug")['rows']
    check(published == [['example-cli', 'product'], ['example-labs', 'organization'], ['example-model', 'model']],
          f'the server accepts the organization, product and model catalog types: {published}')
    refused = pc.json('create', 'ingestion_runs', json.dumps({'key': 'grinder-v2', 'status': 'staging', 'description': 'Grinder',
                                                              'sources': [source['source']]}))
    attempt = pc.run('create', 'page_revisions', json.dumps({
        'run': refused['id'], 'page': ids['loose-widget'][0], 'base_revision': ids['loose-widget'][1], 'title': 'Loose widget',
        'summary': 'Loose widget', 'body': 'Recorded from the note.', 'properties': {'catalog_type': 'spaceship'}}), expect=1)
    check('Invalid catalog_type' in attempt.stdout + attempt.stderr, 'the server still refuses an unknown catalog_type')


if __name__ == '__main__':
    try:
        main()
    except AssertionError as error:
        print('FAIL -', error)
        sys.exit(1)
