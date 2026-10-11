"""Store immutable sources and ingest evidence; synthesis belongs to the skill."""
import fcntl
import hashlib
import json
import math
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request

from . import cli as wc
from . import image_review as reviewed_image

AUDIO = {'.mp3', '.m4a', '.wav', '.flac', '.ogg', '.webm', '.mp4', '.mpeg', '.mpga', '.opus'}
TEXT = {'.txt', '.md', '.markdown', '.csv', '.json', '.rst', '.log'}
MAX_SOURCE = 100 * 1024 * 1024
MAX_AUDIO = 25_000_000
AUDIO_PROFILE = 'mono-16khz-16kbps-opus-v1'


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def rows(cfg, sql):
    result = wc.must(cfg, 'POST', '/api/context/query', {'sql': sql})
    if result.get('truncated'):
        raise wc.Fail(1, 'Evidence query was truncated; no ingestion writes attempted from incomplete results.')
    return [dict(zip(result['columns'], row)) for row in result['rows']]


def multipart(fields, field, filename, content, media='application/octet-stream'):
    boundary = 'wikicontext-' + secrets.token_hex(24)
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    # Filename is generated locally, never an unsanitized source label.
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\nContent-Type: {media}\r\n\r\n'.encode())
    parts.extend([content, f'\r\n--{boundary}--\r\n'.encode()])
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary


def upload_source(cfg, path, content, digest, title):
    # Refresh through the normal authenticated client before using its cached token.
    wc.must(cfg, 'POST', '/api/context/query', {'sql': 'SELECT 1'})
    session = wc.load_session(cfg)
    if not session:
        session = wc.login(cfg)
    fields = {'space': wc.space_id(cfg), 'title': title or path.stem, 'original_name': path.name,
              'media_type': mimetypes.guess_type(path.name)[0] or 'application/octet-stream'}
    suffix = path.suffix.lower() if path.suffix.lower().lstrip('.').isalnum() else '.bin'
    body, media = multipart(fields, 'original', digest + suffix, content)
    request = urllib.request.Request(cfg['url'] + wc.records('sources'), data=body,
                                    headers={'Authorization': session['token'], 'Content-Type': media,
                                             'User-Agent': wc.USER_AGENT}, method='POST')
    try:
        with wc.opener.open(request, timeout=180) as response:
            return json.load(response)
    except (OSError, ValueError) as error:
        # A concurrent upload or lost response can already have persisted this exact original.
        found = rows(cfg, 'SELECT id, sha256 FROM sources WHERE sha256 = ' + literal(digest) + ' AND space = ' + literal(wc.space_id(cfg)) + ' LIMIT 1')
        if found:
            return found[0]
        status = getattr(error, 'code', None)
        raise wc.Fail(1, f'Original upload failed (HTTP {status or "transport error"}); retry ingestion.') from None


def command(args):
    if not shutil.which(args[0]):
        raise wc.Fail(2, f'{args[0]} is required for this source type; local input is unchanged.')
    try:
        return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600).stdout
    except (OSError, subprocess.SubprocessError):
        raise wc.Fail(1, f'{args[0]} failed; local input is unchanged.') from None


def duration(path):
    # Match the stream selected by convert_audio; container duration may include
    # longer video or other audio tracks. Some containers (notably WebM) omit
    # stream duration, so count decoded audio time with timestamps reset instead.
    value = command(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                     '-show_entries', 'stream=duration', '-of',
                     'default=noprint_wrappers=1:nokey=1', str(path)]).strip()
    try:
        seconds = float(value)
    except ValueError:
        progress = command(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path),
                            '-map', '0:a:0', '-vn', '-af', 'asetpts=N/SR/TB',
                            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
                            '-f', 'null', '-nostats', '-progress', 'pipe:1', '-'])
        # The null muxer counts samples without retaining decoded recordings on
        # disk or in memory. The final progress block reports the complete time.
        values = [line.partition(b'=')[2] for line in progress.splitlines()
                  if line.startswith(b'out_time_us=')]
        try:
            seconds = float(values[-1]) / 1_000_000
        except (ValueError, IndexError):
            raise wc.Fail(1, 'Cannot verify audio duration; no audio sent to Groq.') from None
    if not math.isfinite(seconds) or seconds <= 0:
        raise wc.Fail(1, 'Cannot verify audio duration; no audio sent to Groq.')
    return seconds


