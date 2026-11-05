#!/usr/bin/env python3
"""Synthetic archive, retention, restore and lifecycle regression checks."""
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("hosted", Path(__file__).with_name("entrypoint.py"))
hosted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosted)


class S3:
    def __init__(self):
        self.objects = {}
        self.deleted = []
        self.corrupt = False

    def upload_file(self, path, bucket, key, ExtraArgs):
        self.objects[key] = {"Body": Path(path).read_bytes(), "Metadata": ExtraArgs["Metadata"],
                             "LastModified": dt.datetime.now(dt.timezone.utc)}

    def get_object(self, Bucket, Key):
        value = self.objects[Key]
        return {"Body": io.BytesIO(value["Body"] + (b"corrupt" if self.corrupt else b""))}

    def head_object(self, Bucket, Key):
        return self.objects[Key]

    def download_file(self, bucket, key, path):
        Path(path).write_bytes(self.objects[key]["Body"])

    def get_paginator(self, name):
        return self

    def paginate(self, Bucket, Prefix):
        yield {"Contents": [{"Key": key, "LastModified": value["LastModified"]} for key, value in self.objects.items() if key.startswith(Prefix)]}

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)
        del self.objects[Key]


def store():
    obj = hosted.BackupStore.__new__(hosted.BackupStore)
    obj.client, obj.bucket, obj.prefix = S3(), "synthetic-private-bucket", "synthetic"
    return obj


