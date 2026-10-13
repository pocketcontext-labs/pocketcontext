#!/usr/bin/env python3
"""Run the browser reader against synthetic data and an isolated real server."""
import argparse
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import struct
import zlib
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import urllib.request
import urllib.error

from integration import ROOT, credentials, server
from wikicontext_client.ingest import multipart


def seed(request):
    admin, user, token = credentials(request)
    def create(table, body):
        return request('POST', '/api/collections/' + table + '/records', body, token)
    request('POST', '/api/collections/users/records', {'email': 'second@example.com', 'name': 'Second reader', 'password': 'SyntheticUserPassword123!', 'passwordConfirm': 'SyntheticUserPassword123!', 'verified': True}, admin)
    original = b'The synthetic observatory opened in 2026. Its telescope studies stars.\n'
    body, media = multipart({'title': 'Observatory source', 'original_name': 'observatory.txt', 'media_type': 'text/plain'},
                            'original', 'observatory.txt', original, 'text/plain')
    upload = urllib.request.Request(request.base_url + '/api/collections/sources/records', body,
                                    {'Authorization': token, 'Content-Type': media})
    with urllib.request.urlopen(upload) as response:
        source = json.load(response)
    rendition = create('renditions', {'source': source['id'], 'kind': 'text', 'processor': 'synthetic browser fixture', 'version_label': 'v1'})
    passage = create('passages', {'rendition': rendition['id'], 'ordinal': 1, 'locator': 'document; line 1', 'body': original.decode()})
    observatory = create('pages', {'slug': 'observatory', 'kind': 'entity'})
    telescope = create('pages', {'slug': 'telescope', 'kind': 'concept'})
    state = {'sequence': 0, 'revision': '', 'pending': None, 'home': '', 'home_changes': 0}

    def stage():
        number = state['sequence'] + 1
        run = create('ingestion_runs', {'key': f'browser-{number}', 'status': 'staging', 'description': f'Browser publication {number}', 'sources': [source['id']]})
        revision = create('page_revisions', {'run': run['id'], 'page': observatory['id'], 'base_revision': state['revision'],
            'title': 'Observatory', 'summary': 'A synthetic place to study stars.',
            'body': f'## Opening\n\nPublished edition {number}. Editiontoken{number}. The observatory opened in 2026.[^1]\n\nSee [[telescope|the telescope]].\n\n'
                    '> [!NOTE] Reading note\n> These records are synthetic.\n\n'
                    '<script>window.wikiInjected = true</script>\n\n'
                    '<img src="https://invalid.example/tracker" onerror="window.wikiInjected = true">\n\n'
                    '[Unsafe link](javascript:alert(1))\n\n![Remote image](https://invalid.example/pixel.png)\n\n'
                    '| Instrument | Status |\n| --- | --- |\n| Telescope | Ready |\n'})
        create('citations', {'page_revision': revision['id'], 'passage': passage['id'], 'marker': '1', 'note': 'Opening date.'})
        create('page_links', {'page_revision': revision['id'], 'target': telescope['id']})
        if number == 1:
            onboarding = create('pages', {'slug': 'colleague-onboarding', 'kind': 'concept'})
            create('page_revisions', {'run': run['id'], 'page': onboarding['id'], 'title': 'Colleague onboarding',
                'summary': 'Synthetic new colleague setup guide.', 'body': 'Start with synthetic setup. [needs verification]'})
            for n in range(25):
                item = create('pages', {'slug': f'starlight-{n:02d}', 'kind': 'concept'})
                create('page_revisions', {'run': run['id'], 'page': item['id'], 'title': f'Starlight {n:02d}',
                    'summary': 'Synthetic search fixture.',
                    'body': f'Starlight telescope research note {n}. <img src=x onerror=window.wikiInjected=true> [needs verification]'})
            create('page_revisions', {'run': run['id'], 'page': telescope['id'], 'title': 'Telescope', 'summary': 'Synthetic instrument.', 'body': '## Lens\n\nAn instrument for observing stars. [needs verification]'})
        state['pending'] = (run, revision)
        return {'edition': number}

    def publish():
        if state['pending'] is None:
            stage()
        run, revision = state['pending']
        request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'], {'expected_revision': run['revision'], 'status': 'published'}, token)
        state.update(sequence=state['sequence'] + 1, revision=revision['id'], pending=None)
        return {'edition': state['sequence']}

    publish()
    def control(action):
        nonlocal token
        if action == '/directory':
            request('PATCH', '/api/settings', {'rateLimits': {'enabled': False}}, admin)
            run = create('ingestion_runs', {'key': 'browser-directory', 'status': 'staging', 'description': 'Synthetic people and groups'})
            people = [create('pages', {'slug': 'directory-' + name.lower(), 'kind': 'entity'}) for name in ('Ada', 'Ben')]
            group = create('pages', {'slug': 'directory-core', 'kind': 'entity'})
            deployment = create('pages', {'slug': 'directory-service', 'kind': 'entity'})
            def directory_revision(page, title, props):
                linked = set()
                rev = create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': title,
                    'summary': 'Synthetic directory fixture.', 'body': 'Synthetic directory. [needs verification]', 'properties': props})
                for field in ('members', 'accountable_owners', 'backup_owners'):
                    for target in props.get(field, []):
                        # Ownership roles may share the same target; links are unique per revision.
                        if target not in linked:
                            create('page_links', {'page_revision': rev['id'], 'target': target})
                            linked.add(target)
                return rev
            for person, name in zip(people, ('Ada', 'Ben')):
                directory_revision(person, name, {'catalog_type': 'person', 'role': 'Engineer',
                    'organization': 'Synthetic organization', 'crm_url': 'https://crm.example.com/#/people/' + person['id']})
            group_revision = directory_revision(group, 'Core', {'catalog_type': 'group', 'purpose': 'Operate the synthetic service',
                'members': [person['id'] for person in people]})
            directory_revision(deployment, 'Directory service', {'catalog_type': 'deployment',
                'accountable_owners': [group['id']], 'backup_owners': [group['id']]})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'],
                {'expected_revision': run['revision'], 'status': 'published'}, token)
            state['directory'] = {'people': people, 'group': group, 'revision': group_revision}
            return request('GET', '/api/collections/publications/records?filter=space%3D%27companyspace001%27&sort=-sequence&perPage=1', token=token)['items'][0]
        if action == '/directory-update':
            directory = state['directory']
            run = create('ingestion_runs', {'key': 'browser-directory-update', 'status': 'staging', 'description': 'Synthetic membership change'})
            revision = create('page_revisions', {'run': run['id'], 'page': directory['group']['id'],
                'base_revision': directory['revision']['id'], 'title': 'Core', 'summary': 'Synthetic membership change.',
                'body': 'Synthetic membership update. [needs verification]', 'properties': {'catalog_type': 'group',
                'purpose': 'Operate the synthetic service', 'members': [directory['people'][0]['id']]}})
            create('page_links', {'page_revision': revision['id'], 'target': directory['people'][0]['id']})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'],
                {'expected_revision': run['revision'], 'status': 'published'}, token)
            return request('GET', '/api/collections/publications/records?filter=space%3D%27companyspace001%27&sort=-sequence&perPage=1', token=token)['items'][0]
        if action == '/prompts':
            request('PATCH', '/api/settings', {'rateLimits': {'enabled': False}}, admin)
            exact_text = '# Exact setup\r\n\r\nUse the synthetic workspace.\r\n'
            body, media = multipart({'title': 'Exact setup prompt original', 'original_name': 'setup.md', 'media_type': 'text/markdown'},
                                    'original', 'setup.md', exact_text.encode(), 'text/markdown')
            upload = urllib.request.Request(request.base_url + '/api/collections/sources/records', body,
                                            {'Authorization': token, 'Content-Type': media})
            with urllib.request.urlopen(upload) as response:
                prompt_source = json.load(response)
            run = create('ingestion_runs', {'key': 'browser-prompts', 'status': 'staging', 'description': 'Synthetic prompts', 'sources': [prompt_source['id']]})
            markdown_text = '# Onboarding\n\nPrepare a synthetic workspace.\n'
            pages = {}
            for slug, title, mode, text in (
                ('onboarding-prompt', 'Onboarding prompt', 'markdown', markdown_text),
                ('exact-setup-prompt', 'Exact setup prompt', 'exact_copy', 'Description only; original contains prompt bytes. [needs verification]'),
                ('ordinary-guide', 'Ordinary guide', 'markdown', 'Synthetic guide. [needs verification]'),
            ):
                page = create('pages', {'slug': slug, 'kind': 'entity'})
                props = {'catalog_type': 'repository_document', 'document_type': 'other' if slug == 'ordinary-guide' else 'prompt',
                         'output_mode': mode, 'lifecycle_status': 'active'}
                if props['document_type'] == 'prompt':
                    props.update(purpose='Set up a synthetic workspace', target_agents=['codex', 'claude-code'],
                                 required_skills=['wikicontext'], inputs=['Workspace path'],
                                 approval_boundaries='Ask before installing dependencies', last_validated_at='2026-10-13')
                if mode == 'exact_copy':
                    props['source_id'] = prompt_source['id']
                revision = create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': title,
                    'summary': 'Synthetic reusable instructions.', 'body': text, 'properties': props,
                    'property_evidence': {'purpose': ['1']} if slug == 'onboarding-prompt' else {}})
                if slug == 'onboarding-prompt':
                    create('citations', {'page_revision': revision['id'], 'passage': passage['id'], 'marker': '1'})
                pages[slug] = page['id']
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'], {'expected_revision': run['revision'], 'status': 'published'}, token)
            publication = request('GET', '/api/collections/publications/records?filter=space%3D%27companyspace001%27&sort=-sequence&perPage=1', token=token)['items'][0]
            return {'publication': publication, 'sequence': publication['sequence'], 'markdown': pages['onboarding-prompt'], 'exact': pages['exact-setup-prompt'],
                    'markdown_text': markdown_text, 'exact_text': exact_text}
        if action == '/repository-files':
            request('PATCH', '/api/settings', {'rateLimits': {'enabled': False}}, admin)
            run = create('ingestion_runs', {'key': 'browser-repository-files', 'status': 'staging', 'description': 'Synthetic repository files'})
            document = create('pages', {'slug': 'shared-readme', 'kind': 'entity'})
            props = {'catalog_type': 'repository_document', 'document_type': 'readme', 'output_mode': 'markdown', 'lifecycle_status': 'active'}
            revision = create('page_revisions', {'run': run['id'], 'page': document['id'], 'title': 'Shared README', 'summary': 'Synthetic shared file.', 'body': 'Synthetic readme. [needs verification]', 'properties': props})
            destinations = []
            for name in ('one', 'two'):
                page = create('pages', {'slug': 'readme-copy-' + name, 'kind': 'entity'})
                target = create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': 'README copy ' + name, 'summary': 'Synthetic destination.', 'body': 'Synthetic destination. [needs verification]', 'properties': {'catalog_type': 'repository_destination', 'documents': [document['id']], 'github_repository': 'example/' + name, 'github_branch': 'main', 'github_path': 'README.md', 'lifecycle_status': 'active'}})
                create('page_links', {'page_revision': target['id'], 'target': document['id']})
                destinations.append((page, target))
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'], {'expected_revision': run['revision'], 'status': 'published'}, token)
            run = create('ingestion_runs', {'key': 'browser-repository-sync', 'status': 'staging', 'description': 'Synthetic sync evidence'})
            page = create('pages', {'slug': 'readme-sync', 'kind': 'entity'})
            observation = create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': 'README synchronization', 'summary': 'Synthetic check.', 'body': 'Synthetic check. [needs verification]', 'properties': {'catalog_type': 'repository_sync', 'destinations': [destinations[0][0]['id']], 'synced_document_revision': revision['id'], 'synced_destination_revision': destinations[0][1]['id'], 'rendered_sha256': 'a' * 64, 'github_commit': 'b' * 40, 'checked_at': '2026-10-10T10:00:00Z', 'sync_status': 'current'}})
            create('page_links', {'page_revision': observation['id'], 'target': destinations[0][0]['id']})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'], {'expected_revision': run['revision'], 'status': 'published'}, token)
            state['repository_document'] = (document, revision, props)
            return request('GET', '/api/collections/publications/records?filter=space%3D%27companyspace001%27&sort=-sequence&perPage=1', token=token)['items'][0]
        if action == '/repository-files-update':
            document, revision, props = state['repository_document']
            run = create('ingestion_runs', {'key': 'browser-repository-update', 'status': 'staging', 'description': 'Synthetic document update'})
            create('page_revisions', {'run': run['id'], 'page': document['id'], 'base_revision': revision['id'], 'title': 'Shared README', 'summary': 'Updated synthetic file.', 'body': 'Updated synthetic readme. [needs verification]', 'properties': props})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'], {'expected_revision': run['revision'], 'status': 'published'}, token)
            return request('GET', '/api/collections/publications/records?filter=space%3D%27companyspace001%27&sort=-sequence&perPage=1', token=token)['items'][0]
        if action == '/catalog':
            request('PATCH', '/api/settings', {'rateLimits': {'enabled': False}}, admin)
            run = create('ingestion_runs', {'key': 'browser-catalog', 'status': 'staging', 'description': 'Synthetic property catalog'})
            deployment = create('pages', {'slug': 'synthetic-cluster', 'kind': 'entity'})
            create('page_revisions', {'run': run['id'], 'page': deployment['id'], 'title': 'Synthetic cluster', 'summary': 'Synthetic deployment fixture.',
                'body': 'Synthetic deployment. [needs verification]', 'properties': {'catalog_type': 'deployment', 'provider': 'Fixture cloud'}})
            for n in range(51):
                item = create('pages', {'slug': f'catalog-bucket-{n:02d}', 'kind': 'entity'})
                revision = create('page_revisions', {'run': run['id'], 'page': item['id'], 'title': f'Catalog bucket {n:02d}', 'summary': 'Synthetic resource fixture.',
                    'body': 'Synthetic inventory. [needs verification]', 'properties': {'catalog_type': 'resource',
                        'provider': 'Fixture cloud', 'provider_id': f'synthetic-bucket-{n}', 'deployment_profiles': [deployment['id']],
                        'lifecycle_status': 'active', 'accountable_owner': None if n == 0 else 'Synthetic operator',
                        'provider_observed_at': '2026-10-08', 'expires_at': None, 'expiry_observation': 'Not returned'},
                    'property_evidence': {'provider_observed_at': ['1']}})
                create('citations', {'page_revision': revision['id'], 'passage': passage['id'], 'marker': '1'})
                create('page_links', {'page_revision': revision['id'], 'target': deployment['id']})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'],
                {'expected_revision': run['revision'], 'status': 'published'}, token)
            return request('GET', '/api/collections/publications/records?filter=space%3D%27companyspace001%27&sort=-sequence&perPage=1', token=token)['items'][0]
        if action == '/images':
            def chunk(kind, data):
                return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
            png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1200, 600, 8, 2, 0, 0, 0))
                   + chunk(b'IDAT', zlib.compress((b'\0' + b'\x24\x80\xd0' * 1200) * 600)) + chunk(b'IEND', b''))
            sources = {}
            for key, mime, name, content in (
                ('image', 'image/png', 'observatory.png', png),
                ('broken', 'image/png', 'broken.png', b'Synthetic undecodable image bytes'),
                ('unsupported', 'image/svg+xml', 'unsupported.svg', b'<svg xmlns="http://www.w3.org/2000/svg"><text>synthetic</text></svg>'),
            ):
                body, media = multipart({'title': f'Synthetic {key} source', 'original_name': name, 'media_type': mime},
                                        'original', name, content, mime)
                upload = urllib.request.Request(request.base_url + '/api/collections/sources/records', body,
                                                {'Authorization': token, 'Content-Type': media})
                with urllib.request.urlopen(upload) as response:
                    sources[key] = json.load(response)
            rendition = create('renditions', {'source': sources['image']['id'], 'kind': 'image-review',
                'processor': 'synthetic browser fixture', 'version_label': 'v1'})
            image_passage = create('passages', {'rendition': rendition['id'], 'ordinal': 1,
                'locator': 'image; description; region 0,0,1200,600', 'body': 'A synthetic blue image.'})
            run = create('ingestion_runs', {'key': 'browser-images', 'status': 'staging',
                'description': 'Synthetic image preview fixture', 'sources': [sources['image']['id']]})
            page = create('pages', {'slug': 'image-evidence', 'kind': 'concept'})
            revision = create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': 'Image evidence',
                'summary': 'Synthetic image evidence.', 'body': 'The synthetic image is blue.[^1]'})
            create('citations', {'page_revision': revision['id'], 'passage': image_passage['id'], 'marker': '1'})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'],
                {'expected_revision': run['revision'], 'status': 'published'}, token)
            return {**{key: value['id'] for key, value in sources.items()}, 'passage': image_passage['id']}
        if action == '/transcript':
            run = create('ingestion_runs', {'key': 'large-transcript', 'status': 'staging',
                'description': 'Synthetic transcript request-budget regression'})
            page = create('pages', {'slug': 'large-transcript', 'kind': 'concept'})
            revision = create('page_revisions', {'run': run['id'], 'page': page['id'],
                'title': 'Large transcript', 'summary': 'Synthetic transcript with 738 citations.',
                'body': '\n\n'.join(f'Synthetic sentence.[^{n}]' for n in range(1, 739))})
            for n in range(1, 739):
                create('citations', {'page_revision': revision['id'], 'passage': passage['id'], 'marker': str(n)})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'],
                {'expected_revision': run['revision'], 'status': 'published'}, token)
            request('PATCH', '/api/settings', {'rateLimits': {'enabled': True, 'rules': [
                {'label': '/api/context/', 'audience': '', 'duration': 10, 'maxRequests': 60}]}}, admin)
            return {'ok': True}
        if action in ('/home-telescope', '/home-clear'):
            state['home_changes'] += 1
            setting = {'home': telescope['id']} if action == '/home-telescope' else {'clear_home': True}
            run = create('ingestion_runs', {'key': f'browser-home-{state["home_changes"]}',
                'status': 'staging', 'description': 'Browser home-only publication',
                'home_base': state['home'], **setting})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'],
                {'expected_revision': run['revision'], 'status': 'published'}, token)
            state['home'] = setting.get('home', '')
            return request('GET', '/api/collections/publications/records?filter=space%3D%27companyspace001%27&sort=-sequence&perPage=1', token=token)['items'][0]
        if action == '/publish-new-page':
            run = create('ingestion_runs', {'key': 'browser-directory-addition', 'status': 'staging',
                'description': 'Synthetic welcome directory update'})
            page = create('pages', {'slug': 'zenith-guide', 'kind': 'concept'})
            create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': 'Zenith guide',
                'summary': 'A newly published directory entry.', 'body': 'Synthetic new page. [needs verification]'})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'],
                {'expected_revision': run['revision'], 'status': 'published'}, token)
            return request('GET', '/api/collections/publications/records?filter=space%3D%27companyspace001%27&sort=-sequence&perPage=1', token=token)['items'][0]
        if action in ('/new-reader', '/new-reader-revoked'):
            state['new_readers'] = state.get('new_readers', 0) + 1
            email = 'space-reader-' + str(state['new_readers']) + '@example.com'
            account = request('POST', '/api/collections/users/records', {'email': email, 'name': 'Synthetic space reader', 'password': 'SyntheticUserPassword123!', 'passwordConfirm': 'SyntheticUserPassword123!', 'verified': True}, admin)
            if action == '/new-reader-revoked':
                members = request('GET', '/api/collections/space_members/records?filter=account%3D%27' + account['id'] + '%27', token=admin)['items']
                member = next(row for row in members if row['space'] == 'companyspace001')
                request('PATCH', '/api/collections/space_members/records/' + member['id'], {'active': False, 'expected_revision': member['revision']}, admin)
            return request('POST', '/api/collections/users/auth-with-password', {'identity': email, 'password': 'SyntheticUserPassword123!'})
        if action == '/spaces':
            if 'spaces_fixture' in state:
                return state['spaces_fixture']
            request('PATCH', '/api/settings', {'rateLimits': {'enabled': False}}, admin)
            other_token = request('POST', '/api/collections/users/auth-with-password', {'identity': 'second@example.com', 'password': 'SyntheticUserPassword123!'})['token']
            def personal_fixture(identity, label):
                space = request('POST', '/api/wiki/spaces/personal', {}, identity)['id']
                def private_create(table, fields):
                    return request('POST', '/api/collections/' + table + '/records', {'space': space, **fields}, identity)
                original = (label + ' private evidence.\n').encode()
                body, media = multipart({'space': space, 'title': label + ' source', 'original_name': label + '.txt', 'media_type': 'text/plain'}, 'original', label + '.txt', original, 'text/plain')
                upload = urllib.request.Request(request.base_url + '/api/collections/sources/records', body, {'Authorization': identity, 'Content-Type': media})
                with urllib.request.urlopen(upload) as response:
                    private_source = json.load(response)
                rendition = private_create('renditions', {'source': private_source['id'], 'kind': 'text', 'processor': 'browser-spaces-fixture', 'version_label': 'v1'})
                private_passage = private_create('passages', {'rendition': rendition['id'], 'ordinal': 1, 'locator': 'line 1', 'body': original.decode()})
                run = private_create('ingestion_runs', {'key': 'browser-private', 'status': 'staging', 'description': label + ' publication'})
                page = private_create('pages', {'slug': 'observatory', 'kind': 'concept'})
                revision = private_create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': label + ' notes', 'summary': label + ' summary', 'body': label + ' private evidence.[^1]'})
                private_create('citations', {'page_revision': revision['id'], 'passage': private_passage['id'], 'marker': '1'})
                request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'], {'expected_revision': run['revision'], 'status': 'published'}, identity)
                publication = request('GET', '/api/collections/publications/records?filter=space%3D%27' + space + '%27&perPage=1', token=identity)['items'][0]
                return {'space': space, 'source': private_source['id'], 'passage': private_passage['id'], 'publication': publication['id']}
            own = personal_fixture(token, 'Personal')
            foreign = personal_fixture(other_token, 'Foreign')
            state['spaces_fixture'] = {'own': own, 'foreign': foreign}
            return state['spaces_fixture']
        if action in ('/revoke-company', '/restore-company'):
            memberships = request('GET', '/api/collections/space_members/records?filter=account%3D%27' + user['id'] + '%27', token=admin)['items']
            member = next(row for row in memberships if row['space'] == 'companyspace001')
            request('PATCH', '/api/collections/space_members/records/' + member['id'], {'active': action == '/restore-company', 'expected_revision': member['revision']}, admin)
            return {'ok': True}
        if action == '/other-session':
            return request('POST', '/api/collections/users/auth-with-password', {'identity': 'second@example.com', 'password': 'SyntheticUserPassword123!'})
        if action == '/stage':
            return stage()
        if action == '/publish':
            return publish()
        if action in ('/disable', '/enable'):
            request('PATCH', '/api/collections/users/records/' + user['id'], {'disabled': action == '/disable'}, admin)
            if action == '/enable':
                token = request('POST', '/api/collections/users/auth-with-password', {'identity': 'agent@example.com', 'password': 'SyntheticUserPassword123!'})['token']
            return {'ok': True}
        raise ValueError('Unknown fixture action')
    return control


