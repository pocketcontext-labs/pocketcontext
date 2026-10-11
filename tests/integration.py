#!/usr/bin/env python3
"""Exercise WikiContext through HTTP against an isolated temporary database."""
import argparse
import concurrent.futures
import contextlib
import json
from pathlib import Path
import socket
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SEARCH = 'search' in json.loads((ROOT / 'pocketcontext.json').read_text())

@contextlib.contextmanager
def server(binary, fixtures=''):
    with tempfile.TemporaryDirectory(prefix='wikicontext-test-') as tmp:
        hooks=Path(tmp)/'pb_hooks'
        shutil.copytree(ROOT/'pb_hooks',hooks)
        (hooks/'failure_fixture.pb.js').write_text('''
onRecordCreateExecute((e) => {
  if(e.record.getString('record') === 'auditfailure001' || (e.record.getString('record') === 'pubfailure00001' && e.record.getString('action') === 'update')) throw new Error('Synthetic audit failure');
  e.next();
}, 'audit_log');
onRecordCreateExecute((e) => {
  if(e.record.id === 'dirfailure00001') throw new Error('Synthetic directory failure');
  e.next();
}, 'user_directory');
''' + fixtures)
        common = [str(Path(binary).resolve()), '--dir', str(Path(tmp)/'pb_data'), '--migrationsDir', str(ROOT/'pb_migrations'), '--hooksDir', str(hooks)]
        result = subprocess.run(common+['superuser','upsert','admin@example.com','SyntheticAdminPassword123!'],cwd=ROOT,capture_output=True,text=True)
        assert result.returncode == 0, result.stdout+result.stderr
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
        with open(Path(tmp)/'server.log','w+') as log:
            proc=subprocess.Popen(common+['serve','--http',f'127.0.0.1:{port}'],cwd=ROOT,stdout=log,stderr=log)
            def request(method,path,body=None,token=None,expected=200):
                headers={'Content-Type':'application/json'}
                if token: headers['Authorization']=token
                req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
                try:
                    with urllib.request.urlopen(req,timeout=20) as r: status,raw=r.status,r.read()
                except urllib.error.HTTPError as e: status,raw=e.code,e.read()
                assert status in (expected if isinstance(expected,tuple) else (expected,)), (method,path,status,raw.decode())
                return json.loads(raw) if raw else None
            try:
                for _ in range(150):
                    try: request('GET','/api/health'); break
                    except (OSError,AssertionError):
                        if proc.poll() is not None: log.seek(0); raise AssertionError(log.read())
                        time.sleep(.1)
                else: raise AssertionError('Server startup timed out')
                request.base_url = f'http://127.0.0.1:{port}'
                request.data_dir = Path(tmp)/'pb_data'
                yield request
            finally:
                proc.terminate();proc.wait(timeout=15)