class Backups(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = hosted.Config(Path(self.temp.name) / "source")
        self.config.initialize_dirs()
        self.config.revision = "a" * 40
        self.instance = "b" * 32
        hosted.atomic_json(self.config.project / "pocketcontext.json", {"instance": self.instance, "name": "Synthetic"})
        with sqlite3.connect(self.config.db) as db:
            db.execute("CREATE TABLE evidence (body TEXT)")
            db.execute("INSERT INTO evidence VALUES ('synthetic evidence')")
        originals = self.config.project / "storage" / "sources" / "synthetic"
        originals.mkdir(parents=True)
        (originals / "note.txt").write_text("synthetic immutable original")
        with sqlite3.connect(self.config.db) as db:
            db.execute("CREATE TABLE _collections (id TEXT, name TEXT)")
            db.execute("INSERT INTO _collections VALUES ('sources', 'sources')")
            db.execute("CREATE TABLE sources (id TEXT, original TEXT, sha256 TEXT)")
            db.execute("INSERT INTO sources VALUES ('synthetic', 'note.txt', ?)", (hosted.digest(originals / "note.txt"),))
        runtime = self.config.private / "cache" / "pocketcontext" / "test"
        runtime.mkdir(parents=True)
        hosted.atomic_json(runtime / "mcp-oauth-synthetic.json", {"grants": {"synthetic": "preserved"}})
        (runtime / "server.log").write_text("not part of recovery")
        self.store = store()

    def test_populated_roundtrip_preserves_originals_private_state_and_revision(self):
        result = hosted.complete_backup(self.config, self.store, self.config.revision)
        target = hosted.Config(Path(self.temp.name) / "destination")
        target.initialize_dirs()
        hosted.restore(target, self.store, result["key"])
        with sqlite3.connect(target.db) as db:
            self.assertEqual(db.execute("SELECT body FROM evidence").fetchone(), ("synthetic evidence",))
        self.assertEqual((target.project / "storage/sources/synthetic/note.txt").read_text(), "synthetic immutable original")
        self.assertFalse((target.private / "cache/pocketcontext/test/mcp-oauth-synthetic.json").exists())
        self.assertTrue((target.private / "restore-pending.json").exists())
        self.assertFalse((target.private / "cache/pocketcontext/test/server.log").exists())
        self.assertEqual(hosted.read_json(target.state)["revision"], self.config.revision)
        with self.assertRaises(hosted.Failure):
            hosted.restore(target, self.store, result["key"])

    def test_changed_state_invalidates_prepared_upgrade(self):
        result = hosted.complete_backup(self.config, self.store, self.config.revision)
        self.assertTrue(hosted.prepared_matches(self.config, result, self.config.revision))
        with sqlite3.connect(self.config.db) as db:
            db.execute("INSERT INTO evidence VALUES ('later write')")
        self.assertFalse(hosted.prepared_matches(self.config, result, self.config.revision))
        self.assertFalse(hosted.prepared_matches(self.config, result, "c" * 40))

    def test_remote_corruption_does_not_record_success(self):
        self.store.client.corrupt = True
        with self.assertRaises(hosted.Failure):
            hosted.complete_backup(self.config, self.store, self.config.revision)
        self.assertFalse((self.config.private / "last-backup.json").exists())

    def test_retention_only_deletes_old_owned_instance_archives(self):
        result = hosted.complete_backup(self.config, self.store, self.config.revision)
        original = self.store.client.objects[result["key"]]
        old = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=31)
        original["LastModified"] = old
        unknown = self.store.prefix + "/" + self.instance + "/do-not-delete.tar.gz"
        self.store.client.objects[unknown] = dict(original)
        other = self.store.prefix + "/" + "c" * 32 + "/" + result["key"].rsplit("/", 1)[-1]
        self.store.client.objects[other] = dict(original)
        no_owner = self.store.prefix + "/" + self.instance + "/20000101T000000Z-" + "d" * 32 + ".tar.gz"
        self.store.client.objects[no_owner] = dict(original, Metadata={})
        self.store.prune(self.instance)
        self.assertEqual(self.store.client.deleted, [result["key"]])
        self.assertEqual(set(self.store.client.objects), {unknown, other, no_owner})

    def test_missing_original_refuses_backup(self):
        (self.config.project / "storage/sources/synthetic/note.txt").unlink()
        with self.assertRaises(hosted.Failure):
            hosted.snapshot(self.config, self.config.revision)

    def test_log_named_original_is_preserved(self):
        original = self.config.project / "storage/sources/synthetic/evidence.log"
        original.write_text("valid original")
        self.assertIn(original, hosted.included_files(self.config))

    def test_snapshot_refuses_symlink_roots(self):
        other = Path(self.temp.name) / "outside"
        other.mkdir()
        (other / "private-file").write_text("must not be followed")
        (self.config.private / "config").symlink_to(other, target_is_directory=True)
        with self.assertRaises(hosted.Failure):
            hosted.snapshot(self.config, self.config.revision)

    def test_failed_prepare_retention_resumes_and_removes_receipt(self):
        supervisor = hosted.Supervisor(self.config, self.store)
        with patch.object(supervisor, "stop"), patch.object(supervisor, "start") as start, patch.object(self.store, "prune", side_effect=hosted.Failure("denied")):
            with self.assertRaises(hosted.Failure):
                supervisor.backup(pause=True)
            start.assert_called_once()
        self.assertFalse(supervisor.paused)
        self.assertFalse((self.config.private / "prepared-upgrade.json").exists())

    def test_snapshot_refuses_symlinks(self):
        (self.config.project / "storage" / "escape").symlink_to("/etc/passwd")
        with self.assertRaises(hosted.Failure):
            hosted.snapshot(self.config, self.config.revision)

    def test_archive_rejects_traversal_links_duplicates_and_corruption(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("/escape", tarfile.REGTYPE), ("private/link", tarfile.SYMTYPE)):
            with self.subTest(name=name):
                archive = Path(self.temp.name) / "unsafe.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    entry.linkname = "/etc/passwd"
                    tar.addfile(entry, io.BytesIO(b""))
                with tempfile.TemporaryDirectory() as destination:
                    with self.assertRaises(hosted.Failure):
                        hosted.validate_archive(archive, Path(destination))
        archive, _ = hosted.snapshot(self.config, self.config.revision)
        rewritten = archive.with_name("corrupt.tar.gz")
        with tarfile.open(archive) as source, tarfile.open(rewritten, "w:gz") as target:
            for entry in source.getmembers():
                data = source.extractfile(entry).read()
                if entry.name.endswith("note.txt"):
                    data = b"corruption"
                    entry.size = len(data)
                target.addfile(entry, io.BytesIO(data))
        with tempfile.TemporaryDirectory() as destination:
            with self.assertRaises(hosted.Failure):
                hosted.validate_archive(rewritten, Path(destination))

    def test_volume_lock_excludes_other_writer(self):
        with hosted.exclusive(self.config):
            with self.assertRaises(hosted.Failure):
                with hosted.exclusive(self.config):
                    self.fail("acquired second writer")

    def test_failed_shutdown_exits_supervisor_instead_of_staying_unhealthy(self):
        hosted.atomic_json(self.config.state, {"revision": self.config.revision})
        supervisor = hosted.Supervisor(self.config, self.store)
        failed_child = Mock()
        failed_child.poll.return_value = None
        failed_child.wait.return_value = 1
        supervisor.commands.append({"command": "backup", "done": threading.Event()})
        def start():
            supervisor.child = failed_child
        with patch.object(supervisor, "start", side_effect=lambda *_: start()), patch.object(supervisor, "control_loop"), patch.object(hosted.signal, "signal"):
            with self.assertRaisesRegex(hosted.Failure, "server exited unexpectedly"):
                supervisor.run()
        self.assertTrue(supervisor.stopping.is_set())

    def test_init_refuses_existing_project_without_starting(self):
        supervisor = hosted.Supervisor(self.config, self.store)
        with patch.object(supervisor, "start") as start:
            with self.assertRaises(hosted.Failure):
                supervisor.run(initialize=True)
            start.assert_not_called()

    def test_upgrade_failure_does_not_start_new_binary_or_advance_revision(self):
        hosted.atomic_json(self.config.state, {"revision": self.config.revision})
        self.config.revision = "c" * 40
        supervisor = hosted.Supervisor(self.config, self.store)
        with patch.object(self.store, "upload", side_effect=hosted.Failure("offline")), patch.object(supervisor, "start") as start:
            with self.assertRaises(hosted.Failure):
                supervisor.run()
            start.assert_not_called()
        self.assertEqual(hosted.read_json(self.config.state)["revision"], "a" * 40)


if __name__ == "__main__":
    unittest.main()
