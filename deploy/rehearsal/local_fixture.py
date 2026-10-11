#!/usr/bin/env python3
"""Create synthetic historical WikiContext state for an isolated local ONCE engine."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests'))
from clone_preparation import serve, credentials, clone
from local_once import Engine

MINIO = 'wikicontext-minio-fixture:9e49d5e-7394ce0'


def private(path, value):
    with path.open('x') as handle:
        os.chmod(path, 0o600)
        json.dump(value, handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-state', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--fixture-app', required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(mode=0o700)
    # All records and storage authority are newly generated synthetic fixtures.
    engine = Engine(json.loads(args.engine_state.read_text())['name'])
    state = engine.inspect()
    engine.load(MINIO)
    gateway = json.loads(engine.docker('network', 'inspect', 'bridge'))[0]['IPAM']['Config'][0]['Gateway']
    access, secret = 'syntheticclone', secrets.token_hex(24)
    envpath = args.output / 'minio.env'
    envpath.write_text(f'MINIO_ROOT_USER={access}\nMINIO_ROOT_PASSWORD={secret}\n')
    envpath.chmod(0o600)
    engine.outer('cp', str(envpath), engine.name + ':/tmp/minio.env')
    engine.docker('run', '-d', '--name', 'wiki-rehearsal-minio', '-p', '9000:9000', '--env-file', '/tmp/minio.env', MINIO, 'server', '/data')
    endpoint = f'http://{gateway}:9000'
    def mc(*command):
        return engine.docker('exec', '-e', f'MC_HOST_test=http://{access}:{secret}@127.0.0.1:9000', 'wiki-rehearsal-minio', 'mc', *command)
    for _ in range(60):
        try:
            mc('mb', '--ignore-existing', 'test/originals', 'test/replica'); break
        except RuntimeError: time.sleep(1)
    else: raise RuntimeError('synthetic object storage startup failed')
    config = {'clone_url': 'http://wiki-rehearsal.localhost', 'operator_email': 'admin@example.com', 'operator_password': secrets.token_urlsafe(32),
              's3': {'enabled': True, 'bucket': 'originals', 'endpoint': endpoint, 'region': 'us-east-1', 'accessKey': access, 'secret': secret, 'forcePathStyle': True},
              'test_users': [{'email': 'agent@example.com', 'password': secrets.token_urlsafe(32)}]}
    private(args.output / 'clone.private.json', config)
    source = args.output / 'source'
    with serve(args.binary, args.fixture_app, source, initialize=True) as request:
        admin, user, token = credentials(request)
        create = lambda table, body: request('POST', '/api/collections/' + table + '/records', body, token)
        boundary = 'synthetic-once-original'
        original = b'Synthetic company evidence for local ONCE forward and rollback.\n'
        payload = b''
        for key, value in {'title': 'Synthetic company original', 'original_name': 'evidence.txt', 'media_type': 'text/plain'}.items():
            payload += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        payload += f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\n'.encode() + original + f'\r\n--{boundary}--\r\n'.encode()
        upload = urllib.request.Request(request.base_url + '/api/collections/sources/records', data=payload, headers={'Authorization': token, 'Content-Type': 'multipart/form-data; boundary=' + boundary}, method='POST')
        with urllib.request.urlopen(upload, timeout=20) as response: evidence = json.load(response)
        rendition = create('renditions', {'source': evidence['id'], 'kind': 'text', 'processor': 'synthetic', 'version_label': 'v1'})
        passage = create('passages', {'rendition': rendition['id'], 'ordinal': 1, 'locator': 'document', 'body': original.decode()})
        page = create('pages', {'slug': 'synthetic-company-evidence', 'kind': 'concept'})
        for number in (1, 2):
            run = create('ingestion_runs', {'key': f'synthetic-publication-{number}', 'status': 'staging', 'description': 'Synthetic ONCE rehearsal', 'sources': [evidence['id']]})
            revision = create('page_revisions', {'run': run['id'], 'page': page['id'], 'base_revision': revision['id'] if number == 2 else '', 'title': 'Synthetic company evidence', 'summary': f'Version {number}', 'body': f'Synthetic evidence version {number}.[^1]'})
            create('citations', {'page_revision': revision['id'], 'passage': passage['id'], 'marker': '1'})
            request('PATCH', '/api/collections/ingestion_runs/records/' + run['id'], {'status': 'published', 'expected_revision': run['revision']}, token)
        snapshot = {}
        for table in clone.DOMAIN:
            if table in ('spaces', 'space_members'): continue
            snapshot[table] = request('POST', '/api/context/query', {'sql': f'SELECT * FROM {table} ORDER BY id'}, token)
        maintenance = request('GET', '/api/context/maintenance', token=admin)
        request('PUT', '/api/context/maintenance', {'readOnly': True, 'expectedGeneration': maintenance['generation']}, admin)
    shutil.copytree(source, args.output / 'checkpoint')
    receipt = clone.prepare(args.binary, args.output / 'checkpoint', args.output / 'prepared', args.output / 'clone.private.json')
    engine.outer('cp', str(source / 'storage'), engine.name + ':/tmp/wiki-originals')
    engine.docker('cp', '/tmp/wiki-originals', 'wiki-rehearsal-minio:/tmp/wiki-originals')
    mc('cp', '--recursive', '/tmp/wiki-originals/', 'test/originals/')
    env = {'BASE_URL': config['clone_url'], 'WIKICONTEXT_S3_BUCKET': 'originals', 'WIKICONTEXT_S3_ENDPOINT': endpoint, 'WIKICONTEXT_S3_REGION': 'us-east-1', 'WIKICONTEXT_S3_ACCESS_KEY_ID': access, 'WIKICONTEXT_S3_SECRET_ACCESS_KEY': secret, 'WIKICONTEXT_S3_FORCE_PATH_STYLE': 'true', 'LITESTREAM_SYNC_INTERVAL': '1s', 'LITESTREAM_BUCKET': 'replica', 'LITESTREAM_PATH': 'test/data', 'LITESTREAM_ENDPOINT': endpoint, 'LITESTREAM_REGION': 'us-east-1', 'LITESTREAM_ACCESS_KEY_ID': access, 'LITESTREAM_SECRET_ACCESS_KEY': secret}
    private(args.output / 'environment.private.json', env)
    private(args.output / 'expected.private.json', {'snapshot': snapshot, 'source': evidence, 'original_sha256': hashlib.sha256(original).hexdigest(), 'user': user['id'], 'page': page['id']})
    print(json.dumps({'prepared': str(args.output / 'prepared'), 'frozen_source_preserved': receipt['source_unchanged'], 'domain_unchanged': receipt['domain_unchanged'], 'publications': 2, 'originals': 1, 'minio': 'wiki-rehearsal-minio', 'loopback_s3_port': state['s3_port']}))

if __name__ == '__main__': main()
