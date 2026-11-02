#!/usr/bin/env python3
"""Offline release-candidate rehearsal using synthetic knowledge and isolated homes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from e2e import isolated_env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    with tempfile.TemporaryDirectory(prefix='pocketcontext-013-') as tmp:
        root = Path(tmp)
        home = root / 'home'
        home.mkdir()
        env = isolated_env(home)
        env['XDG_CONFIG_HOME'] = str(home / 'config')
        env['APPDATA'] = str(home / 'config')
        databases = []

        def run(*argv, expect=0, stdin=None):
            result = subprocess.run([binary, *map(str, argv)], env=env, input=stdin,
                                    capture_output=True, text=True, encoding="utf-8", timeout=120)
            assert result.returncode == expect, (argv, result.returncode, result.stderr)
            return json.loads(result.stdout) if result.stdout.lstrip().startswith(('{', '[')) else result.stdout

        try:
            for name in ('alpha', 'beta'):
                db = root / name / 'pocketcontext.db'
                databases.append(db)
                run('init', '--name', name, '--db', db, '--password-stdin', stdin='synthetic-password-013\n')
                status = run('status', '--db', db)
                assert status['running'] and status['headless'] and not status['tcp']
                run('skill', '--db', db, '--agent', 'codex')
            entries = run('profile', 'list')
            assert len(entries['profiles']) == 2 and not entries['default']
            ports = [run('status', '--db', db)['port'] for db in databases]
            assert ports[0] != ports[1]
            run('profile', 'default', 'alpha')
            run('profile', 'check', 'alpha')
            db = databases[0]
            manual = root / 'manual'
            exported = run('manual', '--out', manual)
            run('manual', '--out', manual, expect=1)
            space = run('create-space', 'PocketContext manual', '--db', db)['id']
            readme = None
            for relative, digest in exported['files'].items():
                file = manual / relative
                assert hashlib.sha256(file.read_bytes()).hexdigest() == digest
                first = run('ingest', file, '--db', db, '--space', space)
                second = run('ingest', file, '--db', db, '--space', space)
                assert first['source'] == second['source']
                if relative == 'README.md':
                    readme = first
            passages = run('sql', "SELECT id, body FROM passages WHERE rendition = '" + readme['rendition'] + "' ORDER BY ordinal", '--db', db, '--space', space)['rows']
            backup = next(row for row in passages if 'For a consistent backup' in row[1])
            single = next(row for row in passages if 'Only one computer may run a project at a time' in row[1])
            spec = {'run_key': 'manual-guide-0.13.0', 'sources': [readme['source']], 'pages': [{
                'slug': 'pocketcontext-guide', 'kind': 'summary', 'title': 'PocketContext 0.13.0 guide',
                'summary': 'Backups and switching computers.',
                'body': 'Stop the server successfully, then copy the complete project folder with its matching binary.[^1] Only one computer may run a synced project at a time; stop before switching and wait for sync.[^2]',
                'citations': {'1': backup[0], '2': single[0]}}]}
            run('stage', '-', '--dry-run', '--db', db, '--space', space, stdin=json.dumps(spec))
            staged = run('stage', '-', '--db', db, '--space', space, stdin=json.dumps(spec))
            assert run('check-run', staged['run'], '--db', db, '--space', space)['ok']
            run('publish', staged['run'], '--expected-revision', staged['revision'], '--db', db, '--space', space)
            page = run('page', 'pocketcontext-guide', '--db', db, '--space', space)
            assert page['citations']
            assert run('search', 'copy', '--db', db, '--space', space)['pages']
            run('lint', '--db', db, '--space', space)
            assert not run('status', '--db', db)['tcp']
            run('check', '--db', db)
            run('open', '--no-browser', '--db', db)
            assert run('status', '--db', db)['tcp']
            run('name', 'renamed', '--db', db)
            run('whoami', '--db', db, expect=1)
            run('profile', 'update', 'alpha')
            assert run('whoami', '--db', db)['knowledgeBaseName'] == 'renamed'
            run('profile', 'remove', 'alpha')
            assert db.exists() and not run('profile', 'default')['default']
            run('stop', '--db', databases[1])
            assert not run('status', '--db', databases[1])['running']
            run('ensure-running', '--db', databases[1])
            run('profile', 'check', 'beta')
        finally:
            for db in databases:
                subprocess.run([binary, 'stop', '--db', str(db)], env=env, capture_output=True, timeout=40)
    print('0.13.0 rehearsal passed: two headless projects, routing registration, distinct ports, manual reruns and cited guide publication, reader activation, rename reconciliation and removal preserving data')


if __name__ == '__main__':
    main()
