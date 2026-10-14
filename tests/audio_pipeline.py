#!/usr/bin/env python3
"""Synthetic orchestration checks; no provider calls or application writes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from wikicontext_client import audio_pipeline as ap, ingest, transcript_bundle


class AudioPipelineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.audio = self.root / 'italian.m4a'
        self.audio.write_bytes(b'synthetic audio')
        self.cfg = {'url': 'https://wiki.example.test', 'email': 'test@example.test'}
        self.provenance = {'input_sha256': hashlib.sha256(self.audio.read_bytes()).hexdigest(),
                           'input_name': self.audio.name, 'profile': ap.PROFILE}
        self.calls = []
        self.fail = False
        self.imports = patch.object(transcript_bundle, 'import_bundle', return_value={'status': 'extracted', 'source': 'synthetic'})
        for p in (patch.dict(os.environ, {'XDG_CACHE_HOME': str(self.root / 'cache'), 'GEMINI_API_KEY': 'synthetic'}),
                  patch.object(ap.wc, 'space_id', return_value='companyspace001'),
                  patch.object(ingest, 'rows', return_value=[{'role': 'editor'}]),
                  patch.object(ap.wc, 'must', return_value={'record': {'id': 'testaccount0001'}}), patch.object(ap.shutil, 'which', return_value='/synthetic/tool'),
                  patch.object(ingest, 'prepare_audio', return_value=(b'synthetic ogg', self.provenance)),
                  patch.object(ap.subprocess, 'run', side_effect=self.provider), self.imports):
            p.start()
            self.addCleanup(p.stop)

    def provider(self, command, **kwargs):
        self.calls.append(command)
        if '--resume' in command:
            manifest = Path(command[command.index('--resume') + 1])
        else:
            output = Path(command[command.index('--output-dir') + 1]) / 'synthetic-run'
            output.mkdir(parents=True)
            manifest = output / 'manifest.json'
            manifest.write_text('{}')
        return subprocess.CompletedProcess(command, 1 if self.fail else 0, json.dumps({
            'status': 'failed' if self.fail else 'complete', 'manifest_path': str(manifest),
            'errors': [{'stage': 'transcription', 'code': 'invalid_output',
                        'validation': {'reason': 'expected_array', 'path': '$.segments[0]'}}] if self.fail else []
        }).encode(), b'private stderr must never be printed')

    def run_audio(self, **kwargs):
        return ingest.ingest(self.cfg, self.audio, **kwargs)

    def test_default_pinned_pipeline_and_offline_reuse(self):
        result = self.run_audio(language='it', translation_language='en')
        command = self.calls[0]
        self.assertIn(ap.GEMINI_PACKAGE, command)
        self.assertEqual(command[command.index('--pipeline') + 1], 'standard')
        self.assertEqual(command[command.index('--language') + 1], 'it')
        self.assertEqual(command[command.index('--translation-language') + 1], 'en')
        self.assertEqual(Path(result['workflow_receipt']).stat().st_mode & 0o777, 0o600)
        with patch.dict(os.environ, {'GEMINI_API_KEY': ''}):
            self.assertEqual(result, self.run_audio(language='it', translation_language='en'))
        self.assertEqual(len(self.calls), 1)

    def test_failure_requires_explicit_resume_and_retains_validation(self):
        self.fail = True
        with self.assertRaises(ap.wc.Fail) as failed:
            self.run_audio(language='it')
        self.assertIn('expected_array', str(failed.exception))
        self.assertNotIn('private stderr', str(failed.exception))
        with self.assertRaises(ap.wc.Fail):
            self.run_audio(language='it')
        self.assertEqual(len(self.calls), 1)
        receipt = next(self.root.glob('cache/wikicontext/audio-workflows/*/workflow.json'))
        self.fail = False
        self.run_audio(language='it', resume=receipt)
        self.assertIn('--resume', self.calls[-1])
        with self.assertRaises(ap.wc.Fail):
            self.run_audio(language='de', resume=receipt)
        self.assertEqual(len(self.calls), 2)

    def test_malformed_receipt_never_retries(self):
        with patch.object(ap.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'not JSON', b'secret')):
            with self.assertRaises(ap.wc.Fail):
                self.run_audio()
        receipt = next(self.root.glob('cache/wikicontext/audio-workflows/*/workflow.json'))
        with self.assertRaises(ap.wc.Fail):
            self.run_audio(resume=receipt)
        self.assertEqual(self.calls, [])

    def test_changed_snapshot_fails_closed(self):
        result = self.run_audio()
        (Path(result['workflow_receipt']).parent / 'audio.ogg').write_bytes(b'changed')
        with self.assertRaises(ap.wc.Fail):
            self.run_audio()
        self.assertEqual(len(self.calls), 1)

    def test_reader_fails_before_provider_or_conversion(self):
        with patch.object(ingest, 'rows', return_value=[{'role': 'reader'}]), patch.object(ingest, 'prepare_audio') as conversion:
            with self.assertRaises(ap.wc.Fail):
                self.run_audio()
            conversion.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_missing_key_fails_before_conversion(self):
        with patch.dict(os.environ, {'GEMINI_API_KEY': ''}), patch.object(ingest, 'prepare_audio') as conversion:
            with self.assertRaises(ap.wc.Fail):
                self.run_audio()
            conversion.assert_not_called()

    def test_diagnostic_redaction_and_http_status(self):
        errors = ap.safe_errors({'errors': [{'stage': 'transcription', 'code': 'request_failed',
                  'http_status': 401, 'validation': {'reason': 'secret-value', 'path': 'private meeting words'}}]})
        self.assertEqual(errors, [{'stage': 'transcription', 'code': 'request_failed', 'http_status': 401}])

    def test_original_gemini_formats_route_to_pipeline(self):
        for suffix in ('.aif', '.aiff', '.aac'):
            path = self.root / ('fixture' + suffix)
            path.write_bytes(b'synthetic original')
            with patch.object(ap, 'ingest_audio', return_value={'status': 'extracted'}) as route:
                ingest.ingest(self.cfg, path, audio_storage='original')
                self.assertEqual(route.call_args.args[1], path)
                self.assertEqual(route.call_args.args[4], 'original')

    def test_import_only_never_runs_gemini(self):
        self.run_audio(transcript_bundle=self.root / 'manifest.json', audio_storage='original')
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
