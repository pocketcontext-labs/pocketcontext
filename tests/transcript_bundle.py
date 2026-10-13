#!/usr/bin/env python3
"""Synthetic, offline strict bundle validation and resumable import coverage."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave
from ingest import EvidenceStore, SPACE
from wikicontext_client import ingest
from wikicontext_client import transcript_bundle as bundle


def fixture(root):
    audio = root / 'synthetic.wav'
    with wave.open(str(audio), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(8000); f.writeframes(b'\0' * 16000)
    transcript = {'schema_version': 'gemini-transcribe.transcript/v1', 'language': 'English', 'segments': [{'id': 'seg000001', 'start': 0, 'end': 1, 'speaker': 'SPEAKER_01', 'text': 'Synthetic evidence.'}], 'audio_annotations': [{'id': 'ann000001', 'start': 0, 'end': 1, 'kind': 'background_noise', 'description': 'Synthetic silence.', 'speakers': []}], 'uncertainties': [], 'tone': []}
    m = {'schema_version': 'gemini-transcribe.bundle/v1', 'run_id': 'synthetic', 'created_at': '2026-10-13T00:00:00Z', 'status': 'complete', 'source': {'name': audio.name, 'sha256': bundle.sha(audio.read_bytes()), 'size_bytes': audio.stat().st_size, 'mime_type': 'audio/wav', 'duration_seconds': 1}, 'extraction': {'provider': 'google', 'model': 'synthetic', 'package_version': '1', 'prompt_version': '1', 'store': True}, 'stages': {'transcription': 'complete', 'analysis': 'skipped', 'translation': 'skipped'}, 'artifacts': []}
    for role, name, content in [('transcript', 'transcript.json', json.dumps(transcript).encode()), ('transcript_txt', 'transcript.txt', b'Synthetic evidence.\n'), ('transcript_srt', 'transcript.srt', b'1\n00:00:00,000 --> 00:00:01,000\nSynthetic evidence.\n')]:
        (root / name).write_bytes(content)
        m['artifacts'].append({'role': role, 'path': name, 'sha256': bundle.sha(content), 'size_bytes': len(content), 'media_type': bundle.ARTIFACT_FORMATS[role][1]})
    manifest = root / 'manifest.json'; manifest.write_text(json.dumps(m))
    return audio, manifest, m


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.audio, self.manifest, self.m = fixture(self.root)
        self.store = EvidenceStore(); self.cfg = {'url': 'http://example.invalid', 'email': 'synthetic@example.test'}
        for p in [patch.object(ingest, 'rows', self.store.query), patch.object(ingest, 'upload_source', self.store.upload), patch.object(ingest.wc, 'must', self.store.create), patch.object(ingest.wc, 'space_id', return_value=SPACE), patch.object(ingest, 'transcribe', side_effect=AssertionError('No model calls'))]:
            p.start(); self.addCleanup(p.stop)
    def save(self): self.manifest.write_text(json.dumps(self.m))
    def run_import(self): return ingest.ingest(self.cfg, self.audio, transcript_bundle=self.manifest, audio_storage='original')
    def test_complete_retry(self):
        first = self.run_import(); self.assertEqual(first, self.run_import())
        self.assertEqual(len(first['artifact_sources']), 4)
        self.assertEqual(len(first['segment_passages']['seg000001']), 1)
    def test_changed_bundle_conflicts(self):
        self.run_import(); self.m['run_id'] = 'changed'; self.save()
        with self.assertRaises(ingest.wc.Fail): self.run_import()
    def test_partial_resume(self):
        self.store.fail_ordinal = 1
        with self.assertRaises(ingest.wc.Fail): self.run_import()
        self.store.fail_ordinal = None
        result = self.run_import(); self.assertEqual(result, self.run_import())
    def test_bad_source_before_writes(self):
        self.audio.write_bytes(b'wrong')
        with self.assertRaises(ingest.wc.Fail): self.run_import()
        self.assertFalse(self.store.tables['sources'])
    def test_bad_artifact_before_writes(self):
        (self.root / 'transcript.txt').write_text('tampered')
        with self.assertRaises(ingest.wc.Fail): self.run_import()
        self.assertFalse(self.store.tables['sources'])
    def test_paths(self):
        for value in ('../transcript.json', '/tmp/transcript.json', './transcript.json', 'a\\b'):
            self.m['artifacts'][0]['path'] = value; self.save()
            with self.assertRaises(ingest.wc.Fail): self.run_import()
    def test_symlink(self):
        (self.root / 'link').symlink_to(self.root / 'transcript.json')
        self.m['artifacts'][0]['path'] = 'link'; self.save()
        with self.assertRaises(ingest.wc.Fail): self.run_import()
    def test_incomplete(self):
        self.m['status'] = 'partial'; self.save()
        with self.assertRaises(ingest.wc.Fail): self.run_import()
    def test_duration_mismatch(self):
        self.m['source']['duration_seconds'] = 30; self.save()
        with self.assertRaises(ingest.wc.Fail): self.run_import()
    def test_duplicate_json(self):
        self.manifest.write_text('{"a":1,"a":2}')
        with self.assertRaises(ingest.wc.Fail): self.run_import()
    def test_mode(self):
        with self.assertRaises(ingest.wc.Fail): ingest.ingest(self.cfg, self.audio, transcript_bundle=self.manifest)
    def set_transcript(self, t):
        data = json.dumps(t).encode(); (self.root / 'transcript.json').write_bytes(data)
        self.m['artifacts'][0].update(sha256=bundle.sha(data), size_bytes=len(data)); self.save()
    def test_silent_and_long(self):
        t = json.loads((self.root / 'transcript.json').read_text()); t['segments'] = []
        self.set_transcript(t)
        result = self.run_import(); self.assertEqual(result['segment_passages'], {})
        self.assertEqual(result, self.run_import())
        t['segments'] = [{'id': 'seg000001', 'start': 0, 'end': 1, 'speaker': 'UNKNOWN', 'text': 'words ' * 9000}]
        self.set_transcript(t)
        result = ingest.ingest(self.cfg, self.audio, transcript_bundle=self.manifest, audio_storage='original', version='long')
        self.assertGreater(len(result['segment_passages']['seg000001']), 1)
    def test_enrichment(self):
        analysis = {'schema_version': 'gemini-transcribe.analysis/v1', 'summary': [{'text': 'Synthetic summary.', 'segment_ids': ['seg000001']}], 'topics': [], 'decisions': [], 'action_items': [], 'questions': [], 'speaker_mappings': []}
        translation = {'schema_version': 'gemini-transcribe.translation/v1', 'target_language': 'Italian', 'segments': [{'segment_id': 'seg000001', 'text': 'Prova sintetica.'}]}
        for role, value in [('analysis', analysis), ('analysis_md', 'Summary'), ('translation', translation), ('translation_txt', 'Traduzione'), ('translation_srt', 'Subtitle')]:
            data = json.dumps(value).encode(); name = bundle.ARTIFACT_FORMATS[role][0]; (self.root / name).write_bytes(data)
            self.m['artifacts'].append({'role': role, 'path': name, 'sha256': bundle.sha(data), 'size_bytes': len(data), 'media_type': bundle.ARTIFACT_FORMATS[role][1]})
        self.m['stages'].update(analysis='complete', translation='complete'); self.save()
        result = self.run_import(); self.assertEqual(len(result['artifact_sources']), 9)
        self.assertEqual(set(result['derived_renditions']), {'analysis', 'translation'})
        self.assertEqual(result, self.run_import())
    def test_queryable_model_observations(self):
        t = json.loads((self.root / 'transcript.json').read_text())
        t['tone'] = [{'segment_ids': ['seg000001'], 'label': 'calm', 'cues': 'Even delivery.', 'subjective': True}]
        t['uncertainties'] = [{'segment_ids': ['seg000001'], 'kind': 'wording', 'description': 'One unclear syllable.'}]
        self.set_transcript(t)
        result = self.run_import()
        self.assertEqual(set(result['observation_passages']), {'tone000001', 'uncertainty000001'})
        passages = [p for p in self.store.tables['passages'] if p['rendition'] == result['observations_rendition']]
        self.assertEqual(len(passages), 2)
        self.assertIn('Subjective model tone inference (not spoken text)', passages[0]['body'])
        self.assertIn('seg000001', passages[1]['body'])
        self.assertEqual(result, self.run_import())
    def test_unexpected_passage(self):
        result = self.run_import()
        self.store.tables['passages'].append({'id': 'unexpected', 'rendition': result['rendition'], 'ordinal': 2, 'locator': 'extra', 'body': 'extra'})
        with self.assertRaises(ingest.wc.Fail): self.run_import()
    def test_malformed_types(self):
        self.m['artifacts'][0]['role'] = []; self.save()
        with self.assertRaises(ingest.wc.Fail): self.run_import()
        self.assertFalse(self.store.tables['sources'])
    def test_invalid_refs(self):
        path = self.root / 'transcript.json'; t = json.loads(path.read_text()); t['tone'] = [{'segment_ids': ['missing'], 'label': 'calm', 'cues': 'test', 'subjective': True}]
        data = json.dumps(t).encode(); path.write_bytes(data); self.m['artifacts'][0].update(sha256=bundle.sha(data), size_bytes=len(data)); self.save()
        with self.assertRaises(ingest.wc.Fail): self.run_import()
        self.assertFalse(self.store.tables['sources'])

if __name__ == '__main__': unittest.main()
