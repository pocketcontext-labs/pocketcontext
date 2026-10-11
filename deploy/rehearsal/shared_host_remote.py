"""Injected through pinned SSH; standalone remote code with no secret output."""
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import stat
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone

RUN = Path("/run")
BASE = Path("/var/lib/wikicontext-rehearsal")
PURPOSE = "wikicontext-private-rehearsal"
LABEL = "com.pocketcontext.rehearsal"

def run(*args, timeout=60):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("Rehearsal command failed; subprocess output suppressed")
    return result.stdout

def inspect(kind, name):
    result = subprocess.run(["docker", kind, "inspect", name], capture_output=True, text=True, timeout=30)
    if result.returncode:
        if kind == "image": raise RuntimeError("Image inspection failed")
        arguments = ["docker", kind, "ls"] + (["--all"] if kind == "container" else []) + ["--format", "{{.Names}}" if kind == "container" else "{{.Name}}"]
        present = run(*arguments).splitlines()
        if name not in present: return None
        raise RuntimeError("Resource inspection failed")
    return json.loads(result.stdout)[0]

def labels(record, kind):
    return record.get("Config", {}).get("Labels", {}) if kind == "container" else record.get("Labels", {})

def owned(kind, name, identity):
    record = inspect(kind, name)
    if record is not None and (labels(record, kind).get(LABEL) != identity or labels(record, kind).get("com.pocketcontext.purpose") != PURPOSE):
        raise RuntimeError("Rehearsal ownership mismatch")
    return record

def names(identity):
    if str(uuid.UUID(identity)) != identity: raise RuntimeError("Canonical rehearsal UUID required")
    prefix = "wiki-rehearsal-" + identity
    return prefix, prefix + "-data", prefix + "-network"

def check_scope(scope):
    identity = scope["id"]; names(identity)
    if scope["existingProfile"] != "pocketdeploy-v1": raise RuntimeError("Unexpected controller profile")
    uuid.UUID(scope["existingDeploymentId"])
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,39}\.localhost", scope["host"]): raise RuntimeError("Private loopback host required")
    for key in ("oldImage", "candidateImage"):
        if not re.fullmatch(r"[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}", scope[key]): raise RuntimeError("Immutable image required")
    if scope["oldImage"] == scope["candidateImage"]: raise RuntimeError("Distinct image digests required")
    for key, low, high in (("port", 1024, 65535), ("memoryMB", 512, 1024), ("maxPreparedBytes", 1, 100_000_000_000)):
        if type(scope[key]) is not int or not low <= scope[key] <= high: raise RuntimeError("Invalid resource bound")
    if type(scope["cpus"]) not in (int, float) or not 0 < scope["cpus"] <= 0.5: raise RuntimeError("Shared-host CPU bound must not exceed 0.5")
    if not scope["sourceOriginalsBucket"] or not scope["sourceReplicaBucket"]: raise RuntimeError("Source storage boundaries required")
    if datetime.fromisoformat(scope["expiresUtc"].replace("Z", "+00:00")).utcoffset().total_seconds() != 0: raise RuntimeError("UTC expiry required")

def verify_prepared(directory, scope):
    if directory.is_symlink() or not directory.is_dir(): raise RuntimeError("Prepared directory required")
    receipt_path = directory.parent / (directory.name + ".preparation.json")
    if receipt_path.is_symlink() or not receipt_path.is_file(): raise RuntimeError("Preparation receipt required")
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("version") != 1 or receipt.get("maintenance") != "writable" or not receipt.get("source_unchanged") or not receipt.get("copied_sessions_revoked") or not receipt.get("domain_unchanged") or not receipt.get("original_files_unchanged") or receipt.get("network_isolation") != "new-loopback-only-namespace":
        raise RuntimeError("Preparation receipt incomplete")
    expected = receipt.get("prepared_files")
    if not isinstance(expected, dict) or "data.db" not in expected: raise RuntimeError("Prepared file manifest required")
    found = {}; total = 0
    for path in directory.rglob("*"):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode): continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise RuntimeError("Prepared files must be regular unlinked files")
        total += info.st_size
        if total > scope["maxPreparedBytes"]: raise RuntimeError("Prepared data exceeds approved bound")
        checksum = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""): checksum.update(block)
        found[path.relative_to(directory).as_posix()] = checksum.hexdigest()
    if found != expected: raise RuntimeError("Prepared file manifest changed")
    if found["data.db"] != receipt.get("prepared_database_sha256"): raise RuntimeError("Prepared database receipt mismatch")
    return total, receipt

