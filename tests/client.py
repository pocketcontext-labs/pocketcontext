#!/usr/bin/env python3
"""Read throttling retries are bounded; uncertain writes are never replayed."""
import importlib.util
from pathlib import Path
import unittest
import io
import json
import os
import tempfile
import urllib.request
from unittest.mock import patch
from wikicontext_client import cli as wc
class Client(unittest.TestCase):
    def test_tracing_excludes_groq_origin_and_request_contents(self):
        from observecontext_client.instrumentation import instrument_cli
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'events.jsonl'
            config = dict(version=1, url='https://wiki.example.com', origin=[],
                service='wikicontext.client', output=str(output), upload=False,
                spool=None, flush_timeout=10, capture_sql=False, status_file=None)
            def response(*args, **kwargs):
                value = io.BytesIO(b'{}')
                value.status = 200
                value.headers = {}
                return value
            with patch.dict(os.environ, {'OBSERVECONTEXT_CAPTURE_V1': json.dumps(config)}), \
                    patch('urllib.request.OpenerDirector.open', side_effect=response), \
                    instrument_cli(service='wikicontext.client', opener=wc.opener):
                for url in ('https://api.groq.com/openai/v1/audio/transcriptions',
                            'https://wiki.example.com/api/collections/sources/records'):
                    request = urllib.request.Request(url, data=b'private original bytes',
                        headers={'Authorization': 'private-token'})
                    with wc.opener.open(request) as result:
                        self.assertEqual(result.read(), b'{}')
            events = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]['route'], '/api/collections/sources/records')
            self.assertNotIn('private', output.read_text())

    def test_throttled_read(self):
        with patch.object(wc,'call',side_effect=[(429,{}),(200,{'rows':[]})]) as call,patch.object(wc.time,'sleep') as sleep:
            self.assertEqual(wc.must({},'POST','/api/context/query',{}),{'rows':[]})
            self.assertEqual(call.call_count,2);sleep.assert_called_once_with(10)
    def test_no_write_replay(self):
        with patch.object(wc,'call',return_value=(503,{})) as call,patch.object(wc.time,'sleep') as sleep:
            with self.assertRaises(wc.Fail):wc.must({},'POST','/api/collections/pages/records',{})
            self.assertEqual(call.call_count,1);sleep.assert_not_called()
    def test_retry_budget(self):
        with patch.object(wc,'call',return_value=(503,{})) as call,patch.object(wc.time,'sleep'):
            with self.assertRaises(wc.Fail):wc.must({},'POST','/api/context/query',{})
            self.assertEqual(call.call_count,4)
    def test_publish_preserves_staged_fields(self):
        args=wc.parse(['publish','a'*15,'--expected-revision','2'])
        with patch.object(wc,'config',return_value={}),patch.object(wc,'must',return_value={}) as request,patch.object(wc,'say'):
            wc.run(args)
        request.assert_called_once_with({},'PATCH',wc.records('ingestion_runs','a'*15),{'expected_revision':2,'status':'published'})
    def test_publish_home_requires_explicit_base(self):
        args=wc.parse(['publish','a'*15,'--expected-revision','2','--home','onboarding'])
        with patch.object(wc,'must') as request:
            with self.assertRaises(wc.Fail):wc.home_fields({},args)
        request.assert_not_called()
    def test_staging_does_not_refresh_existing_choice(self):
        args=wc.parse(['stage-home','a'*15,'--expected-revision','2','--clear-home'])
        with patch.object(wc,'must',return_value={'columns':['home','clear_home'],'rows':[['b'*15,False]]}) as request:
            with self.assertRaises(wc.Fail):wc.home_fields({},args)
        self.assertEqual(request.call_count,1)
    def test_home_conflict_is_not_replayed(self):
        args=wc.parse(['publish','a'*15,'--expected-revision','2'])
        with patch.object(wc,'config',return_value={}),patch.object(wc,'call',return_value=(409,{})) as request:
            with self.assertRaises(wc.Fail) as error:wc.run(args)
        self.assertEqual(error.exception.code,4)
        self.assertEqual(request.call_count,1)
    def test_space_selection(self):
        space=wc.COMPANY_SPACE
        self.assertEqual(wc.parse(['--space',space,'lint']).space,space)
        self.assertEqual(wc.parse(['lint','--space',space]).space,space)
        self.assertIsNone(wc.parse(['lint']).space)
        with patch.object(wc.sys,'stderr',io.StringIO()),self.assertRaises(SystemExit):wc.parse(['lint','--space','bad'])
        with patch.dict(os.environ,{'WIKICONTEXT_URL':'http://127.0.0.1:1','WIKICONTEXT_USER_EMAIL':'a@example.test','WIKICONTEXT_SPACE':'bad'}):
            with self.assertRaises(wc.Fail) as error:wc.config()
        self.assertEqual(error.exception.code,2)
        found={'columns':['id'],'rows':[[space]],'truncated':False}
        with patch.object(wc,'must',return_value=found) as request:
            cfg={}
            self.assertEqual(wc.space_id(cfg),space);self.assertEqual(wc.space_id(cfg),space)
        self.assertEqual(request.call_count,1)
        self.assertIn("kind = 'group'",request.call_args.args[3]['sql'])
        for rows,selected in [([],'m'*15),([],None),([[space],['t'*15]],None)]:
            with patch.object(wc,'must',return_value=dict(found,rows=rows)):
                with self.assertRaises(wc.Fail):wc.space_id({'space':selected})
    def test_create_scopes_roots_only(self):
        space='s'*15
        for collection,expected in [('pages',{'slug':'x','kind':'concept','space':space}),('page_links',{'page_revision':'r'*15,'target':'t'*15})]:
            body={key:value for key,value in expected.items() if key!='space'}
            args=wc.parse(['create',collection,json.dumps(body),'--space',space])
            with patch.object(wc,'config',return_value={}),patch.object(wc,'space_id',return_value=space),patch.object(wc,'must',return_value={}) as request,patch.object(wc,'say'):
                wc.run(args)
            self.assertEqual(request.call_args.args[3],expected)
    def test_personal_creation_is_explicit(self):
        args = wc.parse(['create-personal-space'])
        with patch.object(wc, 'config', return_value={}), patch.object(wc, 'must', return_value={'id': 's'*15}) as request, patch.object(wc, 'say'):
            wc.run(args)
        request.assert_called_once_with({}, 'POST', '/api/wiki/spaces/personal', {})

    def test_spaces_lists_personal_when_company_access_revoked(self):
        account, personal = 'u'*15, 's'*15
        replies = [{'record': {'id': account}},
                   {'columns': ['id', 'kind', 'name', 'role'],
                    'rows': [[personal, 'personal', 'Personal', 'owner']], 'truncated': False}]
        with patch.object(wc, 'config', return_value={}), patch.object(wc, 'must', side_effect=replies), patch.object(wc, 'say') as output:
            wc.run(wc.parse(['spaces']))
        self.assertEqual(json.loads(output.call_args.args[0]),
                         [{'id': personal, 'kind': 'personal', 'name': 'Personal', 'role': 'owner', 'selected': False}])

    def test_space_lookup_rejects_truncated(self):
        with patch.object(wc, 'must', return_value={'rows': [[wc.COMPANY_SPACE]], 'truncated': True}):
            with self.assertRaisesRegex(wc.Fail, 'truncated'):
                wc.space_id({})

if __name__=='__main__':unittest.main()
