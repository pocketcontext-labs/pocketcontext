#!/usr/bin/env python3
"""Synthetic publication checks for imported references; no real vault data."""
import argparse
import json
from pathlib import Path
import tempfile
from e2e import Project, PASSWORD


def scenario(pc):
    pc.json('init', '--port', str(pc.port), '--password-stdin', stdin=PASSWORD + '\n')
    other = pc.json('create-space', 'Other')['id']
    note = pc.root / 'original.md'
    note.write_text('An original synthetic note.', encoding='utf-8')
    source = pc.json('ingest', str(note))['source']
    foreign = pc.json('ingest', str(note), '--space', other)['source']

    def spec(key, body):
        return {'run_key': key, 'pages': [{'slug': key, 'kind': 'legacy', 'title': key,
                'summary': 'Imported synthetic page.', 'body': body}]}

    body = (f'[needs verification]\nImported.[^import-1]\n\n'
            f'[^import-1]: [Original](source:{source})\n\n'
            f'![Image reference](source:{source}) [Elsewhere](space:{other}/not-yet-published)\n'
            '`[[literal]] [^1]`\n```md\n[[literal-fence]]\n[^2]: example\n```')
    staged = pc.json('stage', '-', stdin=json.dumps(spec('imported', body)))
    assert staged['problems'] == [], staged
    assert pc.json('check-run', staged['run'])['ok']
    pc.json('publish', staged['run'], '--expected-revision', str(staged['revision']))
    assert pc.json('page', 'imported')['body'] == body
    assert pc.json('sql', 'SELECT count(*) FROM citations')['rows'][0][0] == 0
    assert pc.json('sql', 'SELECT count(*) FROM page_links')['rows'][0][0] == 0

    for key, target in [('foreign-source', f'source:{foreign}'), ('bad-source', 'source:bad'),
                        ('bad-space', 'space:xxxxxxxxxxxxxxx/overview')]:
        result = pc.json('stage', '-', '--dry-run', stdin=json.dumps(spec(key, f'[needs verification] [Bad]({target})')), expect=3)
        assert any(p['kind'].endswith('-reference') for p in result['problems']), result

    # Bypass stage: the publication hook must independently reject foreign sources.
    run = pc.json('create', 'ingestion_runs', json.dumps({'key': 'direct-invalid', 'status': 'staging', 'description': 'Synthetic direct API validation'}))
    page = pc.json('create', 'pages', json.dumps({'slug': 'direct-invalid', 'kind': 'legacy'}))
    pc.json('create', 'page_revisions', '-', stdin=json.dumps({'page': page['id'], 'run': run['id'],
        'title': 'Direct invalid reference', 'summary': 'Must be refused.',
        'body': f'[needs verification] [Foreign](source:{foreign})'}))
    checked = pc.json('check-run', run['id'], expect=3)
    assert not checked['ok'] and any(p['kind'] == 'source-reference' for p in checked['problems']), checked
    pc.run('publish', run['id'], '--expected-revision', str(run['revision']), expect=1)

    # Formatted labels retain inline code while deriving the normal local link record.
    formatted = spec('formatted', "[needs verification] [BERT's `[CLS]`/`[SEP]` (token) scheme](page:bert-input#Token%20scheme)")
    formatted['pages'].append({'slug': 'bert-input', 'kind': 'legacy', 'title': 'BERT input',
                              'summary': 'Synthetic target.', 'body': '## Token scheme\n[needs verification]'})
    staged = pc.json('stage', '-', stdin=json.dumps(formatted))
    assert staged['problems'] == [], staged
    assert pc.json('check-run', staged['run'])['ok']
    pc.json('publish', staged['run'], '--expected-revision', str(staged['revision']))
    assert pc.json('sql', 'SELECT count(*) FROM page_links')['rows'][0][0] == 1
    missing = pc.json('stage', '-', '--dry-run', stdin=json.dumps(spec('missing-local',
        '[needs verification] [Missing](page:missing-target)')), expect=3)
    assert any(p['kind'] == 'link-target' for p in missing['problems']), missing

    run = pc.json('create', 'ingestion_runs', json.dumps({'key': 'direct-page-invalid', 'status': 'staging',
                                                        'description': 'Synthetic missing page-link record'}))
    page = pc.json('create', 'pages', json.dumps({'slug': 'direct-page-invalid', 'kind': 'legacy'}))
    pc.json('create', 'page_revisions', '-', stdin=json.dumps({'page': page['id'], 'run': run['id'],
        'title': 'Direct page reference', 'summary': 'Must have a link record.',
        'body': '[needs verification] [Target](page:bert-input)'}))
    checked = pc.json('check-run', run['id'], expect=3)
    assert any(p['kind'] == 'missing-link-record' for p in checked['problems']), checked

    pc.json('archive-space', other)
    # Destination archival does not block new local publications.
    staged = pc.json('stage', '-', stdin=json.dumps(spec('after-archive', f'[needs verification] [Other](space:{other}/not-yet-published)')))
    pc.json('publish', staged['run'], '--expected-revision', str(staged['revision']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='pocketcontext-navigation-') as folder:
        pc = Project(Path(args.binary).resolve(), Path(folder))
        try:
            scenario(pc)
            print('Navigation references: PASS')
        finally:
            pc.run('stop')
