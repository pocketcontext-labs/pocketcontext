"""Strict, offline evidence-bundle preflight and resumable immutable import."""
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import tempfile
from datetime import datetime

from . import cli as wc

ROLES = {'transcript', 'transcript_txt', 'transcript_srt', 'analysis', 'analysis_md',
         'translation', 'translation_txt', 'translation_srt'}
ARTIFACT_FORMATS = {
    'transcript': ('transcript.json', 'application/json'),
    'transcript_txt': ('transcript.txt', 'text/plain'),
    'transcript_srt': ('transcript.srt', 'application/x-subrip'),
    'analysis': ('analysis.json', 'application/json'),
    'analysis_md': ('analysis.md', 'text/markdown'),
    'translation': ('translation.json', 'application/json'),
    'translation_txt': ('translation.txt', 'text/plain'),
    'translation_srt': ('translation.srt', 'application/x-subrip'),
}
MAX_FILE = 100 * 1024 * 1024
MAX_JSON = 8 * 1024 * 1024


def require(ok, message):
    if not ok:
        raise wc.Fail(2, 'Invalid transcript bundle: ' + message)


def text(value, maximum=1000000):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


GENERATION_USAGE = {'prompt_token_count', 'cached_content_token_count', 'candidates_token_count',
                    'thoughts_token_count', 'total_token_count', 'initial_prompt_token_count'}


def validate_generation(g):
    """Validate optional public generation receipts; never retain opaque provider state."""
    require(isinstance(g, dict), 'invalid generation metadata.')
    if 'schema_version' not in g:  # Historical local prototypes had unversioned metadata.
        return
    def integer(v): return type(v) is int and 0 <= v <= 9_007_199_254_740_991
    require(isinstance(g, dict) and set(g) == {'schema_version', 'pipeline', 'api', 'sdk_version', 'settings', 'stages'}, 'invalid generation metadata.')
    require(g['schema_version'] == 'gemini-transcribe.generation/v1' and g['pipeline'] in ('standard', 'long-decode'), 'unsupported generation metadata.')
    require(g['api'] == {'standard': 'interactions', 'long-decode': 'generate_content'}[g['pipeline']] and text(g['sdk_version'], 100), 'invalid generation API.')
    settings = g['settings']
    allowed = {'automatic_retries', 'request_timeout_seconds'}
    if g['pipeline'] == 'long-decode':
        allowed |= {'max_output_tokens', 'thinking_level', 'automatic_continuation', 'deadline_seconds', 'max_hops'}
    require(isinstance(settings, dict) and set(settings) == allowed and settings['automatic_retries'] is False, 'invalid generation settings.')
    for key in allowed - {'automatic_retries', 'automatic_continuation', 'thinking_level'}:
        require(number(settings[key]) and 0 < settings[key] <= 9_007_199_254_740_991, 'invalid generation limit.')
    if g['pipeline'] == 'long-decode':
        require(settings['automatic_continuation'] is False and settings['thinking_level'] == 'low' and integer(settings['max_hops']) and integer(settings['max_output_tokens']), 'invalid continuation settings.')
    require(isinstance(g['stages'], dict) and set(g['stages']) <= {'transcription', 'analysis', 'translation'}, 'invalid generation stages.')
    for attempts in g['stages'].values():
        require(isinstance(attempts, list) and 1 <= len(attempts) <= 100, 'invalid generation attempts.')
        for attempt in attempts:
            require(isinstance(attempt, dict) and set(attempt) == {'status', 'hops', 'continuation_count'} and attempt['status'] in ('complete', 'failed') and integer(attempt['continuation_count']), 'invalid generation attempt.')
            hops = attempt['hops']
            require(isinstance(hops, list) and len(hops) <= 100, 'invalid generation hops.')
            for index, hop in enumerate(hops, 1):
                require(isinstance(hop, dict) and set(hop) <= {'hop', 'status', 'finish_reason', 'usage', 'visible_bytes', 'has_continuation_token', 'elapsed_seconds', 'error_code'}, 'unknown generation hop fields.')
                require(type(hop.get('hop')) is int and hop['hop'] == index and hop.get('status') in ('received', 'failed') and number(hop.get('elapsed_seconds')) and hop['elapsed_seconds'] >= 0, 'invalid generation hop.')
                require('finish_reason' not in hop or hop['finish_reason'] in ('STOP', 'CONTINUATION', 'MAX_TOKENS', 'OTHER'), 'invalid generation finish reason.')
                require('visible_bytes' not in hop or integer(hop['visible_bytes']), 'invalid visible byte count.')
                require('has_continuation_token' not in hop or type(hop['has_continuation_token']) is bool, 'invalid continuation flag.')
                require('error_code' not in hop or text(hop['error_code'], 100), 'invalid generation error.')
                usage = hop.get('usage', {})
                require(isinstance(usage, dict) and set(usage) <= GENERATION_USAGE and all(integer(v) for v in usage.values()), 'invalid generation usage.')
            require(attempt['continuation_count'] == sum(h.get('finish_reason') == 'CONTINUATION' for h in hops), 'incorrect continuation count.')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    require(len(data) <= MAX_JSON, 'JSON exceeds 8 MiB.')
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, 'duplicate JSON key.')
            result[key] = value
        return result
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                          parse_constant=lambda _: require(False, 'non-finite JSON number.'))
    except (ValueError, UnicodeError, RecursionError):
        raise wc.Fail(2, 'Invalid transcript bundle JSON.') from None


