#!/usr/bin/env python3
"""Revisioned catalog metadata, provenance and relationship publication boundaries."""
import argparse
import json
import os
import shutil
from pathlib import Path
import tempfile
from unittest.mock import patch
from integration import ROOT, server, credentials
import search_integration
from search_integration import Fixture, running
from wikicontext_client import ingest, repository_files, cli


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    # Upgrade a populated database without rewriting historical content or manifests.
    with tempfile.TemporaryDirectory(prefix='wiki-properties-upgrade-') as tmp:
        legacy = Path(tmp)/'legacy'
        legacy.mkdir()
        for name in ('pb_hooks', 'pb_migrations'):
            shutil.copytree(ROOT/name, legacy/name)
        (legacy/'pb_migrations/1791400000_properties.js').unlink()
        config = json.loads((ROOT/'pocketcontext.json').read_text())
        config['tables']['page_revisions'] = [key for key in config['tables']['page_revisions'] if key not in ('properties', 'property_evidence')]
        (legacy/'pocketcontext.json').write_text(json.dumps(config))
        work = Path(tmp)/'app'
        with patch.object(search_integration, 'ROOT', legacy), running(args.binary, work) as request:
            _, _, token = credentials(request)
            fixture = Fixture(request, token)
            page = fixture.page('legacy-resource')
            staged = fixture.run('legacy-resource-publication')
            revision = fixture.revision(staged, page)
            publication = fixture.publish(staged)
            before = fixture.query('SELECT id,manifest FROM publications')
            audit = fixture.query('SELECT id FROM audit_log ORDER BY id')
        with running(args.binary, work) as request:
            fixture = Fixture(request, token)
            assert fixture.query('SELECT id,manifest FROM publications') == before
            assert fixture.query('SELECT id FROM audit_log ORDER BY id') == audit
            row = fixture.query('SELECT id,properties,property_evidence FROM page_revisions')[0]
            assert row['id'] == revision['id'] and row['properties'] is None and row['property_evidence'] is None
            assert fixture.search(publication)['hits'][0]['id'] == revision['id']
            staged = fixture.run('upgraded-resource-publication')
            updated = request('POST', '/api/collections/page_revisions/records', dict(run=staged['id'], page=page['id'], base_revision=revision['id'], title='Updated resource', summary='Synthetic upgrade', body='[needs verification]', properties={'catalog_type': 'resource'}), token)
            fixture.publish(staged)
            assert json.loads(fixture.query('SELECT manifest FROM publications ORDER BY sequence DESC LIMIT 1')[0]['manifest'])[page['id']] == updated['id']
            assert fixture.query("SELECT properties FROM page_revisions WHERE id='%s'" % revision['id'])[0]['properties'] is None

    with server(args.binary) as request, tempfile.TemporaryDirectory(prefix='wiki-properties-') as folder:
        _, _, token = credentials(request)
        def create(table, body, expected=200):
            return request('POST', f'/api/collections/{table}/records', body, token, expected)
        def query(sql):
            result = request('POST', '/api/context/query', {'sql': sql}, token)
            assert not result['truncated']
            return [dict(zip(result['columns'], row)) for row in result['rows']]
        def publish(run, expected=200):
            return request('PATCH', '/api/collections/ingestion_runs/records/'+run['id'], {'expected_revision': 1, 'status': 'published'}, token, expected)
        def run(key):
            return create('ingestion_runs', {'key': key, 'status': 'staging', 'description': 'Synthetic catalog test'})
        def revision(staged, page, base='', properties=None, evidence=None, expected=200, body='Synthetic assessment. [needs verification]'):
            return create('page_revisions', {'run': staged['id'], 'page': page['id'], 'base_revision': base, 'title': 'Synthetic resource', 'summary': 'Synthetic catalog', 'body': body, 'properties': properties, 'property_evidence': evidence}, expected)
        def link(rev, page):
            return create('page_links', {'page_revision': rev['id'], 'target': page['id']})
        def cite(rev):
            return create('citations', {'page_revision': rev['id'], 'passage': passage, 'marker': '1'})
        source = Path(folder)/'evidence.txt'
        source.write_bytes(b'Synthetic provider observation.\r\nCopyright synthetic example.\r\n')
        with patch.dict(os.environ, {'XDG_CACHE_HOME': folder}):
            ingest.ingest({'url': request.base_url, 'email': 'agent@example.com', 'password': 'SyntheticUserPassword123!'}, source)
        passage = query('SELECT id FROM passages LIMIT 1')[0]['id']
        target = create('pages', {'slug': 'deployment', 'kind': 'entity'})
        page = create('pages', {'slug': 'bucket', 'kind': 'entity'})
        first = run('catalog-first')
        target_rev = revision(first, target)  # Legacy omitted/null properties remain readable.
        props = {'catalog_type': 'resource', 'provider': 'Synthetic', 'deployment_profiles': [target['id']], 'owner': None, 'active': True, 'capacity': 3}
        rev = revision(first, page, properties=props, evidence={'provider': ['1']})
        cite(rev)
        publish(first, 400)  # Relationships require explicit link records.
        assert not query('SELECT id FROM publications')
        assert query("SELECT status FROM ingestion_runs WHERE id='%s'" % first['id'])[0]['status'] == 'staging'
        link(rev, target)
        publish(first)
        # SQL exposes exactly the immutable published metadata.
        row = query("SELECT properties,property_evidence FROM page_revisions WHERE id='%s'" % rev['id'])[0]
        assert json.loads(row['properties']) == props
        assert json.loads(row['property_evidence']) == {'provider': ['1']}
        request('PATCH', '/api/collections/page_revisions/records/'+rev['id'], {'expected_revision': 1, 'properties': {'owner': 'Changed'}}, token, 400)
        # Concurrent property changes use the same base conflict boundary as prose.
        update, stale = run('catalog-update'), run('catalog-stale')
        revised = revision(update, page, rev['id'], {'catalog_type': 'resource', 'owner': 'Reviewed'})
        revision(stale, page, rev['id'], {'catalog_type': 'resource', 'owner': 'Stale'})
        publish(update)
        publish(stale, 409)
        manifests = query('SELECT manifest FROM publications ORDER BY sequence')
        assert json.loads(manifests[0]['manifest'])[page['id']] == rev['id']
        assert json.loads(manifests[1]['manifest'])[page['id']] == revised['id']
        assert json.loads(query("SELECT properties FROM page_revisions WHERE id='%s'" % rev['id'])[0]['properties']) == props
        bad = run('catalog-malformed')
        for malformed in [[], 'text', 2, {'title': 'spoof'}, {'wikicontext_page': 'spoof'}, {'bad-key': 'x'}, {'nested': {}}, {'list': [1]}, {'list': ['x','x']}, {'catalog_type': 'unknown'}, {'resources': ['bad']}, {'resources': target['id']}, {'long': 'x'*2049}, {'number': 9007199254740992}, {f'key_{n}': n for n in range(65)}]:
            revision(bad, page, revised['id'], malformed, expected=400)
        for evidence in [[], {'missing': ['1']}, {'provider': '1'}, {'provider': ['0']}, {'provider': ['1','1']}]:
            revision(bad, page, revised['id'], {'provider': 'Synthetic'}, evidence, expected=400)
        # Missing and unused evidence fail atomically; property-only citation is valid.
        for name, evidence, add_citation, body in [
            ('missing', {'provider': ['1']}, False, '[needs verification]'),
            ('unused', {}, True, '[needs verification]'),
            ('uncited-body', {'provider': ['1']}, True, 'Uncited prose.'),
        ]:
            staged = run(name)
            draft = revision(staged, page, revised['id'], {'provider': 'Synthetic'}, evidence, body=body)
            if add_citation:
                cite(draft)
            publish(staged, 400)
        # A relationship to an unpublished page fails even with its link record.
        missing = create('pages', {'slug': 'unpublished', 'kind': 'entity'})
        staged = run('unpublished-target')
        draft = revision(staged, page, revised['id'], {'resources': [missing['id']]})
        link(draft, missing)
        publish(staged, 400)
        # A current relation prevents archiving its target; historical-only relations do not.
        staged = run('restore-relation')
        related = revision(staged, page, revised['id'], {'deployment_profiles': [target['id']]})
        link(related, target)
        publish(staged)
        archive = run('archive-target')
        create('page_revisions', {'run': archive['id'], 'page': target['id'], 'base_revision': target_rev['id'], 'title': 'Archived deployment', 'summary': 'Synthetic archive', 'body': '[needs verification]', 'archived': True})
        publish(archive, 400)
        assert len(query('SELECT id FROM publications')) == 3
        # Groups own resources; membership and target classifications share the manifest.
        person = create('pages', {'slug': 'synthetic-person', 'kind': 'entity'})
        group = create('pages', {'slug': 'synthetic-core', 'kind': 'entity'})
        staged = run('group-ownership')
        person_rev = revision(staged, person, properties={'catalog_type': 'person'})
        group_rev = revision(staged, group, properties={'catalog_type': 'group', 'members': [person['id']]})
        owned = revision(staged, page, related['id'], {'catalog_type': 'resource', 'accountable_owners': [group['id']], 'backup_owners': [group['id']], 'accountable_owner': 'Legacy owner'})
        link(group_rev, person)
        link(owned, group)
        publish(staged)
        historical = query('SELECT manifest FROM publications ORDER BY sequence DESC LIMIT 1')[0]['manifest']
        for key, target_page in [('members', group), ('accountable_owners', person), ('backup_owners', person)]:
            staged = run('invalid-group-target-' + key)
            subject, base = (group, group_rev) if key == 'members' else (page, owned)
            draft = revision(staged, subject, base['id'], {'catalog_type': 'group' if key == 'members' else 'resource', key: [target_page['id']]})
            link(draft, target_page)
            publish(staged, 400)
            assert query('SELECT manifest FROM publications ORDER BY sequence DESC LIMIT 1')[0]['manifest'] == historical
        # Reclassifying only a target must also validate unchanged referring revisions.
        for subject, base, catalog in [(person, person_rev, 'group'), (group, group_rev, 'person')]:
            staged = run('invalid-reclassification-' + catalog)
            revision(staged, subject, base['id'], {'catalog_type': catalog})
            publish(staged, 400)
        staged = run('invalid-members-source')
        revision(staged, person, person_rev['id'], {'catalog_type': 'person', 'members': []}, expected=400)
        # Membership can be revised without changing the historical group or owners.
        staged = run('empty-group')
        revision(staged, group, group_rev['id'], {'catalog_type': 'group', 'members': []})
        publish(staged)
        assert json.loads(query("SELECT properties FROM page_revisions WHERE id='%s'" % group_rev['id'])[0]['properties'])['members'] == [person['id']]
        # One immutable document can feed multiple destinations; sync is independent.
        document = create('pages', {'slug': 'shared-copyright', 'kind': 'entity'})
        destination = create('pages', {'slug': 'copyright-repo-a', 'kind': 'entity'})
        destination_b = create('pages', {'slug': 'copyright-repo-b', 'kind': 'entity'})
        observation = create('pages', {'slug': 'copyright-sync-a', 'kind': 'entity'})
        source_id = query('SELECT id FROM sources LIMIT 1')[0]['id']
        document_props = {'catalog_type': 'repository_document', 'document_type': 'copyright', 'output_mode': 'exact_copy', 'source_id': source_id}
        destination_props = {'catalog_type': 'repository_destination', 'documents': [document['id']], 'github_repository': 'synthetic/repo-a', 'github_branch': 'main', 'github_path': 'COPYRIGHT'}
        staged = run('repository-files')
        doc_rev = revision(staged, document, properties=document_props)
        dest_rev = revision(staged, destination, properties=destination_props)
        dest_b_rev = revision(staged, destination_b, properties={**destination_props, 'github_repository': 'synthetic/repo-b'})
        link(dest_rev, document)
        link(dest_b_rev, document)
        publish(staged)
        export_sequence = query('SELECT sequence FROM publications ORDER BY sequence DESC LIMIT 1')[0]['sequence']
        cfg = {'url': request.base_url, 'email': 'agent@example.com', 'password': 'SyntheticUserPassword123!'}
        with patch.dict(os.environ, {'XDG_CACHE_HOME': folder}):
            output = Path(folder)/'COPYRIGHT.review'
            receipt = repository_files.export(cfg, destination['id'], output, export_sequence)
            assert output.read_bytes() == source.read_bytes()
            assert receipt['document_revision'] == doc_rev['id'] and receipt['destination_revision'] == dest_rev['id']
            try:
                repository_files.export(cfg, destination['id'], output, export_sequence)
                raise AssertionError('Overwrote existing output')
            except cli.Fail:
                assert output.read_bytes() == source.read_bytes()
            try:
                repository_files.export(cfg, 'z'*15, Path(folder)/'absent', export_sequence)
                raise AssertionError('Accepted absent destination')
            except cli.Fail:
                assert not (Path(folder)/'absent').exists()
        sync_props = {'catalog_type': 'repository_sync', 'destinations': [destination['id']], 'synced_destination_revision': dest_rev['id'], 'synced_document_revision': doc_rev['id'], 'rendered_sha256': query('SELECT sha256 FROM sources LIMIT 1')[0]['sha256'], 'github_commit': 'b'*40, 'checked_at': '2026-10-10T00:00:00Z', 'sync_status': 'current'}
        staged = run('repository-observation')
        sync_rev = revision(staged, observation, properties=sync_props)
        link(sync_rev, destination)
        publish(staged)
        assert json.loads(query('SELECT manifest FROM publications ORDER BY sequence DESC LIMIT 1')[0]['manifest'])[document['id']] == doc_rev['id']
        for index, malformed in enumerate([
            {**document_props, 'source_id': 'bad'},
            {**document_props, 'output_mode': 'template'},
            {**destination_props, 'documents': []},
            *[{**destination_props, 'github_path': path} for path in ['/COPYRIGHT', '../COPYRIGHT', '.git/config', 'a//b', 'a/./b', 'a\\b']],
            *[{**destination_props, 'github_branch': branch} for branch in ['../main', 'a.lock', 'a..b', '@{x}', 'a b']],
            {**sync_props, 'checked_at': '2026-02-30T00:00:00Z'},
            {**sync_props, 'github_commit': 'abc'},
        ]):
            staged = run('invalid-repository-metadata-' + str(index))
            revision(staged, document, properties=malformed, expected=400)
        staged = run('nonexistent-original-source')
        revision(staged, document, doc_rev['id'], {**document_props, 'source_id': 'zzzzzzzzzzzzzzz'}, expected=404)
        publications_before_duplicate = query('SELECT id,manifest FROM publications ORDER BY sequence')
        staged = run('duplicate-repository-destination')
        duplicate = revision(staged, destination_b, dest_b_rev['id'], {**destination_props, 'github_repository': 'Synthetic/Repo-A'})
        link(duplicate, document)
        publish(staged, 400)
        assert query('SELECT id,manifest FROM publications ORDER BY sequence') == publications_before_duplicate
        assert query("SELECT status FROM ingestion_runs WHERE id='%s'" % staged['id'])[0]['status'] == 'staging'
        staged = run('wrong-repository-document')
        wrong = revision(staged, destination, dest_rev['id'], {**destination_props, 'documents': [person['id']]})
        link(wrong, person)
        publish(staged, 400)
        staged = run('wrong-synced-destination-revision')
        wrong = revision(staged, observation, sync_rev['id'], {**sync_props, 'synced_destination_revision': dest_b_rev['id']})
        link(wrong, destination)
        publish(staged, 400)
        staged = run('wrong-rendered-hash')
        wrong = revision(staged, observation, sync_rev['id'], {**sync_props, 'rendered_sha256': 'a'*64})
        link(wrong, destination)
        publish(staged, 400)
        staged = run('wrong-synced-revision')
        wrong = revision(staged, observation, sync_rev['id'], {**sync_props, 'synced_document_revision': person_rev['id']})
        link(wrong, destination)
        publish(staged, 400)
        staged = run('unpublished-synced-revision')
        unpublished_doc = revision(staged, document, doc_rev['id'], document_props)
        wrong = revision(staged, observation, sync_rev['id'], {**sync_props, 'synced_document_revision': unpublished_doc['id']})
        link(wrong, destination)
        publish(staged, 400)
        # Unknown observations need no fabricated Git commit.
        staged = run('unknown-repository-observation')
        unknown = revision(staged, observation, sync_rev['id'], {**sync_props, 'github_commit': None, 'sync_status': 'unknown'})
        link(unknown, destination)
        publish(staged)
        # Remapping a destination preserves the old pinned observation as history.
        staged = run('remapped-repository-destination')
        remapped = revision(staged, destination, dest_rev['id'], {**destination_props, 'github_path': 'COPYRIGHT.txt'})
        link(remapped, document)
        publish(staged)
        old_sync = json.loads(query("SELECT properties FROM page_revisions WHERE id='%s'" % unknown['id'])[0]['properties'])
        assert old_sync['synced_destination_revision'] == dest_rev['id']
        with patch.dict(os.environ, {'XDG_CACHE_HOME': folder}):
            old_content, old_receipt = repository_files.render(cfg, destination['id'], export_sequence)
            current_sequence = query('SELECT sequence FROM publications ORDER BY sequence DESC LIMIT 1')[0]['sequence']
            new_content, new_receipt = repository_files.render(cfg, destination['id'], current_sequence)
            assert old_content == new_content == source.read_bytes()
            assert old_receipt['github_path'] == 'COPYRIGHT'
            assert new_receipt['github_path'] == 'COPYRIGHT.txt'
        # Clean README bodies can cite their provenance through metadata.
        markdown = create('pages', {'slug': 'shared-readme', 'kind': 'entity'})
        staged = run('clean-repository-markdown')
        clean = revision(staged, markdown, properties={'catalog_type': 'repository_document', 'document_type': 'readme', 'output_mode': 'markdown'}, evidence={'document_type': ['1']}, body='# Synthetic README\n\nInstructions.')
        cite(clean)
        markdown_destination = create('pages', {'slug': 'readme-destination', 'kind': 'entity'})
        md_target = revision(staged, markdown_destination, properties={**destination_props, 'documents': [markdown['id']], 'github_path': 'README.md'})
        link(md_target, markdown)
        publish(staged)
        markdown_sequence = query('SELECT sequence FROM publications ORDER BY sequence DESC LIMIT 1')[0]['sequence']
        with patch.dict(os.environ, {'XDG_CACHE_HOME': folder}):
            md_content, md_receipt = repository_files.render(cfg, markdown_destination['id'], markdown_sequence)
            assert md_content == b'# Synthetic README\n\nInstructions.'
        staged = run('changed-repository-markdown')
        clean_next = revision(staged, markdown, clean['id'], properties={'catalog_type': 'repository_document', 'document_type': 'readme', 'output_mode': 'markdown'}, evidence={'document_type': ['1']}, body='# Revised README\n')
        cite(clean_next)
        publish(staged)
        with patch.dict(os.environ, {'XDG_CACHE_HOME': folder}):
            assert repository_files.render(cfg, markdown_destination['id'], markdown_sequence)[0] == md_content
            latest = query('SELECT sequence FROM publications ORDER BY sequence DESC LIMIT 1')[0]['sequence']
            assert repository_files.render(cfg, markdown_destination['id'], latest)[0] == b'# Revised README\n'

        # Reclassification adds a prompt view without replacing document identity,
        # original bytes, destination mappings or earlier publication history.
        prompt_props = {**document_props, 'document_type': 'prompt',
                        'purpose': 'Synthetic setup instructions',
                        'target_agents': ['codex', 'claude-code'],
                        'required_skills': ['wikicontext'], 'inputs': ['Repository path'],
                        'approval_boundaries': 'Ask before changing shell configuration.',
                        'last_validated_at': '2026-10-13'}
        staged = run('classify-existing-document-as-prompt')
        prompt_rev = revision(staged, document, doc_rev['id'], prompt_props)
        publish(staged)
        assert json.loads(query("SELECT properties FROM page_revisions WHERE id='%s'" % doc_rev['id'])[0]['properties']) == document_props
        latest = query('SELECT sequence FROM publications ORDER BY sequence DESC LIMIT 1')[0]['sequence']
        with patch.dict(os.environ, {'XDG_CACHE_HOME': folder}):
            content, receipt = repository_files.render(cfg, destination['id'], latest)
            assert content == source.read_bytes()
            assert receipt['document_revision'] == prompt_rev['id']
            assert receipt['destination_revision'] == remapped['id']
            assert repository_files.render(cfg, destination['id'], export_sequence)[1]['document_revision'] == doc_rev['id']
        staged = run('invalid-prompt-document')
        for malformed in [
            {**prompt_props, 'document_type': 'unknown'},
            {**prompt_props, 'source_id': None},
            {**prompt_props, 'output_mode': 'execute'},
            {**prompt_props, 'inputs': [{'name': 'nested'}]},
        ]:
            revision(staged, document, prompt_rev['id'], malformed, expected=400)
        # Markdown prompts retain metadata-only provenance and exact body output.
        staged = run('markdown-prompt')
        prompt_body = '# Synthetic prompt\n\nAsk before installing dependencies.\n'
        md_prompt = revision(staged, markdown, clean_next['id'], properties={
            'catalog_type': 'repository_document', 'document_type': 'prompt',
            'output_mode': 'markdown'}, evidence={'document_type': ['1']}, body=prompt_body)
        cite(md_prompt)
        publish(staged)
        latest = query('SELECT sequence FROM publications ORDER BY sequence DESC LIMIT 1')[0]['sequence']
        with patch.dict(os.environ, {'XDG_CACHE_HOME': folder}):
            assert repository_files.render(cfg, markdown_destination['id'], latest)[0] == prompt_body.encode()

    print('PASS: revisioned properties, immutable history, conflict rollback, bounded metadata, property provenance and relationship graph')


if __name__ == '__main__':
    main()
