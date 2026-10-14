"""Stage a reviewed audio catalog selection; never synthesize or publish it."""
import math
from . import cli as wc, knowledge as k, properties as props


def identifier(value):
    if not isinstance(value, str) or not k.ID.fullmatch(value):
        raise wc.Fail(2, 'Audio catalog requires valid record IDs')
    return value


def ensure(cfg, table, where, payload):
    """Reconcile uncertain immutable writes by identity and exact content."""
    query = f'SELECT * FROM {table} WHERE {where}'
    found = k.rows(cfg, query)
    if not found:
        try:
            return wc.must(cfg, 'POST', wc.records(table), payload)
        except wc.Fail:
            found = k.rows(cfg, query)
            if not found:
                raise
    if len(found) != 1:
        raise wc.Fail(4, 'Ambiguous audio catalog staging identity')
    record = found[0]
    for key, value in payload.items():
        actual = record.get(key, '')
        if key in ('properties', 'property_evidence'):
            actual = props.decode(actual) or {}
        if actual != value:
            raise wc.Fail(4, 'Existing audio catalog staging differs; reassess in a new run')
    return record


def stage(cfg, run_id, receipt, transcript_page, summary_page, *, title=None,
          language=None, duration_seconds=None):
    space = wc.space_id(cfg)
    for value in (run_id, transcript_page, summary_page):
        identifier(value)
    if not isinstance(receipt, dict) or receipt.get('space') != space:
        raise wc.Fail(2, 'Audio receipt must belong to the selected space')
    source, bundle, rendition = [identifier(receipt.get(key)) for key in ('source', 'bundle_rendition', 'rendition')]
    mapping = receipt.get('segment_passages')
    if not isinstance(mapping, dict) or not mapping:
        raise wc.Fail(2, 'Audio receipt must include transcript segment passages')
    candidates = [p for key in sorted(mapping) for values in [mapping[key]] if isinstance(values, list) for p in values]
    if not candidates:
        raise wc.Fail(2, 'Audio receipt has no transcript evidence')
    passage = identifier(candidates[0])
    if title is not None and (not isinstance(title, str) or not title.strip()):
        raise wc.Fail(2, 'Audio title must be nonempty')
    if language is not None and (not isinstance(language, str) or not language.strip()):
        raise wc.Fail(2, 'Audio language must be nonempty')
    if duration_seconds is not None and (type(duration_seconds) not in (int, float) or
            not math.isfinite(duration_seconds) or duration_seconds <= 0):
        raise wc.Fail(2, 'Audio duration must be positive and finite')
    q = k.literal
    runs = k.rows(cfg, f'SELECT status FROM ingestion_runs WHERE id={q(run_id)} AND space={q(space)}')
    if len(runs) != 1 or runs[0]['status'] != 'staging':
        raise wc.Fail(4, 'Audio catalog requires an existing staging run in the selected space')
    evidence = k.rows(cfg, 'SELECT p.id FROM passages p JOIN renditions t ON t.id=p.rendition '
        'JOIN sources s ON s.id=t.source JOIN renditions b ON b.source=s.id '
        f'WHERE p.id={q(passage)} AND t.id={q(rendition)} AND t.kind=\'transcript\' '
        f'AND s.id={q(source)} AND s.space={q(space)} AND s.media_type LIKE \'audio/%\' '
        f'AND b.id={q(bundle)} AND b.kind=\'transcript-bundle\' '
        f'AND json_extract(b.notes, \'$.transcript_rendition\')={q(rendition)}')
    if len(evidence) != 1:
        raise wc.Fail(2, 'Receipt audio, bundle and transcript evidence do not match')
    _, published = k.published(cfg)
    selected = {r['page']: r for r in published}
    for page, kind in ((transcript_page, 'transcript'), (summary_page, 'summary')):
        identities = k.rows(cfg, f'SELECT kind FROM pages WHERE id={q(page)} AND space={q(space)}')
        drafts = k.rows(cfg, f'SELECT archived FROM page_revisions WHERE page={q(page)} AND run={q(run_id)}')
        active = not drafts[0]['archived'] if len(drafts) == 1 else page in selected
        if len(identities) != 1 or identities[0]['kind'] != kind or not active:
            raise wc.Fail(2, 'Reviewed transcript and summary pages must be active in this run or publication')
    matches = [r for r in published if props.read(r)[0].get('catalog_type') == 'audio_recording'
               and props.read(r)[0].get('audio_source_id') == source]
    if len(matches) > 1:
        raise wc.Fail(4, 'Multiple published audio identities; reassess')
    old = matches[0] if matches else None
    properties, property_evidence = props.read(old) if old else ({}, {})
    citations = k.rows(cfg, f'SELECT marker,passage,note FROM citations WHERE page_revision={q(old["id"])}') if old else []
    links = k.rows(cfg, f'SELECT target FROM page_links WHERE page_revision={q(old["id"])}') if old else []
    marker = str(max([int(c['marker']) for c in citations] + [0]) + 1)
    properties.update(catalog_type='audio_recording', audio_source_id=source,
                      selected_bundle_rendition_id=bundle,
                      transcript_pages=[transcript_page], summary_pages=[summary_page])
    # A transcript passage establishes source provenance, not technical duration
    # or human-reviewed language metadata. Do not manufacture evidence for those.
    for key, value in (('language', language), ('duration_seconds', duration_seconds)):
        if value is not None:
            properties[key] = value
            property_evidence.pop(key, None)
    property_evidence['audio_source_id'] = [marker]
    property_evidence.pop('selected_bundle_rendition_id', None)
    property_evidence.pop('transcript_pages', None)
    property_evidence.pop('summary_pages', None)
    props.read({'properties': properties, 'property_evidence': property_evidence})
    if old:
        page = old['page']
    else:
        slug = 'audio-' + source
        page = ensure(cfg, 'pages', f'space={q(space)} AND slug={q(slug)}',
                      {'space': space, 'slug': slug, 'kind': 'entity'})['id']
    payload = {'space': space, 'run': run_id, 'page': page,
               'base_revision': old['id'] if old else '',
               'title': title or (old['title'] if old else 'Audio recording'),
               'summary': old['summary'] if old else 'Reviewed transcript and summary for this recording.',
               'body': old['body'] if old else f'Recording source.[^{marker}]',
               'archived': False, 'properties': properties, 'property_evidence': property_evidence}
    revision = ensure(cfg, 'page_revisions', f'run={q(run_id)} AND page={q(page)}', payload)['id']
    for citation in citations + [{'marker': marker, 'passage': passage}]:
        ensure(cfg, 'citations', f'page_revision={q(revision)} AND marker={q(citation["marker"])}',
               {'space': space, 'page_revision': revision, **citation})
    targets = {link['target'] for link in links} | {transcript_page, summary_page}
    for values in (v for key, v in properties.items() if key in props.RELATIONSHIPS):
        targets.update(values)
    for target in sorted(targets):
        ensure(cfg, 'page_links', f'page_revision={q(revision)} AND target={q(target)}',
               {'space': space, 'page_revision': revision, 'target': target})
    return {'space': space, 'run': run_id, 'page': page, 'revision': revision,
            'source': source, 'bundle_rendition': bundle, 'status': 'staged',
            'next': 'Review staged content, publish explicitly, then verify the published Audio catalog and protected evidence.'}
