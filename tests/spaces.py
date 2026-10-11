#!/usr/bin/env python3
"""Space isolation through SQL, REST, realtime, protected files and publication."""
import argparse
import json
import queue
import secrets
import threading
import urllib.error
import urllib.request

from integration import SEARCH, server

ADMIN = {'identity': 'admin@example.com', 'password': 'SyntheticAdminPassword123!'}
PASSWORD = 'SyntheticSpacesPassword123!'
FIXTURES = '''
routerAdd('POST', '/api/test/ensure-personal/{id}', (e) => {
  return e.json(200, {id: require(`${__hooks}/spaces.js`).ensurePersonalSpace(e.app, e.request.pathValue('id'))});
}, $apis.requireSuperuserAuth());
routerAdd('POST', '/api/test/group-functions', (e) => {
  const spaces = require(`${__hooks}/spaces.js`);
  const body = e.requestInfo().body;
  if (body.op === 'create') return e.json(200, {id: spaces.createGroupSpace(e.app, body.actor, body.name)});
  return e.json(200, spaces.setMembership(e.app, body.actor, body.space, body.account, body.role, body.active, body.expected_revision));
}, $apis.requireSuperuserAuth());
'''


class Listener:
    """One SSE connection; events are queued for assertions."""
    def __init__(self, request, token, subscriptions):
        self.messages = queue.Queue()
        threading.Thread(target=self.listen, args=(request.base_url,), daemon=True).start()
        event, data = self.messages.get(timeout=5)
        assert event == 'PB_CONNECT', (event, data)
        self.client = data['clientId']
        request('POST', '/api/realtime', {'clientId': self.client, 'subscriptions': subscriptions}, token, expected=204)

    def listen(self, base):
        try:
            with urllib.request.urlopen(base + '/api/realtime', timeout=30) as response:
                event, data = '', ''
                for raw in response:
                    line = raw.decode().strip()
                    if line.startswith('event:'):
                        event = line[6:].strip()
                    elif line.startswith('data:'):
                        data = line[5:].strip()
                    elif not line and event:
                        self.messages.put((event, json.loads(data)))
                        event, data = '', ''
        except Exception as error:  # Surface transport failures to the waiting assertion.
            self.messages.put(('error', repr(error)))

    def events(self, wait=0.75):
        found = []
        try:
            while True:
                found.append(self.messages.get(timeout=wait))
        except queue.Empty:
            return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    with server(args.binary, FIXTURES) as request:
        admin = request('POST', '/api/collections/_superusers/auth-with-password', ADMIN)['token']

        def account(name, disabled=False):
            email = name + '@example.test'
            user = request('POST', '/api/collections/users/records', {
                'email': email, 'name': 'Synthetic ' + name, 'password': PASSWORD, 'passwordConfirm': PASSWORD,
                'disabled': disabled}, admin)
            if disabled:
                return user, None
            token = request('POST', '/api/collections/users/auth-with-password', {'identity': email, 'password': PASSWORD})['token']
            return user, token

        def rows(token, sql):
            result = request('POST', '/api/context/query', {'sql': sql}, token)
            assert not result['truncated']
            return [dict(zip(result['columns'], row)) for row in result['rows']]

        def personal(token):
            found = rows(token, "SELECT id FROM spaces WHERE kind = 'personal'")
            assert len(found) == 1, found
            return found[0]['id']

        def records(table, record=''):
            return '/api/collections/' + table + '/records' + ('/' + record if record else '')

        def create(token, table, body, expected=200):
            return request('POST', records(table), body, token, expected)

        def upload(token, space, content):
            boundary = 'spaces-' + secrets.token_hex(8)
            parts = b''
            for name, value in {'space': space, 'title': 'Synthetic evidence', 'original_name': 'evidence.txt', 'media_type': 'text/plain'}.items():
                parts += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            parts += f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode()
            parts += content + f'\r\n--{boundary}--\r\n'.encode()
            req = urllib.request.Request(request.base_url + records('sources'), data=parts, method='POST', headers={
                'Authorization': token, 'Content-Type': 'multipart/form-data; boundary=' + boundary})
            try:
                with urllib.request.urlopen(req, timeout=20) as response:
                    return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                return error.code, json.loads(error.read() or b'null')

        def evidence(token, space, content):
            status, source = upload(token, space, content)
            assert status == 200, (status, source)
            rendition = create(token, 'renditions', {'source': source['id'], 'kind': 'text', 'processor': 'synthetic', 'version_label': 'v1'})
            passage = create(token, 'passages', {'rendition': rendition['id'], 'ordinal': 1, 'locator': 'document', 'body': content.decode()})
            return source, rendition, passage

        def run(token, space, key, **extra):
            return create(token, 'ingestion_runs', dict(space=space, key=key, status='staging', description='Synthetic ' + key, **extra))

        def page(token, space, slug):
            return create(token, 'pages', {'space': space, 'slug': slug, 'kind': 'concept'})

        def revision(token, staged, target, base='', body='Synthetic claim [needs verification].', expected=200, **extra):
            return create(token, 'page_revisions', dict(run=staged['id'], page=target['id'], base_revision=base,
                          title=target['slug'], summary='Synthetic summary', body=body, **extra), expected)

        def publish(token, staged, expected=200):
            return request('PATCH', records('ingestion_runs', staged['id']), {'expected_revision': staged['revision'], 'status': 'published'}, token, expected)

        def manifest(token, space):
            found = rows(token, f"SELECT sequence, manifest FROM publications WHERE space = '{space}' ORDER BY sequence DESC LIMIT 1")
            return found[0]['sequence'], json.loads(found[0]['manifest']) if isinstance(found[0]['manifest'], str) else found[0]['manifest']

        def same_not_found(token, method, path, body, foreign_id, missing_id='missing00000000'):
            """A foreign record and an absent one produce identical responses."""
            foreign = request(method, path.replace('{id}', foreign_id), json.loads(json.dumps(body).replace('{id}', foreign_id)), token, (400, 403, 404))
            absent = request(method, path.replace('{id}', missing_id), json.loads(json.dumps(body).replace('{id}', missing_id)), token, (400, 403, 404))
            assert foreign == absent, (path, foreign, absent)

        alice, a = account('alice')
        bob, b = account('bob')
        carol, c = account('carol')
        dave, d = account('dave')
        ghost, _ = account('ghost', disabled=True)

        # Company access is the default; personal spaces require an explicit request.
        assert not rows(a, "SELECT id FROM spaces WHERE kind = 'personal'")
        default_page = create(a, 'pages', {'slug': 'company-default', 'kind': 'concept'})
        assert default_page['space'] == 'companyspace001'
        assert rows(b, "SELECT id FROM pages WHERE slug = 'company-default'") == [{'id': default_page['id']}]
        for user, token in [(alice, a), (bob, b), (carol, c), (dave, d)]:
            first = request('POST', '/api/wiki/spaces/personal', {}, token)
            assert request('POST', '/api/wiki/spaces/personal', {}, token) == first
            member = rows(token, "SELECT id, revision FROM space_members WHERE space = 'companyspace001' AND account = '%s'" % user['id'])[0]
            request('PATCH', records('space_members', member['id']), {'active': False, 'expected_revision': member['revision']}, admin)
            request('POST', '/api/collections/users/auth-refresh', {}, token)
            assert not rows(token, "SELECT id FROM spaces WHERE id = 'companyspace001'")
        request('POST', '/api/wiki/spaces/personal', {}, expected=(401, 403))
        # Personal spaces are idempotent and never created for disabled accounts.
        pa, pb = personal(a), personal(b)
        assert pa != pb
        assert request('POST', '/api/test/ensure-personal/' + alice['id'], {}, admin)['id'] == pa
        assert request('POST', '/api/test/ensure-personal/' + alice['id'], {}, admin)['id'] == pa
        request('POST', '/api/test/ensure-personal/' + ghost['id'], {}, admin, (400, 403, 500))
        assert not request('GET', records('spaces') + '?filter=' + urllib.request.quote(f"created_by='{ghost['id']}'"), token=admin)['items']
        assert [r['role'] for r in rows(a, f"SELECT role FROM space_members WHERE space = '{pa}'")] == ['owner']

        # Alice's personal knowledge.
        a_source, a_rendition, a_passage = evidence(a, pa, b'Alice private synthetic evidence.\n')
        a_page = page(a, pa, 'shared-slug')
        a_run = run(a, pa, 'shared-key', sources=[a_source['id']])
        a_rev = revision(a, a_run, a_page, body='Alice private claim.[^1]')
        create(a, 'citations', {'page_revision': a_rev['id'], 'passage': a_passage['id'], 'marker': '1'})
        create(a, 'page_links', {'page_revision': a_rev['id'], 'target': a_page['id']})
        a_listener = Listener(request, a, ['publications/*', 'pages/*'])
        b_listener = Listener(request, b, ['publications/*', 'pages/*', 'pages/' + a_page['id'], 'ingestion_runs/' + a_run['id']])
        publish(a, a_run)
        a_pub = rows(a, f"SELECT id, sequence FROM publications WHERE space = '{pa}'")[0]
        assert a_pub['sequence'] == 1
        assert any(event.startswith('publications/') for event, _ in a_listener.events())
        assert not b_listener.events(), 'Realtime leaked a foreign publication'

        # Bob sees nothing of Alice's space through SQL.
        tables = ['spaces', 'space_members', 'sources', 'renditions', 'passages', 'ingestion_runs', 'pages',
                  'page_revisions', 'citations', 'page_links', 'publications', 'audit_log']
        for table in tables:
            column = 'id' if table == 'spaces' else 'space'
            assert rows(b, f"SELECT count(*) AS n FROM {table} WHERE {column} = '{pa}'") == [{'n': 0}], table
            assert rows(a, f"SELECT count(*) AS n FROM {table} WHERE {column} = '{pb}'") == [{'n': 0}], table
        assert rows(b, 'SELECT count(*) AS n FROM sources') == [{'n': 0}]
        assert rows(b, 'SELECT id FROM user_directory') == [{'id': bob['id']}]
        assert rows(a, 'SELECT id FROM user_directory') == [{'id': alice['id']}]
        request('GET', records('user_directory'), token=a, expected=403)
        request('GET', records('user_directory', alice['id']), token=a, expected=(403, 404))

        # REST list/view/update and protected files.
        for table, record in [('spaces', pa), ('sources', a_source['id']), ('renditions', a_rendition['id']), ('passages', a_passage['id']),
                              ('ingestion_runs', a_run['id']), ('pages', a_page['id']), ('page_revisions', a_rev['id']),
                              ('publications', a_pub['id'])]:
            assert request('GET', records(table), token=b)['totalItems'] == (1 if table == 'spaces' else 0), table
            request('GET', records(table, record), token=b, expected=404)
            assert request('GET', records(table, record), token=a)['id'] == record
        assert request('GET', records('audit_log'), token=b)['totalItems'] == len(rows(b, 'SELECT id FROM audit_log'))
        request('PATCH', records('ingestion_runs', a_run['id']), {'expected_revision': 2, 'description': 'Hijack'}, b, 404)
        b_file_token = request('POST', '/api/files/token', {}, b)['token']
        a_file_token = request('POST', '/api/files/token', {}, a)['token']
        file_path = '/api/files/sources/' + a_source['id'] + '/' + a_source['original'] + '?token='
        request('GET', file_path + b_file_token, expected=404)
        with urllib.request.urlopen(request.base_url + file_path + a_file_token, timeout=20) as response:
            assert response.read() == b'Alice private synthetic evidence.\n'
        if SEARCH:
            request('POST', '/api/context/search', {'index': 'pages', 'scope': a_pub['id'], 'query': 'Alice'}, b, (400, 403, 404))
            hits = request('POST', '/api/context/search', {'index': 'pages', 'scope': a_pub['id'], 'query': 'Alice'}, a)['hits']
            assert [hit['id'] for hit in hits] == [a_rev['id']]

        # Foreign and absent references are indistinguishable, at every entry point.
        b_run = run(b, pb, 'shared-key')
        b_page = page(b, pb, 'shared-slug')
        b_source, _, b_passage = evidence(b, pb, b'Alice private synthetic evidence.\n')
        assert b_source['sha256'] == rows(a, f"SELECT sha256 FROM sources WHERE id = '{a_source['id']}'")[0]['sha256']
        b_rev = revision(b, b_run, b_page)
        same_not_found(b, 'POST', records('pages'), {'space': '{id}', 'slug': 'intrude', 'kind': 'concept'}, pa)
        same_not_found(b, 'POST', records('ingestion_runs'), {'space': '{id}', 'key': 'intrude', 'status': 'staging', 'description': 'x'}, pa)
        same_not_found(b, 'POST', records('renditions'), {'source': '{id}', 'kind': 'text', 'processor': 'x', 'version_label': 'v9'}, a_source['id'])
        same_not_found(b, 'POST', records('passages'), {'rendition': '{id}', 'ordinal': 9, 'locator': 'x', 'body': 'x'}, a_rendition['id'])
        same_not_found(b, 'POST', records('page_revisions'), {'run': b_run['id'], 'page': '{id}', 'title': 'x', 'summary': 'x', 'body': 'x [needs verification]'}, a_page['id'])
        same_not_found(b, 'POST', records('page_revisions'), {'run': '{id}', 'page': b_page['id'], 'title': 'x', 'summary': 'x', 'body': 'x [needs verification]'}, a_run['id'])
        same_not_found(b, 'POST', records('page_revisions'), {'run': b_run['id'], 'page': b_page['id'], 'base_revision': '{id}', 'title': 'x', 'summary': 'x', 'body': 'x [needs verification]'}, a_rev['id'])
        same_not_found(b, 'POST', records('citations'), {'page_revision': b_rev['id'], 'passage': '{id}', 'marker': '1'}, a_passage['id'])
        same_not_found(b, 'POST', records('citations'), {'page_revision': '{id}', 'passage': b_passage['id'], 'marker': '1'}, a_rev['id'])
        same_not_found(b, 'POST', records('page_links'), {'page_revision': b_rev['id'], 'target': '{id}'}, a_page['id'])
        same_not_found(b, 'POST', records('ingestion_runs'), {'space': pb, 'key': 'foreign-source', 'status': 'staging', 'description': 'x', 'sources': ['{id}']}, a_source['id'])
        same_not_found(b, 'POST', records('ingestion_runs'), {'space': pb, 'key': 'foreign-home', 'status': 'staging', 'description': 'x', 'home': '{id}'}, a_page['id'])
        same_not_found(b, 'PATCH', records('ingestion_runs', b_run['id']), {'expected_revision': 1, 'home': '{id}'}, a_page['id'])
        same_not_found(b, 'PATCH', records('ingestion_runs', '{id}'), {'expected_revision': 1, 'description': 'x'}, a_run['id'])
        status_foreign, foreign = upload(b, pa, b'Intrusion')
        status_absent, absent = upload(b, 'missing00000000', b'Intrusion')
        assert status_foreign == status_absent == 404 and foreign == absent, (foreign, absent)
        # A child may not claim a space different from its parent's.
        create(b, 'page_links', {'space': pa, 'page_revision': b_rev['id'], 'target': b_page['id']}, expected=404)
        # Per-space uniqueness: Bob reused Alice's slug, run key and original bytes; sequence restarts.
        create(b, 'pages', {'space': pb, 'slug': 'shared-slug', 'kind': 'concept'}, expected=400)
        publish(b, b_run)
        assert manifest(b, pb)[0] == 1 and manifest(a, pa)[0] == 1
        assert not a_listener.events(), 'Realtime leaked a foreign publication'

        # Group space fixture: superuser-managed, ordinary REST management rejected.
        for token in (a, b):
            create(token, 'spaces', {'kind': 'group', 'name': 'Forbidden'}, expected=403)
            create(token, 'space_members', {'space': pa, 'account': bob['id'], 'role': 'reader'}, expected=403)
            own = rows(token, 'SELECT id FROM space_members')[0]['id']
            request('PATCH', records('space_members', own), {'expected_revision': 1, 'role': 'reader'}, token, (403, 404))
            request('DELETE', records('space_members', own), token=token, expected=(403, 404))
            request('DELETE', records('spaces', personal(token)), token=token, expected=(403, 404))
        create(admin, 'spaces', {'kind': 'personal', 'name': 'Forged'}, expected=400)
        create(admin, 'space_members', {'space': pa, 'account': bob['id'], 'role': 'reader'}, expected=400)
        group = create(admin, 'spaces', {'kind': 'group', 'name': 'Synthetic team'})
        g = group['id']
        create(admin, 'space_members', {'space': g, 'account': carol['id'], 'role': 'editor'}, expected=400)  # owner first
        create(admin, 'space_members', {'space': g, 'account': alice['id'], 'role': 'owner'})
        carol_membership = create(admin, 'space_members', {'space': g, 'account': carol['id'], 'role': 'editor'})
        create(admin, 'space_members', {'space': g, 'account': dave['id'], 'role': 'reader'})
        create(admin, 'space_members', {'space': g, 'account': ghost['id'], 'role': 'reader'}, expected=403)
        create(admin, 'space_members', {'space': g, 'account': dave['id'], 'role': 'editor'}, expected=400)
        assert {r['id'] for r in rows(a, 'SELECT id FROM user_directory')} == {alice['id'], carol['id'], dave['id']}
        assert {r['id'] for r in rows(d, 'SELECT id FROM user_directory')} == {alice['id'], carol['id'], dave['id']}
        assert rows(b, 'SELECT id FROM user_directory') == [{'id': bob['id']}]
        assert rows(b, f"SELECT count(*) AS n FROM spaces WHERE id = '{g}'") == [{'n': 0}]
        assert {(r['kind'], r['role']) for r in rows(d, "SELECT s.kind, m.role FROM spaces s JOIN space_members m ON m.space = s.id WHERE m.account = '%s'" % dave['id'])} == {('personal', 'owner'), ('group', 'reader')}

        g_listener = Listener(request, c, ['publications/*'])
        g_page = page(c, g, 'shared-slug')
        g_source, _, g_passage = evidence(c, g, b'Alice private synthetic evidence.\n')
        g_run = run(c, g, 'shared-key')
        g_rev = revision(c, g_run, g_page)
        # Readers can read but not write; outsiders cannot see.
        create(d, 'pages', {'space': g, 'slug': 'reader-page', 'kind': 'concept'}, expected=403)
        create(d, 'page_links', {'page_revision': g_rev['id'], 'target': g_page['id']}, expected=403)
        request('PATCH', records('ingestion_runs', g_run['id']), {'expected_revision': 1, 'status': 'cancelled'}, d, 403)
        assert request('GET', records('pages', g_page['id']), token=d)['slug'] == 'shared-slug'
        request('GET', records('pages', g_page['id']), token=b, expected=404)
        # Cross-space references from Alice's personal space into the group are rejected.
        a_cross = run(a, pa, 'cross-space')
        a_cross_rev = revision(a, a_cross, a_page, a_rev['id'], body='Cross [needs verification].')
        create(a, 'page_links', {'page_revision': a_cross_rev['id'], 'target': g_page['id']}, expected=404)
        create(a, 'citations', {'page_revision': a_cross_rev['id'], 'passage': g_passage['id'], 'marker': '1'}, expected=404)
        revision(a, a_cross, g_page, expected=404)
        revision(a, g_run, a_page, expected=404)
        create(a, 'sources', {'space': pa, 'title': 'x', 'original_name': 'x.txt', 'media_type': 'text/plain', 'supersedes': g_source['id']}, expected=404)
        create(a, 'ingestion_runs', {'space': pa, 'key': 'cross-home', 'status': 'staging', 'description': 'x', 'home': g_page['id']}, expected=404)
        revision(a, a_cross, page(a, pa, 'exact-copy'), body='[needs verification]', expected=404,
                 properties={'catalog_type': 'repository_document', 'document_type': 'license', 'output_mode': 'exact_copy', 'source_id': g_source['id']})
        # Relationship properties cannot name another space's pages at publication.
        related = revision(a, a_cross, page(a, pa, 'resource'), body='[needs verification]',
                           properties={'catalog_type': 'resource', 'resources': [g_page['id']]})
        publish(a, a_cross, 400)
        # Publication conflicts and sequences are per space.
        publish(c, g_run)
        assert manifest(a, g) == (1, {g_page['id']: g_rev['id']})
        assert manifest(a, pa)[0] == 1
        assert any(event.startswith('publications/') for event, _ in g_listener.events())
        stale_left, stale_right = run(a, g, 'left'), run(c, g, 'right')
        revision(a, stale_left, g_page, g_rev['id'])
        revision(c, stale_right, g_page, g_rev['id'])
        a_next = run(a, pa, 'unrelated')
        revision(a, a_next, a_page, a_rev['id'])
        publish(a, stale_left)
        publish(a, a_next)  # Unaffected by the group's newer publication.
        publish(c, stale_right, 409)
        assert manifest(a, g)[0] == 2 and manifest(a, pa)[0] == 2

        # Deactivation takes effect on the next request, including realtime and files.
        c_file = request('POST', '/api/files/token', {}, c)['token']
        g_file = '/api/files/sources/' + g_source['id'] + '/' + g_source['original'] + '?token='
        with urllib.request.urlopen(request.base_url + g_file + c_file, timeout=20) as response:
            assert response.status == 200
        request('PATCH', records('space_members', carol_membership['id']), {'expected_revision': 1, 'active': False}, admin)
        assert rows(c, f"SELECT count(*) AS n FROM pages WHERE space = '{g}'") == [{'n': 0}]
        request('GET', records('pages', g_page['id']), token=c, expected=404)
        request('GET', g_file + c_file, expected=404)
        create(c, 'pages', {'space': g, 'slug': 'after-revocation', 'kind': 'concept'}, expected=404)
        assert {r['id'] for r in rows(a, 'SELECT id FROM user_directory')} == {alice['id'], dave['id']}
        assert rows(c, 'SELECT id FROM user_directory') == [{'id': carol['id']}]
        g_listener.events()
        after = run(a, g, 'after-revocation')
        revision(a, after, g_page, manifest(a, g)[1][g_page['id']])
        publish(a, after)
        assert not g_listener.events(), 'Deactivated member received a realtime event'
        # The last active owner cannot be removed; stale membership updates conflict.
        owner_row = rows(a, f"SELECT id, revision FROM space_members WHERE space = '{g}' AND account = '{alice['id']}'")[0]
        request('PATCH', records('space_members', owner_row['id']), {'expected_revision': owner_row['revision'], 'role': 'editor'}, admin, 400)
        request('PATCH', records('space_members', carol_membership['id']), {'expected_revision': 1, 'active': True}, admin, 409)
        request('PATCH', records('space_members', carol_membership['id']), {'expected_revision': 2, 'account': bob['id']}, admin, 400)
        request('PATCH', records('space_members', carol_membership['id']), {'expected_revision': 2, 'active': True}, admin)
        assert rows(c, f"SELECT count(*) AS n FROM pages WHERE space = '{g}'") == [{'n': 1}]

        # Guarded enablement functions: only active owners manage group membership.
        created = request('POST', '/api/test/group-functions', {'op': 'create', 'actor': bob['id'], 'name': 'Bob team'}, admin)['id']
        assert rows(b, f"SELECT role FROM space_members WHERE space = '{created}'") == [{'role': 'owner'}]
        request('POST', '/api/test/group-functions', {'op': 'member', 'actor': alice['id'], 'space': created, 'account': alice['id'], 'role': 'owner', 'active': True}, admin, 404)
        request('POST', '/api/test/group-functions', {'op': 'member', 'actor': bob['id'], 'space': pa, 'account': bob['id'], 'role': 'owner', 'active': True}, admin, 404)
        added = request('POST', '/api/test/group-functions', {'op': 'member', 'actor': bob['id'], 'space': created, 'account': dave['id'], 'role': 'reader', 'active': True}, admin)
        request('POST', '/api/test/group-functions', {'op': 'member', 'actor': dave['id'], 'space': created, 'account': carol['id'], 'role': 'reader', 'active': True}, admin, 403)
        assert added['revision'] == 1 and rows(d, f"SELECT count(*) AS n FROM spaces WHERE id = '{created}'") == [{'n': 1}]
        assert related['space'] == pa and g_rev['space'] == g and a_rev['space'] == pa
    print('PASS: personal/group space isolation across SQL, REST, realtime, files and directory; cross-space references; per-space uniqueness and publication; reader/deactivation rules')


if __name__ == '__main__':
    main()
