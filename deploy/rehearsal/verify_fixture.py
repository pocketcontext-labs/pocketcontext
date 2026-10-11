#!/usr/bin/env python3
"""Verify synthetic old application rows and protected originals over HTTP."""
import argparse
import hashlib
import json
import secrets
import urllib.error
from pathlib import Path
import urllib.parse
import urllib.request


def verify(url, fixture, migrated=False, personal_probe=False, rollback=False):
    config = json.loads((fixture / 'clone.private.json').read_text())
    expected = json.loads((fixture / 'expected.private.json').read_text())
    hostname = urllib.parse.urlparse(config['clone_url']).netloc
    def request(path, body=None, token=None, method=None):
        headers = {'Host': hostname, 'Content-Type': 'application/json'}
        if token: headers['Authorization'] = token
        call = urllib.request.Request(url.rstrip('/') + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        with urllib.request.urlopen(call, timeout=30) as response: return response.read()
    user = config['test_users'][0]
    token = json.loads(request('/api/collections/users/auth-with-password', {'identity': user['email'], 'password': user['password']}))['token']
    for table, snapshot in expected['snapshot'].items():
        columns = snapshot['columns']
        quoted = ','.join('"' + column.replace('"', '""') + '"' for column in columns)
        actual = json.loads(request('/api/context/query', {'sql': f'SELECT {quoted} FROM {table} ORDER BY id'}, token))
        # Later synthetic PITR evidence may add records: every historical row must
        # remain exact, while additions are tested separately by the PITR helper.
        assert not actual['truncated'] and actual['columns'] == columns, 'snapshot shape changed'
        by_id = {row[columns.index('id')]: row for row in actual['rows']}
        assert all(by_id.get(row[columns.index('id')]) == row for row in snapshot['rows']), 'historical domain row changed: ' + table
    source = expected['source']
    file_token = json.loads(request('/api/files/token', {}, token))['token']
    blob = request('/api/files/' + source['collectionId'] + '/' + source['id'] + '/' + urllib.parse.quote(source['original']) + '?token=' + urllib.parse.quote(file_token))
    assert hashlib.sha256(blob).hexdigest() == expected['original_sha256'], 'protected original changed'
    if migrated:
        spaces = json.loads(request('/api/context/query', {'sql': "SELECT space, role, active FROM space_members WHERE account='" + expected['user'] + "'"}, token))
        assert ['companyspace001', 'editor', True] in spaces['rows'] or ['companyspace001', 'editor', 1] in spaces['rows'], 'company membership absent'
    if personal_probe:
        assert migrated, 'personal probe requires migrated server'
        before = json.loads(request('/api/context/query', {'sql': "SELECT id FROM spaces WHERE kind='personal'"}, token))
        assert before['rows'] == [], 'personal space existed before explicit request'
        personal = json.loads(request('/api/wiki/spaces/personal', {}, token))['id']
        assert json.loads(request('/api/wiki/spaces/personal', {}, token))['id'] == personal
        page = json.loads(request('/api/collections/pages/records', {'slug': 'synthetic-private-' + secrets.token_hex(4), 'kind': 'concept', 'space': personal}, token))
        operator = json.loads(request('/api/collections/_superusers/auth-with-password', {'identity': config['operator_email'], 'password': config['operator_password']}))['token']
        password = secrets.token_urlsafe(32)
        email = 'synthetic-peer-' + secrets.token_hex(4) + '@example.test'
        json.loads(request('/api/collections/users/records', {'email': email, 'name': 'Synthetic peer', 'password': password, 'passwordConfirm': password}, operator))
        peer = json.loads(request('/api/collections/users/auth-with-password', {'identity': email, 'password': password}))['token']
        hidden = json.loads(request('/api/context/query', {'sql': "SELECT id FROM pages WHERE id='" + page['id'] + "'"}, peer))
        assert hidden['rows'] == [], 'personal page leaked through SQL'
        try:
            request('/api/collections/pages/records/' + page['id'], token=peer)
            raise AssertionError('personal page leaked through REST')
        except urllib.error.HTTPError as error:
            assert error.code in (403, 404)
        boundary = 'synthetic-private-evidence'
        original = b'Synthetic private pearl evidence.\n'
        payload = b''
        for key, value in {'title': 'Private pearl evidence', 'original_name': 'private.txt', 'media_type': 'text/plain', 'space': personal}.items():
            payload += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        payload += f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="private.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode() + original + f'\r\n--{boundary}--\r\n'.encode()
        upload = urllib.request.Request(url.rstrip('/') + '/api/collections/sources/records', data=payload, headers={'Host': hostname, 'Authorization': token, 'Content-Type': 'multipart/form-data; boundary=' + boundary})
        with urllib.request.urlopen(upload, timeout=30) as response: private_source = json.load(response)
        def create(table, body): return json.loads(request('/api/collections/' + table + '/records', body, token))
        rendition = create('renditions', {'source': private_source['id'], 'kind': 'text', 'processor': 'synthetic', 'version_label': 'v1'})
        passage = create('passages', {'rendition': rendition['id'], 'ordinal': 1, 'locator': 'document', 'body': original.decode()})
        run = create('ingestion_runs', {'key': 'synthetic-private-' + secrets.token_hex(4), 'space': personal, 'description': 'Synthetic private publication', 'status': 'staging', 'sources': [private_source['id']]})
        revision = create('page_revisions', {'run': run['id'], 'page': page['id'], 'title': 'Private pearl', 'summary': 'Private evidence', 'body': 'Private pearl evidence.[^1]'})
        create('citations', {'page_revision': revision['id'], 'passage': passage['id'], 'marker': '1'})
        request('/api/collections/ingestion_runs/records/' + run['id'], {'status': 'published', 'expected_revision': run['revision']}, token, 'PATCH')
        publications = json.loads(request('/api/context/query', {'sql': "SELECT id FROM publications WHERE space='" + personal + "'"}, token))
        publication = publications['rows'][0][0]
        search = {'index': 'pages', 'scope': publication, 'query': 'pearl'}
        assert json.loads(request('/api/context/search', search, token))['hits'], 'owner private search empty'
        peer_file = json.loads(request('/api/files/token', {}, peer))['token']
        owner_file = json.loads(request('/api/files/token', {}, token))['token']
        file_path = '/api/files/sources/' + private_source['id'] + '/' + private_source['original'] + '?token='
        assert request(file_path + owner_file) == original
        for path, body, bearer in [('/api/context/search', search, peer), (file_path + peer_file, None, None), ('/api/collections/sources/records/' + private_source['id'], None, peer), ('/api/collections/publications/records/' + publication, None, peer)]:
            try:
                request(path, body, bearer)
                raise AssertionError('private evidence accessible to outsider')
            except urllib.error.HTTPError as error: assert error.code in (400, 403, 404)
        for table, identity in [('sources', private_source['id']), ('publications', publication)]:
            assert json.loads(request('/api/context/query', {'sql': "SELECT id FROM " + table + " WHERE id='" + identity + "'"}, peer))['rows'] == []
        default = json.loads(request('/api/collections/pages/records', {'slug': 'synthetic-company-' + secrets.token_hex(4), 'kind': 'concept'}, peer))
        assert default['space'] == 'companyspace001', 'root write did not default to company'
    if personal_probe:
        verify(url, fixture, migrated=True, personal_probe=False)
    if rollback:
        for sql in ["SELECT id FROM pages WHERE (slug LIKE 'synthetic-private-%' OR slug LIKE 'synthetic-company-%') AND id!='" + expected['page'] + "'", "SELECT id FROM sources WHERE title='Private pearl evidence'"]:
            assert json.loads(request('/api/context/query', {'sql': sql}, token))['rows'] == [], 'candidate-only rows survived rollback'
        try:
            request('/api/context/query', {'sql': 'SELECT id FROM spaces'}, token)
            raise AssertionError('candidate spaces schema survived rollback')
        except urllib.error.HTTPError as error: assert error.code == 400

    return {'historical_tables_verified': len(expected['snapshot']), 'protected_original_exact': True, 'company_membership_checked': migrated, 'personal_boundary_checked': personal_probe, 'rollback_candidate_rows_absent': rollback}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--migrated', action='store_true')
    parser.add_argument('--personal-probe', action='store_true', help='Create synthetic personal and company pages plus a peer account')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    print(json.dumps(verify(args.url, args.fixture, args.migrated, args.personal_probe, args.rollback)))

if __name__ == '__main__': main()
