#!/usr/bin/env python3
"""Rehearse coexistence, upgrade and full-backup rollback with synthetic projects.

Runs on Linux, macOS and Windows using only the standard library. By default it
fetches the pinned 0.15.0 executable and verifies the release archive checksum.
Pass --previous-binary to use an already verified local release instead.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import zipfile

from e2e import isolated_env, free_port, PASSWORD

PREVIOUS = '0.15.0'


def download_previous(destination):
    system = {'Linux': 'linux', 'Darwin': 'darwin', 'Windows': 'windows'}[platform.system()]
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'AMD64': 'amd64', 'x86_64': 'amd64'}[platform.machine()]
    if system == 'windows':
        arch = 'amd64'
    extension = 'zip' if system == 'windows' else 'tar.gz'
    archive = f'pocketcontext_{PREVIOUS}_{system}_{arch}.{extension}'
    base = f'https://github.com/pocketcontext-labs/pocketcontext/releases/download/v{PREVIOUS}'
    with urllib.request.urlopen(f'{base}/checksums.txt', timeout=120) as response:
        checksums = response.read().decode('utf-8')
    expected = [line.split()[0] for line in checksums.splitlines() if len(line.split()) == 2 and line.split()[1] == archive]
    if len(expected) != 1:
        raise AssertionError('previous archive must have exactly one release checksum')
    with urllib.request.urlopen(f'{base}/{archive}', timeout=180) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != expected[0]:
        raise AssertionError('previous release archive checksum mismatch')
    name = 'pocketcontext.exe' if system == 'windows' else 'pocketcontext'
    destination.mkdir()
    binary = destination / name
    if system == 'windows':
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            if package.namelist().count(name) != 1:
                raise AssertionError('previous archive has duplicate or absent executable')
            binary.write_bytes(package.read(name))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as package:
            members = [member for member in package.getmembers() if member.name == name]
            if len(members) != 1 or not members[0].isfile():
                raise AssertionError('previous archive executable must be one regular file')
            binary.write_bytes(package.extractfile(members[0]).read())
    binary.chmod(0o755)
    return binary


def replace_binary(source, destination):
    stage = destination.with_name(destination.name + '.next')
    shutil.copy2(source, stage)
    for attempt in range(50):
        try:
            os.replace(stage, destination)
            return
        except PermissionError:
            if attempt == 49:
                raise
            time.sleep(0.1)


def rehearse(target, previous, root):
    home = root / 'home'
    (home / '.codex').mkdir(parents=True)
    env = isolated_env(home)
    executable = 'pocketcontext.exe' if os.name == 'nt' else 'pocketcontext'
    alpha = root / 'Old project'
    beta = root / 'New project'
    for folder, source in ((alpha, previous), (beta, target)):
        folder.mkdir()
        shutil.copy2(source, folder / executable)

    def run(folder, *args, binary=None, stdin=None, expect=0):
        command = [str(binary or folder / executable), '--db', str(folder / 'pocketcontext.db'), *args]
        result = subprocess.run(command, input=stdin, capture_output=True, text=True, encoding='utf-8', env=env, timeout=120)
        if result.returncode != expect:
            raise AssertionError(f'{args}: exit {result.returncode}, expected {expect}\n{result.stdout}\n{result.stderr}')
        return result

    def data(folder, *args, **kwargs):
        return json.loads(run(folder, *args, **kwargs).stdout)

    def release(binary):
        return subprocess.check_output([str(binary), '--version'], text=True, encoding='utf-8', env=env).split()[1]

    old_version, new_version = release(previous), release(target)
    if old_version != PREVIOUS or old_version == new_version:
        raise AssertionError(f'expected distinct versions with previous {PREVIOUS}: {old_version}, {new_version}')
    stopped = set()
    try:
        ports = [free_port(), free_port()]
        while ports[0] == ports[1]:
            ports[1] = free_port()
        for folder, name, port in ((alpha, 'Older', ports[0]), (beta, 'Current', ports[1])):
            data(folder, 'init', '--name', name, '--port', str(port), '--password-stdin', stdin=PASSWORD + '\n')
            data(folder, 'skill', '--agent', 'codex')
        note = root / 'synthetic.txt'
        note.write_text('Synthetic upgrade evidence: the lighthouse is green.\n', encoding='utf-8')
        source = data(alpha, 'ingest', str(note), '--title', 'Upgrade evidence')['source']
        data(beta, 'ingest', str(note), '--title', 'Independent current evidence')
        assert data(alpha, 'status')['version'] == old_version
        assert data(beta, 'status')['version'] == new_version
        refused = run(alpha, 'ensure-running', binary=target, expect=1)
        assert 'version' in refused.stderr and old_version in refused.stderr, refused.stderr
        mismatch = data(alpha, 'status', binary=target)
        assert mismatch['version'] == new_version and mismatch['serverVersion'] == old_version
        assert mismatch['compatible'] is False
        run(alpha, 'stop', binary=target)
        run(alpha, 'ensure-running')
        run(alpha, 'stop')
        stopped.add(alpha)
        backup = root / 'Complete backup'
        shutil.copytree(alpha, backup)
        before_hash = hashlib.sha256((alpha / 'pocketcontext.db').read_bytes()).hexdigest()
        identity = json.loads((alpha / 'pocketcontext.json').read_text())['instance']
        replace_binary(target, alpha / executable)
        assert hashlib.sha256((alpha / 'pocketcontext.db').read_bytes()).hexdigest() == before_hash
        stopped.discard(alpha)
        run(alpha, 'ensure-running')
        data(alpha, 'skill', '--agent', 'codex')
        assert data(alpha, 'status')['version'] == new_version
        assert json.loads((alpha / 'pocketcontext.json').read_text())['instance'] == identity
        data(alpha, 'profile', 'check', 'Older')
        run(alpha, 'check')
        assert data(alpha, 'sql', "SELECT title FROM sources WHERE id = '" + source + "'")['rows'] == [['Upgrade evidence']]
        assert data(beta, 'status')['version'] == new_version
        run(alpha, 'stop')
        stopped.add(alpha)
        # Roll back all project data together with its matching binary, at the
        # same path; machine-local profiles and skills are recreated explicitly.
        shutil.rmtree(alpha)
        shutil.copytree(backup, alpha)
        assert hashlib.sha256((alpha / 'pocketcontext.db').read_bytes()).hexdigest() == before_hash
        assert release(alpha / executable) == old_version
        stopped.discard(alpha)
        run(alpha, 'ensure-running')
        data(alpha, 'skill', '--agent', 'codex')
        assert data(alpha, 'status')['version'] == old_version
        assert data(alpha, 'sql', "SELECT title FROM sources WHERE id = '" + source + "'")['rows'] == [['Upgrade evidence']]
        data(beta, 'profile', 'check', 'Older')
        assert data(beta, 'status')['version'] == new_version
        print(f'PASS: {old_version} and {new_version} coexist; mismatch refused; clean upgrade and complete-backup rollback preserve evidence and identity')
    finally:
        for folder in (alpha, beta):
            if folder not in stopped:
                result = subprocess.run([str(folder / executable), '--db', str(folder / 'pocketcontext.db'), 'stop'], env=env, capture_output=True, timeout=60)
                if result.returncode:
                    raise AssertionError(f'could not stop synthetic project {folder.name}: {result.stderr.decode(errors="replace")}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--previous-binary', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='pocketcontext-upgrades-') as directory:
        root = Path(directory)
        previous = args.previous_binary.resolve() if args.previous_binary else download_previous(root / 'previous-release')
        rehearse(args.binary.resolve(), previous, root)


if __name__ == '__main__':
    main()