def read(path, limit=MAX_FILE):
    require(path.is_file() and path.stat().st_size <= limit, 'missing or oversized regular file.')
    with path.open('rb') as handle:
        result = handle.read(limit + 1)
    require(len(result) <= limit, 'file grew beyond size limit.')
    return result


def _preflight(audio, manifest_path):
    from . import ingest as ing
    audio, manifest_path = Path(audio), Path(manifest_path)
    raw = read(manifest_path, MAX_JSON)
    m = strict_json(raw)
    require(isinstance(m, dict) and m.get('schema_version') == 'gemini-transcribe.bundle/v2', 'unsupported manifest version.')
    require(set(m) <= {'schema_version', 'run_id', 'created_at', 'status', 'source', 'extraction', 'stages', 'artifacts', 'errors', 'configuration', 'speaker_names', 'export_provenance', 'timing_review'}, 'unknown manifest fields.')
    require(m.get('status') == 'complete', 'only complete bundles can be imported.')
    require(text(m.get('run_id'), 200), 'invalid run ID.')
    try:
        stamp = datetime.fromisoformat(m['created_at'].replace('Z', '+00:00'))
        require(stamp.utcoffset().total_seconds() == 0, 'created_at must be UTC.')
    except (KeyError, TypeError, ValueError, AttributeError):
        require(False, 'invalid created_at.')
    s, e, stages = m.get('source'), m.get('extraction'), m.get('stages')
    require(isinstance(s, dict) and isinstance(e, dict) and isinstance(stages, dict), 'missing source, extraction or stages.')
    require(set(s) == {'name', 'sha256', 'size_bytes', 'mime_type', 'duration_seconds'} and set(e) == {'provider', 'model', 'package_version', 'prompt_version', 'store'} and set(stages) == {'transcription', 'analysis', 'translation'}, 'unknown or missing provenance fields.')
    errors = m.get('errors', [])
    require(isinstance(errors, list) and len(errors) <= 3, 'invalid errors.')
    for error in errors:
        require(isinstance(error, dict) and set(error) <= {'stage', 'code', 'http_status'} and error.get('stage') in ('transcription', 'analysis', 'translation') and text(error.get('code'), 100) and ('http_status' not in error or error['http_status'] is None or type(error['http_status']) is int and 100 <= error['http_status'] <= 599), 'invalid error receipt.')
    require(text(s.get('name'), 500) and PurePosixPath(s['name']).name == s['name'] and '\\' not in s['name'], 'invalid source name.')
    require(text(s.get('mime_type'), 100) and s['mime_type'].startswith('audio/'), 'invalid source MIME type.')
    require(number(s.get('duration_seconds')) and 0 < s['duration_seconds'] <= 31_536_000, 'invalid duration.')
    require(e.get('provider') == 'google' and type(e.get('store')) is bool and all(text(e.get(k), 100) for k in ('model', 'package_version', 'prompt_version')), 'invalid extraction provenance.')
    require(stages.get('transcription') == 'complete' and all(stages.get(k) in ('complete', 'skipped') for k in ('analysis', 'translation')), 'incomplete stages.')
    config = m.get('configuration')
    if config is not None:
        require(isinstance(config, dict) and text(config.get('translation_language'), 100) and (config.get('language_hint') is None or text(config.get('language_hint'), 100)), 'invalid configuration.')
    if config is not None and 'generation' in config:
        validate_generation(config['generation'])
    source = read(audio)
    require(source and type(s.get('size_bytes')) is int and len(source) == s['size_bytes'] and sha(source) == s.get('sha256'), 'source hash or size mismatch.')
    # Probe an immutable copy of the bytes we will upload, never the mutable input.
    with tempfile.TemporaryDirectory(prefix='wiki-bundle-probe-') as folder:
        snap = Path(folder) / ('audio' + audio.suffix)
        snap.write_bytes(source)
        measured = ing.command(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(snap)])
    try:
        measured = float(measured.strip())
    except ValueError:
        require(False, 'cannot independently measure audio duration.')
    require(number(measured) and measured > 0 and abs(measured - s['duration_seconds']) <= 2, 'source duration mismatch.')
    artifacts = m.get('artifacts')
    require(isinstance(artifacts, list) and 3 <= len(artifacts) <= len(ROLES), 'invalid artifacts.')
    files, paths = {}, set()
    root = manifest_path.resolve().parent
    for a in artifacts:
        require(isinstance(a, dict) and a.get('role') in ROLES and a['role'] not in files, 'duplicate or unknown artifact role.')
        require(set(a) == {'role', 'path', 'sha256', 'size_bytes', 'media_type'}, 'unknown artifact fields.')
        name = a.get('path')
        require((name, a.get('media_type')) == ARTIFACT_FORMATS[a['role']], 'artifact filename or media type differs from role.')
        require(text(name, 500) and '\\' not in name and not PurePosixPath(name).is_absolute() and all(p not in ('', '.', '..') for p in name.split('/')), 'unsafe artifact path.')
        require(name not in paths and name != manifest_path.name, 'duplicate artifact path.')
        target = root
        for part in name.split('/'):
            target = target / part
            require(not target.is_symlink(), 'symlink artifact path.')
        require(target.resolve().is_relative_to(root), 'escaping artifact path.')
        data = read(target)
        require(type(a.get('size_bytes')) is int and len(data) == a['size_bytes'] and sha(data) == a.get('sha256'), 'artifact hash or size mismatch.')
        require(text(a.get('media_type'), 100), 'invalid artifact media type.')
        require(len(data) > 0, 'empty artifact cannot be stored as a protected original; regenerate nonempty presentations.')
        files[a['role']] = (target, data)
        paths.add(name)
    expected = {'transcript', 'transcript_txt', 'transcript_srt'}
    if stages['analysis'] == 'complete': expected |= {'analysis', 'analysis_md'}
    if stages['translation'] == 'complete': expected |= {'translation', 'translation_txt', 'translation_srt'}
    require(set(files) == expected, 'artifacts do not match stages.')
    t = strict_json(files['transcript'][1])
    require(isinstance(t, dict) and t.get('schema_version') == 'gemini-transcribe.transcript/v1' and text(t.get('language'), 100), 'invalid transcript version or language.')
    for key in ('segments', 'audio_annotations', 'uncertainties', 'tone'):
        require(isinstance(t.get(key), list) and len(t[key]) <= 100000, 'invalid transcript arrays.')
    ids, speakers = set(), set()
    def timing(item):
        require(isinstance(item, dict) and number(item.get('start')) and number(item.get('end')) and 0 <= item['start'] <= measured + 2 and 0 <= item['end'] <= measured + 2, 'invalid timestamps.')
    for i, seg in enumerate(t['segments'], 1):
        timing(seg)
        require(seg.get('id') == f'seg{i:06d}' and text(seg.get('text')) and isinstance(seg.get('speaker'), str) and re.fullmatch(r'(?:SPEAKER_(?:0[1-9]|[1-9][0-9]+)|UNKNOWN)', seg['speaker']) is not None, 'invalid segment.')
        ids.add(seg['id']); speakers.add(seg['speaker'])
    def refs(item):
        require(isinstance(item, dict), 'invalid referenced claim.')
        r = item.get('segment_ids')
        require(isinstance(r, list) and r and all(isinstance(x, str) and x in ids for x in r) and len(set(r)) == len(r), 'invalid segment references.')
    for i, ann in enumerate(t['audio_annotations'], 1):
        timing(ann)
        require(ann.get('id') == f'ann{i:06d}' and ann.get('kind') in ('laughter', 'pause', 'overlap', 'background_noise', 'other') and text(ann.get('description')) and isinstance(ann.get('speakers'), list) and all(isinstance(x, str) and x in speakers for x in ann['speakers']) and len(set(ann['speakers'])) == len(ann['speakers']), 'invalid audio annotation.')
    for item in t['uncertainties']:
        refs(item); require(item.get('kind') in ('wording', 'speaker', 'timing', 'other') and text(item.get('description')), 'invalid uncertainty.')
    for item in t['tone']:
        refs(item); require(item.get('subjective') is True and text(item.get('label')) and text(item.get('cues')), 'invalid subjective tone.')
    warnings = []
    for field in ('segments', 'audio_annotations'):
        previous = None
        for index, item in enumerate(t[field]):
            details = {'path': f'$.{field}[{index}]', 'index': index,
                       'id': item['id'], 'start': item['start'], 'end': item['end']}
            if item['start'] > item['end']:
                warnings.append({'reason': 'timestamp_reversed', **details})
            if field == 'segments' and previous is not None and item['start'] < previous['start']:
                warnings.append({'reason': 'timestamp_backward', **details,
                                 'previous_id': previous['id'], 'previous_start': previous['start'],
                                 'backward_seconds': previous['start'] - item['start']})
            previous = item
    review = {'status': 'required' if warnings else 'not_required', 'warnings': warnings}
    require('timing_review' not in m or json.dumps(m['timing_review'], sort_keys=True) == json.dumps(review, sort_keys=True), 'timing review differs from transcript.')
    documents = {'transcript': t, 'timing_review': review}
    if 'analysis' in files:
        a = strict_json(files['analysis'][1]); documents['analysis'] = a
        require(isinstance(a, dict) and a.get('schema_version') == 'gemini-transcribe.analysis/v1', 'invalid analysis version.')
        fields = {'summary': ('text',), 'topics': ('title', 'text'), 'decisions': ('text',), 'action_items': ('task',), 'questions': ('question',), 'speaker_mappings': ('name',)}
        for key, required in fields.items():
            require(isinstance(a.get(key), list), 'invalid analysis array.')
            for item in a[key]:
                refs(item); require(all(text(item.get(k)) for k in required), 'missing claim text.')
                if key == 'action_items': require(all(k in item and (item[k] is None or text(item[k])) for k in ('owner', 'deadline')), 'invalid action attribution.')
                if key == 'questions': require(item.get('status') in ('answered', 'partially_answered', 'unresolved', 'unclear') and 'answer' in item and (item['answer'] is None or text(item['answer'])), 'invalid question.')
                if key == 'speaker_mappings': require(item.get('speaker') in speakers and item.get('status') in ('explicit', 'tentative'), 'invalid speaker mapping.')
    if 'translation' in files:
        tr = strict_json(files['translation'][1]); documents['translation'] = tr
        require(isinstance(tr, dict) and tr.get('schema_version') == 'gemini-transcribe.translation/v1' and text(tr.get('target_language'), 100) and isinstance(tr.get('segments'), list), 'invalid translation.')
        if config is not None:
            require(tr['target_language'] == config['translation_language'], 'translation language differs from configuration.')
        require(len(tr['segments']) == len(t['segments']), 'incomplete translation.')
        for translated, original in zip(tr['segments'], t['segments']):
            require(isinstance(translated, dict) and translated.get('segment_id') == original['id'] and text(translated.get('text')), 'invalid translated segment.')
    require('speaker_names' in m, 'missing speaker name policy.')
    from .speaker_names import resolve, validate
    try:
        validate(m['speaker_names'], t)
        documents['resolved_speaker_names'] = resolve(t, documents.get('analysis'), m['speaker_names'])
    except ValueError:
        require(False, 'invalid speaker name policy or overrides.')
    if 'export_provenance' in m:
        provenance = m['export_provenance']
        require(isinstance(provenance, dict) and set(provenance) == {'schema_version', 'source_manifest_sha256'} and provenance.get('schema_version') == 'gemini-transcribe.export/v1' and isinstance(provenance.get('source_manifest_sha256'), str) and re.fullmatch(r'[0-9a-f]{64}', provenance['source_manifest_sha256']) is not None, 'invalid export provenance.')
    return m, raw, source, files, documents