def convert_audio(path, derivative, metadata=None):
    original_duration = duration(path)
    args = ['ffmpeg', '-nostdin', '-v', 'error', '-fflags', '+bitexact', '-i', str(path),
            '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-af', 'asetpts=N/SR/TB',
            '-ac', '1', '-ar', '16000',
            '-c:a', 'libopus', '-b:a', '16k', '-flags:a', '+bitexact', '-fflags', '+bitexact']
    for key, value in (metadata or {}).items():
        args.extend(['-metadata', key + '=' + str(value)])
    command([*args, str(derivative)])
    if abs(duration(derivative) - original_duration) > 1:
        raise wc.Fail(1, 'Normalized audio duration differs by more than one second; no normalized audio sent. Any previously uploaded source remains stored.')
    if not 0 < derivative.stat().st_size <= MAX_AUDIO:
        raise wc.Fail(2, 'Normalized audio exceeds the 25 MB limit or is empty; no normalized audio sent. Any previously uploaded source remains stored. Supply approved split sources.')
    return original_duration


def prepare_audio(cfg, path):
    """Snapshot large inputs, and retain exact normalized bytes for safe retries."""
    base = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'wikicontext' / 'audio'
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(base, 0o700)
    with tempfile.TemporaryDirectory(prefix='input-', dir=base) as folder:
        snapshot = Path(folder) / ('input' + path.suffix.lower())
        digest = hashlib.sha256()
        with path.open('rb') as source, snapshot.open('wb') as target:
            os.chmod(snapshot, 0o600)
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
                target.write(block)
        input_sha = digest.hexdigest()
        with snapshot.open('rb') as source:
            head = source.read(100)
        if not head or head.startswith(b'version https://git-lfs.github.com/spec/v1\n'):
            raise wc.Fail(2, 'Source is empty or a Git LFS pointer; retrieve actual source bytes first.')
        key = hashlib.sha256((cfg['url'] + '\n' + cfg['email'] + '\n' + input_sha + '\n' + AUDIO_PROFILE).encode()).hexdigest()
        cached = base / key
        with (base / (key + '.lock')).open('a+b') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            if cached.exists():
                try:
                    provenance = json.loads((cached / 'provenance.json').read_text())
                    content = (cached / 'audio.ogg').read_bytes()
                    if (provenance['input_sha256'] != input_sha or provenance['profile'] != AUDIO_PROFILE
                            or provenance['stored_sha256'] != hashlib.sha256(content).hexdigest()
                            or not 0 < len(content) <= MAX_AUDIO):
                        raise ValueError()
                except (OSError, ValueError, KeyError, TypeError):
                    raise wc.Fail(1, 'Normalized audio cache is invalid; investigate before retrying.') from None
                return content, provenance
            converter = command(['ffmpeg', '-version']).decode('utf-8', errors='replace').splitlines()[0]
            provenance = {'input_name': path.name, 'input_sha256': input_sha, 'profile': AUDIO_PROFILE,
                          'converter': converter, 'storage': 'normalized', 'channels': 1,
                          'sample_rate': 16000, 'bitrate': 16000, 'codec': 'opus'}
            with tempfile.TemporaryDirectory(prefix='conversion-', dir=base) as staging:
                derivative = Path(staging) / 'audio.ogg'
                provenance['duration'] = convert_audio(snapshot, derivative, {
                    'wikicontext_input_sha256': input_sha, 'wikicontext_audio_profile': AUDIO_PROFILE,
                    'wikicontext_converter': converter})
                os.chmod(derivative, 0o600)
                content = derivative.read_bytes()
                provenance['stored_sha256'] = hashlib.sha256(content).hexdigest()
                metadata = Path(staging) / 'provenance.json'
                metadata.write_text(json.dumps(provenance, sort_keys=True))
                os.chmod(metadata, 0o600)
                # Publish the complete cache together. The lock serializes concurrent retries.
                os.rename(staging, cached)
            return content, provenance


