#!/usr/bin/env python3
"""Synthetic migration invariants and fences. No Docker, network or production data."""
import copy
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0, str(TOOLS))
import activate_checkpoint as a


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.old, self.new = self.root / 'old.db', self.root / 'new.db'
        for path, migrated in [(self.old, False), (self.new, True)]:
            db = sqlite3.connect(path)
            for table in a.DOMAIN:
                db.execute('CREATE TABLE ' + table + ' (id TEXT PRIMARY KEY, body BLOB, revision INT' + (', space TEXT' if migrated else '') + ')')
                db.execute('INSERT INTO ' + table + ' VALUES (' + ','.join(['?'] * (4 if migrated else 3)) + ')', ('record', b'\x00private\xff', 7) + ((a.COMPANY,) if migrated else ()))
            db.execute('CREATE TABLE users(id TEXT PRIMARY KEY, disabled INT)')
            db.executemany('INSERT INTO users VALUES (?,?)', [('active',0),('disabled',1)])
            if migrated:
                db.execute('CREATE TABLE spaces(id TEXT, kind TEXT, name TEXT)')
                db.execute('INSERT INTO spaces VALUES (?, ?, ?)', (a.COMPANY,'group','Company'))
                db.execute('CREATE TABLE space_members(space TEXT, account TEXT, role TEXT, active INT)')
                db.executemany('INSERT INTO space_members VALUES (?,?,?,?)',[(a.COMPANY,'active','editor',1),(a.COMPANY,'disabled','editor',0)])
            db.commit(); db.close()

    def mutate(self, sql, args=()):
        with closing(sqlite3.connect(self.new)) as db:
            db.execute(sql,args); db.commit()

    def test_all_legacy_columns_and_memberships_preserved(self):
        result=a.compare_databases(self.old,self.new)
        self.assertEqual(result,{table:1 for table in a.DOMAIN})

    def test_legacy_byte_change_detected(self):
        self.mutate('UPDATE sources SET body=?', (b'changed',))
        with self.assertRaisesRegex(a.c.CaptureError,'legacy_domain_changed'): a.compare_databases(self.old,self.new)

    def test_extra_legacy_row_detected(self):
        self.mutate('INSERT INTO citations VALUES (?,?,?,?)',('extra',b'x',1,a.COMPANY))
        with self.assertRaisesRegex(a.c.CaptureError,'legacy_domain_changed'): a.compare_databases(self.old,self.new)

    def test_wrong_backfill_detected(self):
        self.mutate('UPDATE sources SET space=NULL')
        with self.assertRaisesRegex(a.c.CaptureError,'company_backfill_mismatch'): a.compare_databases(self.old,self.new)

    def test_disabled_account_not_reenabled(self):
        self.mutate("UPDATE space_members SET active=1 WHERE account='disabled'")
        with self.assertRaisesRegex(a.c.CaptureError,'company_membership_mismatch'): a.compare_databases(self.old,self.new)

    def test_personal_space_not_automatically_created(self):
        self.mutate("INSERT INTO spaces VALUES ('personal','personal','Private')")
        with self.assertRaisesRegex(a.c.CaptureError,'unexpected_spaces'): a.compare_databases(self.old,self.new)

    def test_no_new_legacy_column_silently_ignored(self):
        self.mutate('ALTER TABLE sources ADD COLUMN unexpected TEXT')
        with self.assertRaisesRegex(a.c.CaptureError,'candidate_schema_mismatch'): a.compare_databases(self.old,self.new)

    def same_schema_baseline(self):
        self.mutate("INSERT INTO spaces VALUES ('personal','personal','Private')")
        self.mutate("UPDATE space_members SET active=0 WHERE account='active'")
        self.mutate("INSERT INTO space_members VALUES ('personal','active','owner',1)")
        with closing(sqlite3.connect(self.new)) as source, closing(sqlite3.connect(self.old)) as target:
            source.backup(target)

    def test_same_schema_preserves_personal_spaces_and_revoked_memberships(self):
        self.same_schema_baseline()
        self.assertEqual(a.compare_databases(self.old,self.new,True), {table:1 for table in a.DOMAIN})

    def test_same_schema_rejects_domain_auth_membership_and_schema_changes(self):
        self.same_schema_baseline()
        for sql in ("UPDATE sources SET body='changed'", "UPDATE users SET disabled=0",
                    "UPDATE space_members SET active=1", "DELETE FROM spaces WHERE id='personal'",
                    "CREATE TABLE unexpected(value TEXT)", "PRAGMA user_version=42"):
            with self.subTest(sql=sql):
                with closing(sqlite3.connect(self.old)) as source, closing(sqlite3.connect(self.new)) as target:
                    source.backup(target)
                self.mutate(sql)
                with self.assertRaisesRegex(a.c.CaptureError, 'same_schema_database_changed'):
                    a.compare_databases(self.old,self.new,True)

    def test_same_schema_temporary_never_thaws(self):
        cfg=SimpleNamespace(same_schema=True)
        row={'Id':'a'*64,'Image':'id','Config':{'Labels':{a.LABEL:'run'}},'Mounts':[{'Name':'v'}]}
        def run(args, *unused, **kwargs):
            return ('a'*64).encode() if args[:2]==['docker','run'] else b''
        for startup in ('read_only','writable'):
            with self.subTest(startup=startup), patch.object(a,'no_writers'), patch.object(a.c,'run',side_effect=run), patch.object(a,'inspect',return_value=row), patch.object(a,'verify_temporary'), patch.object(a,'ready',return_value={'state':startup,'generation':7}), patch.object(a,'api') as api, patch.object(a.c,'stop'):
                if startup=='read_only':
                    self.assertEqual(a.temporary(cfg,{'volume':'v'},{'HostConfig':{}},'image','id','net','run',self.root/'env','token',False),7)
                else:
                    with self.assertRaisesRegex(a.c.CaptureError,'same_schema_requires_frozen_startup'):
                        a.temporary(cfg,{'volume':'v'},{'HostConfig':{}},'image','id','net','run',self.root/'env','token',False)
                api.assert_not_called()

    def test_same_schema_migrate_starts_only_frozen_candidate(self):
        cfg=SimpleNamespace(same_schema=True,capture=self.root/'capture',candidate='candidate',revision='a'*40)
        cfg.capture.mkdir()
        receipt={'volume':'v','image':'old','image_id':'old-id'}
        original={'Config':{'Env':[]}}
        def run(args,*unused,**kwargs):
            if args[:3]==['docker','network','inspect']:
                # Read the run id the helper persisted rather than patch UUIDs.
                started=json.loads((cfg.capture/'activation/started.json').read_text())
                return json.dumps([{'Driver':'bridge','Labels':{a.LABEL:started['run_id']},'Containers':{}}]).encode()
            return b''
        with patch.object(a,'original_source',return_value=original), patch.object(a,'no_writers'), patch.object(a,'marker',return_value=9), patch.object(a,'baseline_matches'), patch.object(a,'pending'), patch.object(a.c,'run',side_effect=run), patch.object(a,'temporary',return_value=9) as temporary, patch.object(a,'compare_snapshot',return_value={'sources':1}):
            a.migrate(cfg,receipt,'token',self.root,'candidate-id')
        self.assertEqual(temporary.call_count,1)
        self.assertEqual(temporary.call_args.args[3],'candidate')
        self.assertIs(temporary.call_args.args[-1],False)
        receipt=json.loads((cfg.capture/'activation/migrated.json').read_text())
        self.assertIs(receipt['same_schema'],True)
        self.assertFalse((cfg.capture/'activation/candidate.env').exists())

    def test_environment_private_preserved_and_not_overwritten(self):
        path=self.root/'env'
        original={'Config':{'Env':['SYNTHETIC_TOKEN=secret value','EMPTY=','EQUAL=a=b']}}
        a.env_file(path,original)
        self.assertEqual(path.read_text(),'SYNTHETIC_TOKEN=secret value\nEMPTY=\nEQUAL=a=b\n')
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        with self.assertRaises(FileExistsError): a.env_file(path,original)

    def test_environment_newline_and_duplicate_rejected(self):
        for values in [['A=x\nB=y'],['A=x','A=y']]:
            with self.assertRaises(a.c.CaptureError): a.env_file(self.root/'env',{'Config':{'Env':values}})

    def test_identical_environment_duplicates_and_candidate_revision(self):
        path=self.root/'env'
        a.env_file(path,{'Config':{'Env':['BASE_URL=https://test.invalid','BASE_URL=https://test.invalid','WIKICONTEXT_REVISION='+'a'*40]}}, 'b'*40)
        self.assertEqual(path.read_text(),'BASE_URL=https://test.invalid\nWIKICONTEXT_REVISION='+'b'*40+'\n')

    def temporary_row(self):
        return {'Image':'digest','Config':{'Labels':{a.LABEL:'run'}},
                'HostConfig':{'PortBindings':{},'PublishAllPorts':False,'Privileged':False,'RestartPolicy':{'Name':'no'}},
                'NetworkSettings':{'Networks':{'private':{}}},
                'Mounts':[{'Name':'volume','Destination':'/storage','RW':True}]}

    def test_temporary_network_ports_labels_enforced(self):
        row=self.temporary_row()
        a.verify_temporary(row,'digest','volume','private','run')
        variants=[]
        changed=copy.deepcopy(row);changed['Config']['Labels']['once']='{}';variants.append(changed)
        changed=copy.deepcopy(row);changed['HostConfig']['PortBindings']={'80/tcp':[{}]};variants.append(changed)
        changed=copy.deepcopy(row);changed['NetworkSettings']['Networks']['once']={};variants.append(changed)
        changed=copy.deepcopy(row);changed['Mounts'].append({'Name':'other'});variants.append(changed)
        for value in variants:
            with self.assertRaises(a.c.CaptureError): a.verify_temporary(value,'digest','volume','private','run')

    def test_once_alias_mounts_allowed_but_unrelated_mounts_rejected(self):
        storage={'Name':'volume','Type':'volume','Destination':'/storage','RW':True}
        rails={**storage,'Destination':'/rails/storage'}
        a.once_mounts({'Mounts':[storage]},'volume')
        a.once_mounts({'Mounts':[storage,rails]},'volume')
        for mounts in ([storage,rails,{**storage,'Destination':'/extra'}], [storage,{**rails,'Name':'other'}], [storage,{**rails,'RW':False}], [storage,storage]):
            with self.assertRaises(a.c.CaptureError):a.once_mounts({'Mounts':mounts},'volume')

    def test_other_writer_rejected(self):
        rows=[{'Id':'another','Mounts':[{'Name':'volume'}]}]
        with patch.object(a.c,'run',side_effect=[json.dumps([{'Mountpoint':'/volumes/volume'}]).encode(),b'another\n',json.dumps(rows).encode()]):
            with self.assertRaisesRegex(a.c.CaptureError,'unexpected_volume_writer'): a.no_writers('volume')

    def test_restart_or_unclean_stop_refused(self):
        row={'State':{'Running':False,'ExitCode':0,'OOMKilled':False},'HostConfig':{'RestartPolicy':{'Name':'no'}}}
        a.stopped(row)
        row['HostConfig']['RestartPolicy']['Name']='always'
        with self.assertRaises(a.c.CaptureError): a.stopped(row)

    def test_plan_no_docker_or_private_access(self):
        result=subprocess.run([sys.executable,str(TOOLS/'activate_checkpoint.py'),'--capture','/nonexistent','--recovery-verification','/nonexistent','--candidate','not-validated-in-plan','--revision','none'],capture_output=True,text=True)
        self.assertEqual(result.returncode,0)
        self.assertEqual(json.loads(result.stdout)['status'],'plan_no_changes')

    def test_temporary_failure_stops_before_remove(self):
        events=[]
        def run(args,*unused,**kwargs):
            events.append(args[1])
            return ('a'*64).encode()
        with patch.object(a,'no_writers'),patch.object(a.c,'run',side_effect=run),patch.object(a,'inspect',return_value={'Id':'a'*64,'Image':'id','Config':{'Labels':{a.LABEL:'run'}},'Mounts':[{'Name':'v'}]}),patch.object(a,'verify_temporary',side_effect=RuntimeError('synthetic')),patch.object(a.c,'stop',side_effect=lambda unused:events.append('stop')):
            with self.assertRaises(RuntimeError):
                a.temporary(None,{'volume':'v'},{'HostConfig':{}},'image','id','net','run',self.root/'env','token',True)
        self.assertEqual(events,['run','stop','rm'])

    def test_uncertain_create_reply_stops_owned_container(self):
        events=[]
        def run(args,*unused,**kwargs):
            events.append(args[1])
            if args[1]=='run':raise RuntimeError('reply lost')
            return b''
        owned={'Id':'a'*64,'Image':'id','Config':{'Labels':{a.LABEL:'run'}},'Mounts':[{'Name':'v'}]}
        with patch.object(a,'no_writers'),patch.object(a.c,'run',side_effect=run),patch.object(a,'inspect',return_value=owned) as inspect,patch.object(a.c,'stop',side_effect=lambda unused:events.append('stop')):
            with self.assertRaises(RuntimeError):
                a.temporary(None,{'volume':'v'},{'HostConfig':{}},'image','id','net','run',self.root/'env','token',True)
        inspect.assert_called_once_with('wiki-checkpoint-run-old')
        self.assertEqual(events,['run','stop','rm'])

    def test_uncertain_stop_never_removes_container(self):
        events=[]
        def run(args,*unused,**kwargs):
            events.append(args[1]);return ('a'*64).encode()
        with patch.object(a,'no_writers'),patch.object(a.c,'run',side_effect=run),patch.object(a,'inspect',return_value={'Id':'a'*64,'Image':'id','Config':{'Labels':{a.LABEL:'run'}},'Mounts':[{'Name':'v'}]}),patch.object(a,'verify_temporary',side_effect=RuntimeError('synthetic')),patch.object(a.c,'stop',side_effect=RuntimeError('cannot stop')):
            with self.assertRaises(RuntimeError):
                a.temporary(None,{'volume':'v'},{'HostConfig':{}},'image','id','net','run',self.root/'env','token',True)
        self.assertEqual(events,['run'])


if __name__=='__main__':unittest.main()
