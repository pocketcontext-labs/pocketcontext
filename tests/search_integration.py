#!/usr/bin/env python3
"""Synthetic HTTP tests for private publication-scoped search and recovery."""
import argparse
import contextlib
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from snapshot import snapshot
from integration import ROOT, credentials


@contextlib.contextmanager
def running(binary, work, *, data=None):
    """Start an isolated copied application."""
    work=Path(work);work.mkdir(exist_ok=True,parents=True)
    hooks=work/'pb_hooks'; migrations=work/'pb_migrations'
    for directory in (hooks,migrations):
        if directory.exists():shutil.rmtree(directory)
    shutil.copytree(ROOT/'pb_hooks',hooks)
    shutil.copytree(ROOT/'pb_migrations',migrations)
    cfg=json.loads((ROOT/'pocketcontext.json').read_text())
    (work/'pocketcontext.json').write_text(json.dumps(cfg))
    (hooks/'search_failure_fixture.pb.js').write_text('''
onRecordCreateExecute(e=>{
 if(e.record.getString('record')==='pubfailure00001'&&e.record.getString('action')==='update')throw new Error('Synthetic audit failure');
 e.next();
},'audit_log');
''')
    data=Path(data or work/'pb_data')
    common=[str(Path(binary).resolve()),'--dir',str(data),'--migrationsDir',str(migrations),'--hooksDir',str(hooks)]
    setup=subprocess.run(common+['superuser','upsert','admin@example.com','SyntheticAdminPassword123!'],cwd=work,capture_output=True,text=True)
    assert setup.returncode==0,setup.stdout+setup.stderr
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    with (work/'server.log').open('w+') as log:
        proc=subprocess.Popen(common+['serve','--http',f'127.0.0.1:{port}'],cwd=work,stdout=log,stderr=log)
        def request(method,path,body=None,token=None,expected=200):
            headers={'Content-Type':'application/json'}
            if token:headers['Authorization']=token
            req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
            try:
                with urllib.request.urlopen(req,timeout=60) as response:status,raw=response.status,response.read()
            except urllib.error.HTTPError as e:status,raw=e.code,e.read()
            assert status in (expected if isinstance(expected,tuple) else (expected,)),(method,path,status,raw.decode())
            return json.loads(raw) if raw else None
        request.data_dir=data
        request.base_url=f'http://127.0.0.1:{port}'
        try:
            for _ in range(150):
                try:request('GET','/api/health');break
                except (OSError,AssertionError):
                    if proc.poll() is not None:log.seek(0);raise AssertionError(log.read())
                    time.sleep(.1)
            else:raise AssertionError('startup timeout')
            yield request
        finally:proc.terminate();proc.wait(timeout=15)