@contextlib.contextmanager
def controller(control):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                result = control(self.path)
                status = 200
            except Exception as error:
                result, status = {'error': str(error)}, 500
            encoded = json.dumps(result).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        def log_message(self, *_args):
            pass
    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield 'http://127.0.0.1:' + str(http.server_port)
    finally:
        http.shutdown()
        http.server_close()
        thread.join()


def check_static(base_url):
    with urllib.request.urlopen(base_url + '/') as response:
        html = response.read().decode()
        assert response.headers['Cache-Control'] == 'no-store'
        assert response.headers['X-Content-Type-Options'] == 'nosniff'
        assert response.headers['X-Frame-Options'] == 'DENY'
        policy = response.headers['Content-Security-Policy']
        assert "script-src 'self'" in policy and "frame-ancestors 'none'" in policy
        assert "'unsafe-inline'" not in policy
    assets = re.findall(r'(?:src|href)="(/assets/[^" ]+)"', html)
    assert assets, 'Built reader assets missing'
    for asset in assets:
        with urllib.request.urlopen(base_url + asset) as response:
            assert response.status == 200 and response.read()
            assert 'immutable' in response.headers['Cache-Control']
    for path in ('/assets/missing.js', '/assets/../pocketcontext.json', '/assets/%2e%2e%2fpocketcontext.json', '/assets/pocketcontext.json'):
        try:
            urllib.request.urlopen(base_url + path)
        except urllib.error.HTTPError as error:
            assert error.code == 404, (path, error.code)
        else:
            raise AssertionError('Unexpected exposed path: ' + path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--grep', help='Run browser scenarios matching this Playwright expression')
    args = parser.parse_args()
    with server(args.binary) as request, controller(seed(request)) as control_url, tempfile.TemporaryDirectory(prefix='wikicontext-ui-') as temporary:
        check_static(request.base_url)
        env = dict(os.environ, WIKICONTEXT_TEST_URL=request.base_url, WIKICONTEXT_TEST_CONTROL=control_url,
                   WIKICONTEXT_TEST_OUTPUT=temporary)
        command = ['pnpm', 'exec', 'playwright', 'test', '--config', 'e2e/playwright.config.ts']
        if args.grep:
            command.extend(['--grep', args.grep])
        subprocess.run(command, cwd=ROOT / 'ui', env=env, check=True)
    print('PASS: real browser reader, synthetic publication and authentication lifecycle')


if __name__ == '__main__':
    main()
