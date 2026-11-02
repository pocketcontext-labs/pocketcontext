"""Exercise native installer safeguards with a real binary and local fake downloads."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    binary = Path(args.binary).resolve()
    version = subprocess.check_output([str(binary), '--version'], text=True).split()[1]
    windows = os.name == 'nt'
    with tempfile.TemporaryDirectory(prefix='pocketcontext-installer-') as temp:
        root = Path(temp)
        assets, mocks, target = root / 'assets', root / 'mocks', root / 'Cloud Drive' / 'Project'
        assets.mkdir(); mocks.mkdir(); target.mkdir(parents=True)
        exe = 'pocketcontext.exe' if windows else 'pocketcontext'
        payload = assets / exe
        shutil.copyfile(binary, payload)
        payload.chmod(0o755)
        (assets / 'THIRD_PARTY_NOTICES.txt').write_text('synthetic test notices')
        release_version = '0.15.0'
        if windows:
            archive = assets / f'pocketcontext_{release_version}_windows_amd64.zip'
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
                for name in (exe, 'THIRD_PARTY_NOTICES.txt'):
                    bundle.write(assets / name, name)
        else:
            system = 'darwin' if platform.system() == 'Darwin' else 'linux'
            arch = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'amd64'
            archive = assets / f'pocketcontext_{release_version}_{system}_{arch}.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                for name in (exe, 'THIRD_PARTY_NOTICES.txt'):
                    bundle.add(assets / name, arcname=name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (assets / 'checksums.txt').write_text(f'{digest}  {archive.name}\n')
        extension = 'ps1' if windows else 'sh'
        installer = root / f'install.{extension}'
        installer.write_text((ROOT / 'scripts' / f'install.{extension}.in').read_text().replace('@VERSION@', release_version))
        env = os.environ.copy()
        env.pop('POCKETCONTEXT_REPLACE_VERSION', None)
        env.update(POCKETCONTEXT_INSTALL_DIR=str(target), PC_TEST_ASSETS=str(assets), PC_TEST_LOG=str(root / 'downloads'))
        if windows:
            wrapper = root / 'run.ps1'
            wrapper.write_text('''$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    Add-Content -LiteralPath $env:PC_TEST_LOG -Value $Uri
    Copy-Item -LiteralPath (Join-Path $env:PC_TEST_ASSETS ($Uri.Split('/')[-1])) -Destination $OutFile
}
& (Join-Path $PSScriptRoot 'install.ps1')
''')
            command = ['pwsh', '-NoProfile', '-File', str(wrapper)]
        else:
            curl = mocks / 'curl'
            curl.write_text('''#!/bin/sh
while [ "$#" -gt 0 ]; do
    case "$1" in --output) shift; output=$1 ;; https://*) url=$1 ;; esac
    shift
done
printf '%s\\n' "$url" >> "$PC_TEST_LOG"
cp "$PC_TEST_ASSETS/${url##*/}" "$output"
''')
            curl.chmod(0o755)
            env['PATH'] = str(mocks) + os.pathsep + env['PATH']
            command = ['sh', str(installer), str(target)]

        def run(expected=None, success=True):
            invocation = env.copy()
            if expected is not None:
                invocation['POCKETCONTEXT_REPLACE_VERSION'] = expected
            result = subprocess.run(command, env=invocation, text=True, capture_output=True, timeout=120)
            assert (result.returncode == 0) == success, result.stdout + result.stderr
            return result.stdout + result.stderr

        # Initial install still works, with pinned archive checksum verification.
        run()
        destination = target / exe
        original = destination.read_bytes()
        log = root / 'downloads'
        downloads = log.read_text()
        assert 'already exists' in run(success=False)
        assert destination.read_bytes() == original and log.read_text() == downloads
        assert 'differs' in run(expected='not-the-installed-version', success=False)
        assert destination.read_bytes() == original and log.read_text() == downloads
        out = run(expected=version)
        assert 'do not initialize it again' in out and ' init ' not in out
        assert destination.read_bytes() == original
        # Bad downloads must never replace the old executable, even with opt-in.
        (assets / 'checksums.txt').write_text(f'{"0" * 64}  {archive.name}\n')
        assert 'checksum mismatch' in run(expected=version, success=False)
        assert destination.read_bytes() == original
        destination.unlink()
        assert 'no executable exists' in run(expected=version, success=False)
        destination.mkdir()
        assert 'regular file' in run(expected=version, success=False)
        destination.rmdir()
        if not windows:
            destination.symlink_to(payload)
            assert 'regular file' in run(expected=version, success=False)
        print('PASS native installer: fresh install, refusal before download, expected-version replacement, checksum failure, absent/non-file targets')


if __name__ == '__main__':
    main()