def preflight(audio, manifest_path):
    try:
        return _preflight(audio, manifest_path)
    except (OSError, KeyError, TypeError, ValueError, AttributeError, OverflowError):
        raise wc.Fail(2, 'Invalid transcript bundle structure or inaccessible local file; no uploads attempted.') from None


def validate_audio_provenance(value, content):
    require(isinstance(value, dict), 'audio provenance must be an object.')
    common = {'input_name', 'input_sha256', 'stored_sha256', 'storage'}
    normalized = {'profile', 'converter', 'channels', 'sample_rate', 'bitrate', 'codec', 'duration'}
    require(value.get('storage') in ('original', 'normalized'), 'invalid audio storage provenance.')
    require(set(value) == common | (normalized if value['storage'] == 'normalized' else set()), 'invalid audio provenance fields.')
    require(text(value['input_name'], 500) and text(value['input_sha256'], 64) and
            re.fullmatch('[0-9a-f]{64}', value['input_sha256']) is not None,
            'invalid original audio identity.')
    require(value['stored_sha256'] == sha(content), 'stored audio provenance digest mismatch.')
    if value['storage'] == 'normalized':
        require(value['profile'] == 'mono-24khz-32kbps-opus-v1' and
                value['channels'] == 1 and value['sample_rate'] == 24000 and
                value['bitrate'] == 32000 and value['codec'] == 'opus' and
                text(value['converter'], 1000) and number(value['duration']) and value['duration'] > 0,
                'invalid normalization provenance.')
    else:
        require(value['input_sha256'] == sha(content), 'original audio digest mismatch.')


