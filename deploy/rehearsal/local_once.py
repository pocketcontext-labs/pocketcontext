#!/usr/bin/env python3
"""Disposable synthetic ONCE engine; never connects ONCE to the host Docker socket."""
from __future__ import annotations
import argparse
import json
import hashlib
import platform
import os
from pathlib import Path
import subprocess
import time
import uuid
import io
import tarfile
import re

DIND = 'docker.io/library/docker@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac'
LABEL = 'com.pocketcontext.local-once-rehearsal'
ONCE_HASHES = {'aarch64': '97e32ba0fdac0ad5e6010851b306e3cb2616285a9eeb2e869ff7e71f4b442bbb', 'x86_64': 'aef855da263721c6c1072ff5ebc4c17a52af8c8e80c46c5a9dd458e7ca3a7f35'}


def run(args, *, data=None, timeout=600):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('isolated Docker operation failed; raw output suppressed')
    return result.stdout


class Engine:
    def __init__(self, name):
        if not name.startswith('wiki-once-') or len(name) != 46:
            raise ValueError('invalid isolated engine name')
        uuid.UUID(name[10:])
        self.name = name
        self.volume = name + '-docker'

    def outer(self, *args, **kwargs):
        return run(['sudo', '-n', 'docker', *args], **kwargs)

    def docker(self, *args, **kwargs):
        return self.outer('exec', '-i', self.name, 'docker', *args, **kwargs)

    def once(self, *args, **kwargs):
        return self.outer('exec', '-i', self.name, '/usr/local/bin/once', *args, **kwargs)

    def inspect(self, *, cleanup=False):
        info = json.loads(self.outer('inspect', self.name))[0]
        if info['Config']['Labels'].get(LABEL) != self.name:
            raise RuntimeError('engine ownership mismatch')
        mounts = info['Mounts']
        if len(mounts) != 1 or mounts[0]['Type'] != 'volume' or mounts[0]['Name'] != self.volume or mounts[0]['Destination'] != '/var/lib/docker':
            raise RuntimeError('unexpected engine mounts')
        host = info['HostConfig']
        if info['Config']['Image'] != DIND or host['NetworkMode'] == 'host' or host['PidMode'] == 'host' or host['RestartPolicy']['Name'] != 'no' or host['Memory'] != 4 * 1024**3 or host['NanoCpus'] != 2 * 10**9:
            raise RuntimeError('unexpected engine isolation or resource settings')
        ports = host['PortBindings']
        if set(ports) != {'80/tcp', '9000/tcp'}:
            raise RuntimeError('unexpected published ports')
        for bindings in ports.values():
            if bindings and any(x['HostIp'] != '127.0.0.1' for x in bindings):
                raise RuntimeError('engine port is not loopback-only')
        if any(ports.get(p) for p in ('2375/tcp', '2376/tcp')):
            raise RuntimeError('Docker API must not be published')
        if cleanup:
            return {}
        ports = info['NetworkSettings']['Ports']
        return {'name': self.name, 'running': info['State']['Running'], 'http_port': int(ports['80/tcp'][0]['HostPort']), 's3_port': int(ports['9000/tcp'][0]['HostPort'])}

    @classmethod
    def create(cls, binary):
        if hashlib.sha256(Path(binary).read_bytes()).hexdigest() != ONCE_HASHES.get(platform.machine()):
            raise ValueError('ONCE binary does not match pinned v0.3.3 architecture checksum')
        engine = cls('wiki-once-' + str(uuid.uuid4()))
        engine.outer('volume', 'create', '--label', f'{LABEL}={engine.name}', engine.volume)
        try:
            engine.outer('run', '-d', '--privileged', '--name', engine.name, '--label', f'{LABEL}={engine.name}', '--restart=no', '--memory=4g', '--cpus=2', '-p', '127.0.0.1::80', '-p', '127.0.0.1::9000', '-v', f'{engine.volume}:/var/lib/docker', '--entrypoint', 'dockerd', DIND, '--host=unix:///var/run/docker.sock', '--storage-driver=overlay2')
            for _ in range(90):
                try:
                    engine.docker('info', '--format', '{{.ServerVersion}}', timeout=10)
                    break
                except RuntimeError:
                    time.sleep(1)
            else:
                raise RuntimeError('isolated daemon not ready')
            engine.inspect()
            engine.outer('cp', str(binary), engine.name + ':/usr/local/bin/once')
            engine.outer('exec', engine.name, 'chmod', '755', '/usr/local/bin/once')
            return engine
        except BaseException:
            engine.close()
            raise

    def load(self, image):
        # Stream images locally; never serialize image configuration into logs.
        sender = subprocess.Popen(['sudo', '-n', 'docker', 'image', 'save', image], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            receiver = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', self.name, 'docker', 'load'], stdin=sender.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
            sender.stdout.close()
            if receiver.returncode or sender.wait(timeout=30):
                raise RuntimeError('local image transfer failed')
        finally:
            if sender.poll() is None:
                sender.kill()
                sender.wait()

    def close(self):
        names = self.outer('ps', '-a', '--filter', f'name=^/{self.name}$', '--format', '{{.Names}}').decode().splitlines()
        if self.name in names:
            self.inspect(cleanup=True)
            self.outer('rm', '-f', self.name)
        volume = json.loads(self.outer('volume', 'inspect', self.volume))[0]
        if volume.get('Labels', {}).get(LABEL) != self.name:
            raise RuntimeError('engine volume ownership mismatch')
        self.outer('volume', 'rm', self.volume)


def prepared_archive(engine, directory, destination, image, environment):
    """Package a validated prepared synthetic clone using ONCE v0.3.3 schema."""
    from shared_host_remote import verify_prepared
    from prepare_config import BINDINGS
    if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", image):
        raise ValueError("immutable registry image required")
    if set(environment) != set(BINDINGS) | {"BASE_URL"} or environment["BASE_URL"] != "http://wiki-rehearsal.localhost":
        raise ValueError("exact clone storage bindings required")
    _, receipt = verify_prepared(directory, {"maxPreparedBytes": 1024**3})
    if not receipt.get("database_integrity_verified") or receipt["clone_url"] != "http://wiki-rehearsal.localhost":
        raise ValueError("prepared integrity and local clone URL required")
    binary_hash = engine.docker("run", "--rm", "--network=none", "--entrypoint", "sha256sum", image, "/usr/local/bin/pocketcontext").decode().split()[0]
    if binary_hash != receipt["binary_sha256"]:
        raise ValueError("prepared binary does not match exact old image")
    s3 = {"enabled": True, "bucket": environment["WIKICONTEXT_S3_BUCKET"], "endpoint": environment["WIKICONTEXT_S3_ENDPOINT"], "region": environment["WIKICONTEXT_S3_REGION"], "accessKey": environment["WIKICONTEXT_S3_ACCESS_KEY_ID"], "secret": environment["WIKICONTEXT_S3_SECRET_ACCESS_KEY"], "forcePathStyle": environment["WIKICONTEXT_S3_FORCE_PATH_STYLE"].lower() == "true"}
    if hashlib.sha256(json.dumps(s3, sort_keys=True, separators=(",", ":")).encode()).hexdigest() != receipt["storage_binding_sha256"]:
        raise ValueError("prepared clone bindings mismatch")
    settings = {"name": "wikicontext", "image": image, "host": "wiki-rehearsal.localhost", "disableTLS": True, "env": environment, "smtp": {}, "resources": {}, "autoUpdate": False, "backup": {"autoBackup": False}, "keys": {}, "registry": {}}
    with destination.open("xb") as raw:
        os.chmod(destination, 0o600)
        with tarfile.open(fileobj=raw, mode="w:gz") as archive:
            for name, value in [("once.application.json", settings), ("once.volume.json", {})]:
                payload = json.dumps(value).encode()
                entry = tarfile.TarInfo(name)
                entry.size = len(payload)
                entry.mode = 0o600
                archive.addfile(entry, io.BytesIO(payload))
            for path in sorted(directory.rglob("*")):
                archive.add(path, arcname="data/pb_data/" + path.relative_to(directory).as_posix(), recursive=False)
    return receipt


def application(engine):
    """Return only the single rehearsal app's selected nonsecret runtime fields."""
    names = engine.docker("ps", "-a", "--filter", "name=^/once-app-", "--format", "{{.Names}}").decode().splitlines()
    if len(names) != 1:
        raise RuntimeError("expected exactly one isolated ONCE application")
    info = json.loads(engine.docker("inspect", names[0]))[0]
    settings = json.loads(info["Config"]["Labels"]["once"])
    if settings["host"] != "wiki-rehearsal.localhost" or settings.get("autoUpdate") or settings.get("backup", {}).get("autoBackup"):
        raise RuntimeError("unexpected ONCE application")
    return {"name": names[0], "image_id": info["Image"], "running": info["State"]["Running"], "exit_code": info["State"]["ExitCode"], "oom": info["State"].get("OOMKilled", False), "volume": next(m["Name"] for m in info["Mounts"] if m["Destination"] == "/storage")}


def stop_first(engine):
    before = application(engine)
    engine.docker("update", "--restart=no", before["name"])
    engine.docker("stop", "--time", "300", before["name"], timeout=330)
    after = application(engine)
    if after["running"] or after["exit_code"] != 0 or after["oom"]:
        raise RuntimeError("clean stop not proven; preserve stopped volume")
    return after


def backup(engine, destination):
    """Actual ONCE backup; metadata and synthetic database remain private."""
    path = "/tmp/rehearsal-backup-" + str(uuid.uuid4()) + ".tar.gz"
    engine.once("backup", "wiki-rehearsal.localhost", path, timeout=900)
    try:
        with destination.open("xb") as target:
            os.chmod(destination, 0o600)
            result = subprocess.run(["sudo", "-n", "docker", "exec", engine.name, "cat", path], stdout=target, stderr=subprocess.DEVNULL, timeout=300)
            if result.returncode:
                raise RuntimeError("private ONCE backup transfer failed")
    finally:
        engine.outer("exec", engine.name, "rm", "-f", path)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def rebind_replica(source, destination, replica_path):
    """Retain actual ONCE backup payload, changing only its clone replica path."""
    if not re.fullmatch(r"rehearsals/[0-9a-f-]{36}/data.db", replica_path):
        raise ValueError("fresh UUID-scoped replica required")
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    seen = set()
    total = 0
    with tarfile.open(source, "r:gz") as incoming, destination.open("xb") as raw:
        os.chmod(destination, 0o600)
        with tarfile.open(fileobj=raw, mode="w:gz") as outgoing:
            for entry in incoming:
                parts = entry.name.split("/")
                if entry.name in seen or any(part == ".." for part in parts) or any(part == "" for part in parts[:-1]) or entry.name.startswith("/") or not (entry.isfile() or entry.isdir()) or not (entry.name in ("once.application.json", "once.volume.json", "data") or entry.name.startswith("data/")):
                    raise ValueError("unsafe ONCE archive member")
                seen.add(entry.name)
                total += entry.size
                if total > 1024**3:
                    raise ValueError("archive exceeds synthetic fixture bound")
                payload = incoming.extractfile(entry).read() if entry.isfile() else None
                if entry.name == "once.application.json":
                    settings = json.loads(payload)
                    if settings["host"] != "wiki-rehearsal.localhost" or not settings["disableTLS"] or settings.get("autoUpdate") or settings.get("backup", {}).get("autoBackup") or settings["env"]["LITESTREAM_PATH"] == replica_path:
                        raise ValueError("unexpected clone archive settings")
                    settings["env"]["LITESTREAM_PATH"] = replica_path
                    payload = json.dumps(settings).encode()
                    entry.size = len(payload)
                outgoing.addfile(entry, io.BytesIO(payload) if payload is not None else None)
    if not {"once.application.json", "once.volume.json"} <= seen or hashlib.sha256(source.read_bytes()).hexdigest() != original_hash:
        raise ValueError("incomplete or changed source archive")
    return {"source_sha256": original_hash, "rebound_sha256": hashlib.sha256(destination.read_bytes()).hexdigest(), "changed_setting": "env.LITESTREAM_PATH", "replica_path": replica_path}


def rollback(engine, original_backup, rebound_backup):
    receipt = rebind_replica(original_backup, rebound_backup, "rehearsals/" + str(uuid.uuid4()) + "/data.db")
    before = stop_first(engine)
    # Keep the candidate volume for inspection, but remove its ONCE registration.
    engine.once("remove", "wiki-rehearsal.localhost")
    after = restore(engine, rebound_backup)
    if after["volume"] == before["volume"]:
        raise RuntimeError("rollback must restore to a fresh volume")
    return {"archive": receipt, "application": after, "preserved_candidate_volume": before["volume"]}


def restore(engine, archive):
    engine.inspect()
    engine.outer("cp", str(archive), engine.name + ":/tmp/rehearsal-restore.tar.gz")
    try:
        engine.once("restore", "/tmp/rehearsal-restore.tar.gz", timeout=900)
    finally:
        engine.outer("exec", engine.name, "rm", "-f", "/tmp/rehearsal-restore.tar.gz")
    return application(engine)


def update(engine, image):
    if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", image):
        raise ValueError("immutable candidate digest required")
    before = stop_first(engine)
    engine.once("update", "wiki-rehearsal.localhost", "--image", image, timeout=900)
    after = application(engine)
    if after["volume"] != before["volume"] or not after["running"]:
        raise RuntimeError("candidate did not preserve single application volume")
    return after


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'status', 'load', 'pack', 'restore', 'backup', 'update', 'rollback', 'stop', 'destroy'])
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--once-binary', type=Path)
    parser.add_argument('--image')
    parser.add_argument('--prepared-dir', type=Path)
    parser.add_argument('--private-env', type=Path)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--rebound-archive', type=Path)
    args = parser.parse_args()
    if args.action == 'create':
        if args.state.exists() or not args.once_binary:
            parser.error('create requires a new state path and exact pinned ONCE binary')
        engine = Engine.create(args.once_binary)
        with args.state.open('x') as handle:
            os.chmod(args.state, 0o600)
            json.dump(engine.inspect(), handle)
        print(json.dumps(engine.inspect()))
    else:
        engine = Engine(json.loads(args.state.read_text())['name'])
        if args.action == 'status':
            print(json.dumps(engine.inspect()))
        elif args.action == 'pack':
            from shared_host import private_json
            if not all((args.prepared_dir, args.private_env, args.archive, args.image)):
                parser.error('pack requires prepared directory, private environment, new archive and old image')
            engine.inspect()
            prepared_archive(engine, args.prepared_dir, args.archive, args.image, private_json(args.private_env))
            print('Created private prepared-clone ONCE archive')
        elif args.action == 'restore':
            if not args.archive:
                parser.error('--archive required')
            print(json.dumps(restore(engine, args.archive)))
        elif args.action == 'backup':
            if not args.archive:
                parser.error('new --archive required')
            print(json.dumps({'sha256': backup(engine, args.archive)}))
        elif args.action == 'update':
            if not args.image:
                parser.error('immutable --image required')
            print(json.dumps(update(engine, args.image)))
        elif args.action == 'rollback':
            if not args.archive or not args.rebound_archive:
                parser.error('--archive and new --rebound-archive required')
            print(json.dumps(rollback(engine, args.archive, args.rebound_archive)))
        elif args.action == 'stop':
            print(json.dumps(stop_first(engine)))
        elif args.action == 'load':
            if not args.image:
                parser.error('--image required')
            engine.inspect()
            engine.load(args.image)
            print('Loaded local test image into isolated engine')
        else:
            engine.close()
            args.state.unlink()
            print('Removed owned isolated engine and its Docker data volume')

if __name__ == '__main__':
    main()
