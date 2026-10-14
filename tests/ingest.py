#!/usr/bin/env python3
"""Synthetic ingestion recovery tests; never call Groq or production APIs."""
import hashlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import shutil
import wave
import unittest
import unittest.mock
from unittest.mock import patch

# This test filename shadows the implementation when run as a script.
from wikicontext_client import ingest
UPLOAD_SOURCE = ingest.upload_source
SPACE = 'space0000000001'


class EvidenceStore:
    def __init__(self):
        self.tables = {name: [] for name in ('sources', 'renditions', 'passages')}
        self.fail_ordinal = None

    def query(self, cfg, sql):
        import sqlite3
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        for name, fields in [('sources', 'id, sha256, space'), ('renditions', 'id, source, kind, version_label, notes'), ('passages', 'id, rendition, ordinal INTEGER, locator, body')]:
            db.execute(f'CREATE TABLE {name} ({fields})')
            for record in self.tables[name]:
                columns = [field.split()[0] for field in fields.split(', ')]
                db.execute(f'INSERT INTO {name} VALUES ({",".join("?" for _ in columns)})', [record.get(column) for column in columns])
        result = [dict(row) for row in db.execute(sql)]
        db.close()
        return result

    def upload(self, cfg, path, content, digest, title):
        return self.create(cfg, 'POST', '/api/collections/sources/records', {'space': SPACE, 'sha256': digest, 'original_name': path.name, 'content': content})

    def create(self, cfg, method, path, body):
        table = path.split('/')[3]
        if table == 'passages' and body['ordinal'] == self.fail_ordinal:
            raise ingest.wc.Fail(1, 'injected interrupted write')
        row = {'id': str(len(self.tables[table]) + 1).zfill(15), **body}
        self.tables[table].append(row)
        return row


class IngestionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cfg = {'url': 'http://127.0.0.1:12345', 'email': 'synthetic@example.test'}
        self.store = EvidenceStore()
        for patcher in [patch.dict(os.environ, {'XDG_CACHE_HOME': str(self.root / 'cache')}),
                        patch.object(ingest, 'rows', self.store.query), patch.object(ingest, 'upload_source', self.store.upload),
                        patch.object(ingest.wc, 'must', self.store.create),
                        patch.object(ingest.wc, 'space_id', return_value=SPACE)]:
            patcher.start()
            self.addCleanup(patcher.stop)

    def source(self, name, content):
        path = self.root / name
        path.write_bytes(content)
        return path

    def test_extensionless_repository_text(self):
        for name in ('LICENSE', 'COPYRIGHT', 'NOTICE'):
            content = b'Copyright synthetic example.\r\n'
            kind, processor, passages = ingest.extract(Path(name), content)
            self.assertEqual(kind, 'text')
            self.assertEqual(passages[0]['body'], content.decode())
        with self.assertRaises(ingest.wc.Fail):
            ingest.extract(Path('LICENSE'), b'\xff')

    def test_interrupted_passages_resume_and_duplicate(self):
        source = self.source('evidence.md', ('first\n' * 12000).encode())
        self.store.fail_ordinal = 2
        with self.assertRaises(ingest.wc.Fail):
            ingest.ingest(self.cfg, source)
        self.assertEqual(len(self.store.tables['sources']), 1)
        self.assertEqual(len(self.store.tables['passages']), 1)
        self.store.fail_ordinal = None
        completed = ingest.ingest(self.cfg, source)
        duplicate = ingest.ingest(self.cfg, source)
        self.assertEqual(completed, duplicate)
        self.assertEqual(completed['passages'], 3)
        self.assertEqual(len(self.store.tables['renditions']), 1)
        self.assertEqual(''.join(p['body'] for p in self.store.tables['passages']), source.read_text())
        self.assertEqual(completed['status'], 'extracted')

    def test_provider_failure_preserves_original_then_cached_resume(self):
        source = self.source('meeting.wav', b'synthetic audio fixture')
        with patch.object(ingest, 'transcribe', side_effect=ingest.wc.Fail(1, 'provider unavailable')):
            with self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, source, audio_storage='original', audio_provider='groq')
        self.assertEqual(len(self.store.tables['sources']), 1)
        self.assertEqual(len(self.store.tables['renditions']), 0)
        transcript = [{'locator': 'seconds 0-1', 'body': 'Synthetic transcript.'}]
        with patch.object(ingest, 'transcribe', return_value=transcript) as provider:
            ingest.ingest(self.cfg, source, audio_storage='original', audio_provider='groq')
            ingest.ingest(self.cfg, source, audio_storage='original', audio_provider='groq')
            self.assertEqual(provider.call_count, 1)
        self.assertEqual(source.read_bytes(), b'synthetic audio fixture')

    def audio_source(self):
        path = self.root / 'synthetic-meeting.wav'
        with wave.open(str(path), 'wb') as audio:
            audio.setnchannels(2)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes(b'\0' * 48000 * 2 * 2)
        return path

    def test_normalization_failure_never_uploads(self):
        path = self.source('broken.wav', b'synthetic invalid audio')
        with patch.object(ingest, 'prepare_audio', side_effect=ingest.wc.Fail(1, 'normalization failed')):
            with self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, audio_provider='groq')
        self.assertFalse(self.store.tables['sources'])
        self.assertEqual(path.read_bytes(), b'synthetic invalid audio')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_selected_audio_duration_ignores_longer_video_and_other_audio(self):
        for suffix, video_codec, audio_codec, offset in [
                ('mp4', 'mpeg4', 'aac', '0'), ('webm', 'libvpx', 'libopus', '2')]:
            with self.subTest(format=suffix):
                path = self.root / ('mixed.' + suffix)
                ingest.command(['ffmpeg', '-nostdin', '-v', 'error',
                                '-f', 'lavfi', '-i', 'color=size=16x16:rate=10:duration=4',
                                '-itsoffset', offset, '-f', 'lavfi', '-i',
                                'sine=frequency=440:duration=1',
                                '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
                                '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
                                '-c:v', video_codec, '-c:a', audio_codec, str(path)])
                probe = json.loads(ingest.command(['ffprobe', '-v', 'error',
                                   '-show_streams', '-show_format', '-of', 'json', str(path)]))
                self.assertGreater(float(probe['format']['duration']), 3.5)
                audio = [stream for stream in probe['streams'] if stream['codec_type'] == 'audio']
                self.assertEqual(len(audio), 2)
                if suffix == 'webm':
                    self.assertNotIn('duration', audio[0])
                    self.assertGreater(float(audio[0]['start_time']), 1.5)
                self.assertAlmostEqual(ingest.duration(path), 1, delta=0.1)
                content, provenance = ingest.prepare_audio(self.cfg, path)
                self.assertAlmostEqual(provenance['duration'], 1, delta=0.1)
                derivative = self.root / (suffix + '.ogg')
                derivative.write_bytes(content)
                self.assertAlmostEqual(ingest.duration(derivative), 1, delta=0.1)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_duration_fallback_counts_decoded_wav_samples(self):
        path = self.audio_source()
        real_command = ingest.command
        def missing_duration(args):
            return b'N/A\n' if args[0] == 'ffprobe' else real_command(args)
        with patch.object(ingest, 'command', side_effect=missing_duration):
            # FFmpeg versions may round progress timestamps by a millisecond.
            self.assertAlmostEqual(ingest.duration(path), 1, delta=0.002)

    def test_invalid_audio_duration_is_rejected(self):
        for value in [b'0', b'-1', b'nan', b'inf']:
            with self.subTest(value=value), patch.object(ingest, 'command', return_value=value):
                with self.assertRaises(ingest.wc.Fail):
                    ingest.duration(self.root / 'unused.wav')
        for progress in [b'', b'out_time_us=N/A', b'out_time_us=0', b'out_time_us=nan']:
            with self.subTest(progress=progress), patch.object(ingest, 'command', side_effect=[b'N/A', progress]):
                with self.assertRaises(ingest.wc.Fail):
                    ingest.duration(self.root / 'unused.webm')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_normalized_upload_provider_bytes_and_retry(self):
        path = self.audio_source()
        original = path.read_bytes()
        sent = []
        def provider(audio_path, original_duration):
            sent.append(audio_path.read_bytes())
            self.assertAlmostEqual(original_duration, 1, delta=0.1)
            if len(sent) == 1:
                raise ingest.wc.Fail(1, 'synthetic provider failure')
            return [{'locator': 'seconds 0-1', 'body': 'Synthetic transcript.'}]
        with patch.object(ingest, 'send_transcription', side_effect=provider), \
                patch.dict(os.environ, {'WIKICONTEXT_GROQ_API_KEY': 'synthetic-key'}):
            with self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, audio_provider='groq')
            self.assertEqual(len(self.store.tables['sources']), 1)
            result = ingest.ingest(self.cfg, path, audio_provider='groq')
            self.assertEqual(result, ingest.ingest(self.cfg, path, audio_provider='groq'))
        self.assertEqual(len(sent), 2)
        stored = self.store.tables['sources'][0]
        self.assertEqual(stored['original_name'], 'synthetic-meeting.normalized.ogg')
        self.assertEqual(sent, [stored['content'], stored['content']])
        self.assertEqual(result['sha256'], hashlib.sha256(sent[0]).hexdigest())
        self.assertEqual(path.read_bytes(), original)
        provenance = json.loads(self.store.tables['renditions'][0]['notes'])['audio']
        self.assertEqual(provenance['input_sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(provenance['input_name'], path.name)
        self.assertEqual(provenance['stored_sha256'], result['sha256'])
        self.assertEqual(provenance['storage'], 'normalized')
        self.assertEqual(provenance['channels'], 1)
        self.assertEqual(provenance['sample_rate'], 16000)
        self.assertEqual(provenance['bitrate'], 16000)
        self.assertEqual(provenance['codec'], 'opus')
        stored_path = self.root / 'stored.ogg'
        stored_path.write_bytes(sent[0])
        inspected = json.loads(ingest.command(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(stored_path)]))
        stream = inspected['streams'][0]
        self.assertEqual(stream['codec_name'], 'opus')
        self.assertEqual(stream['channels'], 1)
        tags = {key.lower(): value for key, value in stream['tags'].items()}
        self.assertEqual(tags['wikicontext_input_sha256'], provenance['input_sha256'])
        self.assertEqual(tags['wikicontext_audio_profile'], provenance['profile'])
        self.assertEqual(tags['wikicontext_converter'], provenance['converter'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_normalization_precedes_source_size_gate(self):
        path = self.audio_source()
        normalized, provenance = ingest.prepare_audio(self.cfg, path)
        self.assertLess(len(normalized), path.stat().st_size)
        transcript = [{'locator': 'seconds 0-1', 'body': 'Synthetic transcript.'}]
        with patch.object(ingest, 'MAX_SOURCE', len(normalized) + 1), \
                patch.object(ingest, 'send_transcription', return_value=transcript), \
                patch.dict(os.environ, {'WIKICONTEXT_GROQ_API_KEY': 'synthetic-key'}):
            ingest.ingest(self.cfg, path, audio_provider='groq')
            with self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, audio_storage='original', audio_provider='groq')
        self.assertEqual(len(self.store.tables['sources']), 1)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_audio_cache_and_fresh_cache_determinism(self):
        path = self.audio_source()
        first, provenance = ingest.prepare_audio(self.cfg, path)
        with patch.object(ingest, 'convert_audio', side_effect=AssertionError('cached output must be reused')):
            second, saved_provenance = ingest.prepare_audio(self.cfg, path)
        self.assertEqual(first, second)
        self.assertEqual(provenance, saved_provenance)
        other_cfg = {**self.cfg, 'email': 'other@example.test'}
        fresh, _ = ingest.prepare_audio(other_cfg, path)
        self.assertEqual(first, fresh)
        renamed = self.root / 'renamed.wav'
        renamed.write_bytes(path.read_bytes())
        renamed_bytes, _ = ingest.prepare_audio({**self.cfg, 'email': 'third@example.test'}, renamed)
        self.assertEqual(first, renamed_bytes)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_invalid_cached_audio_never_uploads(self):
        path = self.audio_source()
        ingest.prepare_audio(self.cfg, path)
        cached = next((self.root / 'cache/wikicontext/audio').glob('*/audio.ogg'))
        cached.write_bytes(b'tampered audio')
        with self.assertRaises(ingest.wc.Fail):
            ingest.ingest(self.cfg, path, audio_provider='groq')
        self.assertFalse(self.store.tables['sources'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_default_duration_mismatch_and_size_limit_prevent_upload(self):
        path = self.audio_source()
        with patch.object(ingest, 'duration', side_effect=[10.0, 7.0]):
            with self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, audio_provider='groq')
        self.assertFalse(self.store.tables['sources'])
        with patch.object(ingest, 'MAX_AUDIO', 1):
            with self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, audio_provider='groq')
        self.assertFalse(self.store.tables['sources'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_audio_partial_passages_resume_after_rename_and_fresh_cache(self):
        path = self.audio_source()
        transcript = [{'locator': 'seconds 0-0.5', 'body': 'Synthetic first passage.'},
                      {'locator': 'seconds 0.5-1', 'body': 'Synthetic second passage.'}]
        with patch.object(ingest, 'send_transcription', return_value=transcript), \
                patch.dict(os.environ, {'WIKICONTEXT_GROQ_API_KEY': 'synthetic-key'}):
            self.store.fail_ordinal = 2
            with self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, audio_provider='groq')
            self.assertEqual(len(self.store.tables['passages']), 1)
            original_notes = self.store.tables['renditions'][0]['notes']
            renamed = self.root / 'renamed.wav'
            renamed.write_bytes(path.read_bytes())
            self.store.fail_ordinal = None
            result = ingest.ingest({**self.cfg, 'email': 'new-machine@example.test'}, renamed, audio_provider='groq')
        self.assertEqual(result['passages'], 2)
        self.assertEqual(len(self.store.tables['sources']), 1)
        self.assertEqual(len(self.store.tables['renditions']), 1)
        self.assertEqual(self.store.tables['renditions'][0]['notes'], original_notes)

    def test_unsupported_and_scanned_pdf_never_claim_completion(self):
        with self.assertRaises(ingest.wc.Fail):
            ingest.ingest(self.cfg, self.source('unknown.zip', b'fixture'))
        with patch.object(ingest, 'command', return_value=b'\f'):
            with self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, self.source('scan.pdf', b'pdf fixture'))
        self.assertEqual(len(self.store.tables['sources']), 2)
        self.assertFalse(self.store.tables['renditions'])

    def test_changed_extraction_cannot_overwrite_immutable_rendition(self):
        source = self.source('evidence.txt', b'Original evidence.' * 2000)
        self.store.fail_ordinal = 2
        with self.assertRaises(ingest.wc.Fail):
            ingest.ingest(self.cfg, source)
        self.store.fail_ordinal = None
        cache = next((self.root / 'cache/wikicontext/extractions').glob('*.json'))
        record = json.loads(cache.read_text())
        record[2][0]['body'] = 'Different evidence.'
        cache.write_text(json.dumps(record))
        with self.assertRaises(ingest.wc.Fail) as raised:
            ingest.ingest(self.cfg, source)
        self.assertEqual(raised.exception.code, 4)
        self.assertEqual(self.store.tables['passages'][0]['body'], source.read_text()[:24000])

    def test_lfs_pointer_rejected_before_upload(self):
        path = self.source('meeting.wav', b'version https://git-lfs.github.com/spec/v1\noid sha256:abc\n')
        with self.assertRaises(ingest.wc.Fail):
            ingest.ingest(self.cfg, path)
        self.assertFalse(self.store.tables['sources'])

    def test_original_upload_identifies_client(self):
        # Edge proxies reject Python's default urllib signature.
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"id":"source00000000001"}'
        with patch.object(ingest.wc, 'must'), patch.object(ingest.wc, 'load_session', return_value={'token': 'synthetic-token'}), \
                patch.object(ingest.wc.opener, 'open', return_value=response) as request:
            UPLOAD_SOURCE(self.cfg, self.source('note.md', b'fixture'), b'fixture', 'a' * 64, 'Note')
        self.assertEqual(request.call_args.args[0].get_header('User-agent'), ingest.wc.USER_AGENT)

    def image_fixture(self, suffix='png', size=(96, 64)):
        from PIL import Image, ImageDraw
        path = self.root / ('synthetic-slide.' + suffix)
        image = Image.new('RGB', size, 'white')
        ImageDraw.Draw(image).rectangle((4, 4, 40, 30), fill='blue')
        image.save(path)
        review = {'processor': 'synthetic human review / 1',
                  'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                  'width': size[0], 'height': size[1],
                  'passages': [
                      {'kind': 'transcription', 'body': 'Synthetic slide text.', 'region': [0, 0, 48, 32]},
                      {'kind': 'description', 'body': 'A blue rectangle.', 'region': [4, 4, 37, 27]}]}
        return path, review

    def review_file(self, review):
        path = self.root / 'review.json'
        path.write_text(json.dumps(review))
        return path

    def test_images_preserve_originals_and_separate_reviewed_evidence(self):
        for suffix in ('png', 'jpg', 'webp'):
            with self.subTest(format=suffix):
                path, review = self.image_fixture(suffix)
                original = path.read_bytes()
                result = ingest.ingest(self.cfg, path, image_review=self.review_file(review))
                self.assertEqual(result, ingest.ingest(self.cfg, path, image_review=self.review_file(review)))
                self.assertEqual(result['sha256'], hashlib.sha256(original).hexdigest())
                stored = next(s for s in self.store.tables['sources'] if s['id'] == result['source'])
                self.assertEqual(stored['content'], original)
                self.assertEqual(path.read_bytes(), original)
                rendition = next(r for r in self.store.tables['renditions'] if r['id'] == result['rendition'])
                self.assertEqual(rendition['kind'], 'image-review')
                provenance = json.loads(rendition['notes'])['image']
                self.assertEqual(provenance['source_sha256'], result['sha256'])
                self.assertEqual((provenance['width'], provenance['height']), (96, 64))
                self.assertEqual(len(provenance['review_sha256']), 64)
                passages = [p for p in self.store.tables['passages'] if p['rendition'] == result['rendition']]
                for passage, expected in zip(passages, review['passages']):
                    locator = json.loads(passage['locator'])
                    self.assertEqual(locator['kind'], expected['kind'])
                    self.assertEqual(locator['region'], expected['region'])
                    self.assertEqual(locator['units'], 'pixels')
                    self.assertEqual(passage['body'], expected['body'])
        self.assertEqual(len(self.store.tables['sources']), 3)

    def test_image_partial_resume_and_completed_review_conflict(self):
        path, review = self.image_fixture()
        self.store.fail_ordinal = 2
        with self.assertRaises(ingest.wc.Fail):
            ingest.ingest(self.cfg, path, image_review=self.review_file(review))
        self.assertEqual(len(self.store.tables['passages']), 1)
        self.store.fail_ordinal = None
        result = ingest.ingest(self.cfg, path, image_review=self.review_file(review))
        self.assertEqual(result['passages'], 2)
        renamed = self.root / 'renamed.png'
        renamed.write_bytes(path.read_bytes())
        self.assertEqual(result, ingest.ingest({**self.cfg, 'email': 'second@example.test'}, renamed,
                                              image_review=self.review_file(review)))
        for change in ('body', 'processor', 'region'):
            changed = copy.deepcopy(review)
            if change == 'body':
                changed['passages'][0]['body'] = 'Changed interpretation.'
            elif change == 'processor':
                changed['processor'] = 'Different reviewer / 2'
            else:
                changed['passages'][0]['region'] = [0, 0, 47, 32]
            with self.subTest(change=change), self.assertRaises(ingest.wc.Fail) as raised:
                ingest.ingest(self.cfg, path, image_review=self.review_file(changed))
            self.assertEqual(raised.exception.code, 4)
        self.assertEqual(len(self.store.tables['renditions']), 1)
        changed = copy.deepcopy(review)
        changed['passages'][0]['body'] = 'Corrected reviewed text.'
        newer = ingest.ingest(self.cfg, path, version='v2', image_review=self.review_file(changed))
        self.assertNotEqual(newer['rendition'], result['rendition'])
        self.assertEqual(newer['source'], result['source'])
        self.assertEqual(len(self.store.tables['passages']), 4)

    def test_invalid_image_review_never_uploads(self):
        path, valid = self.image_fixture()
        invalid = []
        for field, value in [('source_sha256', 'a' * 64), ('width', 95), ('height', True),
                             ('processor', ''), ('sequence', 0), ('sequence', True),
                             ('related_source', 'doesnotexist000')]:
            bad = copy.deepcopy(valid)
            bad[field] = value
            invalid.append(bad)
        for field, value in [('body', ''), ('body', 'x' * 24001), ('kind', 'instructions'),
                             ('region', [-1, 0, 1, 1]), ('region', [0, 0, 97, 64]),
                             ('region', [0, 0, 0, 1]), ('region', [0, 0, 1.5, 1]),
                             ('region', [0, 0, True, 1])]:
            bad = copy.deepcopy(valid)
            bad['passages'][0][field] = value
            invalid.append(bad)
        invalid.extend([{}, [], {**valid, 'passages': []}])
        for i, review in enumerate(invalid):
            with self.subTest(case=i), self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, image_review=self.review_file(review))
            self.assertFalse(self.store.tables['sources'])
        with self.assertRaises(ingest.wc.Fail):
            ingest.ingest(self.cfg, path)
        self.assertFalse(self.store.tables['sources'])

    def test_invalid_images_never_upload(self):
        from PIL import Image
        valid, review = self.image_fixture()
        invalid = [self.source('broken.png', b'not an image'),
                   self.source('mismatched.jpg', valid.read_bytes()),
                   self.source('truncated.png', valid.read_bytes()[:40])]
        wide = self.root / 'too-wide.png'
        Image.new('RGB', (16385, 1), 'white').save(wide)
        invalid.append(wide)
        animated = self.root / 'animated.webp'
        Image.new('RGB', (96, 64), 'red').save(animated, save_all=True,
             append_images=[Image.new('RGB', (96, 64), 'blue')], duration=100, loop=0)
        invalid.append(animated)
        gif = self.root / 'unsupported.gif'
        Image.new('RGB', (96, 64), 'white').save(gif)
        invalid.append(gif)
        for path in invalid:
            with self.subTest(path=path.name), self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, image_review=self.review_file(review))
            self.assertFalse(self.store.tables['sources'])

    def test_image_review_canonical_retry_and_corrupt_passage_rejection(self):
        path, review = self.image_fixture()
        review['passages'].append({'kind': 'caption', 'body': 'An incomplete caption.', 'region': [0, 32, 96, 32]})
        review_path = self.review_file(review)
        result = ingest.ingest(self.cfg, path, image_review=review_path)
        review_path.write_text(json.dumps(dict(reversed(list(review.items()))), indent=4))
        self.assertEqual(result, ingest.ingest(self.cfg, path, image_review=review_path))
        self.store.tables['passages'][0]['body'] = 'Synthetic corrupted stored text.'
        with self.assertRaises(ingest.wc.Fail) as raised:
            ingest.ingest(self.cfg, path, image_review=review_path)
        self.assertEqual(raised.exception.code, 4)
        self.store.tables['passages'][0]['body'] = review['passages'][0]['body']
        self.store.create(self.cfg, 'POST', ingest.wc.records('passages'), {
            'rendition': result['rendition'], 'ordinal': 4, 'locator': 'extra', 'body': 'Unexpected passage.'})
        with self.assertRaises(ingest.wc.Fail) as raised:
            ingest.ingest(self.cfg, path, image_review=review_path)
        self.assertEqual(raised.exception.code, 4)

    def test_malformed_review_and_decoded_pixel_limit_fail_before_writes(self):
        from PIL import Image
        path, review = self.image_fixture()
        review_path = self.review_file(review)
        malformed = [b'{', b'\xff', b'{"processor":"a","processor":"b"}',
                     json.dumps({**review, 'processor': '\ud800'}).encode()]
        for raw in malformed:
            review_path.write_bytes(raw)
            with self.subTest(raw=repr(raw)), self.assertRaises(ingest.wc.Fail):
                ingest.ingest(self.cfg, path, image_review=review_path)
            self.assertFalse(self.store.tables['sources'])
        # A compressed solid image is small on disk but exceeds decoded pixel bounds.
        large = self.root / 'too-many-pixels.png'
        fixture = Image.new('1', (8000, 6251))
        fixture.save(large)
        fixture.close()
        with self.assertRaises(ingest.wc.Fail):
            ingest.ingest(self.cfg, large, image_review=self.review_file(review))
        self.assertFalse(self.store.tables['sources'])

    def test_image_provenance_links_supplement_without_superseding(self):
        parent = ingest.ingest(self.cfg, self.source('webinar.txt', b'Synthetic webinar transcript.'))
        path, review = self.image_fixture()
        review.update(related_source=parent['source'], sequence=2, notes='Selected screenshot, not complete deck.')
        result = ingest.ingest(self.cfg, path, image_review=self.review_file(review))
        rendition = next(r for r in self.store.tables['renditions'] if r['id'] == result['rendition'])
        provenance = json.loads(rendition['notes'])['image']
        self.assertEqual(provenance['related_source'], parent['source'])
        self.assertEqual(provenance['sequence'], 2)
        self.assertEqual(provenance['notes'], review['notes'])
        self.assertNotIn('supersedes', self.store.tables['sources'][-1])

    def test_missing_groq_key_no_provider_request(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(ingest.wc.opener, 'open') as request:
            with self.assertRaises(ingest.wc.Fail):
                ingest.transcribe(self.source('meeting.wav', b'fixture'))
            request.assert_not_called()

    def test_audio_duration_mismatch_prevents_upload(self):
        with patch.dict(os.environ, {'WIKICONTEXT_GROQ_API_KEY': 'synthetic-key'}), patch.object(ingest, 'duration', side_effect=[10.0, 7.0]), patch.object(ingest, 'command'), patch.object(ingest.wc.opener, 'open') as request:
            with self.assertRaises(ingest.wc.Fail):
                ingest.transcribe(self.source('meeting.wav', b'fixture'))
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