def verify_container(record, identity, scope=None, expected_image=None):
    if record is None: return
    name, volume, network = names(identity)
    mounts = record.get("Mounts", [])
    if len(mounts) != 1 or mounts[0].get("Type") != "volume" or mounts[0].get("Name") != volume or mounts[0].get("Destination") != "/storage": raise RuntimeError("Unexpected rehearsal mounts")
    if set(record.get("NetworkSettings", {}).get("Networks", {})) != {network}: raise RuntimeError("Unexpected rehearsal network")
    if "once" in labels(record, "container"): raise RuntimeError("ONCE applications are excluded")
    config = record.get("HostConfig", {})
    if scope and (config.get("NanoCpus") != int(scope["cpus"] * 1_000_000_000) or config.get("Memory") != scope["memoryMB"] * 1024**2 or config.get("RestartPolicy", {}).get("Name") != "no" or config.get("PidsLimit") != 256): raise RuntimeError("Rehearsal resource limits changed")
    if expected_image and record.get("Image") != expected_image: raise RuntimeError("Rehearsal image identity changed")
    if scope and record.get("HostConfig", {}).get("PortBindings") != {"80/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(scope["port"])}]}: raise RuntimeError("Rehearsal must bind loopback only")

def stop(name, identity):
    record = owned("container", name, identity)
    if record is None: return
    verify_container(record, identity)
    if record["State"]["Running"]:
        try: run("docker", "stop", "--time", "300", name, timeout=320)
        except Exception:
            # Preserve storage while revoking clone networking after uncertain stop.
            run("docker", "network", "disconnect", "--force", names(identity)[2], name)
            raise RuntimeError("Shutdown uncertain; clone network fenced, volume retained") from None
    record = owned("container", name, identity)
    if record["State"]["Running"] or record["State"].get("OOMKilled") or record["State"].get("ExitCode") != 0:
        raise RuntimeError("Clean application stop not proven; preserve container and volume")

def main(request):
    scope = request["scope"]; check_scope(scope)
    identity = scope["id"]; name, volume, network = names(identity)
    action = request["action"]
    if action not in ("status", "prepare-upload", "start-old", "candidate", "stop", "remove"): raise RuntimeError("Unsupported rehearsal action")
    base = BASE / identity
    if base.is_symlink(): raise RuntimeError("Unsafe rehearsal directory")
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = os.open(base / "lifecycle.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, "w") as locked:
        fcntl.flock(locked, fcntl.LOCK_EX)
        manifest = base / "scope.json"
        if manifest.exists() and json.loads(manifest.read_text()) != scope: raise RuntimeError("Rehearsal scope changed")
        if not manifest.exists():
            with manifest.open("x") as output: os.chmod(manifest, 0o600); json.dump(scope, output)
        pending = base / "pending.json"
        retired = base / "retired"
        ready_path = base / "ready.json"
        ready = json.loads(ready_path.read_text()) if ready_path.exists() else None
        record = owned("container", name, identity)
        owned("volume", volume, identity); owned("network", network, identity)
        verify_container(record, identity, scope)
        if action == "prepare-upload":
            if record or owned("volume", volume, identity) or owned("network", network, identity) or pending.exists() or retired.exists(): raise RuntimeError("Fresh rehearsal required for staging")
            (base / "prepared").mkdir(mode=0o700, exist_ok=False)
            return {"prepared_directory_created": True}
        if action == "status":
            return {"exists": record is not None, "running": bool(record and record["State"]["Running"]), "image_id": record.get("Image") if record else None, "loopback_port": scope["port"], "pending": pending.exists(), "retired": retired.exists()}
        if action in ("stop", "remove"):
            stop(name, identity)
            if action == "remove":
                if owned("container", name, identity): run("docker", "rm", name)
                if owned("container", name + "-loader", identity): run("docker", "rm", name + "-loader")
                if owned("volume", volume, identity): run("docker", "volume", "rm", volume)
                if owned("network", network, identity): run("docker", "network", "rm", network)
                retired.touch(mode=0o600)
                pending.unlink(missing_ok=True)
            return {"stopped": True, "removed": action == "remove", "prepared_checkpoint_retained": True}
        if pending.exists() or retired.exists(): raise RuntimeError("Unfinished or retired rehearsal requires explicit recovery; no automatic replay")
        if datetime.now(timezone.utc) >= datetime.fromisoformat(scope["expiresUtc"].replace("Z", "+00:00")): raise RuntimeError("Rehearsal lifetime expired")
        env = request["environment"]
        expected = {"WIKICONTEXT_S3_BUCKET", "WIKICONTEXT_S3_ENDPOINT", "WIKICONTEXT_S3_REGION", "WIKICONTEXT_S3_ACCESS_KEY_ID", "WIKICONTEXT_S3_SECRET_ACCESS_KEY", "WIKICONTEXT_S3_FORCE_PATH_STYLE", "LITESTREAM_BUCKET", "LITESTREAM_PATH", "LITESTREAM_ENDPOINT", "LITESTREAM_REGION", "LITESTREAM_ACCESS_KEY_ID", "LITESTREAM_SECRET_ACCESS_KEY", "LITESTREAM_SYNC_INTERVAL"}
        if set(env) != expected or any(not isinstance(value, str) or not value or "\n" in value or "\r" in value for value in env.values()): raise RuntimeError("Explicit clone bindings required")
        if env["WIKICONTEXT_S3_BUCKET"] in (scope["sourceOriginalsBucket"], scope["sourceReplicaBucket"]) or env["LITESTREAM_BUCKET"] in (scope["sourceOriginalsBucket"], scope["sourceReplicaBucket"], env["WIKICONTEXT_S3_BUCKET"]): raise RuntimeError("Separate clone originals and replica buckets required")
        if env["WIKICONTEXT_S3_ACCESS_KEY_ID"] == env["LITESTREAM_ACCESS_KEY_ID"]: raise RuntimeError("Independent original and replica credentials required")
        if env["LITESTREAM_PATH"] != "rehearsals/" + identity + "/data.db": raise RuntimeError("Fresh UUID-bound replica path required")
        env = {**env, "BASE_URL": "http://" + scope["host"] + ":" + str(scope["port"])}
        binding_hash = hashlib.sha256(json.dumps(env, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if action == "candidate":
            if not ready or ready.get("phase") != "start-old" or ready.get("bindings_sha256") != binding_hash: raise RuntimeError("Candidate requires unchanged restored-image bindings and old-ready evidence")
            verify_container(record, identity, scope, ready["image_id"])
        # Verify existing metadata policy, never rewrite shared-host firewall rules.
        for chain in ("DOCKER-USER", "FORWARD"):
            run("iptables", "-C", chain, "-d", "169.254.169.254/32", "-j", "DROP")
        memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        if int(memory["MemAvailable"].split()[0]) * 1024 < scope["memoryMB"] * 2 * 1024**2: raise RuntimeError("Insufficient memory headroom")
        image = scope["oldImage"] if action == "start-old" else scope["candidateImage"]
        if shutil.disk_usage(base).free < scope["maxPreparedBytes"] * 2 + 3 * 1024**3: raise RuntimeError("Insufficient pre-pull disk headroom")
        run("docker", "pull", image, timeout=600)
        image_record = inspect("image", image)
        if image not in image_record.get("RepoDigests", []): raise RuntimeError("Image digest verification failed")
        if "once" in (image_record.get("Config", {}).get("Labels") or {}): raise RuntimeError("ONCE-labeled images are excluded")
        with pending.open("x") as output:
            os.chmod(pending, 0o600); json.dump({"action": action, "image": image}, output)
        if action == "start-old":
            if record or inspect("volume", volume) or inspect("network", network): raise RuntimeError("First startup requires absent rehearsal resources")
            prepared = base / "prepared"
            total, receipt = verify_prepared(prepared, scope)
            storage = {"enabled": True, "bucket": env["WIKICONTEXT_S3_BUCKET"], "endpoint": env["WIKICONTEXT_S3_ENDPOINT"], "region": env["WIKICONTEXT_S3_REGION"], "accessKey": env["WIKICONTEXT_S3_ACCESS_KEY_ID"], "secret": env["WIKICONTEXT_S3_SECRET_ACCESS_KEY"], "forcePathStyle": env["WIKICONTEXT_S3_FORCE_PATH_STYLE"] == "true"}
            if hashlib.sha256(json.dumps(storage, sort_keys=True, separators=(",", ":")).encode()).hexdigest() != receipt.get("storage_binding_sha256"): raise RuntimeError("Clone storage differs from preparation receipt")
            if receipt.get("clone_url") != "http://" + scope["host"] + ":" + str(scope["port"]): raise RuntimeError("Clone URL differs from preparation receipt")
            if shutil.disk_usage(base).free < 2 * total + 1024**3: raise RuntimeError("Insufficient disk headroom")
            measured = run("docker", "run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/sha256sum", image, "/usr/local/bin/pocketcontext").split()[0]
            if measured != receipt.get("binary_sha256"): raise RuntimeError("Old image does not match prepared server binary")
            run("docker", "volume", "create", "--label", LABEL + "=" + identity, "--label", "com.pocketcontext.purpose=" + PURPOSE, volume)
            loader = name + "-loader"
            if inspect("container", loader): raise RuntimeError("Loader already exists; preserve for inspection")
            run("docker", "create", "--name", loader, "--network", "none", "--label", LABEL + "=" + identity, "--label", "com.pocketcontext.purpose=" + PURPOSE, "--mount", "type=volume,src=" + volume + ",dst=/storage", "--entrypoint", "/bin/true", image)
            try: run("docker", "cp", str(prepared), loader + ":/storage/pb_data", timeout=600)
            finally: run("docker", "rm", loader)
            run("docker", "network", "create", "--label", LABEL + "=" + identity, "--label", "com.pocketcontext.purpose=" + PURPOSE, network)
        else:
            if not record or not inspect("volume", volume) or not inspect("network", network): raise RuntimeError("Restored old instance required before candidate")
            stop(name, identity)
            run("docker", "rm", name)
        with tempfile.NamedTemporaryFile(mode="w", prefix="wiki-rehearsal-", dir=RUN) as environment:
            os.chmod(environment.name, 0o600)
            for key, value in env.items(): environment.write(key + "=" + value + "\n")
            environment.flush()
            run("docker", "run", "-d", "--name", name, "--restart", "no", "--network", network,
                "--label", LABEL + "=" + identity, "--label", "com.pocketcontext.purpose=" + PURPOSE,
                "--cpus", str(scope["cpus"]), "--memory", str(scope["memoryMB"]) + "m", "--pids-limit", "256",
                "--log-opt", "max-size=10m", "--log-opt", "max-file=2", "--publish", "127.0.0.1:" + str(scope["port"]) + ":80",
                "--mount", "type=volume,src=" + volume + ",dst=/storage", "--env-file", environment.name, image)
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            current = owned("container", name, identity)
            if not current or not current["State"]["Running"]: raise RuntimeError("Rehearsal startup failed; preserve volume")
            try: verify_container(current, identity, scope, image_record["Id"])
            except Exception:
                run("docker", "stop", "--time", "300", current["Id"], timeout=320)
                raise RuntimeError("Rehearsal runtime mismatch; stopped and retained") from None
            ports = current["HostConfig"].get("PortBindings", {})
            if ports != {"80/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(scope["port"])}]} or "once" in labels(current, "container"):
                run("docker", "stop", "--time", "300", current["Id"], timeout=320)
                raise RuntimeError("Rehearsal isolation mismatch; stopped and retained")
            connection = http.client.HTTPConnection("127.0.0.1", scope["port"], timeout=3)
            try:
                connection.request("GET", "/api/health", headers={"Host": scope["host"]})
                if connection.getresponse().status == 200:
                    with ready_path.open("w") as output:
                        os.chmod(ready_path, 0o600); json.dump({"phase": action, "image_id": image_record["Id"], "bindings_sha256": binding_hash}, output)
                    pending.unlink()
                    return {"healthy": True, "phase": action, "loopback_only": True, "once_registered": False}
            except OSError: pass
            finally: connection.close()
            time.sleep(5)
        stop(name, identity)
        raise RuntimeError("Readiness deadline exceeded; stopped container and volume retained")

if __name__ == "__main__":
    import sys
    try: print(json.dumps(main(json.load(sys.stdin))))
    except Exception: print('{"error":"Rehearsal operation refused or failed; raw output suppressed."}'); sys.exit(1)