def credentials(request):
    admin=request('POST','/api/collections/_superusers/auth-with-password',{'identity':'admin@example.com','password':'SyntheticAdminPassword123!'})['token']
    user=request('POST','/api/collections/users/records',{'email':'agent@example.com','name':'Synthetic agent','password':'SyntheticUserPassword123!','passwordConfirm':'SyntheticUserPassword123!'},admin)
    token=request('POST','/api/collections/users/auth-with-password',{'identity':'agent@example.com','password':'SyntheticUserPassword123!'})['token']
    return admin,user,token


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--binary',required=True);args=parser.parse_args()
    with server(args.binary) as request:
        admin,user,token=credentials(request)
        path=lambda t:'/api/collections/'+t+'/records'
        create=lambda t,b:request('POST',path(t),b,token)
        def query(sql):
            r=request('POST','/api/context/query',{'sql':sql},token)
            assert not r['truncated'];return [dict(zip(r['columns'],v)) for v in r['rows']]
        def publish(run,expected=200):return request('PATCH',path('ingestion_runs')+'/'+run['id'],{'expected_revision':run['revision'],'status':'published'},token,expected)
        def run(key):return create('ingestion_runs',{'key':key,'status':'staging','description':'Synthetic '+key})
        def revision(run,page,base='',body='Synthetic claim [needs verification].',**extra):
            return create('page_revisions',dict(run=run['id'],page=page['id'],base_revision=base,title=page['slug'],summary='Synthetic summary',body=body,**extra))
        request('GET','/api/context/schema',expected=(401,403))
        request('POST','/api/context/query',{'sql':'SELECT * FROM users'},token,400)
        request('POST',path('pages'),{'id':'auditfailure001','slug':'rollback','kind':'concept'},token,(400,500))
        assert not query("SELECT id FROM pages WHERE slug='rollback'")
        p=create('pages',{'slug':'first','kind':'concept'})
        assert p['revision']==1 and p['created_by']==user['id']
        for identity in (token,admin):
            request('PATCH',path('pages')+'/'+p['id'],{'slug':'changed','expected_revision':1},identity,400)
            request('DELETE',path('pages')+'/'+p['id'],token=identity,expected=(403,404))
            request('POST',path('publications'),{},identity,expected=(400,403))
        a=run('first');r=revision(a,p)
        assert not query('SELECT id FROM publications')
        a=publish(a)
        assert a['status']=='published'
        first=query('SELECT * FROM publications')[0]
        manifest=json.loads(first['manifest']) if isinstance(first['manifest'],str) else first['manifest']
        assert manifest=={p['id']:r['id']}
        # Pin one publication: draft revisions never enter manifest-based diagnostics.
        diagnostic_draft=run('diagnostic-draft')
        revision(diagnostic_draft,p,r['id'],body='Unpublished synthetic body [needs verification].')
        stats=query("""SELECT count(*) AS pages,
          median(length(r.body)) AS median_body_characters,
          percentile_cont(length(r.body), 0.95) AS p95_body_characters
          FROM publications AS pub JOIN json_each(pub.manifest) AS selected
          JOIN page_revisions AS r ON r.id=selected.value AND r.page=selected.key
          WHERE pub.sequence=1 AND r.archived=false""")
        assert stats==[{'pages':1,'median_body_characters':len(r['body']),
                       'p95_body_characters':len(r['body'])}],stats
        # Closed run cannot gain revisions/links/citations or be republished.
        request('PATCH',path('ingestion_runs')+'/'+a['id'],{'expected_revision':a['revision'],'status':'staging'},token,400)
        request('POST',path('page_links'),{'page_revision':r['id'],'target':p['id']},token,400)
        # Competing publications reject stale synthesis, preserving the loser as staging.
        left,right=run('left'),run('right')
        rl,rr=revision(left,p,r['id']),revision(right,p,r['id'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            result=list(pool.map(lambda x:publish(x,(200,409)),[left,right]))
        assert sum(x.get('status')=='published' for x in result)==1,result
        head=query('SELECT * FROM publications ORDER BY sequence DESC LIMIT 1')[0]
        current=json.loads(head['manifest']) if isinstance(head['manifest'],str) else head['manifest']
        assert current[p['id']] in (rl['id'],rr['id'])
        assert len(query('SELECT id FROM publications'))==2
        # Missing citation blocks publication and leaves no manifest/audit transition.
        bad=run('bad-citation');revision(bad,p,current[p['id']],body='Unsupported claim.[^1]')
        publish(bad,400)
        assert query("SELECT status FROM ingestion_runs WHERE id='%s'"%bad['id'])[0]['status']=='staging'
        # Link targets may be introduced in the same publication.
        q=create('pages',{'slug':'second','kind':'concept'});linked=run('linked')
        l=revision(linked,p,current[p['id']],body='See [[second]]. [needs verification]')
        revision(linked,q)
        create('page_links',{'page_revision':l['id'],'target':q['id']});publish(linked)
        latest=query('SELECT manifest FROM publications ORDER BY sequence DESC LIMIT 1')[0]['manifest']
        latest=json.loads(latest) if isinstance(latest,str) else latest
        archive=run('archive');revision(archive,q,latest[q['id']],archived=True)
        publish(archive,400)
        # Publication is rolled back if audit persistence fails.
        failed=create('ingestion_runs',{'id':'pubfailure00001','key':'audit-failure','status':'staging','description':'Synthetic failure'})
        revision(failed,p,latest[p['id']])
        before_pubs=len(query('SELECT id FROM publications'))
        publish(failed,(400,500))
        assert len(query('SELECT id FROM publications'))==before_pubs
        assert query("SELECT status FROM ingestion_runs WHERE id='pubfailure00001'")[0]['status']=='staging'
        failed=run('cancellation')
        before=len(query('SELECT id FROM pages'))
        request('POST','/api/batch',{'requests':[
          {'method':'POST','url':path('pages'),'body':{'slug':'batch-rollback','kind':'concept'}},
          {'method':'POST','url':path('pages'),'body':{'slug':'index','kind':'concept'}}]},token,400)
        assert len(query('SELECT id FROM pages'))==before
        request('POST',path('ingestion_runs'),{'key':'first','status':'staging','description':'duplicate'},token,400)
        # Explicit revision controls the run update.
        request('PATCH',path('ingestion_runs')+'/'+failed['id'],{'status':'cancelled'},token,400)
        closed=request('PATCH',path('ingestion_runs')+'/'+failed['id'],{'expected_revision':1,'status':'cancelled'},token)
        assert closed['revision']==2
        publish(failed,409)
        # No one can mutate history through the standard REST API.
        for t in ['publications','audit_log']:
            row=query('SELECT id FROM '+t+' LIMIT 1')[0]
            request('PATCH',path(t)+'/'+row['id'],{},admin,403)
            request('DELETE',path(t)+'/'+row['id'],token=admin,expected=403)
    print('PASS: publication atomicity, concurrency, immutability, link and citation validation, shared access, history')

if __name__=='__main__':main()