def import_bundle(cfg, audio, manifest_path, title, version, audio_provenance=None):
    from . import ingest as ing
    require(text(version, 100), 'version must contain 1–100 characters.')
    require(title is None or text(title, 500), 'title exceeds source bounds.')
    m, raw, content, files, docs = preflight(audio, manifest_path)
    if audio_provenance is not None:
        validate_audio_provenance(audio_provenance, content)
    # Build derived audio-observation passages before any network writes. Keep
    # model judgements distinct from words actually spoken in the recording.
    observation_chunks, observation_ordinals = [], {}
    indexed = {seg['id']: seg for seg in docs['transcript']['segments']}
    for category, items in [('tone', docs['transcript']['tone']), ('uncertainty', docs['transcript']['uncertainties'])]:
        for index, item in enumerate(items, 1):
            key = f'{category}{index:06d}'
            refs = item['segment_ids']
            start = min(indexed[ref]['start'] for ref in refs)
            end = max(indexed[ref]['end'] for ref in refs)
            if category == 'tone':
                body = 'Subjective model tone inference (not spoken text): ' + item['label'] + '\nAcoustic cues: ' + item['cues']
            else:
                body = 'Model extraction uncertainty (not spoken text): ' + item['kind'] + '\n' + item['description']
            body += '\nReferenced transcript segments: ' + ', '.join(refs)
            first = len(observation_chunks)
            timing = f'seconds {start:.3f}-{end:.3f}' if all(indexed[ref]['start'] <= indexed[ref]['end'] for ref in refs) else 'timing unavailable (reversed interval)'
            observation_chunks += ing.chunks(body, f'observation {key}; {timing}')
            observation_ordinals[key] = list(range(first, len(observation_chunks)))
    require(all(len(p['locator']) <= 500 and len(p['body']) <= 30000 for p in observation_chunks), 'model observation exceeds passage bounds.')
    digest = sha(raw)
    space = wc.space_id(cfg)
    def get_source(path, data, label=None):
        found = ing.rows(cfg, 'SELECT id, sha256 FROM sources WHERE space = ' + ing.literal(space) + ' AND sha256 = ' + ing.literal(sha(data)) + ' LIMIT 1')
        record = found[0] if found else ing.upload_source(cfg, path, data, sha(data), label)
        require(record.get('sha256') == sha(data), 'server source digest mismatch.')
        return record['id']
    source = get_source(Path(m['source']['name']), content, title)
    # Establish the immutable import identity before auxiliary uploads.
    base_notes = {'bundle_sha256': digest, 'source_sha256': sha(content), 'schema_version': m['schema_version']}
    warnings = docs['timing_review']['warnings']
    if warnings:
        base_notes.update(timing_review_required=True, timing_warning_count=len(warnings), timing_warnings=warnings[:10])
    if audio_provenance is not None:
        base_notes['audio'] = audio_provenance
    def rendition(source_id, kind, passages, extra=None):
        notes = json.dumps({**base_notes, **(extra or {}), 'passages': len(passages), 'sha256': sha(json.dumps(passages, sort_keys=True).encode())}, sort_keys=True)
        require(len(notes) <= 10000, 'provenance exceeds notes bounds.')
        query = 'SELECT id, notes FROM renditions WHERE source = ' + ing.literal(source_id) + ' AND kind = ' + ing.literal(kind) + ' AND version_label = ' + ing.literal(version) + ' LIMIT 1'
        existing = ing.rows(cfg, query)
        if not existing:
            try:
                record = wc.must(cfg, 'POST', wc.records('renditions'), {'source': source_id, 'kind': kind, 'processor': 'google/' + m['extraction']['model'] + ' / transcript-bundle-v2', 'version_label': version, 'notes': notes})
            except wc.Fail:
                existing = ing.rows(cfg, query)
                if not existing: raise
                record = existing[0]
        else: record = existing[0]
        if record['notes'] != notes:
            # An import-only retry may omit locally generated conversion metadata;
            # preserve the first immutable provenance rather than stripping it.
            try:
                previous, expected = json.loads(record['notes']), json.loads(notes)
                if audio_provenance is None:
                    previous.pop('audio', None)
                elif isinstance(previous.get('audio'), dict):
                    expected['audio']['input_name'] = previous['audio'].get('input_name')
                compatible = previous == expected
            except (ValueError, TypeError, KeyError):
                compatible = False
            if not compatible:
                raise wc.Fail(4, 'Existing bundle rendition differs; select a new --version.')
        mapping = []
        for ordinal, passage in enumerate(passages, 1):
            query = 'SELECT id, locator, body FROM passages WHERE rendition = ' + ing.literal(record['id']) + f' AND ordinal = {ordinal} LIMIT 1'
            previous = ing.rows(cfg, query)
            if not previous:
                try: previous = [wc.must(cfg, 'POST', wc.records('passages'), {'rendition': record['id'], 'ordinal': ordinal, **passage})]
                except wc.Fail:
                    previous = ing.rows(cfg, query)
                    if not previous: raise
            if any(previous[0][k] != passage[k] for k in ('locator', 'body')): raise wc.Fail(4, 'Existing bundle passage differs; select a new --version.')
            mapping.append(previous[0]['id'])
        counts = ing.rows(cfg, 'SELECT COUNT(*) AS count FROM passages WHERE rendition = ' + ing.literal(record['id']))[0]
        if counts['count'] != len(passages): raise wc.Fail(4, 'Unexpected bundle passages; select a new --version.')
        return record['id'], mapping
    t = docs['transcript']
    passages, segment_ordinals = [], {}
    for seg in t['segments']:
        start = len(passages)
        name = docs['resolved_speaker_names'].get(seg['speaker'])
        label = f"{name} ({seg['speaker']})" if name else seg['speaker']
        timing = f"seconds {seg['start']:.3f}-{seg['end']:.3f}" if seg['start'] <= seg['end'] else 'timing unavailable (reversed interval)'
        passages += ing.chunks(label + ': ' + seg['text'], f"segment {seg['id']}; {timing}")
        segment_ordinals[seg['id']] = list(range(start, len(passages)))
    # Full mapping evidence and review reasons stay in the protected manifest
    # and analysis sources linked by the transcript-bundle rendition.
    naming_notes = {'speaker_name_policy': m['speaker_names']['policy'],
                    'speaker_name_provenance': 'manifest speaker_names overrides; analysis speaker_mappings (model-generated)'}
    rid, passage_ids = rendition(source, 'transcript', passages, naming_notes)
    artifact_sources = {'manifest': get_source(Path('manifest.json'), raw)}
    for role, (path, data) in files.items(): artifact_sources[role] = get_source(Path(path.name), data)
    annotation_passages, acoustic = {}, []
    for ann in t['audio_annotations']:
        start = len(acoustic)
        timing = f"seconds {ann['start']:.3f}-{ann['end']:.3f}" if ann['start'] <= ann['end'] else 'timing unavailable (reversed interval)'
        acoustic += ing.chunks(ann['kind'] + ': ' + ann['description'], f"annotation {ann['id']}; {timing}")
        annotation_passages[ann['id']] = list(range(start, len(acoustic)))
    arid, aids = rendition(source, 'audio-annotations', acoustic)
    orid, oids = rendition(source, 'model-observations', observation_chunks)
    derived = {}
    for role in ('analysis', 'translation'):
        if role in docs:
            chunks = ing.chunks(json.dumps(docs[role], ensure_ascii=False, indent=2), 'derived ' + role + '; segment references in artifact')
            derived[role], _ = rendition(artifact_sources[role], 'derived-' + role, chunks, {'audio_source': source, 'transcript_rendition': rid, 'independent_evidence': False})
    # Final link record is immutable and reconstructible after any interrupted phase.
    link_rid, _ = rendition(source, 'transcript-bundle', [], {'artifact_sources': artifact_sources, 'transcript_rendition': rid, 'annotations_rendition': arid, 'observations_rendition': orid, 'derived_renditions': derived})
    return {'timing_review': docs['timing_review'], 'space': space, 'source': source, 'sha256': sha(content), 'rendition': rid, 'bundle_rendition': link_rid, 'artifact_sources': artifact_sources, 'derived_renditions': derived, 'annotations_rendition': arid, 'observations_rendition': orid, 'observation_passages': {k: [oids[i] for i in v] for k, v in observation_ordinals.items()}, 'segment_passages': {k: [passage_ids[i] for i in v] for k, v in segment_ordinals.items()}, 'annotation_passages': {k: [aids[i] for i in v] for k, v in annotation_passages.items()}, 'passages': len(passages), 'status': 'extracted', 'next': 'Review original evidence, synthesize cited revisions in a staging run, then publish.'}
