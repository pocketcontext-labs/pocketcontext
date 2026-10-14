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
    m = {'schema_version': 'gemini-transcribe.bundle/v2', 'speaker_names': {'schema_version': 'gemini-transcribe.speaker-names/v1', 'policy': 'explicit-unambiguous/v1', 'overrides': []}, 'run_id': 'synthetic', 'created_at': '2026-10-13T00:00:00Z', 'status': 'complete', 'source': {'name': audio.name, 'sha256': bundle.sha(audio.read_bytes()), 'size_bytes': audio.stat().st_size, 'mime_type': 'audio/wav', 'duration_seconds': 1}, 'extraction': {'provider': 'google', 'model': 'synthetic', 'package_version': '1', 'prompt_version': '1', 'store': True}, 'stages': {'transcription': 'complete', 'analysis': 'skipped', 'translation': 'skipped'}, 'artifacts': []}
    for role, name, content in [('transcript', 'transcript.json', json.dumps(transcript).encode()), ('transcript_txt', 'transcript.txt', b'Synthetic evidence.\n'), ('transcript_srt', 'transcript.srt', b'1\n00:00:00,000 --> 00:00:01,000\nSynthetic evidence.\n')]:
        (root / name).write_bytes(content)
        m['artifacts'].append({'role': role, 'path': name, 'sha256': bundle.sha(content), 'size_bytes': len(content), 'media_type': bundle.ARTIFACT_FORMATS[role][1]})
    manifest = root / 'manifest.json'; manifest.write_text(json.dumps(m))
    return audio, manifest, m


