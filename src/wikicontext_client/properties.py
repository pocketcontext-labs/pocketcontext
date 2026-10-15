"""Revision property shapes shared by lint and deterministic export."""
import datetime
import json
import math
import re
from . import cli as wc

RELATIONSHIPS = frozenset(('deployment_profiles', 'applications', 'resources', 'credentials',
                           'consumers', 'replaces', 'replaced_by', 'members', 'accountable_owners', 'backup_owners', 'documents', 'destinations', 'transcript_pages', 'summary_pages'))
TARGET_CATALOGS = {'members': 'person', 'accountable_owners': 'group', 'backup_owners': 'group', 'documents': 'repository_document', 'destinations': 'repository_destination'}
RESERVED = frozenset(('wikicontext_page', 'wikicontext_revision', 'id', 'page', 'page_id',
    'revision', 'revision_id', 'publication', 'publication_id', 'kind', 'title', 'summary',
    'body', 'archived', 'run', 'base_revision', 'created', 'updated', 'created_by',
    'updated_by', 'properties', 'property_evidence', 'constructor', 'prototype', '__proto__'))


def decode(value):
    # PocketBase's JSON fields on revisions predating the migration may be null.
    return json.loads(value) if isinstance(value, str) else value


def read(revision):
    try:
        properties = decode(revision.get('properties'))
        evidence = decode(revision.get('property_evidence'))
        properties = {} if properties is None else properties
        evidence = {} if evidence is None else evidence
        if not isinstance(properties, dict) or len(properties) > 64 or not isinstance(evidence, dict):
            raise ValueError()
        for key, value in properties.items():
            if not re.fullmatch('[a-z][a-z0-9_]{0,63}', key) or key in RESERVED:
                raise ValueError()
            valid = (value is None or type(value) is bool
                     or (isinstance(value, str) and len(value) <= 2048)
                     or (type(value) in (int, float) and math.isfinite(value) and abs(value) <= 9007199254740991)
                     or (isinstance(value, list) and len(value) <= 100
                         and all(isinstance(item, str) and len(item) <= 2048 for item in value)
                         and len(set(value)) == len(value)))
            if not valid:
                raise ValueError()
            if key in RELATIONSHIPS and (not isinstance(value, list) or
                    any(not re.fullmatch('[a-z0-9]{15}', item) for item in value)):
                raise ValueError()
            if key == 'catalog_type' and value not in ('resource', 'credential', 'deployment', 'person', 'group', 'repository_document', 'repository_destination', 'repository_sync', 'audio_recording'):
                raise ValueError()
        if 'members' in properties and properties.get('catalog_type') != 'group':
            raise ValueError()
        validate_repository(properties)
        for key, markers in evidence.items():
            if (key not in properties or not isinstance(markers, list) or len(markers) > 32
                    or any(not isinstance(marker, str) or not re.fullmatch('[1-9][0-9]{0,5}', marker) for marker in markers)
                    or len(set(markers)) != len(markers)):
                raise ValueError()
        return properties, evidence
    except (ValueError, TypeError, OverflowError):
        raise wc.Fail(1, 'Invalid published revision properties') from None


def validate_repository(p):
    """Mirror the server's repository-file property shape contract."""
    def required(key, pattern):
        if not isinstance(p.get(key), str) or not re.fullmatch(pattern, p[key]):
            raise ValueError()
    catalog = p.get('catalog_type')
    for key, owner in (('documents', 'repository_destination'), ('destinations', 'repository_sync')):
        if key in p and catalog != owner:
            raise ValueError()
    for key in ('audio_source_id', 'selected_bundle_rendition_id', 'transcript_pages', 'summary_pages',
                'timing_review_bundle_rendition_id', 'timing_review_note'):
        if key in p and catalog != 'audio_recording':
            raise ValueError()
    if catalog == 'audio_recording':
        required('audio_source_id', '[a-z0-9]{15}')
        if p.get('selected_bundle_rendition_id') is not None:
            required('selected_bundle_rendition_id', '[a-z0-9]{15}')
        if p.get('timing_review_bundle_rendition_id') is not None or p.get('timing_review_note') is not None:
            required('timing_review_bundle_rendition_id', '[a-z0-9]{15}')
            if (p['timing_review_bundle_rendition_id'] != p.get('selected_bundle_rendition_id')
                    or not isinstance(p.get('timing_review_note'), str) or not p['timing_review_note'].strip()):
                raise ValueError()
        if p.get('recorded_at') is not None:
            required('recorded_at', r'\d{4}-\d{2}-\d{2}')
            datetime.date.fromisoformat(p['recorded_at'])
        if p.get('language') is not None and (not isinstance(p['language'], str) or not p['language'].strip()):
            raise ValueError()
        if p.get('duration_seconds') is not None and (type(p['duration_seconds']) not in (int, float) or not math.isfinite(p['duration_seconds']) or p['duration_seconds'] <= 0):
            raise ValueError()
    if catalog == 'repository_document':
        if p.get('document_type') not in ('readme', 'license', 'copyright', 'notice', 'contributing', 'prompt', 'other') or p.get('output_mode') not in ('exact_copy', 'markdown'):
            raise ValueError()
        if p['output_mode'] == 'exact_copy':
            required('source_id', '[a-z0-9]{15}')
    if catalog == 'repository_destination':
        if len(p.get('documents', [])) != 1:
            raise ValueError()
        required('github_repository', '[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+')
        if p['github_repository'].split('/')[1] in ('.', '..'):
            raise ValueError()
        required('github_branch', r'[^\s\x00-\x1f\x7f~^:?*\[\\]+')
        branch = p['github_branch']
        if (branch.startswith(('-', '/')) or branch.endswith(('/', '.')) or '..' in branch or '@{' in branch or branch == '@'
                or any(not v or v.startswith('.') or v.endswith('.lock') for v in branch.split('/'))):
            raise ValueError()
        required('github_path', r'[^\x00-\x1f\x7f\\]+')
        if any(v in ('', '.', '..') or v.lower() == '.git' for v in p['github_path'].split('/')):
            raise ValueError()
    if catalog == 'repository_sync':
        if len(p.get('destinations', [])) != 1:
            raise ValueError()
        required('synced_document_revision', '[a-z0-9]{15}')
        required('synced_destination_revision', '[a-z0-9]{15}')
        required('rendered_sha256', '[a-f0-9]{64}')
        if p.get('github_commit') is not None or p.get('sync_status') not in ('pending', 'unknown'):
            required('github_commit', '(?:[a-f0-9]{40}|[a-f0-9]{64})')
        required('checked_at', r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z')
        datetime.datetime.fromisoformat(p['checked_at'].replace('Z', '+00:00'))
        if p.get('sync_status') not in ('current', 'behind', 'diverged', 'pending', 'unknown'):
            raise ValueError()
