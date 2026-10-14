"""Private, resumable Gemini orchestration. Provider generation is never retried implicitly."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from . import cli as wc
from . import ingest as ing

GEMINI_COMMIT = 'bd5745046c05a9eb67cdb6fbafbe191bfb85e86d'
GEMINI_PACKAGE = 'gemini-transcribe @ git+https://github.com/pocketcontext/gemini-transcribe.git@' + GEMINI_COMMIT
PROFILE = 'mono-24khz-32kbps-opus-v1'


def save(path, value):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as handle:
        os.fchmod(handle.fileno(), 0o600)
        json.dump(value, handle, sort_keys=True)
    os.replace(handle.name, path)


REASONS = frozenset('''invalid_json invalid_structure invalid_nullable_value
expected_object missing_field unexpected_fields expected_array expected_nonempty_string
expected_finite_number expected_boolean expected_null invalid_enum empty_references
duplicate_references unknown_segment_reference unsupported_schema_version timestamp_order
timestamp_out_of_bounds invalid_local_id duplicate_speakers unknown_speaker
target_language_mismatch translation_segment_count translation_segment_order
invalid_language invalid_timestamp invalid_speaker_label'''.split())
FIELDS = frozenset('''language segments start end speaker text audio_annotations kind
description speakers uncertainties segment_ids tone label cues subjective schema_version
id summary topics title decisions action_items task owner deadline questions question answer
status speaker_mappings name target_language segment_id'''.split())


def valid_diagnostic(value):
    """Also validate diagnostics read from resumable, potentially edited manifests."""
    if not isinstance(value, dict) or set(value) not in (
            {'reason', 'path'}, {'reason', 'path', 'line', 'column'}):
        return False
    if not isinstance(value['reason'], str) or value['reason'] not in REASONS:
        return False
    path = value['path']
    if not isinstance(path, str) or len(path) > 256 or not re.fullmatch(
            r'\$(?:\.[a-z_]+|\[[0-9]{1,10}\])*', path):
        return False
    if any(field not in FIELDS for field in re.findall(r'\.([a-z_]+)', path)):
        return False
    return 'line' not in value or (value['reason'] == 'invalid_json' and all(
        type(value[k]) is int and 0 < value[k] <= 2**63-1 for k in ('line', 'column')))


def safe_errors(receipt):
    """Only known content-free structural diagnostics cross the process boundary."""
    result = []
    errors = receipt.get('errors', [])
    if not isinstance(errors, list):
        raise ValueError('Invalid error receipt')
    codes = {'invalid_output', 'invalid_configuration', 'invalid_arguments', 'local_failure',
             'request_failed', 'request_timeout', 'processing_timeout', 'processing_failed',
             'incomplete_response', 'stage_failed', 'export_failed', 'resume_invalid',
             'source_changed', 'source_unavailable', 'bundle_in_use'}
    for error in errors[:20]:
        if not isinstance(error, dict):
            raise ValueError('Invalid error receipt')
        item = {'stage': error.get('stage') if isinstance(error.get('stage'), str) and error.get('stage') in
                ('transcription', 'analysis', 'translation', 'resume', 'configuration') else 'unknown',
                'code': error.get('code') if isinstance(error.get('code'), str) and error.get('code') in codes else 'unknown'}
        if type(error.get('http_status')) is int and 100 <= error['http_status'] <= 599:
            item['http_status'] = error['http_status']
        if valid_diagnostic(error.get('validation')):
            item['validation'] = error['validation']
        result.append(item)
    return result


def ingest_audio(cfg, path, title, version, audio_storage, pipeline, language,
                 translation_language, resume, gemini_executable):
    from .transcript_bundle import import_bundle
    with path.open('rb') as handle:
        head = handle.read(100)
    if not head or head.startswith(b'version https://git-lfs.github.com/spec/v1\n'):
        raise wc.Fail(2, 'Source is empty or a Git LFS pointer; retrieve actual source bytes first.')
    if pipeline not in ('standard', 'long-decode'):
        raise wc.Fail(2, 'Unsupported Gemini pipeline.')
    for value in (language, translation_language):
        if value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 100):
            raise wc.Fail(2, 'Language must contain 1–100 characters.')
    model = os.environ.get('GEMINI_MODEL') or ('gemini-4-argon' if pipeline == 'long-decode' else 'gemini-3.8-flash')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', model):
        raise wc.Fail(2, 'Invalid GEMINI_MODEL.')
    if (pipeline == 'long-decode') != (model == 'gemini-4-argon'):
        raise wc.Fail(2, 'Gemini model and pipeline are incompatible.')
    # Check ordinary membership before conversion or any provider call.
    space = wc.space_id(cfg)
    refreshed = wc.must(cfg, 'POST', '/api/collections/users/auth-refresh')
    wc.hide(refreshed.get('token'))
    account = refreshed.get('record', {}).get('id')
    if not isinstance(account, str) or not re.fullmatch(r'[a-z0-9]{15}', account):
        raise wc.Fail(1, 'Unable to verify audio ingestion account.')
    memberships = ing.rows(cfg, 'SELECT role FROM space_members WHERE space = ' +
            ing.literal(space) + ' AND account = ' + ing.literal(account) + ' AND active = 1')
    if not memberships or memberships[0].get('role') not in ('owner', 'editor'):
        raise wc.Fail(2, 'Audio ingestion requires an active editor or owner space membership.')
    if not gemini_executable and not shutil.which('uv'):
        raise wc.Fail(2, 'uv is required for the pinned Gemini Transcribe package.')
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            raise wc.Fail(2, tool + ' is required for audio ingestion.')
    if not os.environ.get('GEMINI_API_KEY', '').strip():
        # Completed local workflows remain usable offline. Otherwise missing
        # credentials stop before normalization, package installation or uploads.
        input_hash = hashlib.sha256()
        with path.open('rb') as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b''):
                input_hash.update(block)
        expected = {'url': cfg['url'], 'email': cfg['email'], 'space': space,
                    'input_sha256': input_hash.hexdigest(), 'storage': audio_storage,
                    'pipeline': pipeline, 'model': model, 'language': language,
                    'translation_language': translation_language, 'version': version,
                    'package_commit': GEMINI_COMMIT}
        workflows = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'wikicontext' / 'audio-workflows'
        complete = False
        for candidate in workflows.glob('*/workflow.json'):
            try:
                saved = json.loads(candidate.read_text())
                if saved.get('status') == 'complete' and all(saved['identity'].get(k) == v for k, v in expected.items()):
                    complete = True
                    break
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                continue
        if not complete:
            raise wc.Fail(2, 'Set GEMINI_API_KEY before Gemini audio ingestion; no provider call attempted.')
    if audio_storage == 'original' and path.suffix.lower() not in {'.wav', '.mp3', '.aiff', '.aif', '.aac', '.ogg', '.flac', '.m4a'}:
        raise wc.Fail(2, 'Gemini does not accept this original audio format; use --audio-storage normalized.')
    if audio_storage == 'normalized':
        content, provenance = ing.prepare_audio(cfg, path, profile=PROFILE,
                sample_rate=24000, bitrate=32000, max_bytes=ing.MAX_SOURCE)
        suffix = '.ogg'
    else:
        if not 0 < path.stat().st_size <= ing.MAX_SOURCE:
            raise wc.Fail(2, 'Original audio must be nonempty and no larger than 100 MiB.')
        content = path.read_bytes()
        provenance = {'input_name': path.name, 'input_sha256': hashlib.sha256(content).hexdigest(),
                      'storage': 'original'}
        suffix = path.suffix.lower()
    if not 0 < len(content) <= ing.MAX_SOURCE or content.startswith(b'version https://git-lfs.github.com/spec/v1\n'):
        raise wc.Fail(2, 'Audio must contain actual nonempty bytes no larger than 100 MiB; no provider call attempted.')
    digest = hashlib.sha256(content).hexdigest()
    provenance['stored_sha256'] = digest
    identity = {'url': cfg['url'], 'email': cfg['email'], 'space': space,
                'input_sha256': provenance['input_sha256'], 'stored_sha256': digest,
                'storage': audio_storage, 'pipeline': pipeline, 'model': model, 'language': language,
                'translation_language': translation_language, 'version': version,
                'package_commit': GEMINI_COMMIT}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    base = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'wikicontext' / 'audio-workflows'
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(base, 0o700)
    folder = base / key
    folder.mkdir(mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    receipt_path = folder / 'workflow.json'
    if resume and Path(resume).resolve() != receipt_path.resolve():
        raise wc.Fail(2, 'Resume receipt does not match this audio, configuration, identity and version.')
    with (folder / 'workflow.lock').open('a+b') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        audio = folder / ('audio' + suffix)
        if receipt_path.exists():
            try:
                receipt = json.loads(receipt_path.read_text())
                if receipt['identity'] != identity or hashlib.sha256(audio.read_bytes()).hexdigest() != digest:
                    raise ValueError()
            except (OSError, ValueError, KeyError, TypeError):
                raise wc.Fail(1, 'Audio workflow receipt or snapshot is invalid; investigate before retrying.') from None
        else:
            if resume:
                raise wc.Fail(2, 'Resume receipt does not exist.')
            if audio.exists():
                if audio.is_symlink() or hashlib.sha256(audio.read_bytes()).hexdigest() != digest:
                    raise wc.Fail(1, 'Unreceipted audio snapshot differs; investigate before retrying.')
                os.chmod(audio, 0o600)
            else:
                with os.fdopen(os.open(audio, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as handle:
                    handle.write(content)
            receipt = {'schema': 'wikicontext.audio-workflow/v1', 'identity': identity,
                       'audio': provenance, 'status': 'prepared'}
            save(receipt_path, receipt)
        if receipt['status'] != 'complete':
            if receipt['status'] != 'prepared' and not resume:
                raise wc.Fail(1, f'Previous Gemini attempt requires explicit --resume {receipt_path}; no provider retry attempted.')
            if not os.environ.get('GEMINI_API_KEY', '').strip():
                raise wc.Fail(2, 'Set GEMINI_API_KEY before Gemini audio ingestion; no provider call attempted.')
            command = [str(gemini_executable)] if gemini_executable else [
                'uv', 'run', '--no-project', '--no-config', '--python', '3.12', '--with', GEMINI_PACKAGE, 'gemini-transcribe']
            manifest = receipt.get('manifest_path')
            if manifest:
                command += ['--resume', manifest]
            elif receipt['status'] != 'prepared':
                raise wc.Fail(1, f'Previous attempt has no resumable manifest; inspect private workflow {receipt_path} before starting a new version.')
            else:
                command += [str(audio), '--output-dir', str(folder / 'bundles'), '--pipeline', pipeline]
                for flag, value in (('--language', language), ('--translation-language', translation_language)):
                    if value is not None:
                        command += [flag, value]
            command += ['--model', model, '--json']
            receipt['status'] = 'running'
            save(receipt_path, receipt)
            try:
                process = subprocess.run(command, cwd=folder, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, timeout=7200, check=False)
                output = json.loads(process.stdout)
                if not isinstance(output, dict) or output.get('status') not in ('complete', 'partial', 'failed'):
                    raise ValueError()
                manifest = output.get('manifest_path')
                if manifest:
                    manifest = Path(manifest).resolve()
                    if not manifest.is_relative_to(folder / 'bundles') or manifest.name != 'manifest.json':
                        raise ValueError()
                    receipt['manifest_path'] = str(manifest)
                receipt['errors'] = safe_errors(output)
                if b'Warning: uploaded audio deletion failed;' in process.stderr:
                    receipt['errors'].append({'stage': 'cleanup', 'code': 'uploaded_audio_deletion_failed'})
                receipt['status'] = 'complete' if process.returncode == 0 and output['status'] == 'complete' and manifest else 'failed'
                save(receipt_path, receipt)
            except (OSError, ValueError, TypeError, subprocess.SubprocessError):
                receipt['status'] = 'uncertain'
                save(receipt_path, receipt)
                raise wc.Fail(1, f'Gemini did not return a valid receipt; no retry attempted. Inspect private workflow {receipt_path}.') from None
            if receipt['status'] != 'complete':
                raise wc.Fail(1, 'Gemini extraction failed: ' + json.dumps(receipt['errors']) +
                              f'; resume explicitly with --resume {receipt_path}.')
        result = import_bundle(cfg, audio, receipt['manifest_path'], title or path.stem, version, audio_provenance=receipt['audio'])
        receipt['import'] = result
        save(receipt_path, receipt)
        return {**result, 'workflow_receipt': str(receipt_path), 'manifest_path': receipt['manifest_path'],
                'audio_provenance': receipt['audio'], 'audio_provider': 'gemini', 'pipeline': pipeline,
                'provider_warnings': receipt.get('errors', [])}
