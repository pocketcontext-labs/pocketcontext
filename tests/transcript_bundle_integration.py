#!/usr/bin/env python3
"""Real HTTP synthetic bundle retry, privacy and immutable conflict coverage."""
import argparse
import json
import hashlib
import os
from pathlib import Path
import tempfile
from unittest.mock import patch
import urllib.error
import urllib.request
from integration import server, credentials
from transcript_bundle import fixture
from wikicontext_client import ingest
from wikicontext_client import cli as wc


def main():
    p = argparse.ArgumentParser(); p.add_argument('--binary', required=True); args = p.parse_args()
    with server(args.binary) as request, tempfile.TemporaryDirectory(prefix='wiki-bundle-test-') as folder:
        admin, user, token = credentials(request)
        cfg = {'url': request.base_url, 'email': 'agent@example.com', 'password': 'SyntheticUserPassword123!'}
        root = Path(folder); audio, manifest, m = fixture(root)
        transcript = root / 'transcript.json'
        t = json.loads(transcript.read_text())
        t['tone'] = [{'segment_ids': ['seg000001'], 'label': 'calm', 'cues': 'Synthetic steady tone.', 'subjective': True}]
        t['uncertainties'] = [{'segment_ids': ['seg000001'], 'kind': 'wording', 'description': 'Synthetic ambiguity.'}]
        data = json.dumps(t).encode(); transcript.write_bytes(data)
        m['artifacts'][0].update(sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data))
        manifest.write_text(json.dumps(m))
        with patch.dict(os.environ, {'XDG_CACHE_HOME': str(root / 'cache')}), patch.object(ingest, 'transcribe', side_effect=AssertionError('No provider calls')):
            def run(): return ingest.ingest(cfg, audio, audio_storage='original', transcript_bundle=manifest, version='bundle-v1')
            real = wc.must
            def interrupted(cfg, method, url, body=None):
                if url == wc.records('passages') and body['locator'].startswith('annotation'):
                    raise wc.Fail(1, 'synthetic interruption')
                return real(cfg, method, url, body)
            with patch.object(wc, 'must', side_effect=interrupted):
                try: run()
                except wc.Fail as e: assert str(e) == 'synthetic interruption', str(e)
                else: raise AssertionError('Expected interruption')
            result = run(); assert result == run()
            observations = ingest.rows(cfg, "SELECT body FROM passages WHERE rendition = '" + result['observations_rendition'] + "' ORDER BY ordinal")
            assert len(observations) == 2 and 'Subjective model' in observations[0]['body']
            assert set(result['observation_passages']) == {'tone000001', 'uncertainty000001'}
            assert len(result['artifact_sources']) == 4 and len(result['segment_passages']['seg000001']) == 1
            stored = ingest.rows(cfg, 'SELECT id, original, sha256 FROM sources')
            assert len(stored) == 5
            for item in stored:
                url = request.base_url + '/api/files/sources/' + item['id'] + '/' + item['original']
                try: urllib.request.urlopen(url)
                except urllib.error.HTTPError as e: assert e.code in (403, 404)
                else: raise AssertionError('Anonymous access')
            request('POST', '/api/wiki/spaces/personal', {}, token)
            personal = ingest.rows(cfg, "SELECT id FROM spaces WHERE kind = 'personal'")[0]['id']
            pcfg = {**cfg, 'space': personal, 'space_checked': False}
            separate = ingest.ingest(pcfg, audio, audio_storage='original', transcript_bundle=manifest, version='bundle-v1')
            assert separate['source'] != result['source'] and separate['space'] == personal
            other = request('POST', '/api/collections/users/records', {'email': 'other@example.com', 'name': 'Other synthetic', 'password': 'SyntheticUserPassword123!', 'passwordConfirm': 'SyntheticUserPassword123!'}, admin)
            other_cfg = {'url': request.base_url, 'email': 'other@example.com', 'password': 'SyntheticUserPassword123!', 'space': personal}
            try: ingest.ingest(other_cfg, audio, audio_storage='original', transcript_bundle=manifest)
            except wc.Fail as e: assert 'not accessible' in str(e)
            else: raise AssertionError('Cross-user personal import allowed')
            m['run_id'] = 'different'
            manifest.write_text(json.dumps(m))
            try: run()
            except wc.Fail as e: assert 'new --version' in str(e)
            else: raise AssertionError('Expected immutable conflict')
            assert len(ingest.rows(cfg, 'SELECT id FROM sources')) == 10
    print('Transcript bundle integration passed')

if __name__ == '__main__': main()
