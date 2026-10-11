import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("remote", Path(__file__).resolve().parents[1] / "shared_host_remote.py")
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
ID = "22222222-2222-4222-8222-222222222222"

def scope():
    return {"id": ID, "existingProfile": "pocketdeploy-v1", "existingDeploymentId": "11111111-1111-4111-8111-111111111111", "host": "wiki-rehearsal.localhost", "port": 18081, "oldImage": "ghcr.io/example/wiki@sha256:" + "a"*64, "candidateImage": "ghcr.io/example/wiki@sha256:" + "b"*64, "cpus": .5, "memoryMB": 512, "maxPreparedBytes": 100000, "sourceOriginalsBucket": "source-files", "sourceReplicaBucket": "source-replica", "expiresUtc": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}

def environment():
    return {"WIKICONTEXT_S3_BUCKET": "clone-files", "WIKICONTEXT_S3_ENDPOINT": "https://storage.example.test", "WIKICONTEXT_S3_REGION": "auto", "WIKICONTEXT_S3_ACCESS_KEY_ID": "synthetic-original-key", "WIKICONTEXT_S3_SECRET_ACCESS_KEY": "synthetic-original-secret", "WIKICONTEXT_S3_FORCE_PATH_STYLE": "true", "LITESTREAM_BUCKET": "clone-replica", "LITESTREAM_PATH": "rehearsals/" + ID + "/data.db", "LITESTREAM_ENDPOINT": "https://storage.example.test", "LITESTREAM_REGION": "auto", "LITESTREAM_ACCESS_KEY_ID": "synthetic-replica-key", "LITESTREAM_SECRET_ACCESS_KEY": "synthetic-replica-secret", "LITESTREAM_SYNC_INTERVAL": "10s"}

def storage(env):
    return {"enabled": True, "bucket": env["WIKICONTEXT_S3_BUCKET"], "endpoint": env["WIKICONTEXT_S3_ENDPOINT"], "region": env["WIKICONTEXT_S3_REGION"], "accessKey": env["WIKICONTEXT_S3_ACCESS_KEY_ID"], "secret": env["WIKICONTEXT_S3_SECRET_ACCESS_KEY"], "forcePathStyle": True}

class HostTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.s = scope(); self.e = environment()
        self.name, self.volume, self.network = remote.names(ID)
        self.data = self.root / ID / "prepared"; self.data.mkdir(parents=True)
        (self.data / "data.db").write_bytes(b"synthetic database")
        digest = hashlib.sha256(b"synthetic database").hexdigest()
        self.receipt = {"version": 1, "maintenance": "writable", "network_isolation": "new-loopback-only-namespace", "source_unchanged": True, "domain_unchanged": True, "original_files_unchanged": True, "copied_sessions_revoked": True, "prepared_files": {"data.db": digest}, "prepared_database_sha256": digest, "binary_sha256": "c"*64, "clone_url": "http://wiki-rehearsal.localhost:18081", "storage_binding_sha256": hashlib.sha256(json.dumps(storage(self.e),sort_keys=True,separators=(',',':')).encode()).hexdigest()}
        self.receipt_path = self.data.parent / "prepared.preparation.json"
        self.receipt_path.write_text(json.dumps(self.receipt))
        self.records = {}; self.commands = []
        self.labels = {remote.LABEL: ID, "com.pocketcontext.purpose": remote.PURPOSE}
        for image in (self.s["oldImage"], self.s["candidateImage"]):
            self.records["image", image] = {"RepoDigests": [image], "Id": "sha256:" + image[-64:], "Config": {"Labels": {}}}
        for obj, attr, value in [(remote,"BASE",self.root), (remote,"RUN",self.root), (remote,"inspect",self.inspect), (remote,"run",self.docker_run)]:
            context=patch.object(obj,attr,value);context.start();self.addCleanup(context.stop)
        context=patch.object(remote.http.client,"HTTPConnection");self.http=context.start();self.addCleanup(context.stop)
        self.http.return_value.getresponse.return_value.status=200

    def inspect(self, kind, name): return copy.deepcopy(self.records.get((kind,name)))
    def docker_run(self, *args, **kwargs):
        self.commands.append(args)
        if args[:3] == ("docker","volume","create"): self.records["volume",args[-1]]={"Labels": self.labels}
        elif args[:3] == ("docker","network","create"): self.records["network",args[-1]]={"Labels": self.labels}
        elif args[:3] == ("docker","run","--rm"): return "c"*64 + "  /usr/local/bin/pocketcontext"
        elif args[:3] == ("docker","run","-d"):
            self.records["container",self.name]={"Id":"d"*64,"Image":self.records["image",args[-1]]["Id"],"Config":{"Labels":self.labels},"State":{"Running":True,"ExitCode":0,"OOMKilled":False},"Mounts":[{"Type":"volume","Name":self.volume,"Destination":"/storage"}],"NetworkSettings":{"Networks":{self.network:{}}},"HostConfig":{"PortBindings":{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"18081"}]},"NanoCpus":500000000,"Memory":512*1024**2,"RestartPolicy":{"Name":"no"},"PidsLimit":256}}
        elif args[:2] == ("docker","stop"):
            self.records["container",self.name]["State"]["Running"]=False
        elif args[:2] == ("docker","rm"): self.records.pop(("container",args[-1]),None)
        elif args[:3] in (("docker","volume","rm"),("docker","network","rm")): self.records.pop((args[1],args[-1]),None)
        return ""
    def call(self, action, env=None): return remote.main({"scope":self.s,"action":action,"environment":env or self.e})

    def test_restored_candidate_stopfirst_and_exact_cleanup(self):
        self.assertTrue(self.call("start-old")["healthy"])
        command=next(c for c in self.commands if c[:3]==("docker","run","-d"))
        self.assertIn("127.0.0.1:18081:80",command)
        self.assertFalse(any("once" in argument for command in self.commands for argument in command))
        self.commands.clear()
        self.assertTrue(self.call("candidate")["healthy"])
        stop=next(i for i,c in enumerate(self.commands) if c[:2]==("docker","stop"))
        start=next(i for i,c in enumerate(self.commands) if c[:3]==("docker","run","-d"))
        self.assertLess(stop,start)
        with self.assertRaisesRegex(RuntimeError,"old-ready"): self.call("candidate")
        self.assertTrue(self.call("remove")["removed"])
        self.assertTrue(self.data.exists())
        with self.assertRaisesRegex(RuntimeError,"retired"): self.call("start-old")

    def test_candidate_storage_rebinding_refused(self):
        self.call("start-old")
        other={**self.e,"LITESTREAM_SECRET_ACCESS_KEY":"changed-synthetic-secret"}
        with self.assertRaisesRegex(RuntimeError,"unchanged"): self.call("candidate",other)
        self.assertTrue(self.records["container",self.name]["State"]["Running"])

    def test_unclean_stop_and_foreign_volume_are_preserved(self):
        self.call("start-old")
        self.records["container",self.name]["State"]["ExitCode"]=137
        with self.assertRaisesRegex(RuntimeError,"Clean application stop"): self.call("remove")
        self.assertIn(("volume",self.volume),self.records)
        self.records["container",self.name]["Mounts"][0]["Name"]="production-volume"
        with self.assertRaisesRegex(RuntimeError,"Unexpected rehearsal mounts"): self.call("remove")

    def test_missing_proof_changes_symlinks_public_binding_and_metadata_failure_refused(self):
        (self.data/"symlink").symlink_to(self.data/"data.db")
        with self.assertRaisesRegex(RuntimeError,"regular"): remote.verify_prepared(self.data,self.s)
        (self.data/"symlink").unlink()
        (self.data/"data.db").write_bytes(b"modified")
        with self.assertRaisesRegex(RuntimeError,"manifest"): remote.verify_prepared(self.data,self.s)

    def test_source_bucket_reuse_and_shared_credentials_refused(self):
        for patch_values in ({"WIKICONTEXT_S3_BUCKET":"source-files"},{"LITESTREAM_BUCKET":"source-replica"},{"LITESTREAM_ACCESS_KEY_ID":self.e["WIKICONTEXT_S3_ACCESS_KEY_ID"]},{"LITESTREAM_PATH":"production/data.db"}):
            with self.assertRaises(RuntimeError): self.call("start-old",{**self.e,**patch_values})
        self.assertFalse(self.commands)

    def test_pending_marker_refuses_mutation_replay(self):
        (self.data.parent/"pending.json").write_text('{}')
        with self.assertRaisesRegex(RuntimeError,"Unfinished"): self.call("start-old")
        self.assertFalse(self.commands)

    def test_owned_label_is_not_enough_to_adopt_public_or_unlimited_container(self):
        self.call("start-old")
        self.records["container",self.name]["HostConfig"]["PortBindings"]["80/tcp"][0]["HostIp"]="0.0.0.0"
        with self.assertRaisesRegex(RuntimeError,"loopback"): self.call("candidate")

class BoundTests(unittest.TestCase):
    def test_shared_host_cpu_memory_and_public_name_refused(self):
        for key,value in (("cpus",1),("memoryMB",2048),("host","wiki.pocketcontext.com"),("port",80)):
            altered=scope();altered[key]=value
            with self.assertRaises(RuntimeError):remote.check_scope(altered)

if __name__ == "__main__": unittest.main()