def transcribe(path, normalized=False):
    if not wc.hide(os.environ.get('WIKICONTEXT_GROQ_API_KEY')):
        raise wc.Fail(2, 'Set WIKICONTEXT_GROQ_API_KEY to transcribe audio; uploaded source remains stored.')
    if normalized:
        return send_transcription(path, duration(path))
    with tempfile.TemporaryDirectory(prefix='wikicontext-audio-') as folder:
        derivative = Path(folder) / 'audio.ogg'
        original_duration = convert_audio(path, derivative)
        return send_transcription(derivative, original_duration)


def send_transcription(path, original_duration):
    key = wc.hide(os.environ.get('WIKICONTEXT_GROQ_API_KEY'))
    if not key:
        raise wc.Fail(2, 'Set WIKICONTEXT_GROQ_API_KEY to transcribe audio; uploaded source remains stored.')
    if not 0 < path.stat().st_size <= MAX_AUDIO:
        raise wc.Fail(2, 'Transcription audio must be nonempty and no larger than 25 MB.')
    body, media = multipart({'model': 'whisper-large-v3-turbo', 'response_format': 'verbose_json', 'timestamp_granularities[]': 'segment'}, 'file', 'audio.ogg', path.read_bytes(), 'audio/ogg')
    request = urllib.request.Request('https://api.groq.com/openai/v1/audio/transcriptions', data=body,
                                    headers={'Authorization': 'Bearer ' + key, 'Content-Type': media}, method='POST')
    try:
        with wc.opener.open(request, timeout=600) as response:
            result = json.load(response)
    except (OSError, ValueError):
        raise wc.Fail(1, 'Groq transcription failed; uploaded source remains stored. Retry after checking provider availability and credentials.') from None
    segments = result.get('segments') if isinstance(result, dict) else None
    if not isinstance(segments, list) or not segments:
        raise wc.Fail(1, 'Groq returned no timestamped segments; original remains stored.')
    output = []
    for segment in segments:
        try:
            start, end, body = float(segment['start']), float(segment['end']), segment['text']
            if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start <= end <= original_duration + 2 or not isinstance(body, str):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise wc.Fail(1, 'Groq returned an invalid transcript segment; retry transcription.') from None
        output.extend(chunks(body, f'seconds {start:.3f}-{end:.3f}'))
    return output


def chunks(text, locator):
    return [{'locator': f'{locator}; characters {offset + 1}-{min(offset + 24000, len(text))}', 'body': text[offset:offset + 24000]}
            for offset in range(0, len(text), 24000) if text[offset:offset + 24000].strip()]


def extract(path, content, normalized=False):
    suffix = path.suffix.lower()
    if suffix in TEXT or not suffix:
        try:
            return 'text', 'utf-8 text / wikicontext-1', chunks(content.decode('utf-8-sig'), 'document')
        except UnicodeDecodeError:
            raise wc.Fail(2, 'Text source is not UTF-8; provide an explicitly converted source without replacing the original.') from None
    if suffix == '.pdf':
        output = command(['pdftotext', '-layout', str(path), '-']).decode('utf-8')
        passages = []
        for number, page in enumerate(output.split('\f'), 1):
            passages.extend(chunks(page, f'page {number}'))
        return 'text', 'pdftotext / wikicontext-1', passages
    if suffix in AUDIO:
        return 'transcript', 'groq/whisper-large-v3-turbo / wikicontext-1', transcribe(path, normalized=normalized)
    raise wc.Fail(2, f'Unsupported source extension {suffix or "(none)"}; original stored, extraction incomplete. Supply a supported source or explicitly prepare a rendition.')


