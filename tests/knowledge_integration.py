#!/usr/bin/env python3
"""Published JSON joins and batched reads through authenticated HTTP only."""
import argparse
import re
import sys
from unittest.mock import patch
from integration import ROOT, credentials, server

from wikicontext_client import knowledge
from wikicontext_client import cli as wc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    with server(args.binary) as request:
        _, _, token = credentials(request)
        def create(table, body):
            return request('POST', f'/api/collections/{table}/records', body, token)
        def run(key):
            return create('ingestion_runs', {'key': key, 'status': 'staging', 'description': 'Synthetic JSON join regression'})
        def revision(run, page, base='', **extra):
            return create('page_revisions', {
                'run': run['id'], 'page': page['id'], 'base_revision': base,
                'title': page['slug'], 'summary': 'Synthetic summary',
                'body': 'Historical statement [needs verification].', **extra})
        def publish(run):
            request('PATCH', f"/api/collections/ingestion_runs/records/{run['id']}",
                    {'expected_revision': 1, 'status': 'published'}, token)
        def query(sql):
            result = request('POST', '/api/context/query', {'sql': sql}, token)
            assert not result['truncated']
            return [dict(zip(result['columns'], row)) for row in result['rows']]
        def head():
            return query('SELECT id, sequence FROM publications ORDER BY sequence DESC LIMIT 1')[0]

        pages = [create('pages', {'slug': f'json-page-{i}', 'kind': 'concept'}) for i in range(3)]
        first = run('json-first')
        revisions = [revision(first, page, body=('See [[json-page-0]]. [needs verification].'
                     if index == 0 else 'Historical statement [needs verification].'))
                     for index, page in enumerate(pages)]
        # Self links are synthetic and remain valid when the unrelated third page archives.
        create('page_links', {'page_revision': revisions[0]['id'], 'target': pages[0]['id']})
        publish(first)
        first_publication = head()
        draft = run('json-unpublished')
        revision(draft, pages[1], revisions[1]['id'], title='Unpublished draft',
                 body='DraftOnlyToken [needs verification].')
        second = run('json-second')
        replacement = revision(second, pages[0], revisions[0]['id'], title='Current title',
                               body='CurrentOnlyToken [needs verification].')
        revision(second, pages[2], revisions[2]['id'], archived=True)

        # Publish between the client's head read and its first manifest join.
        calls, advanced = [], False
        def authenticated(cfg, method, path, body=None):
            nonlocal advanced
            if path == '/api/context/query':
                calls.append(body['sql'])
            result = request(method, path, body, token)
            if not advanced and 'ORDER BY sequence DESC LIMIT 1' in body.get('sql', ''):
                advanced = True
                publish(second)
            return result
        with patch.object(wc, 'must', side_effect=authenticated), patch.object(knowledge, 'BATCH_SIZE', 2):
            pinned, selected = knowledge.published({})
            assert pinned['id'] == first_publication['id']
            assert {page['id'] for page in selected} == {rev['id'] for rev in revisions}
            assert sum('SELECT r.*, p.slug, p.kind' in sql for sql in calls) >= 2
            assert knowledge.search({}, 'DraftOnlyToken')['pages'] == []
            current = knowledge.search({}, 'CurrentOnlyToken')['pages']
            assert [page['id'] for page in current] == [replacement['id']]
            report = knowledge.lint({})
            assert len([item for item in report['findings'] if item['kind'] == 'no-citations']) == 2
            assert not any(item['kind'] == 'broken-link' for item in report['findings'])
        second_publication = head()
        assert second_publication['sequence'] == 2

        # Execute the browser's actual template, not a hand-maintained parallel join.
        api = (ROOT / 'ui/src/api.ts').read_text()
        match = re.search(r'return `(FROM publications pub JOIN json_each\(pub\.manifest\).*?)`;', api)
        assert match, 'Update this regression if the browser published() template changes'
        validation = re.search(r'`(SELECT json_type\(pub\.manifest\).*?)`,', api, re.S)
        assert validation, 'Update this regression if browser validation changes'
        def validate(publication):
            sql = validation.group(1).replace('${identity(publicationId)}', knowledge.literal(publication['id']))
            assert '${' not in sql
            return query(sql)
        for publication, expected_pages in ((first_publication, 3), (second_publication, 2)):
            assert validate(publication) == [{'manifest_type': 'object', 'total': 3,
                                               'unique_keys': 3, 'invalid': 0,
                                               'published_count': expected_pages}]
        assert validate({'id': 'missingpub00001'}) == []
        def browser(publication, conditions='', offset=0, limit=2):
            join = match.group(1).replace('${identity(publicationId)}', knowledge.literal(publication['id']))
            assert '${' not in join
            return query('SELECT r.id, r.page, p.slug, p.kind, r.title, r.summary ' + join +
                         conditions + f' ORDER BY p.slug LIMIT {limit} OFFSET {offset}')
        old = browser(first_publication) + browser(first_publication, offset=2)
        assert [page['id'] for page in old] == [rev['id'] for rev in revisions]
        latest = browser(second_publication)
        assert [page['id'] for page in latest] == [replacement['id'], revisions[1]['id']]
        assert not browser(second_publication, " AND instr(lower(r.body),lower('DraftOnlyToken'))>0")
        assert not browser(first_publication, " AND instr(lower(r.body),lower('CurrentOnlyToken'))>0")
        assert browser(second_publication, " AND instr(lower(r.body),lower('CurrentOnlyToken'))>0")[0]['id'] == replacement['id']
        detail = re.search(r'`(SELECT selected\.\*,.*?)`,', api, re.S)
        summary = re.search(r'const summary = "(.*?)";', api)
        assert detail and summary, 'Update this regression if the browser detail template changes'
        for publication, expected_links in ((first_publication, 1), (second_publication, 0)):
            join = match.group(1).replace('${identity(publicationId)}', knowledge.literal(publication['id']))
            sql = detail.group(1).replace('${published(publicationId)}', join)
            sql = sql.replace('${summary}', summary.group(1)).replace('${literal(slug)}', knowledge.literal(pages[0]['slug']))
            assert '${' not in sql
            selected = query(sql)
            assert len(selected) == 1
            assert selected[0]['citation_count'] == 0
            assert selected[0]['backlink_count'] == expected_links
            assert selected[0]['link_count'] == expected_links
    print('PASS: HTTP JSON manifest joins, paged agent reads, concurrent publication pin, drafts, archives and browser history')


if __name__ == '__main__':
    main()
