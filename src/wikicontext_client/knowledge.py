"""Queries against committed knowledge, never against generated Markdown."""
import math
import re
from . import cli as wc
from . import properties as props


def rows(cfg, sql):
    result = wc.must(cfg, 'POST', '/api/context/query', {'sql': sql})
    if result.get('truncated'):
        raise wc.Fail(1, 'Query was truncated; narrow the selection before continuing')
    return [dict(zip(result['columns'], row)) for row in result['rows']]


BATCH_SIZE = 100
ID = re.compile(r'[a-z0-9]{15}')


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def batches(cfg, statement):
    """Fetch immutable rows by key; retry an oversized batch without advancing."""
    after, limit = '', BATCH_SIZE
    while True:
        try:
            batch = rows(cfg, statement(after, limit))
        except wc.Fail as error:
            if limit > 1 and ('truncated' in str(error) or
                              'HTTP 413 from POST /api/context/query' in str(error)):
                limit = max(1, limit // 2)
                continue
            raise
        if not batch:
            return
        keys = [row['id'] for row in batch]
        if any(not isinstance(key, str) or not ID.fullmatch(key) for key in keys):
            raise wc.Fail(1, 'Invalid SQL pagination ID')
        if keys != sorted(set(keys)) or keys[0] <= after:
            raise wc.Fail(1, 'Invalid SQL pagination')
        yield from batch
        after = keys[-1]


def manifest_join(publication):
    # Publication IDs come from the server but are still validated before SQL use.
    if not isinstance(publication['id'], str) or not ID.fullmatch(publication['id']):
        raise wc.Fail(1, 'Invalid publication ID')
    return ("FROM publications pub JOIN json_each(pub.manifest) m "
            "LEFT JOIN pages p ON p.id=m.key "
            "LEFT JOIN page_revisions r ON r.id=m.value AND r.page=p.id ")


def publication_where(publication):
    return f"pub.id={literal(publication['id'])}"


def select_publication(cfg, publication_id=None, sequence=None):
    if publication_id is not None and (not isinstance(publication_id, str) or not ID.fullmatch(publication_id)):
        raise wc.Fail(2, 'Invalid publication ID')
    if sequence is not None and (type(sequence) is not int or sequence < 1):
        raise wc.Fail(2, 'Publication sequence must be positive')
    if publication_id is not None and sequence is not None:
        raise wc.Fail(2, 'Choose a publication ID or sequence, not both')
    # Sequences and the latest publication are per space.
    condition = ' WHERE space=' + literal(wc.space_id(cfg)) + (
        ' AND id=' + literal(publication_id) if publication_id is not None else
        f' AND sequence={sequence}' if sequence is not None else '')
    result = rows(cfg, "SELECT id, space, sequence, CASE WHEN json_valid(manifest) "
                  "THEN json_type(manifest) ELSE 'invalid' END AS manifest_type "
                  "FROM publications" + condition + " ORDER BY sequence DESC LIMIT 1")
    if not result:
        if publication_id is not None or sequence is not None:
            raise wc.Fail(1, 'Publication not found')
        return None
    publication = result[0]
    if publication.pop('manifest_type') != 'object':
        raise wc.Fail(1, 'Invalid publication manifest')
    return publication


def validate_manifest(cfg, publication):
    join, where = manifest_join(publication), publication_where(publication)
    # Validate every entry, including archived pages, before discarding any rows.
    # Exact page/revision pairing and duplicate-key checks avoid silent inner-join loss.
    validation = rows(cfg, "SELECT count(*) AS total, count(DISTINCT m.key) AS unique_keys, "
        "coalesce(sum(CASE WHEN length(m.key)!=15 OR m.key GLOB '*[^a-z0-9]*' "
        "OR m.type!='text' OR length(m.value)!=15 OR m.value GLOB '*[^a-z0-9]*' "
        "OR p.id IS NULL OR r.id IS NULL THEN 1 ELSE 0 END),0) AS invalid, "
        "coalesce(sum(CASE WHEN r.archived=0 THEN 1 ELSE 0 END),0) AS active "
        + join + 'WHERE ' + where)[0]
    if validation['invalid'] or validation['total'] != validation['unique_keys']:
        raise wc.Fail(1, 'Invalid or incomplete publication manifest')
    return validation


def published(cfg):
    # Pin only metadata: manifests and revision bodies are fetched in bounded SQL pages.
    publication = select_publication(cfg)
    if publication is None:
        return None, []
    validation = validate_manifest(cfg, publication)
    join, where = manifest_join(publication), publication_where(publication)
    pages = list(batches(cfg, lambda after, limit:
        "SELECT r.*, p.slug, p.kind " + join + "WHERE " + where +
        f" AND r.archived=0 AND r.id>{literal(after)} ORDER BY r.id LIMIT {limit}"))
    if len(pages) != validation['active']:
        raise wc.Fail(1, 'Incomplete publication')
    return publication, pages


def relationships(cfg, publication, table, column):
    # Callers supply only the two fixed table/column pairs below. Draft and historical
    # relationships cannot enter the result because their revision must match manifest.
    join, where = manifest_join(publication), publication_where(publication)
    return batches(cfg, lambda after, limit:
        f"SELECT rel.id, rel.page_revision, rel.{column} " + join +
        f"JOIN {table} rel ON rel.page_revision=r.id WHERE " + where +
        f" AND r.archived=0 AND rel.id>{literal(after)} ORDER BY rel.id LIMIT {limit}")


def search(cfg, term, *, publication_id=None, sequence=None, limit=20, offset=0, generation=None):
    """One bounded ranked page; continuation must name the same publication and generation."""
    if (not isinstance(term, str) or not term.strip() or len(term.encode('utf-8')) > 4096
            or len(term.split()) > 16):
        raise wc.Fail(2, 'Search requires 1–16 terms and at most 4096 UTF-8 bytes')
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 10000:
        raise wc.Fail(2, 'Search limit must be 1–100 and offset 0–10000')
    if generation is not None and (not isinstance(generation, str) or not generation
                                  or len(generation.encode('utf-8')) > 128 or '\x00' in generation):
        raise wc.Fail(2, 'Invalid search generation')
    if offset and (not generation or (publication_id is None and sequence is None)):
        raise wc.Fail(2, 'Continuation requires --publication (or --sequence) and --generation')
    publication = select_publication(cfg, publication_id, sequence)
    if publication is None:
        return {'space': wc.space_id(cfg), 'publication': None, 'generation': None, 'pages': [], 'hasMore': False, 'nextOffset': None}
    validate_manifest(cfg, publication)
    body = {'index': 'pages', 'query': term, 'scope': publication['id'], 'limit': limit, 'offset': offset}
    if generation is not None:
        body['expectedGeneration'] = generation
    try:
        result = wc.must(cfg, 'POST', '/api/context/search', body)
    except wc.Fail as error:
        if error.code == 4:
            raise wc.Fail(4, 'Search index changed. Discard prior result pages and restart at offset 0 without --generation.') from None
        raise
    hits = result.get('hits')
    returned_generation = result.get('generation')
    if (result.get('index') != 'pages' or result.get('scope') != publication['id']
            or not isinstance(returned_generation, str) or not returned_generation
            or len(returned_generation.encode('utf-8')) > 128 or '\x00' in returned_generation
            or (generation is not None and returned_generation != generation)
            or type(result.get('hasMore')) is not bool or type(result.get('truncated')) is not bool
            or result['hasMore'] != result['truncated']
            or not isinstance(hits, list) or len(hits) > limit):
        raise wc.Fail(1, 'Invalid scoped search response')
    ids, ranks = [], []
    for hit in hits:
        if (not isinstance(hit, dict) or not isinstance(hit.get('id'), str) or not ID.fullmatch(hit['id'])
                or type(hit.get('score')) not in (int, float) or not math.isfinite(hit['score'])
                or not isinstance(hit.get('excerpt'), str)):
            raise wc.Fail(1, 'Invalid search hit')
        ids.append(hit['id'])
        ranks.append((hit['score'], hit['id']))
    if len(set(ids)) != len(ids) or ranks != sorted(ranks) or (result['hasMore'] and not hits):
        raise wc.Fail(1, 'Invalid search ordering or continuation')
    metadata = {}
    if ids:
        selected = ','.join(literal(record_id) for record_id in ids)
        join, where = manifest_join(publication), publication_where(publication)
        metadata = {row['id']: row for row in batches(cfg, lambda after, size:
            'SELECT r.id, r.page, p.slug, p.kind, r.title, r.summary ' + join + 'WHERE ' + where +
            f' AND r.archived=0 AND r.id IN ({selected}) AND r.id>{literal(after)} ORDER BY r.id LIMIT {size}')}
        if set(metadata) != set(ids):
            raise wc.Fail(1, 'Search hit is absent from the selected publication')
    pages = [dict(metadata[hit['id']], score=hit['score'], excerpt=hit['excerpt']) for hit in hits]
    return {'space': publication['space'], 'publication': publication['id'], 'generation': returned_generation, 'pages': pages,
            'hasMore': result['hasMore'], 'nextOffset': offset + len(pages) if result['hasMore'] else None}


def lint(cfg):
    publication, pages = published(cfg)
    incoming = {page['page']: 0 for page in pages}
    catalogs = {page['page']: props.read(page)[0].get('catalog_type') for page in pages}
    findings = []
    links_by_revision, cited = {}, {}
    if publication:
        for link in relationships(cfg, publication, 'page_links', 'target'):
            links_by_revision.setdefault(link['page_revision'], []).append(link)
        for citation in relationships(cfg, publication, 'citations', 'marker'):
            cited.setdefault(citation['page_revision'], set()).add(str(citation['marker']))
    for page in pages:
        links = links_by_revision.get(page['id'], [])
        properties, evidence = props.read(page)
        for key, catalog in props.TARGET_CATALOGS.items():
            for target in properties.get(key, []):
                if target in catalogs and catalogs[target] != catalog:
                    findings.append({'page': page['slug'], 'kind': 'invalid-property-target', 'property': key, 'target': target})
        property_targets = {target for key, values in properties.items() if key in props.RELATIONSHIPS for target in values}
        links = links + [{'target': target} for target in sorted(property_targets - {link['target'] for link in links})]
        for key, markers in evidence.items():
            for marker in markers:
                if marker not in cited.get(page['id'], set()):
                    findings.append({'page': page['slug'], 'kind': 'missing-property-citation', 'property': key, 'marker': marker})
        for link in links:
            if link['target'] not in incoming:
                findings.append({'page': page['slug'], 'kind': 'broken-link', 'target': link['target']})
            else:
                incoming[link['target']] += 1
        if '[needs verification]' in page['body']:
            findings.append({'page': page['slug'], 'kind': 'needs-verification'})
        if page['id'] not in cited:
            findings.append({'page': page['slug'], 'kind': 'no-citations'})
    for page in pages:
        if not incoming[page['page']]:
            findings.append({'page': page['slug'], 'kind': 'orphan'})
    return {'space': wc.space_id(cfg), 'publication': publication['id'] if publication else None, 'findings': findings,
            'semantic_review': 'Contradictions, claim support and outdated evidence require agent review of source passages.'}
