#!/usr/bin/env python3
"""Portable commands against a synthetic isolated server."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from integration import ROOT, server, credentials


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--binary',required=True);parser.add_argument('--client',help='released standalone launcher to exercise');parser.add_argument('--trace',action='store_true');parser.add_argument('--write-schema',action='store_true');args=parser.parse_args()
    with server(args.binary) as request, tempfile.TemporaryDirectory(prefix='wikicontext-portable-') as tmp:
        admin,user,token=credentials(request)
        schema=request('GET','/api/context/schema',token=token)
        snapshot=ROOT/'skills/wikicontext/references/schema.json'
        if args.write_schema:
            snapshot.write_text(json.dumps(schema,indent=2)+'\n')
            (ROOT/'src/wikicontext_client/schema.json').write_text(snapshot.read_text())
        assert json.loads(snapshot.read_text())==schema,'Review and regenerate SQL schema snapshot'
        assert json.loads((ROOT/'src/wikicontext_client/schema.json').read_text()) == schema
        skill=Path(tmp)/'portable';skill.mkdir();shutil.copy2(ROOT / 'skills/wikicontext/wikicontext', skill / 'wikicontext')
        env={**os.environ,'HOME':tmp,'XDG_CACHE_HOME':str(Path(tmp)/'cache'),'WIKICONTEXT_URL':request.base_url,'WIKICONTEXT_USER_EMAIL':'agent@example.com','WIKICONTEXT_USER_PASSWORD':'SyntheticUserPassword123!'}
        trace_output = Path(tmp) / 'capture.jsonl'
        if args.trace:
            env['OBSERVECONTEXT_CAPTURE_V1'] = json.dumps(dict(version=1, url=request.base_url,
                origin=[], service='wikicontext.client', output=str(trace_output), upload=False,
                spool=None, flush_timeout=10, capture_sql=False, status_file=None))
        def cli(*argv,expected=0):
            result=subprocess.run(([args.client] if args.client else [sys.executable, str(skill / 'wikicontext')]) + list(argv),env=env,cwd=tmp,capture_output=True,text=True)
            assert env['WIKICONTEXT_USER_PASSWORD'] not in result.stdout+result.stderr and token not in result.stdout+result.stderr
            assert result.returncode==expected,(argv,result.stdout,result.stderr)
            return json.loads(result.stdout) if result.stdout.startswith(('{','[')) else result.stdout
        me=cli('whoami');cli('check')
        assert me['space']=='companyspace001'
        listed=cli('spaces')
        assert len(listed)==1 and listed[0]['id']==me['space'] and listed[0]['selected']
        assert listed[0]['kind']=='group' and listed[0]['role']=='editor'
        personal=cli('create-personal-space')['id']
        assert cli('create-personal-space')['id']==personal
        assert cli('whoami')['space']==me['space']
        assert cli('whoami','--space',personal)['space']==personal
        cli('--space','missing00000000','whoami',expected=2)
        assert cli('search','anything')['pages']==[]
        source=Path(tmp)/'source.md';source.write_text('The synthetic launch is on Tuesday.\n')
        ingested=cli('ingest',str(source));cli('ingest',str(source))
        pages=[]
        run=cli('create','ingestion_runs',json.dumps({'key':'portable','status':'staging','description':'Synthetic CLI publication'}))
        page=cli('create','pages',json.dumps({'slug':'synthetic-launch','kind':'concept'}))
        revision=cli('create','page_revisions',json.dumps({'run':run['id'],'page':page['id'],'title':'Synthetic launch','summary':'A synthetic test','body':'A launch on Tuesday [needs verification].'}))
        cli('publish',run['id'],'--expected-revision','1')
        initial_search=cli('search','Tuesday')
        assert initial_search['pages'][0]['id']==revision['id']
        assert cli('lint')['findings']
        result=cli('export-obsidian',str(Path(tmp)/'vault'))
        assert result['sequence']==1 and (Path(tmp)/'vault/wiki/synthetic-launch.md').is_file()
        assert cli('get','page_revisions',revision['id'])['body'].startswith('A launch')
        # The portable client uses the same pinned scope/generation pagination as the browser.
        second=cli('create','ingestion_runs',json.dumps({'key':'portable-second','status':'staging','description':'Synthetic search pagination'}))
        other=cli('create','pages',json.dumps({'slug':'another-launch','kind':'concept'}))
        cli('create','page_revisions',json.dumps({'run':second['id'],'page':other['id'],'title':'Tuesday launch','summary':'A second synthetic launch','body':'Tuesday launch details [needs verification].'}))
        cli('publish',second['id'],'--expected-revision','1')
        ranked=cli('search','Tuesday','--limit','1')
        assert len(ranked['pages'])==1 and ranked['hasMore'] and ranked['nextOffset']==1
        tail=cli('search','Tuesday','--publication',ranked['publication'],'--generation',ranked['generation'],'--offset','1','--limit','1')
        assert len(tail['pages'])==1 and not tail['hasMore'] and tail['nextOffset'] is None
        assert tail['pages'][0]['id']!=ranked['pages'][0]['id']
        assert cli('search','Tuesday','--sequence','1')['pages'][0]['id']==revision['id']
        pinned=cli('search','Tuesday','--publication',initial_search['publication'],'--generation',initial_search['generation'],'--offset','1')
        assert pinned['generation']==initial_search['generation'] and pinned['pages']==[]
        cli('search','Tuesday','--publication',initial_search['publication'],'--generation','0'*64,'--offset','1',expected=4)
        cli('search','Tuesday','--offset','1',expected=2)
        cli('publish',run['id'],'--expected-revision','1',expected=4)
        cli('update','ingestion_runs',run['id'],'{"status":"cancelled"}',expected=2)
        cli('batch',json.dumps([{'method':'POST','url':'/api/collections/users/records','body':{}}]),expected=2)
        # Staging captures the author's expected home and publication preserves it.
        def home_run(key):
            return cli('create','ingestion_runs',json.dumps({'key':key,'status':'staging','description':'Synthetic portable home choice'}))
        chosen=home_run('portable-home')
        staged=cli('stage-home',chosen['id'],'--home',page['slug'],'--expected-revision','1')
        assert staged['home']==page['id'] and staged['home_base']==''
        competing=home_run('portable-home-competing')
        cli('publish',competing['id'],'--home',other['slug'],'--expected-revision','1',expected=2)
        cli('publish',competing['id'],'--home',other['slug'],'--home-base','','--expected-revision','1')
        cli('publish',chosen['id'],'--expected-revision',str(staged['revision']),expected=4)
        unchanged=cli('get','ingestion_runs',chosen['id'])
        assert unchanged['home_base']=='' and unchanged['status']=='staging'
        cli('stage-home',chosen['id'],'--home',page['slug'],'--expected-revision',str(staged['revision']),expected=2)
        reassessed=cli('stage-home',chosen['id'],'--home',page['slug'],'--home-base',other['id'],'--expected-revision',str(staged['revision']))
        cli('publish',chosen['id'],'--expected-revision',str(reassessed['revision']))
        clearing=home_run('portable-home-clear')
        cleared=cli('stage-home',clearing['id'],'--clear-home','--expected-revision','1')
        assert cleared['home_base']==page['id'] and cleared['clear_home']
        cli('publish',clearing['id'],'--expected-revision',str(cleared['revision']))
        latest=cli('sql','SELECT home FROM publications ORDER BY sequence DESC LIMIT 1')
        assert latest['rows']==[['']]
        cache=list((Path(tmp)/'cache/wikicontext').glob('*.json'))
        assert cache and all(p.stat().st_mode & 0o077 == 0 for p in cache)
        assert cli('get','pages',page['id'])['space']==me['space']
        same_slug=cli('create','pages',json.dumps({'slug':page['slug'],'kind':'concept'}),'--space',personal)
        assert same_slug['space']==personal and same_slug['id']!=page['id']
        assert cli('search','Tuesday','--space',personal)['pages']==[]
        cli('create','pages',json.dumps({'slug':'elsewhere','kind':'concept'}),'--space','missing00000000',expected=2)
        cli('logout')
        if args.trace:
            events = [json.loads(line) for line in trace_output.read_text().splitlines()]
            assert any(event['method'] == 'POST' and event['route'] == '/api/collections/sources/records' for event in events)
            assert all(not event.get('sql') and not event['route'].startswith('/api/files/') for event in events)

    print('PASS: copied skill, schema, ingestion, published queries, lint, export, conflicts and private cache')

if __name__=='__main__':main()
