"""Deterministic publication export. The destination is presentation, never input data."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import urllib.parse
import urllib.request
from . import cli as wc
from . import properties as props

MANIFEST = '.wikicontext-export.json'
JOURNAL = '.wikicontext-export-journal.json'
ID = re.compile(r'^[a-z0-9]{15}$')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def packed(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + '\n').encode()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def query(cfg, sql):
    data = wc.must(cfg, 'POST', '/api/context/query', {'sql': sql})
    if data.get('truncated'):
        raise wc.Fail(1, 'Export SQL response truncated; no files were changed')
    return [dict(zip(data['columns'], row)) for row in data['rows']]


def rows(cfg, table, columns, where='1=1'):
    """Keyset pagination; column/table arguments are internal constants only."""
    result, after, limit = [], '', 100
    while True:
        try:
            batch = query(cfg, f'SELECT {columns} FROM {table} WHERE ({where}) AND id > {literal(after)} ORDER BY id LIMIT {limit}')
        except wc.Fail as error:
            if limit > 1 and 'truncated' in str(error):
                limit = max(1, limit // 2)
                continue
            raise
        if not batch:
            return result
        if batch[-1]['id'] <= after:
            raise wc.Fail(1, 'Invalid SQL pagination')
        result.extend(batch)
        after = batch[-1]['id']


def one(cfg, table, columns, record):
    if not isinstance(record, str) or not ID.fullmatch(record):
        raise wc.Fail(1, 'Publication contains an invalid record ID')
    found = query(cfg, f'SELECT {columns} FROM {table} WHERE id = {literal(record)} LIMIT 1')
    if len(found) != 1:
        raise wc.Fail(1, f'Missing published {table} record')
    return found[0]


def decoded(value):
    return json.loads(value) if isinstance(value, str) else value


def plain(value):
    """Escape external metadata in Markdown text, preserving authored page bodies."""
    text = str(value).replace('\r', ' ').replace('\n', ' ')
    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return re.sub(r'([\\`*_{}\[\]()#!|])', r'\\\1', text)


def source_path(source):
    slug = re.sub('[^a-z0-9]+', '-', source['title'].lower()).strip('-')[:70] or 'source'
    suffix = Path(source['original_name']).suffix.lower()
    if not re.fullmatch(r'\.[a-z0-9]{1,12}', suffix):
        suffix = '.bin'
    return f'raw/{slug}-{source["id"]}{suffix}'


def download(cfg, source):
    token = wc.must(cfg, 'POST', '/api/files/token')['token']
    wc.hide(token)
    path = '/api/files/sources/' + urllib.parse.quote(source['id'], safe='') + '/' + urllib.parse.quote(source['original'], safe='')
    request = urllib.request.Request(cfg['url'] + path + '?' + urllib.parse.urlencode({'token': token}), headers={'User-Agent': wc.USER_AGENT})
    try:
        with wc.opener.open(request, timeout=120) as response:
            content = response.read(104857601)
    except Exception:
        raise wc.Fail(1, 'Protected original download failed; no files were changed') from None
    if len(content) > 104857600 or not re.fullmatch('[0-9a-f]{64}', source['sha256']) or digest(content) != source['sha256']:
        raise wc.Fail(1, 'Protected original hash or size check failed; no files were changed')
    return content


def yaml_value(value):
    """JSON flow values with YAML-sensitive Unicode escaped, preserving emoji."""
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    # YAML treats NEL/line separators differently from JSON and forbids most C1
    # controls. Avoid surrogate-pair escapes, which YAML need not recombine.
    return ''.join(f'\\u{ord(char):04x}' if 0x7f <= ord(char) <= 0x9f
                   or ord(char) in (0x2028, 0x2029, 0xfeff) else char
                   for char in encoded)


def render(cfg, sequence=None):
    cache = {}
    def get(cfg, table, columns, record):
        key = (table, columns, record)
        if key not in cache:
            cache[key] = one(cfg, table, columns, record)
        return cache[key]
    space = wc.space_id(cfg)
    where = 'WHERE space = ' + literal(space) + ('' if sequence is None else ' AND sequence = ' + str(int(sequence)))
    pubs = query(cfg, 'SELECT id,run,sequence,manifest,created FROM publications ' + where + ' ORDER BY sequence DESC LIMIT 1')
    if not pubs:
        raise wc.Fail(1, 'No matching publication exists')
    publication = pubs[0]
    manifest = decoded(publication['manifest'])
    if not isinstance(manifest, dict):
        raise wc.Fail(1, 'Invalid publication manifest')
    pages, revisions, sources, files = {}, {}, {}, {}
    for page_id, revision_id in sorted(manifest.items()):
        page = get(cfg, 'pages', 'id,slug,kind', page_id)
        revision = get(cfg, 'page_revisions', 'id,page,run,title,summary,body,archived,properties,property_evidence,created', revision_id)
        if revision['page'] != page_id or not re.fullmatch('[a-z0-9]+(-[a-z0-9]+)*', page['slug']):
            raise wc.Fail(1, 'Invalid published page identity')
        if revision['archived']:
            continue
        pages[page_id], revisions[page_id] = page, revision
    for page_id, page in sorted(pages.items(), key=lambda item: item[1]['slug']):
        revision = revisions[page_id]
        citations = rows(cfg, 'citations', 'id,passage,marker,note', 'page_revision = ' + literal(revision['id']))
        links = rows(cfg, 'page_links', 'id,target', 'page_revision = ' + literal(revision['id']))
        frontmatter = {'wikicontext_page': page_id, 'wikicontext_revision': revision['id'], 'publication': publication['sequence'], 'kind': page['kind'], 'title': revision['title']}
        properties, evidence = props.read(revision)
        for key, value in sorted(properties.items()):
            if key in props.RELATIONSHIPS:
                if any(target not in pages for target in value):
                    raise wc.Fail(1, 'Property relationship is absent from selected publication')
                if key in props.TARGET_CATALOGS and any(
                        props.read(revisions[target])[0].get('catalog_type') != props.TARGET_CATALOGS[key]
                        for target in value):
                    raise wc.Fail(1, 'Property relationship target has invalid catalog type')
                value = ['[[' + pages[target]['slug'] + ']]' for target in value]
            frontmatter[key] = value
        body = '---\n' + ''.join(k + ': ' + yaml_value(v) + '\n' for k, v in frontmatter.items()) + '---\n\n'
        body += '# ' + plain(revision['title']) + '\n\n## Summary\n\n' + plain(revision['summary']) + '\n\n' + revision['body'].rstrip() + '\n'
        if evidence:
            citation_markers = {str(c['marker']) for c in citations}
            body += '\n## Property evidence\n\n'
            for key, markers in sorted(evidence.items()):
                if any(marker not in citation_markers for marker in markers):
                    raise wc.Fail(1, 'Property evidence citation is absent')
                if markers:
                    body += '- ' + plain(key) + ': ' + ' '.join('[^' + marker + ']' for marker in markers) + '\n'
        body += '\n## Sources\n'
        for citation in sorted(citations, key=lambda c: int(c['marker'])):
            passage = get(cfg, 'passages', 'id,rendition,locator', citation['passage'])
            rendition = get(cfg, 'renditions', 'id,source', passage['rendition'])
            sid = rendition['source']
            if sid not in sources:
                sources[sid] = get(cfg, 'sources', 'id,title,original_name,original,sha256', sid)
            source = sources[sid]
            body += f'\n[^{citation["marker"]}]: [{plain(source["original_name"])}](../{source_path(source)}) — {plain(passage["locator"])}'
            if citation['note']:
                body += '; ' + plain(citation['note'])
            body += '\n'
        targets = sorted({pages[link['target']]['slug'] for link in links if link['target'] in pages})
        if targets:
            body += '\n## Related pages\n\n' + ''.join(f'- [[{slug}]]\n' for slug in targets)
        body += '\n## Last updated\n\n' + plain(revision['created']) + '\n'
        path = 'wiki/' + page['slug'] + '.md'
        if path in files or page['slug'] in ('index', 'log'):
            raise wc.Fail(1, 'Published slug collides with an export path')
        files[path] = body.encode()
    history = rows(cfg, 'publications', 'id,run,sequence,created', f'space = {literal(space)} AND sequence <= {int(publication["sequence"])}')
    log = '# Publication log\n\n'
    for pub in sorted(history, key=lambda p: p['sequence']):
        run = get(cfg, 'ingestion_runs', 'id,description,sources', pub['run'])
        log += f'- {plain(pub["created"])} — publication {pub["sequence"]}: {plain(run["description"])}\n'
        for sid in decoded(run['sources']) or []:
            if sid not in sources:
                sources[sid] = get(cfg, 'sources', 'id,title,original_name,original,sha256', sid)
    files['wiki/log.md'] = log.encode()
    index = '# Wiki\n\n' + ''.join(f'- [[{p["slug"]}]] — {plain(revisions[pid]["summary"])}\n' for pid, p in sorted(pages.items(), key=lambda item: item[1]['slug']))
    files['wiki/index.md'] = index.encode()
    for source in sources.values():
        files[source_path(source)] = download(cfg, source)
    return files, {'version': 1, 'server': cfg['url'], 'space': space, 'publication': publication['id'], 'sequence': publication['sequence']}


def safe_path(root, name):
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in ('.', '..') for part in name.split('/')) or '\\' in name:
        raise wc.Fail(1, 'Unsafe export path')
    target = root
    for part in path.parts:
        target = target / part
        if target.is_symlink():
            raise wc.Fail(1, 'Export refuses symbolic links')
    return target


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.wikicontext-', delete=False) as handle:
        temp = Path(handle.name)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def owned(name, allow_manifest=False):
    if allow_manifest and name == MANIFEST:
        return True
    return isinstance(name, str) and bool(re.fullmatch(r'(wiki/[a-z0-9]+(?:-[a-z0-9]+)*\.md|raw/[a-z0-9][a-z0-9.-]*)', name))


def validate_manifest(value):
    if (not isinstance(value, dict) or value.get('version') != 1
            or not isinstance(value.get('files'), dict)):
        raise wc.Fail(1, 'Invalid export manifest')
    for name, checksum in value['files'].items():
        if not owned(name) or not isinstance(checksum, str) or not re.fullmatch('[a-f0-9]{64}', checksum):
            raise wc.Fail(1, 'Invalid export manifest ownership or hash')


def publish(root, files, metadata):
    """Locked, journaled replacement; recovery restores pre-export bytes on retry."""
    import base64
    if any(not owned(name) for name in files):
        raise wc.Fail(1, 'Invalid export-owned path')
    root = Path(root).absolute()
    for ancestor in (root, *root.parents):
        if ancestor.is_symlink():
            raise wc.Fail(1, 'Export refuses symbolic links in destination')
    root.mkdir(parents=True, exist_ok=True)
    lock = safe_path(root, '.wikicontext-export.lock')
    with lock.open('a+b') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        journal_path = safe_path(root, JOURNAL)
        if journal_path.exists():
            recover(root, json.loads(journal_path.read_text()))
            journal_path.unlink()
        manifest_path = safe_path(root, MANIFEST)
        old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'version': 1, 'files': {}}
        validate_manifest(old)
        if old.get('server') and old['server'] != metadata['server']:
            raise wc.Fail(1, 'Destination belongs to a different WikiContext server')
        if old.get('space') and old['space'] != metadata.get('space'):
            raise wc.Fail(1, 'Destination belongs to a different WikiContext space')
        if manifest_path.exists() and not old.get('space') and metadata.get('space') != wc.COMPANY_SPACE:
            raise wc.Fail(1, 'Legacy export can only be adopted by the company space')
        previous = old['files']
        for name, expected in previous.items():
            target = safe_path(root, name)
            if not target.is_file() or digest(target.read_bytes()) != expected:
                raise wc.Fail(1, f'Local edit or deletion conflicts with export: {name}')
        for name in files:
            target = safe_path(root, name)
            if target.exists() and name not in previous:
                raise wc.Fail(1, f'Export would overwrite an unrelated file: {name}')
        new_manifest = dict(metadata, files={name: digest(content) for name, content in sorted(files.items())})
        changes = dict(files, **{MANIFEST: packed(new_manifest)})
        names = sorted(set(previous) | set(changes))
        before, after = {}, {}
        for name in names:
            target = safe_path(root, name)
            before[name] = base64.b64encode(target.read_bytes()).decode() if target.exists() else None
            after[name] = digest(changes[name]) if name in changes else None
        journal = {'before': before, 'after': after}
        atomic_write(journal_path, packed(journal))
        try:
            for name in names:
                target = safe_path(root, name)
                if name in changes:
                    atomic_write(target, changes[name])
                else:
                    target.unlink(missing_ok=True)
        except BaseException:
            recover(root, journal)
            journal_path.unlink()
            raise
        journal_path.unlink()
        return {'destination': str(root), 'space': metadata.get('space'), 'sequence': metadata['sequence'], 'files': len(files)}


def recover(root, journal):
    import base64
    if (not isinstance(journal, dict) or not isinstance(journal.get('before'), dict)
            or not isinstance(journal.get('after'), dict)
            or set(journal['before']) != set(journal['after'])):
        raise wc.Fail(1, 'Invalid export recovery journal')
    for name, encoded in journal['before'].items():
        checksum = journal['after'][name]
        if (not owned(name, allow_manifest=True) or (encoded is not None and not isinstance(encoded, str))
                or (checksum is not None and (not isinstance(checksum, str) or not re.fullmatch('[a-f0-9]{64}', checksum)))):
            raise wc.Fail(1, 'Invalid export recovery ownership or hash')
    # Validate every file first so external edits made after a crash are preserved.
    for name, encoded in journal['before'].items():
        path = safe_path(root, name)
        current = digest(path.read_bytes()) if path.exists() else None
        before = digest(base64.b64decode(encoded, validate=True)) if encoded is not None else None
        if current not in (before, journal['after'][name]):
            raise wc.Fail(1, f'Interrupted export recovery conflicts with a local edit: {name}')
    for name, encoded in journal['before'].items():
        path = safe_path(root, name)
        if encoded is None:
            path.unlink(missing_ok=True)
        else:
            atomic_write(path, base64.b64decode(encoded, validate=True))


def export(cfg, destination, sequence=None):
    files, metadata = render(cfg, sequence)
    return publish(destination, files, metadata)
