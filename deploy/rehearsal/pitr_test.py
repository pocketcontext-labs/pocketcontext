#!/usr/bin/env python3
"""Synthetic timestamp/TXID restore checks inside an isolated local ONCE engine."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import time
import urllib.request
from local_once import Engine


def exercise(engine, container, host, email, password):
    base = 'http://127.0.0.1:' + str(engine.inspect()['http_port'])
    token = ''
    def request(path, body=None, content_type='application/json'):
        data = json.dumps(body).encode() if body is not None and content_type == 'application/json' else body
        headers = {'Host': host, 'Content-Type': content_type}
        if token: headers['Authorization'] = token
        with urllib.request.urlopen(urllib.request.Request(base + path, data=data, headers=headers), timeout=30) as response:
            result = response.read()
        return json.loads(result) if path.startswith('/api/collections/') or path == '/api/files/token' else result
    token = request('/api/collections/users/auth-with-password', {'identity': email, 'password': password})['token']
    def source(label):
        boundary = 'pitr-' + secrets.token_hex(16)
        evidence = ('Synthetic ONCE PITR ' + label + ' ' + secrets.token_hex(16)).encode()
        fields = {'space': 'companyspace001', 'title': 'Synthetic PITR ' + label, 'original_name': label + '.txt', 'media_type': 'text/plain'}
        body = bytearray()
        for key, value in fields.items():
            body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="{label}.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode())
        body.extend(evidence); body.extend(f'\r\n--{boundary}--\r\n'.encode())
        record = request('/api/collections/sources/records', bytes(body), 'multipart/form-data; boundary=' + boundary)
        return record, evidence
    def litestream(*args):
        return engine.docker('exec', container, 'litestream', *args)
    def sync():
        litestream('sync', '-wait', '-timeout', '60', '-socket', '/run/litestream.sock', '/storage/pb_data/data.db')
    early, early_bytes = source('before-boundary')
    sync()
    files = json.loads(litestream('ltx', '-json', '-level', 'all', '-config', '/etc/litestream.yml', '/storage/pb_data/data.db'))
    txid = max(item['max_txid'] for item in files)
    # v0.5.17 selects files strictly before the RFC3339 boundary.
    time.sleep(1.2)
    boundary = datetime.now(timezone.utc).replace(microsecond=0)
    time.sleep(1.2)
    late, late_bytes = source('after-boundary')
    sync()
    marker = '/tmp/wiki-pitr-' + secrets.token_hex(12)
    results = {}
    try:
        for label, options, expected in (
            ('txid', ['-txid', txid], [early['id']]),
            ('timestamp', ['-timestamp', boundary.isoformat().replace('+00:00', 'Z')], [early['id']]),
            ('latest', [], sorted([early['id'], late['id']])),
        ):
            output = marker + '-' + label + '.db'
            litestream('restore', '-config', '/etc/litestream.yml', '-integrity-check', 'full', '-o', output, *options, '/storage/pb_data/data.db')
            code = "import sqlite3,json,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);assert c.execute('PRAGMA integrity_check').fetchall()==[('ok',)];print(json.dumps([r[0] for r in c.execute('SELECT id FROM sources WHERE id IN (?,?) ORDER BY id',sys.argv[2:])]))"
            found = json.loads(engine.docker('exec', container, 'python3', '-c', code, output, early['id'], late['id']))
            if found != expected: raise RuntimeError('PITR boundary source-set mismatch: ' + label)
            results[label] = {'integrity': 'ok', 'before_present': early['id'] in found, 'after_present': late['id'] in found}
        file_token = request('/api/files/token', {})['token']
        for record, evidence in ((early, early_bytes), (late, late_bytes)):
            actual = request('/api/files/' + record['collectionId'] + '/' + record['id'] + '/' + record['original'] + '?token=' + file_token)
            if hashlib.sha256(actual).digest() != hashlib.sha256(evidence).digest(): raise RuntimeError('Retained original bytes mismatch')
        return {'version': 1, 'synthetic_only': True, 'boundary_txid': txid, 'boundary_timestamp': boundary.isoformat(), 'restores': results, 'both_originals_retained': True, 'restored_writer_started': False}
    finally:
        engine.docker('exec', container, 'python3', '-c', "import pathlib,sys;[p.unlink() for p in pathlib.Path('/tmp').glob(sys.argv[1]+'*') if p.is_file()]", marker.rsplit('/', 1)[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-state', required=True, type=Path)
    parser.add_argument('--fixture', required=True, type=Path, help='Private synthetic JSON: container, host, email, password')
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text())
    engine = Engine(json.loads(args.engine_state.read_text())['name'])
    result = exercise(engine, **{key: fixture[key] for key in ('container', 'host', 'email', 'password')})
    args.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print('PASS: timestamp and TXID restore exclude later source; latest includes both; protected original bytes retained')

if __name__ == '__main__':
    main()
