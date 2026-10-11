#!/usr/bin/env python3
"""Actual container S3 uploads and Litestream fresh-volume recovery, synthetic only."""
import argparse
import importlib.util, pathlib, tempfile, secrets, time
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True)
parser.add_argument('--minio-image', required=True, help='Local MinIO fixture image including mc')
args = parser.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('smoke',root/'docker/smoke.py');s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
run_id=secrets.token_hex(4);network='wiki-s3-'+run_id;minio=network+'-minio'
failed=True
try:
 s.docker('network','create',network);s.networks.append(network)
 access='synthetic'+run_id;secret=s.secret(secrets.token_hex(24));mc={'MC_HOST_test':s.secret(f'http://{access}:{secret}@127.0.0.1:9000')}
 s.containers.append(minio)
 s.docker('run','-d','--name',minio,'--network',network,'-e','MINIO_ROOT_USER','-e','MINIO_ROOT_PASSWORD',args.minio_image,'server','/data',env={'MINIO_ROOT_USER':access,'MINIO_ROOT_PASSWORD':secret})
 for _ in range(30):
  status,_=s.docker('exec','-e','MC_HOST_test',minio,'mc','mb','--ignore-existing','test/files','test/replica',env=mc,ok=False)
  if status==0:break
  time.sleep(1)
 else:raise RuntimeError('MinIO fixture failed')
 env=s.once_env({'WIKICONTEXT_S3_BUCKET':'files','WIKICONTEXT_S3_ENDPOINT':f'http://{minio}:9000','WIKICONTEXT_S3_REGION':'us-east-1','WIKICONTEXT_S3_ACCESS_KEY_ID':access,'WIKICONTEXT_S3_SECRET_ACCESS_KEY':secret,'LITESTREAM_BUCKET':'replica','LITESTREAM_PATH':'test/data','LITESTREAM_ENDPOINT':f'http://{minio}:9000','LITESTREAM_REGION':'us-east-1','LITESTREAM_ACCESS_KEY_ID':access,'LITESTREAM_SECRET_ACCESS_KEY':secret,'LITESTREAM_SYNC_INTERVAL':'1h'})
 # Calling the supervised child without its private control socket must not serve.
 probe=['run','--rm']
 for key in env: probe.extend(['-e',key])
 status,output=s.docker(*probe,args.image,'serve',env=env,ok=False)
 s.check(status != 0 and 'initial replica synchronization failed' in output and 'starting server on port 80' not in output,
     'missing replication IPC refuses HTTP startup')
 with tempfile.TemporaryDirectory(prefix='wiki-image-s3-') as td:
  tmp=pathlib.Path(td);first=network+'-a';second=network+'-b';recovered=network+'-c'
  s.initialize(args.image,first,env,network)
  s.run_app(args.image,first,first,env,network);base=s.wait_up(first)
  admin=s.superuser_token(base,env['WIKICONTEXT_SUPERUSER_EMAIL'],env['WIKICONTEXT_SUPERUSER_PASSWORD'])
  password=s.secret(secrets.token_urlsafe(24));user=s.provision_user(base,admin,'restore@example.test',password)
  client=s.Client(base,'restore@example.test',password,tmp/'home-a')
  doc,meta=s.write_record(client,user);s.check_records(client,doc,meta)
  status,_,personal=s.http('POST',base+'/api/wiki/spaces/personal',{},token=client.token)
  s.check(status==200,'explicit personal space created for recovery fixture')
  private_space=personal['id']
  private_doc,private_meta=s.write_record(client,user,space=private_space)
  s.check_records(client,private_doc,private_meta,space=private_space)
  outsider_password=s.secret(secrets.token_urlsafe(24))
  s.provision_user(base,admin,'outsider@example.test',outsider_password)
  def check_private_recovery(owner,endpoint,label):
   s.check_records(owner,private_doc,private_meta,space=private_space)
   outsider=s.Client(endpoint,'outsider@example.test',outsider_password,tmp/label)
   s.check(outsider.sql(f"SELECT id FROM sources WHERE id='{private_doc}'")==[], 'recovered private source stays absent from company peer SQL')
   status,_,_=s.http('GET',endpoint+'/api/collections/sources/records/'+private_doc,token=outsider.token)
   s.check(status==404,'recovered private source retains independent record access')
   status,_,file_token=s.http('POST',endpoint+'/api/files/token',{},token=outsider.token)
   s.check(status==200,'company peer can request only its own file token')
   path='/api/files/'+private_meta[0]+'/'+private_doc+'/'+private_meta[1]+'?token='+file_token['token']
   status,_,_=s.http('GET',endpoint+path)
   s.check(status==404,'recovered private original rejects company peer file token')
  s.check(s.docker('exec',first,'sh','-c','find /storage/pb_data/storage -type f 2>/dev/null || true')[1].strip()=='','no local originals')
  s.check('initial replica synchronization complete' in s.logs(first),'HTTP starts only after initial remote synchronization')
  base=s.maintenance_roundtrip(first,base,admin,client,doc,meta)
  s.check(s.logs(first).count('initial replica synchronization complete') >= 2,
      'frozen S3 restart still synchronizes its replica before HTTP')
  s.stop(first)
  s.check('uploaded verified database and originals' not in s.logs(first),'no complete archive supervisor used')
  # Restore without starting a second writer. Exit zero alone is not proof of sync.
  s.docker('volume','create',second);s.volumes.append(second)
  restore_args=['run','--rm','--network',network,'-v',f'{second}:/storage']
  for key in env: restore_args.extend(['-e',key])
  s.docker(*restore_args,'--entrypoint','sh',args.image,'-c',
      'mkdir -p /storage/pb_data; exec litestream restore -config /etc/litestream.yml /storage/pb_data/data.db',env=env)
  # Read both stopped databases in the image's SQLite runtime, with no raw data output.
  s.docker('run','--rm','-v',f'{first}:/source:ro','-v',f'{second}:/restored:ro',
      '-v',str(root/'tests')+':/tests:ro','--entrypoint','sh',args.image,'-c',
      'cp -a /source/pb_data /tmp/source; cp -a /restored/pb_data /tmp/restored; '
      'exec python3 /tests/object_storage_recovery.py --verify-source /tmp/source/data.db --verify-restored /tmp/restored/data.db')
  s.check(True,'entire recovered database equals stopped source before volume destruction')
  s.docker('rm',first);s.docker('volume','rm',first);s.volumes.remove(first)
  # Leave the comparison restore untouched: default startup must itself recover an empty volume.
  s.run_app(args.image,recovered,recovered,env,network);base=s.wait_up(recovered)
  client=s.Client(base,'restore@example.test',password,tmp/'home-b');s.check_records(client,doc,meta)
  check_private_recovery(client,base,'outsider-restored')
  restored_admin=s.superuser_token(base,env['WIKICONTEXT_SUPERUSER_EMAIL'],env['WIKICONTEXT_SUPERUSER_PASSWORD'])
  status,_,maintenance=s.http('GET',base+'/api/context/maintenance',token=restored_admin)
  s.check(status==200 and maintenance.get('generation')==0 and maintenance.get('state')=='writable',
      'database-only recovery does not inherit the source maintenance marker')
  s.check('restored verified database and originals' not in s.logs(recovered),'no old archive restore')
  s.check('restor' in s.logs(recovered).lower(),'default entrypoint restored an absent database')
  # Confirm the new API write reached the replica before simulating sudden host loss.
  late,late_meta=s.write_record(client,user)
  s.docker('exec',recovered,'litestream','sync','-wait','-timeout','60',
      '-socket','/run/litestream.sock','/storage/pb_data/data.db')
  s.docker('kill',recovered)
  s.check_logs(recovered)
  crashed=network+'-crash-recovery'
  s.run_app(args.image,crashed,crashed,env,network);base=s.wait_up(crashed)
  client=s.Client(base,'restore@example.test',password,tmp/'home-crash')
  s.check_records(client,doc,meta);s.check_records(client,late,late_meta)
  check_private_recovery(client,base,'outsider-crash')
  s.stop(crashed);s.check_logs(crashed)
  s.check('litestream shut down' in s.logs(crashed),'Litestream supervises graceful server shutdown')
  # Each rejected startup uses an empty volume, so S3 verification occurs after restore.
  def refuse_start(label, supplied):
   name=network+'-'+label
   s.run_app(args.image,name,name,supplied,network)
   deadline=time.monotonic()+90
   while time.monotonic()<deadline:
    running,code=s.state_quiet(name)
    endpoint=s.base_url_quiet(name)
    s.check(not endpoint or s.http('GET',endpoint+'/up')[0]!=200,label+' never exposes HTTP')
    if not running:break
    time.sleep(1)
   else:raise RuntimeError(label+' failed to terminate')
   s.check(code!=0,label+' exits with failure')
   s.check('starting server on port 80' not in s.check_logs(name),label+' refuses serving')
   s.docker('run','--rm','-v',name+':/storage:ro','--entrypoint','python3',args.image,
       '-c','from pathlib import Path; assert not Path("/storage/pb_data/data.db").exists()')
   s.check(True,label+' never installs an unverified restored database')
  refuse_start('missing-replica',{**env,'LITESTREAM_PATH':'absent/data'})
  refuse_start('unavailable-originals',{**env,'WIKICONTEXT_S3_ENDPOINT':'http://127.0.0.1:9'})
  key='/'.join((meta[0],doc,meta[1]))
  original=tmp/'original';original.write_bytes(meta[2])
  corrupt=tmp/'corrupt';corrupt.write_bytes(b'Corrupt synthetic original')
  s.docker('cp',str(corrupt),minio+':/tmp/corrupt')
  s.docker('exec','-e','MC_HOST_test',minio,'mc','cp','/tmp/corrupt','test/files/'+key,env=mc)
  refuse_start('corrupt-original',env)
  s.docker('exec','-e','MC_HOST_test',minio,'mc','rm','test/files/'+key,env=mc)
  refuse_start('missing-original',env)
  s.docker('cp',str(original),minio+':/tmp/original')
  s.docker('exec','-e','MC_HOST_test',minio,'mc','cp','/tmp/original','test/files/'+key,env=mc)
  # An explicit init cannot replace a populated remote replica even with an empty volume.
  probe_volume=network+'-init-refused';s.docker('volume','create',probe_volume);s.volumes.append(probe_volume)
  init_args=['run','--rm','--network',network,'-v',probe_volume+':/storage']
  for key in env:init_args.extend(['-e',key])
  status,output=s.docker(*init_args,args.image,'init',env=env,ok=False)
  s.check(status!=0,'init refuses populated replica')
  s.check_logs('refused init',output)
  s.check('full-backups/' not in s.docker('exec','-e','MC_HOST_test',minio,'mc','ls','--recursive','test/replica',env=mc)[1],'no complete archives emitted')
 # No-superuser deployments still create a database before the startup handshake.
 bootstrap=network+'-google-only'
 bootstrap_env={key:value for key,value in env.items() if not key.startswith('WIKICONTEXT_SUPERUSER_')}
 bootstrap_env['LITESTREAM_PATH']='google-only/data'
 s.initialize(args.image,bootstrap,bootstrap_env,network)
 s.run_app(args.image,bootstrap,bootstrap,bootstrap_env,network);s.wait_up(bootstrap)
 s.check('initial replica synchronization complete' in s.logs(bootstrap),'Google-only fresh database synchronized before HTTP')
 s.stop(bootstrap)
 failed=False
 print('PASS actual image entrypoint S3 upload + Litestream final sync + destroy source volume + fresh-volume restore')
finally:s.report_and_clean(failed)