def generation_fixture():
    return {'schema_version': 'gemini-transcribe.generation/v1', 'pipeline': 'long-decode',
        'api': 'generate_content', 'sdk_version': '2.30.1',
        'settings': {'automatic_retries': False, 'request_timeout_seconds': 1200,
            'max_output_tokens': 131072, 'thinking_level': 'low', 'automatic_continuation': False,
            'deadline_seconds': 1800, 'max_hops': 16},
        'stages': {'transcription': [{'status': 'complete', 'continuation_count': 1, 'hops': [
            {'hop': 1, 'status': 'received', 'finish_reason': 'CONTINUATION', 'elapsed_seconds': 1,
             'usage': {'prompt_token_count': 100, 'candidates_token_count': 50}},
            {'hop': 2, 'status': 'received', 'finish_reason': 'STOP', 'elapsed_seconds': 1,
             'usage': {'prompt_token_count': 100, 'candidates_token_count': 20}}]}]}}


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.audio, self.manifest, self.m = fixture(self.root)
        self.store = EvidenceStore(); self.cfg = {'url': 'http://example.invalid', 'email': 'synthetic@example.test'}
        for p in [patch.object(ingest, 'rows', self.store.query), patch.object(ingest, 'upload_source', self.store.upload), patch.object(ingest.wc, 'must', self.store.create), patch.object(ingest.wc, 'space_id', return_value=SPACE), patch.object(ingest, 'transcribe', side_effect=AssertionError('No model calls'))]:
            p.start(); self.addCleanup(p.stop)
    def save(self): self.manifest.write_text(json.dumps(self.m))
    def run_import(self): return ingest.ingest(self.cfg, self.audio, transcript_bundle=self.manifest, audio_storage='original')
    def test_generation_metadata_and_historical(self):
        for generation in (generation_fixture(), {'prototype': 'historical'}):
            self.m['configuration'] = {'translation_language': 'English', 'language_hint': None, 'generation': generation}
            self.save()
            self.assertEqual(bundle.preflight(self.audio, self.manifest)[0]['configuration']['generation'], generation)
    def test_generation_rejects_unsafe_or_inconsistent_receipts_before_upload(self):
        for mutate in (
            lambda g: g.update(api='interactions'),
            lambda g: g['settings'].update(automatic_retries=True),
            lambda g: g['stages']['transcription'][0].update(continuation_count=0),
            lambda g: g['stages']['transcription'][0]['hops'][0].update(continuation_token='opaque-secret'),
            lambda g: g['stages']['transcription'][0]['hops'][0]['usage'].update(thoughts_token_count=-1),
            lambda g: g['stages']['transcription'][0]['hops'][0]['usage'].update(prompt_token_count=True),
        ):
            g = generation_fixture(); mutate(g)
            self.m['configuration'] = {'translation_language': 'English', 'language_hint': None, 'generation': g}; self.save()
            with self.assertRaises(ingest.wc.Fail): self.run_import()
            self.assertFalse(self.store.tables['sources'])
    def test_audio_provenance_preserved_on_import_only_retry(self):
        digest = bundle.sha(self.audio.read_bytes())
        provenance = {'storage': 'original', 'input_name': self.audio.name,
                      'input_sha256': digest, 'stored_sha256': digest}
        result = bundle.import_bundle(self.cfg, self.audio, self.manifest, None, 'v1', audio_provenance=provenance)
        notes = json.loads(self.store.tables['renditions'][0]['notes'])
        self.assertEqual(notes['audio'], provenance)
        self.assertEqual(result, self.run_import())
        bad = {**provenance, 'stored_sha256': '0' * 64}
        with self.assertRaises(ingest.wc.Fail):
            bundle.import_bundle(self.cfg, self.audio, self.manifest, None, 'v1', audio_provenance=bad)

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
    def add_analysis(self, mappings):
        analysis = {'schema_version': 'gemini-transcribe.analysis/v1', 'summary': [], 'topics': [], 'decisions': [], 'action_items': [], 'questions': [], 'speaker_mappings': mappings}
        for role, value in [('analysis', json.dumps(analysis)), ('analysis_md', 'Synthetic analysis')]:
            data = value.encode(); name, media = bundle.ARTIFACT_FORMATS[role]
            (self.root / name).write_bytes(data)
            self.m['artifacts'].append({'role': role, 'path': name, 'sha256': bundle.sha(data), 'size_bytes': len(data), 'media_type': media})
        self.m['stages']['analysis'] = 'complete'; self.save()
    def naming(self, overrides=None):
        self.m['speaker_names'] = {'schema_version': 'gemini-transcribe.speaker-names/v1', 'policy': 'explicit-unambiguous/v1', 'overrides': overrides or []}
        self.save()
    def mapping(self, name='Alice', status='explicit', speaker='SPEAKER_01'):
        return {'speaker': speaker, 'name': name, 'status': status, 'segment_ids': ['seg000001']}
    def body(self, result):
        return next(p['body'] for p in self.store.tables['passages'] if p['id'] == result['segment_passages']['seg000001'][0])
    def test_named_version_preserves_history(self):
        self.add_analysis([self.mapping()])
        original = self.run_import(); self.assertTrue(self.body(original).startswith('Alice (SPEAKER_01):'))
        self.assertEqual(original, self.run_import())
        self.naming([{'speaker': 'SPEAKER_01', 'name': 'Reviewed Alice', 'reason': 'Reviewed correction.'}])
        with self.assertRaises(ingest.wc.Fail): self.run_import()
        named = ingest.ingest(self.cfg, self.audio, transcript_bundle=self.manifest, audio_storage='original', version='named-v2')
        self.assertTrue(self.body(named).startswith('Reviewed Alice (SPEAKER_01):'))
        self.assertEqual(original['source'], named['source'])
        self.assertNotEqual(original['rendition'], named['rendition'])
        self.assertTrue(self.body(original).startswith('Alice (SPEAKER_01):'))
        notes = next(r['notes'] for r in self.store.tables['renditions'] if r['id'] == named['rendition'])
        self.assertIn('model-generated', notes)
    def test_old_version_and_missing_policy_rejected(self):
        self.m['schema_version'] = 'gemini-transcribe.bundle/v1'; self.save()
        with self.assertRaises(ingest.wc.Fail): self.run_import()
        self.m['schema_version'] = 'gemini-transcribe.bundle/v2'; del self.m['speaker_names']; self.save()
        with self.assertRaises(ingest.wc.Fail): self.run_import()
        self.assertFalse(self.store.tables['sources'])
    def test_tentative_conflicts_and_controls_keep_labels(self):
        from wikicontext_client.speaker_names import resolve, metadata
        t = json.loads((self.root / 'transcript.json').read_text())
        for mappings in ([self.mapping(status='tentative')], [self.mapping(), self.mapping('Bob', 'tentative')], [self.mapping('Alice\nInjected')], [self.mapping('Alice\u2028Injected')]):
            self.assertEqual(resolve(t, {'speaker_mappings': mappings}, metadata()), {})
        self.assertEqual(resolve(t, {'speaker_mappings': [self.mapping(' Alice '), self.mapping('alice', 'tentative')]}, metadata()), {'SPEAKER_01': 'Alice'})
    def test_override_precedence_and_malformed_preflight(self):
        self.add_analysis([self.mapping(status='tentative')])
        self.naming([{'speaker': 'SPEAKER_01', 'name': 'Reviewed Alice', 'reason': 'Reviewed self-introduction.'}])
        result = self.run_import(); self.assertTrue(self.body(result).startswith('Reviewed Alice (SPEAKER_01):'))
        self.assertEqual(result, self.run_import())
        for overrides in ([{'speaker': 'UNKNOWN', 'name': 'Alice', 'reason': 'review'}], [{'speaker': 'SPEAKER_01', 'name': 'Alice\nInjected', 'reason': 'review'}], [{'speaker': 'SPEAKER_01', 'name': 'Alice', 'reason': ''}]):
            self.naming(overrides)
            with self.assertRaises(ingest.wc.Fail): bundle.preflight(self.audio, self.manifest)
    def test_collision_and_override_policy(self):
        from wikicontext_client.speaker_names import resolve, metadata
        t = {'segments': [{'speaker': 'SPEAKER_01'}, {'speaker': 'SPEAKER_02'}, {'speaker': 'UNKNOWN'}]}
        a = {'speaker_mappings': [self.mapping(), self.mapping('alice', speaker='SPEAKER_02'), self.mapping('Nobody', speaker='UNKNOWN')]}
        self.assertEqual(resolve(t, a, metadata()), {})
        settings = metadata([{'speaker': 'SPEAKER_01', 'name': 'Bob', 'reason': 'Review'}])
        self.assertEqual(resolve(t, a, settings), {'SPEAKER_01': 'Bob', 'SPEAKER_02': 'alice'})
        settings['overrides'][0]['name'] = 'ALICE'
        self.assertEqual(resolve(t, a, settings), {'SPEAKER_01': 'ALICE'})
        settings['overrides'].append({'speaker': 'SPEAKER_02', 'name': 'alice', 'reason': 'Review'})
        with self.assertRaises(ValueError): resolve(t, a, settings)
    def test_names_are_literal_passage_data(self):
        self.naming([{'speaker': 'SPEAKER_01', 'name': '<b>Alice</b>', 'reason': 'Synthetic markup remains data.'}])
        self.assertTrue(self.body(self.run_import()).startswith('<b>Alice</b> (SPEAKER_01):'))
    def test_null_name_metadata_rejected(self):
        self.m['speaker_names'] = None; self.save()
        with self.assertRaises(ingest.wc.Fail): bundle.preflight(self.audio, self.manifest)
    def test_export_provenance_validation(self):
        self.m['export_provenance'] = {'schema_version': 'gemini-transcribe.export/v1', 'source_manifest_sha256': '0' * 64}; self.save()
        self.run_import()
        self.m['export_provenance']['source_manifest_sha256'] = 'bad'; self.save()
        with self.assertRaises(ingest.wc.Fail): bundle.preflight(self.audio, self.manifest)
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