def ingest(cfg, path, title=None, version='v1', audio_storage='normalized', image_review=None):
    path = Path(path).resolve()
    if not version or len(version) > 100:
        raise wc.Fail(2, 'Rendition version must contain 1–100 characters.')
    if audio_storage not in ('normalized', 'original'):
        raise wc.Fail(2, 'Audio storage must be normalized or original.')
    if not path.is_file():
        raise wc.Fail(2, 'Source must be a regular file.')
    is_image = path.suffix.lower() in reviewed_image.EXTENSIONS
    if image_review and not is_image:
        raise wc.Fail(2, '--image-review requires a PNG, JPEG or WebP source.')
    normalized = path.suffix.lower() in AUDIO and audio_storage == 'normalized'
    provenance = None
    if normalized:
        content, provenance = prepare_audio(cfg, path)
        title = title or path.stem
        path = path.with_name(path.stem + '.normalized.ogg')
    else:
        if path.stat().st_size > MAX_SOURCE:
            raise wc.Fail(2, 'Source must be no larger than 100 MiB; audio can use --audio-storage normalized.')
        content = path.read_bytes()
    if len(content) > MAX_SOURCE:
        raise wc.Fail(2, 'Source exceeds 100 MiB; no upload attempted.')
    if not content or content.startswith(b'version https://git-lfs.github.com/spec/v1\n'):
        raise wc.Fail(2, 'Source is empty or a Git LFS pointer; retrieve actual source bytes first.')
    digest = hashlib.sha256(content).hexdigest()
    image_data = None
    if is_image:
        image_processor, image_passages, image_data = reviewed_image.prepare(content, path.suffix.lower(), image_review)
        image_manifest = {'passages': len(image_passages), 'sha256': hashlib.sha256(json.dumps(image_passages, sort_keys=True).encode()).hexdigest(), 'image': image_data}
        if len(json.dumps(image_manifest, sort_keys=True, ensure_ascii=False)) > 10000:
            raise wc.Fail(2, 'Rendition provenance exceeds the 10000-character notes limit; no upload attempted.')
        related = image_data.get('related_source')
        if related and not rows(cfg, 'SELECT id FROM sources WHERE id = ' + literal(related) + ' AND space = ' + literal(wc.space_id(cfg)) + ' LIMIT 1'):
            raise wc.Fail(2, 'Image related_source does not exist; no upload attempted.')
    # Deduplication is per space: the same bytes in another space are a separate source.
    found = rows(cfg, 'SELECT id, sha256 FROM sources WHERE sha256 = ' + literal(digest) + ' AND space = ' + literal(wc.space_id(cfg)) + ' LIMIT 1')
    source = found[0] if found else upload_source(cfg, path, content, digest, title)
    if source.get('sha256') != digest:
        raise wc.Fail(1, 'Server original checksum differs; stop and investigate before extraction.')
    # A complete immutable rendition can be reused even on a different machine.
    kind_hint = 'image-review' if is_image else ('transcript' if path.suffix.lower() in AUDIO else 'text')
    completed = rows(cfg, 'SELECT id, notes FROM renditions WHERE source = ' + literal(source['id']) + ' AND kind = ' + literal(kind_hint) + ' AND version_label = ' + literal(version) + ' LIMIT 1')
    if completed and not is_image:
        try:
            expected = json.loads(completed[0]['notes'])['passages']
        except (ValueError, KeyError, TypeError):
            expected = None
        if type(expected) is int and expected > 0:
            counts = rows(cfg, 'SELECT COUNT(*) AS count, MIN(ordinal) AS first, MAX(ordinal) AS last FROM passages WHERE rendition = ' + literal(completed[0]['id']))[0]
            if counts == {'count': expected, 'first': 1, 'last': expected}:
                return {'space': wc.space_id(cfg), 'source': source['id'], 'rendition': completed[0]['id'], 'passages': expected, 'sha256': digest, 'status': 'extracted', 'next': 'Synthesize cited page revisions in a staging ingestion run, then publish.'}
    # Cache only extraction output, with a restrictive mode. Identity and server scope prevent cross-workspace reuse.
    key = hashlib.sha256((cfg['url'] + '\n' + cfg['email'] + '\n' + digest + '\n' + version + '\n' + path.suffix.lower() + ('\nimage-review\n' + image_data['review_sha256'] if image_data else '')).encode()).hexdigest()
    base = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'wikicontext' / 'extractions'
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(base, 0o700)
    cache = base / (key + '.json')
    if is_image:
        # The reviewed JSON is already the reproducible extraction. Never let a
        # stale cache bypass review validation or immutable-version conflicts.
        kind, processor, passages = 'image-review', image_processor, image_passages
    elif cache.exists():
        try:
            kind, processor, passages = json.loads(cache.read_text())
        except (ValueError, OSError):
            raise wc.Fail(1, 'Extraction cache is unreadable; investigate before retrying.') from None
    else:
        # Tools operate on an immutable local snapshot of the exact uploaded bytes.
        with tempfile.TemporaryDirectory(prefix='wikicontext-source-') as folder:
            snapshot = Path(folder) / ('source' + path.suffix.lower())
            snapshot.write_bytes(content)
            kind, processor, passages = extract(snapshot, content, normalized=normalized)
        if not passages:
            raise wc.Fail(1, 'Extraction returned no text (scanned PDFs require OCR); original remains stored.')
        with tempfile.NamedTemporaryFile(mode='w', dir=base, delete=False) as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump([kind, processor, passages], handle, ensure_ascii=False)
        os.replace(handle.name, cache)
    manifest_data = {'passages': len(passages), 'sha256': hashlib.sha256(json.dumps(passages, sort_keys=True).encode()).hexdigest()}
    if provenance:
        manifest_data['audio'] = provenance
    if image_data:
        manifest_data['image'] = image_data
    manifest = json.dumps(manifest_data, sort_keys=True, ensure_ascii=False) if image_data else json.dumps(manifest_data, sort_keys=True)
    if len(manifest) > 10000:
        raise wc.Fail(2, 'Rendition provenance exceeds the 10000-character notes limit.')
    query = 'SELECT id, notes FROM renditions WHERE source = ' + literal(source['id']) + ' AND kind = ' + literal(kind) + ' AND version_label = ' + literal(version) + ' LIMIT 1'
    existing = rows(cfg, query)
    if not existing:
        try:
            rendition = wc.must(cfg, 'POST', wc.records('renditions'), {'source': source['id'], 'kind': kind, 'processor': processor, 'version_label': version, 'notes': manifest})
        except wc.Fail:
            existing = rows(cfg, query)
            if not existing:
                raise
            rendition = existing[0]
    else:
        rendition = existing[0]
    if rendition['notes'] != manifest:
        # The same input may be renamed before a retry on another machine. Keep
        # its first recorded name without treating that label as evidence identity.
        try:
            previous_manifest = json.loads(rendition['notes'])
            expected_manifest = json.loads(manifest)
            if provenance and isinstance(previous_manifest.get('audio'), dict):
                expected_manifest['audio']['input_name'] = previous_manifest['audio']['input_name']
            compatible = previous_manifest == expected_manifest
        except (ValueError, KeyError, TypeError, AttributeError):
            compatible = False
        if not compatible:
            raise wc.Fail(4, 'Existing rendition has different extracted content. Preserve it and select a new --version.')
    for ordinal, passage in enumerate(passages, 1):
        query = 'SELECT id, locator, body FROM passages WHERE rendition = ' + literal(rendition['id']) + f' AND ordinal = {ordinal} LIMIT 1'
        previous = rows(cfg, query)
        if not previous:
            try:
                wc.must(cfg, 'POST', wc.records('passages'), {'rendition': rendition['id'], 'ordinal': ordinal, **passage})
                continue
            except wc.Fail:
                previous = rows(cfg, query)
                if not previous:
                    raise
        if any(previous[0][field] != passage[field] for field in ('locator', 'body')):
            raise wc.Fail(4, 'Existing passage differs from extraction; select a new rendition version.')
    if is_image:
        counts = rows(cfg, 'SELECT COUNT(*) AS count, MIN(ordinal) AS first, MAX(ordinal) AS last FROM passages WHERE rendition = ' + literal(rendition['id']))[0]
        if counts != {'count': len(passages), 'first': 1, 'last': len(passages)}:
            raise wc.Fail(4, 'Existing image rendition contains unexpected passages; select a new rendition version.')
    return {'space': wc.space_id(cfg), 'source': source['id'], 'rendition': rendition['id'], 'passages': len(passages), 'sha256': digest, 'status': 'extracted', 'next': 'Synthesize cited page revisions in a staging ingestion run, then publish.'}
