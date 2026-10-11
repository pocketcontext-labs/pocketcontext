#!/usr/bin/env python3
"""Exercise candidate publication guards and exact tested-image promotion offline."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/candidate.yml').read_text()
APPLICATION = (ROOT / '.github/workflows/test.yml').read_text()
IMAGE = 'ghcr.io/pocketcontext/wikicontext'
SHA = 'a' * 40
DIGEST = 'b' * 64


def script(name):
    section = WORKFLOW.split('      - name: ' + name + '\n', 1)[1]
    section = section.split('\n      - ', 1)[0]
    body = section.split('        run: |\n', 1)[1]
    lines = []
    for line in body.splitlines():
        if line.strip() and not line.startswith('          '):
            break
        lines.append(line[10:])
    return '\n'.join(lines)


class CandidateWorkflow(unittest.TestCase):
    def test_only_explicit_candidate_branch_publishes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = dict(os.environ, GITHUB_REF_TYPE='branch', GITHUB_REF='refs/heads/release-candidates/wiki-spaces',
                        GITHUB_SHA=SHA, REQUESTED_REVISION=SHA, GITHUB_OUTPUT=str(Path(tmp) / 'output'))
            for overrides, success in [({}, True), ({'GITHUB_REF': 'refs/heads/main'}, False),
                                       ({'GITHUB_REF': 'refs/heads/feature/wiki-spaces'}, False),
                                       ({'GITHUB_REF_TYPE': 'tag'}, False),
                                       ({'REQUESTED_REVISION': 'b' * 40}, False),
                                       ({'REQUESTED_REVISION': 'not-a-commit'}, False)]:
                with self.subTest(overrides=overrides):
                    result = subprocess.run(['bash', '-c', script('Verify candidate revision')],
                                            env=dict(base, **overrides), capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, success)

    def fixture(self, root):
        (root / 'candidate-digests').mkdir()
        executable = root / 'docker'
        executable.write_text('#!' + sys.executable + '\n'
            'import json,os,sys\n'
            'with open(os.environ["CALLS"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n'
            'if sys.argv[1:3]==["image","inspect"]: print(os.environ["IMAGE"]+"@sha256:"+"b"*64)\n'
            'if sys.argv[1:4]==["buildx","imagetools","inspect"]: print("Digest: sha256:"+"c"*64)\n')
        executable.chmod(0o700)
        return dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'], RUNNER_TEMP=str(root),
                    IMAGE=IMAGE, REVISION=SHA, ARCH='arm64', CALLS=str(root / 'calls'),
                    GITHUB_STEP_SUMMARY=str(root / 'summary'))

    def test_pushes_tested_image_without_rebuild_or_production_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = subprocess.run(['bash', '-c', script('Publish tested native image')],
                                    env=self.fixture(root), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            tag = IMAGE + ':candidate-' + SHA + '-arm64'
            self.assertEqual(calls[:2], [['tag', 'wikicontext:candidate-ci', tag], ['push', tag]])
            self.assertEqual(len(calls), 3)
            self.assertEqual((root / 'candidate-digests/arm64.txt').read_text().strip(), IMAGE + '@sha256:' + DIGEST)

    def test_manifest_uses_exact_two_validated_digest_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = self.fixture(root)
            sources = [IMAGE + '@sha256:' + letter * 64 for letter in ('a', 'b')]
            for arch, source in zip(('amd64', 'arm64'), sources):
                (root / 'candidate-digests' / (arch + '.txt')).write_text(source + '\n')
            result = subprocess.run(['bash', '-c', script('Assemble candidate and record immutable digest')],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            self.assertEqual(calls[0], ['buildx', 'imagetools', 'create', '--tag', IMAGE + ':candidate-' + SHA, *sources])
            self.assertEqual((root / 'summary').read_text(), 'Digest: sha256:' + 'c' * 64 + '\n')
            (root / 'calls').unlink()
            (root / 'candidate-digests/arm64.txt').write_text('unexpected/image@sha256:' + 'b' * 64 + '\n')
            result = subprocess.run(['bash', '-c', script('Assemble candidate and record immutable digest')],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'calls').exists())

    def test_release_gates_cannot_be_disabled_by_dispatch(self):
        self.assertIn('branches: ["release-candidates/**"]', WORKFLOW)
        self.assertIn('needs: [revision, tests]', WORKFLOW)
        self.assertIn('needs: [revision, image]', WORKFLOW)
        self.assertIn('verify_published_launcher: true', WORKFLOW)
        self.assertIn('runner: ubuntu-24.04\n', WORKFLOW)
        self.assertIn('runner: ubuntu-24.04-arm\n', WORKFLOW)
        validation = script('Validate exact native image')
        for command in ('docker/smoke.py config', 'docker/smoke.py smoke', 'docker/object_storage_smoke.py'):
            self.assertIn(command, validation)
        self.assertLess(WORKFLOW.index('Validate exact native image'), WORKFLOW.index('docker/login-action'))
        for forbidden in ('continue-on-error', ':latest', 'environment:', 'SSH_PRIVATE_KEY', 'gh release', 'uses: ./.github/workflows/image.yml'):
            self.assertNotIn(forbidden, WORKFLOW)
        self.assertIn('if: inputs.verify_published_launcher', APPLICATION)
        self.assertIn('--client "$RUNNER_TEMP/published-skill/wikicontext"', APPLICATION)


if __name__ == '__main__':
    unittest.main()
