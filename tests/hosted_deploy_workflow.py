# /// script
# requires-python = ">=3.11"
# dependencies = ["PyYAML==6.0.1"]
# ///
"""Exercise release guards and restricted deployment with synthetic executables."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/image.yml').read_text())


def step(job, name):
    return next(s for s in WORKFLOW['jobs'][job]['steps'] if s.get('name') == name)


class DeploymentWorkflow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ['PATH'],
                    'CALL_LOG': str(self.root / 'calls'), 'GITHUB_SHA': 'a' * 40,
                    'GITHUB_REPOSITORY': 'example/synthetic', 'HEAD': 'a' * 40}

    def executable(self, name, body):
        p = self.root / name
        p.write_text('#!/usr/bin/env python3\n' + body)
        p.chmod(0o700)

    def run_step(self, job, name):
        return subprocess.run(['bash', '-c', step(job, name)['run']], env=self.env,
                              capture_output=True, text=True)

    def test_release_dependencies_and_serialization(self):
        jobs = WORKFLOW['jobs']
        self.assertEqual(jobs['publish']['needs'], ['tests', 'check'])
        self.assertEqual(jobs['manifest']['needs'], 'publish')
        self.assertEqual(jobs['deploy']['needs'], 'manifest')
        self.assertFalse(jobs['deploy']['concurrency']['cancel-in-progress'])
        # Three targets may each spend 900s preparing, 300s stopping and 120s
        # becoming ready; retain 20 minutes for pulls and public verification.
        self.assertGreaterEqual(jobs['deploy']['timeout-minutes'] * 60,
                                3 * (900 + 300 + 120) + 1200)
        self.assertIn("github.ref != 'refs/heads/main'", WORKFLOW['concurrency']['cancel-in-progress'])
        for condition in ('CONTEXT_DEPLOY_PAUSED', 'COLORS_PROFILE', "refs/heads/main", 'pull_request'):
            self.assertIn(condition, jobs['deploy']['if'])
        self.assertIn('-t "$IMAGE:latest"', step('manifest', 'Assemble source and latest tags')['run'])
        self.assertEqual(jobs['manifest']['outputs']['digest'], '${{ steps.manifest.outputs.digest }}')

    def test_current_main_required_before_publication_and_deployment(self):
        self.executable('gh', "import os\nprint(os.environ['HEAD'])\n")
        for job in ('manifest', 'deploy'):
            self.env['HEAD'] = 'a' * 40
            self.assertEqual(self.run_step(job, 'Require current main revision').returncode, 0)
            for head in ('b' * 40, 'unavailable'):
                self.env['HEAD'] = head
                self.assertNotEqual(self.run_step(job, 'Require current main revision').returncode, 0)

    def test_exact_digest_and_pinned_host_key(self):
        self.executable('ssh', "import json, os, pathlib, sys\npathlib.Path(os.environ['CALL_LOG']).write_text(json.dumps(sys.argv[1:]))\n")
        self.env.update(IMAGE='ghcr.io/example/synthetic', DEPLOY_DIGEST='sha256:' + 'a' * 64,
                        SSH_PRIVATE_KEY='synthetic-private-key', SERVER_IP='192.0.2.1',
                        SERVER_USER='synthetic', SSH_KNOWN_HOSTS='synthetic-host-key')
        name = 'Deploy validated digest through restricted SSH'
        result = self.run_step('deploy', name)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads((self.root / 'calls').read_text())
        self.assertEqual(args[-1], 'deploy ghcr.io/example/synthetic@sha256:' + 'a' * 64)
        self.assertIn('StrictHostKeyChecking=yes', args)
        key = Path(args[args.index('-i') + 1])
        self.assertFalse(key.exists(), 'temporary SSH key must be removed')
        for key, bad in [('DEPLOY_DIGEST', 'latest'), ('DEPLOY_DIGEST', 'sha256:' + 'a' * 64 + ';true'), ('SSH_KNOWN_HOSTS', '')]:
            original = self.env[key]
            self.env[key] = bad
            (self.root / 'calls').unlink(missing_ok=True)
            self.assertNotEqual(self.run_step('deploy', name).returncode, 0)
            self.assertFalse((self.root / 'calls').exists())
            self.env[key] = original

    def test_public_health_covers_every_target(self):
        self.executable('curl', "import os, pathlib, sys\nwith pathlib.Path(os.environ['CALL_LOG']).open('a') as f: f.write(sys.argv[-1] + '\\n')\n")
        urls = [f'https://{name}.example.test' for name in ('ada', 'alberto', 'vamsi')]
        self.env['SITE_URLS'] = json.dumps(urls)
        result = self.run_step('deploy', 'Verify every public target')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'calls').read_text().splitlines(), [u + '/up' for u in urls])
        for urls in ([], ['http://example.test'], ['https://user:secret@example.test'], ['https://example.test/private']):
            self.env['SITE_URLS'] = json.dumps(urls)
            self.assertNotEqual(self.run_step('deploy', 'Verify every public target').returncode, 0)


if __name__ == '__main__':
    unittest.main()
