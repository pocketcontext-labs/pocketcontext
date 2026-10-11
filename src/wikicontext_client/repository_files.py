"""Explicit, publication-pinned repository copies; never execute content or Git."""
import os
import re
from pathlib import Path
from . import cli as wc
from . import exporter as exp
from . import properties


def render(cfg, destination_id, sequence):
    if type(sequence) is not int or sequence < 1:
        raise wc.Fail(1, 'A positive publication sequence is required')
    space = wc.space_id(cfg)
    pubs = exp.query(cfg, f'SELECT id,sequence,manifest FROM publications WHERE space = {exp.literal(space)} AND sequence = {sequence} LIMIT 1')
    if len(pubs) != 1:
        raise wc.Fail(1, 'No matching publication exists')
    pub = pubs[0]
    manifest = exp.decoded(pub['manifest'])
    if not isinstance(manifest, dict):
        raise wc.Fail(1, 'Invalid publication manifest')

    def selected(page, catalog):
        if page not in manifest:
            raise wc.Fail(1, 'Repository page absent from selected publication')
        revision = exp.one(cfg, 'page_revisions', 'id,page,body,archived,properties,property_evidence', manifest[page])
        p, _ = properties.read(revision)
        if revision['page'] != page or revision['archived'] or p.get('catalog_type') != catalog:
            raise wc.Fail(1, 'Invalid repository page in selected publication')
        return revision, p

    destination, target = selected(destination_id, 'repository_destination')
    if target.get('lifecycle_status') == 'retired':
        raise wc.Fail(1, 'Selected repository destination is retired')
    document, source = selected(target['documents'][0], 'repository_document')
    if source['output_mode'] == 'exact_copy':
        original = exp.one(cfg, 'sources', 'id,original,sha256', source['source_id'])
        content = exp.download(cfg, original)
    else:
        body = document['body']
        # No implicit private wiki references or evidence transformations in GitHub output.
        if any(marker in body for marker in ('[[', '[^', '[needs verification]')) or re.search(r'^\s*>\s*\[!', body, re.MULTILINE):
            raise wc.Fail(1, 'Markdown contains wiki links, citations or wiki-only markers; publish reviewed portable Markdown or use exact_copy')
        content = body.encode('utf-8')
    return content, {'space': space, 'publication': pub['id'], 'sequence': sequence,
        'destination': destination_id, 'destination_revision': destination['id'],
        'document_revision': document['id'], 'rendered_sha256': exp.digest(content),
        'github_repository': target['github_repository'], 'github_branch': target['github_branch'],
        'github_path': target['github_path']}


def write_new(output, content):
    """Create only; fd-relative traversal refuses symlinks in every component."""
    path = Path(output)
    if '..' in path.parts or path.name in ('', '.', '..'):
        raise wc.Fail(1, 'Unsafe output path')
    fd = os.open('/' if path.is_absolute() else '.', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[:-1]:
            if component in ('/', '.'):
                continue
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        file_fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            with os.fdopen(file_fd, 'wb') as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            os.unlink(path.name, dir_fd=fd)
            raise
    except OSError:
        raise wc.Fail(1, 'Output must be a new file under existing real directories; no overwrite permitted') from None
    finally:
        os.close(fd)


def export(cfg, destination_id, output, sequence):
    content, receipt = render(cfg, destination_id, sequence)
    write_new(output, content)
    return dict(receipt, output=str(output))
