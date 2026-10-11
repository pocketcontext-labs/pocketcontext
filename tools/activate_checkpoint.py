#!/usr/bin/env python3
"""Fenced production migration. Default plan; explicit phases never imply thaw.

Use only after complete off-host recovery verification. Keep pending marker until
operator acceptance; this tool never removes it. Diagnostics never contain data.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import uuid

import capture_checkpoint as c
from verify_checkpoint_replica import database_digest

DOMAIN = ('sources', 'renditions', 'passages', 'ingestion_runs', 'pages',
          'page_revisions', 'citations', 'page_links', 'publications', 'audit_log')
COMPANY = 'companyspace001'
LABEL = 'com.pocketcontext.checkpoint-migration'
API_CODE = r'''import json,sys,urllib.request
p=json.load(sys.stdin)
h={'Content-Type':'application/json','Authorization':p['token']}
def request(method,path,data=None):
 r=urllib.request.Request('http://127.0.0.1:80'+path,method=method,headers=h,data=None if data is None else json.dumps(data).encode())
 with urllib.request.urlopen(r,timeout=30) as response:return json.load(response)
state=request('GET','/api/context/maintenance')
if 'readOnly' in p:
 state=request('PUT','/api/context/maintenance',{'readOnly':p['readOnly'],'expectedGeneration':state['generation']})
assert state['state'] in ('writable','read_only')
print(json.dumps({'state':state['state'],'generation':state['generation']}))
'''


def read(path):
    return json.loads(c.trusted(path, private=True).read_text())


def inspect(container):
    row, = json.loads(c.run(['docker', 'inspect', container]))
    return row


def candidate(image, revision):
    c.require(re.fullmatch(r'ghcr.io/pocketcontext/wikicontext@sha256:[a-f0-9]{64}', image), 'invalid_candidate')
    c.require(re.fullmatch(r'[a-f0-9]{40}', revision), 'invalid_revision')
    row, = json.loads(c.run(['docker', 'image', 'inspect', image]))
    c.require(image in row.get('RepoDigests', []), 'candidate_digest_mismatch')
    c.require('once' not in (row.get('Config', {}).get('Labels') or {}), 'image_has_route_label')
    c.require(row.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == revision, 'candidate_revision_mismatch')
    return row['Id']


def no_writers(volume, allowed=None):
    info, = json.loads(c.run(['docker', 'volume', 'inspect', volume]))
    source = Path(info['Mountpoint'])
    c.require(source.is_absolute(), 'volume_source_invalid')
    ids = c.run(['docker', 'ps', '-q', '--no-trunc']).decode().split()
    rows = json.loads(c.run(['docker', 'inspect', *ids])) if ids else []
    for row in rows:
        if any(m.get('Name') == volume or (m.get('Source') and (Path(m['Source']).is_relative_to(source) or source.is_relative_to(Path(m['Source'])))) for m in row.get('Mounts', [])):
            c.require(row['Id'] == allowed, 'unexpected_volume_writer')


def stopped(row):
    c.require(not row['State']['Running'] and row['State']['ExitCode'] == 0
              and not row['State'].get('OOMKilled')
              and row['HostConfig']['RestartPolicy']['Name'] == 'no', 'source_not_fenced')


def pending(receipt, directory):
    p = read(c.PENDING)
    c.require(p == {'purpose': 'wikicontext-predeployment-checkpoint', 'output': str(directory),
                    'container_id': receipt['container_id']}, 'pending_mismatch')


def control(cfg):
    c.require(os.geteuid() == 0, 'root_required')
    c.trusted(cfg.capture, directory=True, private=True)
    receipt = read(cfg.capture / 'receipt.json')
    c.require(receipt['status'] == 'captured_source_stopped_not_offhost_verified', 'capture_incomplete')
    verification = read(cfg.recovery_verification)
    for key in ('remote_verified', 'database_integrity_verified', 'all_files_verified'):
        c.require(verification.get(key) is True, 'recovery_not_verified')
    c.require(verification.get('writer_started') is False
              and verification.get('capture_receipt_sha256') == c.digest(cfg.capture / 'receipt.json'), 'recovery_binding_mismatch')
    token = read(cfg.capture / 'recovery-control.json')
    c.require(c.digest(cfg.capture / 'recovery-control.json') == receipt['artifacts']['recovery-control.json']['sha256'], 'control_changed')
    c.require(token['container_id'] == receipt['container_id'] and token['image'] == receipt['image'], 'control_mismatch')
    pending(receipt, cfg.capture)
    image_id = candidate(cfg.candidate, cfg.revision)
    c.require(cfg.candidate != receipt['image'], 'candidate_is_old_image')
    volume, = json.loads(c.run(['docker', 'volume', 'inspect', receipt['volume']]))
    c.require(volume['Driver'] == 'local' and not volume.get('Options'), 'volume_mismatch')
    source = c.trusted(Path(volume['Mountpoint']), directory=True)
    c.require(not cfg.capture.is_relative_to(source) and not source.is_relative_to(cfg.capture), 'source_overlap')
    return receipt, token['token'], source, image_id


def api(container, token, read_only=None):
    payload = {'token': token}
    if read_only is not None:
        payload['readOnly'] = read_only
    return json.loads(c.run(['docker', 'exec', '-i', container, 'python3', '-c', API_CODE], json.dumps(payload).encode(), timeout=40))


def ready(container, token):
    deadline = time.monotonic() + 300
    while True:
        try:
            return api(container, token)
        except Exception:
            c.require(inspect(container)['State']['Running'], 'startup_failed')
            c.require(time.monotonic() < deadline, 'startup_timeout')
            time.sleep(2)


def marker(source, frozen):
    value = read(source / 'pb_data/maintenance.json')
    c.require(set(value) == {'readOnly', 'generation'} and value['readOnly'] is frozen
              and type(value['generation']) is int, 'maintenance_mismatch')
    return value['generation']


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def compare_databases(before, after, same_schema=False):
    """Read-only, bounded row streaming; never log a row or private identifier."""
    if same_schema:
        c.require(database_digest(before) == database_digest(after), 'same_schema_database_changed')
        # Full schema and every persisted row, including auth, memberships and
        # private spaces, must match. Only counts leave this private comparison.
        with closing(sqlite3.connect(after.as_uri() + '?mode=ro', uri=True)) as db:
            return {table: db.execute('SELECT count(*) FROM ' + quote(table)).fetchone()[0] for table in DOMAIN}
    old = sqlite3.connect(before.as_uri() + '?mode=ro', uri=True)
    new = sqlite3.connect(after.as_uri() + '?mode=ro', uri=True)
    counts = {}
    try:
        for db in (old, new):
            c.require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'database_integrity')
        for table in DOMAIN:
            columns = [r[1] for r in old.execute('PRAGMA table_info(' + quote(table) + ')')]
            c.require(columns and 'id' in columns and 'space' not in columns, 'baseline_schema_mismatch')
            current = [r[1] for r in new.execute('PRAGMA table_info(' + quote(table) + ')')]
            c.require(set(current) == set(columns) | {'space'}, 'candidate_schema_mismatch')
            query = 'SELECT ' + ','.join(quote(k) for k in columns) + ' FROM ' + quote(table) + ' ORDER BY id'
            a, b = old.execute(query), new.execute(query)
            count = 0
            while True:
                left, right = a.fetchmany(128), b.fetchmany(128)
                c.require(left == right, 'legacy_domain_changed')
                if not left:
                    break
                count += len(left)
            c.require(new.execute('SELECT count(*) FROM ' + quote(table) + ' WHERE space IS NOT ?',(COMPANY,)).fetchone()[0] == 0, 'company_backfill_mismatch')
            counts[table] = count
        c.require(new.execute('SELECT id,kind,name FROM spaces').fetchall() == [(COMPANY, 'group', 'Company')], 'unexpected_spaces')
        accounts = old.execute('SELECT id,disabled FROM users ORDER BY id').fetchall()
        memberships = new.execute('SELECT account,role,active FROM space_members WHERE space=? ORDER BY account', (COMPANY,)).fetchall()
        c.require(memberships == [(i, 'editor', int(not d)) for i, d in accounts], 'company_membership_mismatch')
        c.require(new.execute('SELECT count(*) FROM space_members').fetchone()[0] == len(accounts), 'unexpected_memberships')
        c.require(new.execute('SELECT id,disabled FROM users ORDER BY id').fetchall() == accounts, 'account_admission_changed')
    finally:
        old.close(); new.close()
    return counts


def compare_snapshot(cfg, receipt, source):
    # SQLite read-only can maintain SHM; inspect temporary copies, never checkpoint bytes.
    with tempfile.TemporaryDirectory(prefix='compare-', dir=cfg.capture) as scratch:
        root = Path(scratch)
        for name, origin in [('before', cfg.capture / 'pb_data'), ('after', source / 'pb_data')]:
            target = root / name
            target.mkdir(mode=0o700)
            for leaf in ('data.db', 'data.db-wal', 'data.db-shm'):
                p = origin / leaf
                if p.exists():
                    c.trusted(p)
                    if name == 'before':
                        c.require(c.digest(p) == receipt['artifacts']['pb_data/' + leaf]['sha256'], 'baseline_changed')
                    shutil.copyfile(p, target / leaf)
                    (target / leaf).chmod(0o600)
        return compare_databases(root / 'before/data.db', root / 'after/data.db', getattr(cfg, 'same_schema', False))


def env_file(path, original, revision=None):
    values = original['Config']['Env']
    c.require(isinstance(values, list) and all(isinstance(v, str) and '=' in v and not any(x in v for x in ('\n','\r','\x00')) for v in values), 'unsupported_environment')
    canonical = {}
    for entry in values:
        name, value = entry.split('=', 1)
        c.require(name not in canonical or canonical[name] == value, 'conflicting_environment')
        canonical[name] = value
    if revision is not None:
        c.require(re.fullmatch(r'[a-f0-9]{40}', revision), 'invalid_revision')
        canonical['WIKICONTEXT_REVISION'] = revision
    values = [name + '=' + value for name, value in canonical.items()]
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write('\n'.join(values) + '\n'); stream.flush(); os.fsync(stream.fileno())


def verify_temporary(row, image_id, volume, network, run_id):
    c.require(row['Image'] == image_id, 'temporary_image_mismatch')
    labels = row['Config'].get('Labels') or {}
    c.require('once' not in labels and labels.get(LABEL) == run_id, 'temporary_route_label')
    c.require(not row['HostConfig'].get('PortBindings') and not row['HostConfig'].get('PublishAllPorts')
              and not row['HostConfig'].get('Privileged') and row['HostConfig']['RestartPolicy']['Name'] == 'no', 'temporary_exposure')
    c.require(set(row['NetworkSettings']['Networks']) == {network}, 'temporary_network_mismatch')
    mounts = row['Mounts']
    c.require(len(mounts) == 1 and mounts[0].get('Name') == volume
              and mounts[0].get('Destination') == '/storage' and mounts[0].get('RW'), 'temporary_mount_mismatch')


def temporary(cfg, receipt, original, image, image_id, network, run_id, env, token, thaw):
    no_writers(receipt['volume'])
    name = 'wiki-checkpoint-' + run_id + ('-old' if thaw else '-candidate')
    args = ['docker', 'run', '-d', '--name', name, '--network', network,
            '--restart=no', '--label', LABEL + '=' + run_id, '--env-file', str(env),
            '--mount', 'type=volume,src=' + receipt['volume'] + ',dst=/storage']
    for field, flag in [('Memory','--memory'), ('NanoCpus','--cpus'), ('PidsLimit','--pids-limit')]:
        value = original['HostConfig'].get(field)
        if value and value > 0:
            args.extend([flag, str(value / 1_000_000_000 if field == 'NanoCpus' else value)])
    container = None
    try:
        container = c.run(args + [image]).decode().strip()
        c.require(re.fullmatch(r'[a-f0-9]{64}', container), 'temporary_create_uncertain')
        verify_temporary(inspect(container), image_id, receipt['volume'], network, run_id)
        no_writers(receipt['volume'], container)
        state = ready(container, token)
        if getattr(cfg, 'same_schema', False):
            c.require(not thaw and state['state'] == 'read_only', 'same_schema_requires_frozen_startup')
        else:
            c.require(state['state'] == ('read_only' if thaw else 'writable'), 'unexpected_startup_maintenance')
            state = api(container, token, not thaw)
            c.require(state['state'] == ('writable' if thaw else 'read_only'), 'maintenance_transition_failed')
        c.stop(container)
        return state['generation']
    finally:
        # Never remove an uncertain writer: leave all evidence and pending fence.
        try:
            owned = inspect(container or name)
        except Exception:
            # A failed create reply may hide a started container. Engine inspection
            # plus an empty writer set is required before declaring it absent.
            no_writers(receipt['volume'])
            owned = None
        if owned is not None:
            c.require(owned['Image'] == image_id and (owned['Config'].get('Labels') or {}).get(LABEL) == run_id
                      and any(m.get('Name') == receipt['volume'] for m in owned.get('Mounts', [])), 'uncertain_temporary_identity')
            c.stop(owned['Id'])
            c.run(['docker', 'rm', owned['Id']])


def once_mounts(row, volume):
    mounts = row['Mounts']
    destinations = {m.get('Destination') for m in mounts}
    c.require(destinations in ({'/storage'}, {'/storage', '/rails/storage'})
              and len(mounts) == len(destinations)
              and all(m.get('Name') == volume and m.get('Type') == 'volume' and m.get('RW') for m in mounts), 'once_volume_changed')


def original_source(receipt):
    row = inspect(receipt['container_id'])
    stopped(row)
    c.require(row['Image'] == receipt['image_id'], 'old_image_changed')
    settings = json.loads(row['Config']['Labels']['once'])
    c.require(settings.get('host') == c.HOST and settings.get('image') == receipt['image']
              and settings.get('autoUpdate') is False, 'old_settings_changed')
    once_mounts(row, receipt['volume'])
    return row


def baseline_matches(receipt, directory, source):
    for leaf in ('data.db', 'data.db-wal', 'data.db-shm', 'auxiliary.db', 'auxiliary.db-wal', 'auxiliary.db-shm', 'maintenance.json'):
        expected = receipt['artifacts'].get('pb_data/' + leaf)
        current = source / 'pb_data' / leaf
        if expected is None:
            c.require(not current.exists() and not current.is_symlink(), 'uncheckpointed_database_file')
        else:
            c.trusted(current)
            c.require(c.digest(current) == expected['sha256'] and current.stat().st_size == expected['bytes'], 'source_changed_since_capture')
            checkpoint = c.trusted(directory / 'pb_data' / leaf, private=True)
            c.require(c.digest(checkpoint) == expected['sha256'], 'baseline_changed')


def migrate(cfg, receipt, token, source, image_id):
    original = original_source(receipt)
    no_writers(receipt['volume'])
    initial_generation = marker(source, True)
    baseline_matches(receipt, cfg.capture, source)
    state = cfg.capture / 'activation'
    c.require(not state.exists(), 'migration_already_started_reconcile')
    state.mkdir(mode=0o700); c.sync_dir(cfg.capture)
    run_id = uuid.uuid4().hex
    network = 'wiki-checkpoint-' + run_id
    c.save(state / 'started.json', {'candidate': cfg.candidate, 'revision': cfg.revision, 'run_id': run_id, 'network': network, 'same_schema': getattr(cfg, 'same_schema', False)})
    c.run(['docker', 'network', 'create', '--driver', 'bridge', '--label', LABEL + '=' + run_id, network])
    net, = json.loads(c.run(['docker', 'network', 'inspect', network]))
    c.require(net['Driver'] == 'bridge' and net.get('Labels', {}).get(LABEL) == run_id and not net.get('Containers'), 'network_isolation_mismatch')
    env = state / 'temporary.env'
    candidate_env = state / 'candidate.env'
    env_file(env, original)
    env_file(candidate_env, original, cfg.revision)
    try:
        if not getattr(cfg, 'same_schema', False):
            temporary(cfg, receipt, original, receipt['image'], receipt['image_id'], network, run_id, env, token, True)
        original_source(receipt); pending(receipt, cfg.capture); marker(source, getattr(cfg, 'same_schema', False))
        generation = temporary(cfg, receipt, original, cfg.candidate, image_id, network, run_id, candidate_env, token, False)
        no_writers(receipt['volume']); final_generation = marker(source, True)
        if getattr(cfg, 'same_schema', False):
            c.require(generation == final_generation == initial_generation, 'same_schema_maintenance_changed')
        counts = compare_snapshot(cfg, receipt, source)
        c.save(state / 'migrated.json', {'candidate': cfg.candidate, 'revision': cfg.revision,
                                       'generation': generation, 'legacy_counts': counts, 'same_schema': getattr(cfg, 'same_schema', False)})
    finally:
        env.unlink(missing_ok=True)
        candidate_env.unlink(missing_ok=True)
    c.run(['docker', 'network', 'rm', network])
    return {'status': 'migrated_verified_frozen_stopped', 'tables_verified': len(DOMAIN)}


def once_source(receipt, image_id):
    ids = c.run(['docker', 'ps', '-aq', '--no-trunc']).decode().split()
    matches = []
    for row in json.loads(c.run(['docker', 'inspect', *ids])) if ids else []:
        try:
            settings = json.loads((row['Config'].get('Labels') or {}).get('once', '{}'))
        except (ValueError, TypeError):
            continue
        if settings.get('host') == c.HOST:
            matches.append((row, settings))
    c.require(len(matches) == 1, 'once_identity_ambiguous')
    row, settings = matches[0]
    c.require(row['Image'] == image_id and row['State']['Running'] and settings.get('autoUpdate') is False, 'once_candidate_mismatch')
    once_mounts(row, receipt['volume'])
    return row, settings


def phase(cfg):
    os.umask(0o077)
    with c.locks():
        receipt, token, source, image_id = control(cfg)
        if cfg.phase == 'preflight':
            original_source(receipt); no_writers(receipt['volume']); marker(source, True)
            baseline_matches(receipt, cfg.capture, source)
            c.require(not (cfg.capture / 'activation').exists(), 'migration_already_started_reconcile')
            return {'status': 'preflight_passed_no_migration'}
        if cfg.phase == 'migrate':
            return migrate(cfg, receipt, token, source, image_id)
        state = cfg.capture / 'activation'
        c.trusted(state, directory=True, private=True)
        migrated = read(state / 'migrated.json')
        c.require(migrated['candidate'] == cfg.candidate and migrated['revision'] == cfg.revision, 'migration_identity_mismatch')
        c.require(migrated.get('same_schema', False) == getattr(cfg, 'same_schema', False), 'activation_mode_mismatch')
        marker(source, True)
        if cfg.phase == 'activate':
            original_source(receipt); no_writers(receipt['volume'])
            compare_snapshot(cfg, receipt, source)
            c.save(state / 'activation-started.json', {'candidate': cfg.candidate})
            try:
                # ONCE v0.3.3 has no strategy flag. The source is explicitly stopped.
                c.run(['once', 'update', c.HOST, '--image', cfg.candidate], timeout=900)
                row, settings = once_source(receipt, image_id)
                c.require(settings.get('image') == cfg.candidate, 'once_image_not_pinned')
                no_writers(receipt['volume'], row['Id'])
                c.require(ready(row['Id'], token)['state'] == 'read_only', 'public_candidate_not_frozen')
                marker(source, True)
                c.save(state / 'activated.json', {'container_id': row['Id'], 'candidate': cfg.candidate})
                return {'status': 'activated_frozen_pending_smoke', 'container_id': row['Id']}
            except BaseException:
                # Fence every application container mounting this volume, without
                # guessing which one ONCE retained after an uncertain update.
                ids = c.run(['docker', 'ps', '-aq', '--no-trunc']).decode().split()
                for row in json.loads(c.run(['docker', 'inspect', *ids])) if ids else []:
                    if any(m.get('Name') == receipt['volume'] for m in row.get('Mounts', [])):
                        c.stop(row['Id'])
                raise
        activated = read(state / 'activated.json')
        row, settings = once_source(receipt, image_id)
        c.require(row['Id'] == activated['container_id'] and settings.get('image') == cfg.candidate, 'activated_identity_mismatch')
        no_writers(receipt['volume'], row['Id'])
        c.require(ready(row['Id'], token)['state'] == 'read_only', 'thaw_requires_frozen')
        c.save(state / 'thaw-started.json', {'container_id': row['Id']})
        try:
            result = api(row['Id'], token, False)
            c.require(result['state'] == 'writable', 'thaw_failed')
            marker(source, False)
            c.save(state / 'thawed.json', {'container_id': row['Id'], 'generation': result['generation']})
        except BaseException:
            c.stop(row['Id'])
            raise
        return {'status': 'writable_pending_operator_acceptance', 'generation': result['generation']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('plan','preflight','migrate','activate','thaw'), default='plan')
    parser.add_argument('--capture', type=Path, required=True)
    parser.add_argument('--recovery-verification', type=Path, required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--same-schema', action='store_true', help='Keep candidate frozen and require exact logical database equality; no migration thaw')
    cfg = parser.parse_args()
    try:
        if cfg.phase == 'plan':
            print(json.dumps({'status': 'plan_no_changes', 'phases': ['preflight','migrate','activate','thaw'], 'pending_fence_removed': False, 'same_schema': cfg.same_schema}))
        else:
            print(json.dumps(phase(cfg)))
        return 0
    except Exception:
        print('Activation stopped; private diagnostics suppressed. Preserve pending fence and checkpoint; reconcile before retry.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