class Fixture:
    def __init__(self,request,token,space=None):self.request=request;self.token=token;self.space=space
    def create(self,table,body):
        if self.space and table in ('pages','sources','ingestion_runs'):body=dict(space=self.space,**body)
        return self.request('POST','/api/collections/'+table+'/records',body,self.token)
    def query(self,sql):
        data=self.request('POST','/api/context/query',{'sql':sql},self.token)
        assert not data['truncated'];return [dict(zip(data['columns'],row)) for row in data['rows']]
    def run(self,key,**kwargs):return self.create('ingestion_runs',dict(key=key,status='staging',description='Synthetic search '+key,**kwargs))
    def page(self,slug):return self.create('pages',dict(slug=slug,kind='concept'))
    def revision(self,run,page,base='',**kwargs):
        return self.create('page_revisions',dict(dict(run=run['id'],page=page['id'],base_revision=base,title='Orchid guide',summary='Synthetic botanical research',body='Orchid evidence [needs verification].'),**kwargs))
    def publish(self,run,expected=200):
        result=self.request('PATCH','/api/collections/ingestion_runs/records/'+run['id'],{'status':'published','expected_revision':run['revision']},self.token,expected)
        if result.get('status')=='published':return self.query("SELECT id,sequence FROM publications WHERE run='"+run['id']+"' LIMIT 1")[0]
        return result
    def search(self,pub,query='orchid',**kwargs):
        return self.request('POST','/api/context/search',dict(index='pages',scope=pub['id'],query=query,**kwargs),self.token)
    def generation(self):
        publications=self.query('SELECT id FROM publications ORDER BY sequence DESC LIMIT 1')
        return self.search(publications[0])['generation'] if publications else None


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--binary',required=True);args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='wikicontext-search-') as tmp:
        with running(args.binary,Path(tmp)/'app') as request:
            admin,user,token=credentials(request)
            personal=request('POST','/api/wiki/spaces/personal',{},token)['id']
            f=Fixture(request,token,personal)
            # Shared index internals and maintenance endpoints are absent.
            for table in ('published_pages_fts','published_pages_fts_content','search_state'):
                request('POST','/api/context/query',{'sql':'SELECT * FROM '+table},token,400)
            request('POST','/api/wiki/search/rebuild',{},admin,404)
            p=f.page('orchid-one');q=f.page('orchid-two');first=f.run('first')
            r1=f.revision(first,p);r2=f.revision(first,q);pub1=f.publish(first)
            second=f.run('second');r3=f.revision(second,p,r1['id']);pub2=f.publish(second)
            archive=f.run('archive');f.revision(archive,q,r2['id'],archived=True);pub3=f.publish(archive)
            draft=f.run('draft');f.revision(draft,p,r3['id'],body='Orchid draftonly [needs verification].')
            assert {x['id'] for x in f.search(pub1)['hits']}=={r1['id'],r2['id']}
            assert {x['id'] for x in f.search(pub2)['hits']}=={r3['id'],r2['id']}
            assert {x['id'] for x in f.search(pub3)['hits']}=={r3['id']}
            assert not f.search(pub3,'draftonly')['hits']
            page1=f.search(pub2,limit=1)
            assert page1['hasMore'] and len(page1['hits'])==1
            page2=f.search(pub2,limit=1,offset=1,expectedGeneration=page1['generation'])
            assert not page2['hasMore'] and page1['hits'][0]['id']!=page2['hits'][0]['id']
            request('POST','/api/context/search',dict(index='pages',scope=pub2['id'],query='orchid',limit=1,offset=1,expectedGeneration='stale-generation'),token,409)
            # First publication failure cannot alter the selected scope or search.
            before=f.search(pub3)
            failed=f.run('audit-failure',id='pubfailure00001');f.revision(failed,p,r3['id'])
            f.publish(failed,(400,500))
            assert f.search(pub3)==before
            assert f.query("SELECT status FROM ingestion_runs WHERE id='pubfailure00001'")==[{'status':'staging'}]
            # Personal scopes must look absent to another company member.
            request('POST','/api/collections/users/records',{'email':'other@example.com','name':'Other','password':'SyntheticUserPassword123!','passwordConfirm':'SyntheticUserPassword123!'},admin)
            other=request('POST','/api/collections/users/auth-with-password',{'identity':'other@example.com','password':'SyntheticUserPassword123!'})['token']
            other_space=request('POST','/api/wiki/spaces/personal',{},other)['id']
            g=Fixture(request,other,other_space)
            op=g.page('orchid-one');other_run=g.run('first');orev=g.revision(other_run,op,body='Orchid private other [needs verification].');opub=g.publish(other_run)
            foreign=request('POST','/api/context/search',dict(index='pages',scope=pub1['id'],query='orchid'),other,404)
            absent=request('POST','/api/context/search',dict(index='pages',scope='missing00000000',query='orchid'),other,404)
            assert foreign==absent
            request('POST','/api/context/search',dict(index='pages',scope=opub['id'],query='orchid'),token,404)
            assert [x['id'] for x in g.search(opub)['hits']]==[orev['id']]
            assert not f.search(pub3,'other')['hits']
            # Writes outside this immutable scope do not invalidate its continuation,
            # including visible company publications and later personal publications.
            company=Fixture(request,token)
            cp=company.page('company');cr=company.run('company');company.revision(cr,cp);company.publish(cr)
            final=f.run('final');r4=f.revision(final,p,r3['id']);pub4=f.publish(final)
            assert f.search(pub2,limit=1,offset=1,expectedGeneration=page1['generation'])==page2
            expected=f.search(pub4)
            assert [x['id'] for x in expected['hits']]==[r4['id']]
            snapshot(request.data_dir,Path(tmp)/'restored_data')
        with running(args.binary,Path(tmp)/'restore_app',data=Path(tmp)/'restored_data') as request:
            restored=Fixture(request,token,personal)
            assert restored.search(pub4)==expected
            assert {x['id'] for x in restored.search(pub1)['hits']}=={r1['id'],r2['id']}
            assert restored.search(pub2,limit=1,offset=1,expectedGeneration=page1['generation'])==page2
    print('PASS: private scopes, draft/archive exclusion, historical pagination, generation conflicts/stability, personal isolation, publication rollback and populated restore')


if __name__=='__main__':main()
