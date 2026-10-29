#!/usr/bin/env python3
"""Exercise directory queries against thousands of real, isolated synthetic originals."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

from e2e import Project, PASSWORD


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    with tempfile.TemporaryDirectory(prefix='pocketcontext-source-directory-') as temp:
        pc = Project(binary, Path(temp))
        try:
            pc.json('init', '--port', str(pc.port), '--password-stdin', stdin=PASSWORD + '\n')
            status, raw = pc.http('POST', '/api/collections/users/auth-with-password',
                                  {'identity': 'me@pocketcontext.localhost', 'password': PASSWORD})
            assert status == 200
            headers = {'Authorization': json.loads(raw)['token']}
            space = next(row['id'] for row in pc.json('spaces') if row['selected'])

            def create(number):
                boundary = 'synthetic-source-directory-boundary'
                filename = f'original-{number:05}.txt'
                parts = []
                for field, value in {'title': f'Original {number:05}', 'original_name': filename,
                                     'media_type': 'text/plain', 'space': space}.items():
                    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n{value}\r\n')
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="original"; filename="{filename}"\r\nContent-Type: text/plain\r\n\r\nSynthetic original number {number}.\r\n--{boundary}--\r\n')
                request = urllib.request.Request(pc.url + '/api/collections/sources/records',
                    data=''.join(parts).encode(), method='POST',
                    headers={**headers, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    assert response.status == 200

            with ThreadPoolExecutor(max_workers=4) as workers:
                list(workers.map(create, range(2001)))
            print('Created 2,001 synthetic originals through the authenticated API', flush=True)
            def query(sql):
                status, raw = pc.http('POST', '/api/context/query', {'sql': sql}, headers)
                assert status == 200, raw
                value = json.loads(raw)
                assert not value['truncated']
                return value['rows']
            assert query(f"SELECT count(*) FROM sources WHERE space='{space}'") == [[2001]]
            started = time.monotonic()
            for offset in [0, 50, 1950, 2000]:
                rows = query(f"SELECT id,title,original_name,source_date,created FROM sources WHERE space='{space}' ORDER BY title COLLATE NOCASE ASC, id ASC LIMIT 51 OFFSET {offset}")
                assert len(rows) == min(51, 2001-offset)
                assert [row[1] for row in rows] == [f'Original {n:05}' for n in range(offset, offset+len(rows))]
            for order in ['created DESC, id DESC', 'created ASC, id ASC']:
                assert len(query(f"SELECT id,title,original_name,source_date,created FROM sources WHERE space='{space}' ORDER BY {order} LIMIT 51 OFFSET 1950")) == 51
            other = pc.json('create-space', 'Other')['id']
            assert query(f"SELECT count(*) FROM sources WHERE space='{other}'") == [[0]]
            print(f'Directory first/middle/last pages and all sort modes passed; six page queries in {time.monotonic()-started:.2f}s')
        finally:
            subprocess.run([str(binary), '--db', str(pc.db), 'stop'], env=pc.env,
                           capture_output=True, timeout=60)


if __name__ == '__main__':
    main()
