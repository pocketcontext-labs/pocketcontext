#!/usr/bin/python3
"""Hosted-only lifecycle and complete backups. The Go product remains standalone."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

FORMAT = "pocketcontext-hosted-backup-v1"
DAY = 86400
RETENTION = 30 * DAY
ARCHIVE_NAME = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{32}\.tar\.gz")


class Failure(Exception):
    pass


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with tmp.open("x") as out:
        os.chmod(tmp, 0o600)
        json.dump(value, out, separators=(",", ":"))
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text())


class Config:
    def __init__(self, root=None):
        self.root = Path(root or "/storage")
        self.project = self.root / "project"
        self.private = self.root / "private"
        self.db = self.project / "pocketcontext.db"
        self.control = self.private / "control.sock"
        self.state = self.private / "container.json"
        self.revision = os.environ.get("POCKETCONTEXT_REVISION", "")
        self.binary = "/usr/local/bin/pocketcontext"
        self.domain = os.environ.get("POCKETCONTEXT_DOMAIN", "")

    def initialize_dirs(self):
        for path in (self.root, self.project, self.private):
            if path.is_symlink():
                raise Failure("storage directories must not be symlinks")
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.private, 0o700)

    def validate(self):
        if not re.fullmatch(r"[0-9a-f]{40}", self.revision):
            raise Failure("image must contain a full source revision")
        if not self.domain or "/" in self.domain or ":" in self.domain:
            raise Failure("POCKETCONTEXT_DOMAIN must be the public DNS hostname")
        for key in ("OWNER_EMAIL", "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"):
            if not os.environ.get("POCKETCONTEXT_" + key):
                raise Failure("missing required hosted setting: POCKETCONTEXT_" + key)

    def environment(self):
        env = os.environ.copy()
        env.update(POCKETCONTEXT_DB=str(self.db), XDG_CACHE_HOME=str(self.private / "cache"),
                   XDG_CONFIG_HOME=str(self.private / "config"), XDG_STATE_HOME=str(self.private / "state"))
        return env

    def instance(self):
        value = read_json(self.project / "pocketcontext.json", {}).get("instance", "")
        if not re.fullmatch(r"[0-9a-f]{32}", value):
            raise Failure("missing or invalid initialized project identity")
        return value


@contextlib.contextmanager
def exclusive(config):
    config.initialize_dirs()
    with (config.private / "container.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure("another container lifecycle owns this volume") from None
        yield


def included_files(config):
    """Only regular project/runtime files; no process sockets, locks, logs or assets."""
    selected = []
    for base in (config.project, config.private / "cache", config.private / "config", config.private / "state"):
        if base.is_symlink():
            raise Failure("backup refuses symlink roots")
        if not base.exists():
            continue
        for directory, dirs, files in os.walk(base, followlinks=False):
            directory = Path(directory)
            for name in list(dirs):
                path = directory / name
                if path.is_symlink():
                    raise Failure("backup refuses symlink directories")
                if path == config.private / "cache" / "pocketcontext" / "app":
                    dirs.remove(name)  # immutable embedded assets are supplied by the image
            for name in files:
                path = directory / name
                mode = path.lstat().st_mode
                operational = path.is_relative_to(config.private) and (
                    name.endswith((".lock", ".log")) or name in ("local.key", "server.json", "server.pid"))
                if path == config.db.with_name(config.db.name + ".lease") or operational or stat.S_ISSOCK(mode):
                    continue
                if not stat.S_ISREG(mode):
                    raise Failure("backup refuses symlinks and special files")
                selected.append(path)
    return sorted(selected)


def integrity(path):
    # This is a stopped database or an extracted archive, never the live writer.
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise Failure("database integrity check failed")


def validate_databases(root):
    db = root / "project" / "pocketcontext.db"
    if not db.is_file():
        raise Failure("backup is missing its project database")
    databases = [db] + list((root / "private").rglob("data.db")) + list((root / "private").rglob("auxiliary.db"))
    for path in databases:
        integrity(path)
        if path.name == "auxiliary.db":
            continue
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as connection:
            row = connection.execute("SELECT id FROM _collections WHERE name='sources'").fetchone()
            if not row:
                raise Failure("backup database has no sources collection")
            collection = row[0]
            for record, original, checksum in connection.execute("SELECT id, original, sha256 FROM sources"):
                if any(not part or "/" in part or "\\" in part or part in (".", "..") for part in (collection, record, original)):
                    raise Failure("invalid original file reference")
                file = root / "project" / "storage" / collection / record / original
                if not re.fullmatch(r"[0-9a-f]{64}", checksum) or not file.is_file() or file.is_symlink() or digest(file) != checksum:
                    raise Failure("source original is missing or corrupt")


def snapshot(config, revision):
    """Call only with the child stopped and exclusive volume lock held."""
    config.instance()
    validate_databases(config.root)
    directory = Path(tempfile.mkdtemp(prefix="snapshot-", dir=config.private))
    os.chmod(directory, 0o700)
    archive = directory / "backup.tar.gz"
    files = {}
    try:
        with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as tar:
            for path in included_files(config):
                relative = path.relative_to(config.root).as_posix()
                files[relative] = {"sha256": digest(path), "size": path.stat().st_size}
                tar.add(path, arcname=relative, recursive=False)
            manifest = {"format": FORMAT, "instance": config.instance(), "revision": revision,
                        "created": dt.datetime.now(dt.timezone.utc).isoformat(), "files": files}
            manifest_file = directory / "manifest.json"
            atomic_json(manifest_file, manifest)
            tar.add(manifest_file, arcname="manifest.json", recursive=False)
        os.chmod(archive, 0o600)
        return archive, manifest
    except BaseException:
        shutil.rmtree(directory)
        raise


def validate_archive(archive, destination):
    """Extract into a new private directory, rejecting all link/traversal entries."""
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        names = set()
        for member in members:
            path = PurePosixPath(member.name)
            if (not member.isfile() or path.is_absolute() or ".." in path.parts or "\\" in member.name
                    or member.name in names or member.name != path.as_posix()):
                raise Failure("unsafe backup archive entry")
            if member.name != "manifest.json" and not (
                len(path.parts) >= 2 and path.parts[0] == "project" or
                len(path.parts) >= 3 and path.parts[0] == "private" and path.parts[1] in ("cache", "config", "state")):
                raise Failure("unexpected backup archive entry")
            names.add(member.name)
        if "manifest.json" not in names:
            raise Failure("backup manifest is missing")
        raw = tar.extractfile("manifest.json").read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            raise Failure("backup manifest exceeds limit")
        manifest = json.loads(raw)
        if (manifest.get("format") != FORMAT or set(manifest.get("files", {})) != names - {"manifest.json"}
                or not re.fullmatch(r"[0-9a-f]{32}", manifest.get("instance", ""))
                or not re.fullmatch(r"[0-9a-f]{40}", manifest.get("revision", ""))):
            raise Failure("backup manifest does not match archive")
        for member in members:
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tar.extractfile(member) as source, target.open("xb") as out:
                shutil.copyfileobj(source, out)
            os.chmod(target, 0o600)
            os.utime(target, (member.mtime, member.mtime))
            if member.name != "manifest.json":
                entry = manifest["files"][member.name]
                if target.stat().st_size != entry["size"] or digest(target) != entry["sha256"]:
                    raise Failure("backup content checksum mismatch")
    validate_databases(destination)
    if read_json(destination / "project" / "pocketcontext.json", {}).get("instance") != manifest.get("instance"):
        raise Failure("backup instance does not match manifest")
    return manifest


class BackupStore:
    def __init__(self):
        required = ("ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "PREFIX")
        settings = {key: os.environ.get("POCKETCONTEXT_BACKUP_" + key, "") for key in required}
        if not all(settings.values()):
            raise Failure("all POCKETCONTEXT_BACKUP settings are required")
        if not settings["ENDPOINT"].startswith("https://"):
            raise Failure("backup endpoint must use HTTPS")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9/_-]{0,180}", settings["PREFIX"]) or ".." in settings["PREFIX"]:
            raise Failure("invalid backup prefix")
        import boto3
        from botocore.config import Config as S3Config
        self.client = boto3.client("s3", endpoint_url=settings["ENDPOINT"], region_name=settings["REGION"],
                                   aws_access_key_id=settings["ACCESS_KEY_ID"], aws_secret_access_key=settings["SECRET_ACCESS_KEY"],
                                   config=S3Config(signature_version="s3v4", connect_timeout=10, read_timeout=60,
                                                   retries={"max_attempts": 2, "mode": "standard"}, s3={"addressing_style": "path"}))
        self.bucket, self.prefix = settings["BUCKET"], settings["PREFIX"].strip("/")

    def key(self, instance):
        return self.prefix + "/" + instance + "/" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex + ".tar.gz"

    def verify_remote(self, key, expected):
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        h = hashlib.sha256()
        with contextlib.closing(response["Body"]) as body:
            for block in iter(lambda: body.read(1024 * 1024), b""):
                h.update(block)
        if h.hexdigest() != expected:
            raise Failure("remote backup checksum mismatch")

    def upload(self, archive, manifest):
        key, checksum = self.key(manifest["instance"]), digest(archive)
        self.client.upload_file(str(archive), self.bucket, key, ExtraArgs={"ContentType": "application/gzip", "Metadata": {
            "format": FORMAT, "instance": manifest["instance"], "sha256": checksum, "revision": manifest["revision"]}})
        self.verify_remote(key, checksum)  # metadata alone does not prove recoverability
        return {"key": key, "sha256": checksum, "instance": manifest["instance"], "revision": manifest["revision"], "files": manifest["files"], "completed": time.time()}

    def prune(self, instance, now=None):
        prefix, cutoff = self.prefix + "/" + instance + "/", (now or time.time()) - RETENTION
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not ARCHIVE_NAME.fullmatch(key[len(prefix):]) or obj["LastModified"].timestamp() >= cutoff:
                    continue
                meta = self.client.head_object(Bucket=self.bucket, Key=key).get("Metadata", {})
                if meta.get("format") == FORMAT and meta.get("instance") == instance and re.fullmatch(r"[0-9a-f]{64}", meta.get("sha256", "")):
                    self.client.delete_object(Bucket=self.bucket, Key=key)

    def download(self, key, destination):
        if not key.startswith(self.prefix + "/") or not ARCHIVE_NAME.fullmatch(key.rsplit("/", 1)[-1]):
            raise Failure("restore key must be an owned backup in the configured prefix")
        meta = self.client.head_object(Bucket=self.bucket, Key=key).get("Metadata", {})
        if meta.get("format") != FORMAT or not re.fullmatch(r"[0-9a-f]{64}", meta.get("sha256", "")):
            raise Failure("restore object is missing ownership/checksum metadata")
        self.client.download_file(self.bucket, key, str(destination))
        if digest(destination) != meta["sha256"]:
            raise Failure("downloaded backup checksum mismatch")
        return meta


def complete_backup(config, store, revision):
    archive, manifest = snapshot(config, revision)
    try:
        result = store.upload(archive, manifest)
        atomic_json(config.private / "last-backup.json", result)
        store.prune(manifest["instance"])
        return result
    finally:
        shutil.rmtree(archive.parent)


def prepared_matches(config, prepared, revision):
    if not prepared or prepared.get("revision") != revision:
        return False
    actual = {p.relative_to(config.root).as_posix(): {"sha256": digest(p), "size": p.stat().st_size} for p in included_files(config)}
    return actual == prepared.get("files")


class Supervisor:
    def __init__(self, config, store):
        self.config, self.store, self.child = config, store, None
        self.stopping = threading.Event()
        self.commands = []
        self.condition = threading.Condition()
        self.paused = False

    def start(self, initialize=False):
        args = [self.config.binary, "serve", "--headless", "--hosted", "--domain", self.config.domain, "--mcp", "--db", str(self.config.db)]
        if initialize:
            args.append("--hosted-init")
        if (self.config.private / "restore-pending.json").exists():
            args.append("--hosted-restore")
        self.child = subprocess.Popen(args, env=self.config.environment())

    def stop(self):
        if self.child is None:
            return
        if self.child.poll() is not None:
            raise Failure("server exited before a clean snapshot")
        self.child.send_signal(signal.SIGTERM)
        try:
            code = self.child.wait(timeout=90)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()
            raise Failure("server did not stop cleanly; backup refused") from None
        self.child = None
        if code != 0:
            raise Failure("server shutdown failed; backup refused")

    def backup(self, pause=False):
        self.stop()
        archive = None
        try:
            archive, manifest = snapshot(self.config, self.config.revision)
            if not pause and not self.stopping.is_set():
                self.start()
            result = self.store.upload(archive, manifest)
            atomic_json(self.config.private / "last-backup.json", result)
            self.store.prune(manifest["instance"])
            if pause:
                atomic_json(self.config.private / "prepared-upgrade.json", result)
                self.paused = True
            return {"ok": True, "key": result["key"], "paused": pause}
        except Exception:
            self.paused = False
            (self.config.private / "prepared-upgrade.json").unlink(missing_ok=True)
            if self.child is None and not self.stopping.is_set():
                self.start()
            raise
        finally:
            if archive is not None:
                shutil.rmtree(archive.parent)

    def control_loop(self):
        self.config.control.unlink(missing_ok=True)
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(self.config.control))
            os.chmod(self.config.control, 0o600)
            listener.listen(4)
            listener.settimeout(1)
            while not self.stopping.is_set():
                try:
                    conn, _ = listener.accept()
                except TimeoutError:
                    continue
                with conn:
                    conn.settimeout(900)
                    command = conn.recv(128).decode().strip()
                    if command not in ("backup", "prepare-upgrade"):
                        conn.sendall(b'{"ok":false,"error":"unknown command"}\n')
                        continue
                    job = {"command": command, "done": threading.Event()}
                    with self.condition:
                        self.commands.append(job)
                        self.condition.notify_all()
                    while not job["done"].wait(1):
                        if self.stopping.is_set():
                            break
                    try:
                        conn.sendall(json.dumps(job.get("result", {"ok": False, "error": "server is stopping"})).encode() + b"\n")
                    except OSError:
                        pass

    def run(self, initialize=False):
        prior = read_json(self.config.state)
        if initialize:
            if self.config.db.exists() or prior:
                raise Failure("init requires a new empty project")
        elif not self.config.db.exists():
            raise Failure("project is absent; explicitly initialize or restore it")
        elif not prior or not re.fullmatch(r"[0-9a-f]{40}", prior.get("revision", "")):
            raise Failure("existing project has no container provenance; explicit migration required")
        elif prior["revision"] != self.config.revision:
            prepared = read_json(self.config.private / "prepared-upgrade.json")
            if prepared_matches(self.config, prepared, prior["revision"]):
                self.store.verify_remote(prepared["key"], prepared["sha256"])
            else:
                complete_backup(self.config, self.store, prior["revision"])
        # Record intent before starting a binary that may migrate data.
        atomic_json(self.config.state, {"revision": self.config.revision})
        (self.config.private / "prepared-upgrade.json").unlink(missing_ok=True)
        self.start(initialize)
        thread = threading.Thread(target=self.control_loop, daemon=True)
        thread.start()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: self.stopping.set())
        last = read_json(self.config.private / "last-backup.json", {}).get("completed", 0)
        next_backup = max(time.time() + 60, last + DAY)
        try:
            while not self.stopping.wait(0.25):
                if not self.paused and (self.child is None or self.child.poll() is not None):
                    raise Failure("server exited unexpectedly")
                marker = self.config.private / "restore-pending.json"
                if marker.exists() and self.child is not None:
                    connection = http.client.HTTPConnection("127.0.0.1", 80, timeout=1)
                    try:
                        connection.request("GET", "/up", headers={"Host": self.config.domain})
                        response = connection.getresponse()
                        response.read()
                        if response.status == 200:
                            marker.unlink()
                    except OSError:
                        pass
                    finally:
                        connection.close()
                job = None
                with self.condition:
                    if self.commands:
                        job = self.commands.pop(0)
                if job:
                    try:
                        if self.paused:
                            raise Failure("service is already prepared for upgrade")
                        job["result"] = self.backup(job["command"] == "prepare-upgrade")
                        next_backup = time.time() + DAY
                    except Exception:
                        job["result"] = {"ok": False, "error": "backup failed; inspect private operational state"}
                        print("hosted backup failed", file=sys.stderr, flush=True)
                    finally:
                        job["done"].set()
                elif not self.paused and time.time() >= next_backup:
                    try:
                        self.backup()
                        next_backup = time.time() + DAY
                        print("daily backup verified", flush=True)
                    except Exception:
                        print("daily backup failed; retry in one hour", file=sys.stderr, flush=True)
                        next_backup = time.time() + 3600
        finally:
            self.stopping.set()
            if self.child is not None and self.child.poll() is None:
                self.stop()
            self.config.control.unlink(missing_ok=True)


def control(config, command):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(900)
        client.connect(str(config.control))
        client.sendall(command.encode() + b"\n")
        raw = bytearray()
        while b"\n" not in raw and len(raw) < 4096:
            block = client.recv(4096)
            if not block:
                break
            raw.extend(block)
    result = json.loads(raw)
    if not result.get("ok"):
        raise Failure(result.get("error", "backup failed"))
    print(json.dumps(result))


def restore(config, store, key):
    if config.db.exists() or (config.private / "cache").exists() or config.state.exists():
        raise Failure("restore requires an empty destination volume")
    with tempfile.TemporaryDirectory(prefix="restore-", dir=config.private) as temp:
        temp = Path(temp)
        archive = temp / "backup.tar.gz"
        meta = store.download(key, archive)
        extracted = temp / "verified"
        extracted.mkdir(mode=0o700)
        manifest = validate_archive(archive, extracted)
        if meta.get("instance") != manifest["instance"] or meta.get("revision") != manifest["revision"]:
            raise Failure("backup ownership metadata does not match manifest")
        # Preflight all destinations before publishing any recovered file.
        if any(config.project.iterdir()):
            raise Failure("restore would overwrite project files")
        private = extracted / "private"
        private_paths = list(private.iterdir()) if private.exists() else []
        if any((config.private / path.name).exists() for path in private_paths):
            raise Failure("restore would overwrite private state")
        # Restored authorization must not resurrect grants revoked since this backup.
        for path in private.rglob("mcp-oauth-*.json"):
            path.unlink()
        config.project.rmdir()
        os.replace(extracted / "project", config.project)
        for path in private_paths:
            os.replace(path, config.private / path.name)
        atomic_json(config.private / "restore-pending.json", {"revision": manifest["revision"]})
        atomic_json(config.state, {"revision": manifest["revision"]})
        print(json.dumps({"ok": True, "instance": manifest["instance"], "revision": manifest["revision"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", default="serve", choices=("serve", "init", "backup", "prepare-upgrade", "restore"))
    parser.add_argument("key", nargs="?")
    args = parser.parse_args()
    override = os.environ.get("POCKETCONTEXT_CONTAINER_COMMAND", "")
    if override not in ("", "init"):
        raise Failure("POCKETCONTEXT_CONTAINER_COMMAND supports only explicit init")
    if args.command == "serve" and override == "init":
        args.command = "init"
    config = Config()
    os.umask(0o077)
    if args.command in ("backup", "prepare-upgrade"):
        return control(config, args.command)
    config.validate()
    store = BackupStore()
    with exclusive(config):
        if args.command == "restore":
            if not args.key:
                raise Failure("restore requires an exact backup object key")
            return restore(config, store, args.key)
        Supervisor(config, store).run(args.command == "init")


if __name__ == "__main__":
    try:
        main()
    except Failure as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Provider exceptions can contain signed URLs, settings and credentials.
        print("hosted operation failed; credentials and provider details suppressed", file=sys.stderr)
        sys.exit(1)
