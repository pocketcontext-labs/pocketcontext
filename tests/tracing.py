#!/usr/bin/env python3
"""Verify opt-in request tracing and retrieval isolation using synthetic users."""
import argparse
import json
import urllib.error
import urllib.request
from integration import server, ROOT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    with server(args.binary) as request:
        admin = request('POST', '/api/collections/_superusers/auth-with-password',
                        {'identity': 'admin@example.com', 'password': 'SyntheticAdminPassword123!'})['token']
        users = []
        for index in range(2):
            email = f'trace{index}@example.com'
            user = request('POST', '/api/collections/users/records', {
                'email': email, 'name': f'Trace user {index}',
                'password': 'SyntheticUserPassword123!', 'passwordConfirm': 'SyntheticUserPassword123!'}, admin)
            token = request('POST', '/api/collections/users/auth-with-password',
                            {'identity': email, 'password': 'SyntheticUserPassword123!'})['token']
            users.append((user, token))
        user, token = users[0]

        def call(method, path, body=None, auth=token, extra=None):
            headers = {'Content-Type': 'application/json'}
            if auth:
                headers['Authorization'] = auth
            headers.update(extra or {})
            req = urllib.request.Request(request.base_url + path, method=method, headers=headers,
                                         data=None if body is None else json.dumps(body).encode())
            try:
                response = urllib.request.urlopen(req, timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                raw = response.read()
                return response.code, response.headers, json.loads(raw) if raw else None

        sql = 'SELECT id FROM user_directory LIMIT 5'
        status, headers, baseline = call('POST', '/api/context/query', {'sql': sql})
        assert status == 200 and 'X-Context-Request-Id' not in headers
        for capture in (False, True):
            extra = {'X-Context-Trace': '1', 'X-Context-Correlation-Id': 'synthetic-operation'}
            if capture:
                extra['X-Context-Capture-Sql'] = '1'
            status, headers, body = call('POST', '/api/context/query', {'sql': sql}, extra=extra)
            assert status == 200 and body == baseline
            path = '/api/context/traces/' + headers['X-Context-Request-Id']
            status, retrieval_headers, trace = call('GET', path, extra=extra)
            assert status == 200 and retrieval_headers['Cache-Control'] == 'no-store'
            assert 'X-Context-Request-Id' not in retrieval_headers
            assert trace['service'] == 'wikicontext' and trace['user_id'] == user['id']
            assert trace['correlation_id'] == 'synthetic-operation' and len(trace['spans']) >= 4
            assert trace.get('sql', '') == (sql if capture else '')
            assert call('GET', path, auth=users[1][1])[0] == 404
            assert call('GET', path, auth='')[0] in (401, 403)
            assert call('GET', path, auth=admin)[0] in (401, 403)
            assert token not in json.dumps(trace)
        # REST traces exclude response values and query strings.
        status, headers, body = call('GET', '/api/collections/spaces/records?perPage=1', extra={'X-Context-Trace': '1'})
        assert status == 200 and body['items'][0]['name'] == 'Company'
        trace = call('GET', '/api/context/traces/' + headers['X-Context-Request-Id'])[2]
        assert '?' not in trace['route'] and 'Company' not in json.dumps(trace)
        # Application revocation also revokes trace retrieval.
        path = '/api/context/traces/' + headers['X-Context-Request-Id']
        request('PATCH', '/api/collections/users/records/' + user['id'], {'disabled': True}, admin)
        assert call('GET', path)[0] == 401
    print('PASS opt-out, SQL opt-in, source ownership, REST redaction and revocation')


if __name__ == '__main__':
    main()
