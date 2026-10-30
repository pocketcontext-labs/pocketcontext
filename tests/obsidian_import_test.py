#!/usr/bin/env python3
"""Synthetic preservation and resume checks for the standalone importer."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("obsidian_import", Path(__file__).resolve().parents[1] / "scripts/import_obsidian.py")
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "vault"
        self.root.mkdir()

    def write(self, collection, name, text, raw=False):
        path = self.root / collection / ("raw" if raw else m.CONTENT_DIR) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text if isinstance(text, bytes) else text.encode())
        return path.relative_to(self.root).as_posix()

    def convert(self, path):
        inventory = m.Inventory(self.root)
        converter = m.Converter(inventory)
        return converter.convert(inventory.entries[path]), converter

    def test_local_alias_heading_and_cross_space(self):
        path = self.write("alpha", "index.md", "# Home\n[[nested/topic.md#Details|Read]] and [[beta/" + m.CONTENT_DIR + "/index.md|Other]].")
        self.write("alpha", "nested/topic.md", "# Topic")
        self.write("beta", "index.md", "# Other")
        page, converter = self.convert(path)
        self.assertEqual(page["slug"], "overview")
        self.assertIn("[[nested-topic#Details|Read]]", page["body"])
        self.assertIn("[Other](space:000000000000000/overview)", page["body"])
        self.assertEqual(converter.cross_spaces, {"beta"})

    def test_multiline_and_inline_code_aliases(self):
        path = self.write("alpha", "index.md", "[[nested/topic|the topic\npaper guide]] and [[nested/topic#Token scheme|BERT's `[CLS]`/`[SEP]` scheme]].")
        self.write("alpha", "nested/topic.md", "# Topic")
        page, converter = self.convert(path)
        self.assertIn("[[nested-topic|the topic paper guide]]", page["body"])
        self.assertIn("[BERT's `[CLS]`/`[SEP]` scheme](page:nested-topic#Token%20scheme)", page["body"])
        self.assertFalse(converter.issues)

    def test_formatted_link_in_named_footnote_keeps_definition(self):
        path = self.write("alpha", "index.md", "Claim.[^original]\n\n[^original]: [[topic|the `[CLS]`\n    scheme]] and [[raw/note.md|original]].\n")
        self.write("alpha", "topic.md", "# Topic")
        self.write("alpha", "note.md", "Original", raw=True)
        page, converter = self.convert(path)
        self.assertIn("Claim.[^import-1]", page["body"])
        self.assertIn("[^import-1]: [the `[CLS]` scheme](page:topic)", page["body"])
        self.assertIn("[original](source:000000000000000)", page["body"])
        self.assertFalse(converter.issues)

    def test_sources_images_and_footnotes(self):
        path = self.write("alpha", "page.md", "# Page\n![Caption](assets/figure.png)\n![[assets/figure.png|320x200]]\nClaim.[^1]\n\n[^1]: [[raw/original.md|Original]]\n    See [[other]].")
        self.write("alpha", "assets/figure.png", b"synthetic bytes")
        self.write("alpha", "original.md", "Original", raw=True)
        self.write("alpha", "other.md", "Other")
        page, converter = self.convert(path)
        body = page["body"]
        self.assertIn('![figure](source:000000000000000 "size=320x200")', body)
        self.assertIn("![Caption](source:000000000000000)", body)
        self.assertIn("[^import-1]: [Original](source:000000000000000)", body)
        self.assertIn("    See [[other|other]].", body)
        self.assertNotIn("[^1]", body)
        self.assertEqual(converter.issues, [])

    def test_code_is_preserved_including_multiline_spans(self):
        code = "```md\n[[absent]] [^1]\n```\n\n`[[absent]]`\n\n``start\n[[absent]] [^2]\nend``\n\n    [[absent]]\n"
        path = self.write("alpha", "page.md", code + "\n[[missing]]")
        page, converter = self.convert(path)
        self.assertIn(code, page["body"])
        self.assertEqual(len(converter.issues), 1)
        self.assertEqual(converter.issues[0]["target"], "missing")

    def test_unique_nested_basename_prefers_page_to_original(self):
        path = self.write("alpha", "index.md", "[[paper]]")
        self.write("alpha", "papers/paper.md", "Page")
        self.write("alpha", "paper.pdf", b"original", raw=True)
        page, converter = self.convert(path)
        self.assertIn("[[papers-paper|paper]]", page["body"])
        self.assertFalse(converter.issues)

    def test_ambiguous_and_missing_targets_are_reported(self):
        path = self.write("alpha", "index.md", "[[topic]] and [[missing]]")
        self.write("alpha", "one/topic.md", "One")
        self.write("alpha", "two/topic.md", "Two")
        page, converter = self.convert(path)
        self.assertEqual([i["reason"] for i in converter.issues], ["ambiguous local filename", "missing target"])
        self.assertNotIn("[[", page["body"])

    def test_collision_slugs_are_stable_and_reserved_names_replaced(self):
        self.write("alpha", "index.md", "Home")
        self.write("alpha", "overview.md", "Other")
        self.write("alpha", "log.md", "History")
        inventory = m.Inventory(self.root)
        slugs = [e["slug"] for e in inventory.entries.values()]
        self.assertEqual(len(set(slugs)), 3)
        self.assertIn("import-history", slugs)
        self.assertTrue(all(s not in {"index", "log"} for s in slugs))
        self.assertEqual(slugs, [e["slug"] for e in m.Inventory(self.root).entries.values()])

    def test_excluded_collections_empty_sources_and_no_foreign_fallback(self):
        path = self.write("alpha", "index.md", "[[other]]")
        self.write("alpha", "empty.md", "", raw=True)
        self.write("beta", "other.md", "Other")
        self.write("_master", "index.md", "Excluded")
        self.write("_template", "index.md", "Excluded")
        inventory = m.Inventory(self.root)
        self.assertEqual(inventory.collections, ["alpha", "beta"])
        self.assertEqual(inventory.issues[0]["reason"], "empty source")
        page, converter = self.convert(path)
        self.assertEqual(converter.issues[0]["reason"], "missing target")

    def test_relative_paths_cannot_escape_vault(self):
        path = self.write("alpha", "index.md", "[[../../../../outside.md]]")
        _, converter = self.convert(path)
        self.assertEqual(converter.issues[0]["reason"], "missing target")

    def test_ordinary_markdown_relative_link_not_converted_twice(self):
        path = self.write("alpha", "index.md", "[Topic](nested/topic.md)")
        self.write("alpha", "nested/topic.md", "Topic")
        page, converter = self.convert(path)
        self.assertIn("[[nested-topic|Topic]]", page["body"])
        self.assertFalse(converter.issues)

    def test_resume_published_run_never_restages(self):
        self.write("alpha", "index.md", "Home")
        inventory = m.Inventory(self.root)
        audit = m.Converter(inventory)
        args = SimpleNamespace(state=Path(self.temp.name) / "state.json", binary="/binary", db=Path(self.temp.name) / "project.db")
        fake = FakeCLI()
        with patch.object(m, "CLI", return_value=fake):
            first = m.apply(inventory, ["alpha"], args, audit)
            second = m.apply(inventory, ["alpha"], args, audit)
        self.assertEqual(first[0]["status"], "published")
        self.assertEqual(second[0]["status"], "unchanged")
        self.assertEqual(fake.stages, 1)

    def test_changed_input_refused_before_writes(self):
        path = self.write("alpha", "index.md", "Home")
        inventory = m.Inventory(self.root)
        args = SimpleNamespace(state=Path(self.temp.name) / "state.json", binary="/binary", db=Path(self.temp.name) / "project.db")
        fake = FakeCLI()
        with patch.object(m, "CLI", return_value=fake):
            m.apply(inventory, ["alpha"], args, m.Converter(inventory))
            (self.root / path).write_text("Changed")
            changed = m.Inventory(self.root)
            before = len(fake.calls)
            with self.assertRaisesRegex(RuntimeError, "Input changed"):
                m.apply(changed, ["alpha"], args, m.Converter(changed))
            self.assertEqual(len(fake.calls), before)

    def test_manual_revision_refused_on_resume(self):
        self.write("alpha", "index.md", "Home")
        inventory = m.Inventory(self.root)
        args = SimpleNamespace(state=Path(self.temp.name) / "state.json", binary="/binary", db=Path(self.temp.name) / "project.db")
        fake = FakeCLI()
        with patch.object(m, "CLI", return_value=fake):
            m.apply(inventory, ["alpha"], args, m.Converter(inventory))
            fake.manifest = {"page1": "manual-revision"}
            with self.assertRaisesRegex(RuntimeError, "changed after publication"):
                m.apply(inventory, ["alpha"], args, m.Converter(inventory))
        self.assertEqual(fake.stages, 1)


    def test_interrupted_stage_resumes_reserved_run(self):
        self.write("alpha", "index.md", "Home")
        inventory = m.Inventory(self.root)
        args = SimpleNamespace(state=Path(self.temp.name) / "state.json", binary="/binary", db=Path(self.temp.name) / "project.db")
        fake = FakeCLI()
        normal = fake.call
        def fail_stage(*args, **kwargs):
            if args[0] == "stage":
                raise RuntimeError("interrupted first page batch")
            return normal(*args, **kwargs)
        fake.call = fail_stage
        with patch.object(m, "CLI", return_value=fake):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                m.apply(inventory, ["alpha"], args, m.Converter(inventory))
            self.assertEqual(fake.run["status"], "staging")
            fake.call = normal
            result = m.apply(inventory, ["alpha"], args, m.Converter(inventory))
        self.assertEqual(result[0]["status"], "published")
        self.assertEqual(sum(call[0] == "create" for call in fake.calls), 1)

class FakeCLI:
    database = "synthetic-database"
    def __init__(self):
        self.calls = []
        self.stages = 0
        self.run = None
        self.manifest = {}

    def call(self, *args, **kwargs):
        self.calls.append(args)
        if args[0] == "create-space":
            return {"id": "space0000000001", "archived": False}
        if args[0] == "create":
            self.run = {"id": "run1", "status": "staging", "revision": 1}
            return self.run
        if args[0] == "stage":
            self.stages += 1
            self.run = {"id": "run1", "status": "staging", "revision": 1}
            return {"run": "run1", "revision": 1, "problems": []}
        if args[0] == "check-run":
            return {"ok": True}
        if args[0] == "publish":
            self.run["status"] = "published"
            self.manifest = {"page1": "revision1"}
        return {}

    def rows(self, query):
        if "FROM ingestion_runs" in query:
            return [self.run] if self.run else []
        if "FROM publications" in query:
            return [{"manifest": json.dumps(self.manifest)}]
        return []

    def all_rows(self, *args):
        return [{"id": "revision1", "page": "page1"}]


if __name__ == "__main__":
    unittest.main()
