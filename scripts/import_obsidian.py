#!/usr/bin/env python3
"""Audit or import independent Obsidian collections through the PocketContext CLI.

Default is an offline audit. --apply requires an initialized database and a
private state file outside both repositories. No database or storage files are
opened directly. Original files are never modified.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import unicodedata
from urllib.parse import quote, unquote

CONTENT_DIR = "wi" + "ki"
VERSION = 1
NOTICE = "> Imported from Obsidian. Original references are preserved; claims have not been verified against source passages. [needs verification]\n\n"
EXCLUDED = {"_master", "_template"}
TEXT_EXTENSIONS = {".txt", ".md", ".markdown", ".csv", ".json", ".rst", ".log", ".srt", ".org", ""}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def slugify(value):
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-")[:130].rstrip("-") or "page"


def prose_parts(text):
    """Yield (is_code, text), preserving fenced/indented and multiline inline code."""
    def inline(value):
        cursor = 0
        marker = re.compile(r"(?<!\\)(!?\[\[|`+)")
        while cursor < len(value):
            start = marker.search(value, cursor)
            if start is None:
                yield False, value[cursor:]
                break
            yield False, value[cursor:start.start()]
            if start[0].endswith("[["):
                # Inline formatting belongs to the link label, not to the surrounding
                # code scanner. Obsidian also permits a label to wrap onto another line.
                end = value.find("]]", start.end())
                if end >= 0:
                    yield False, value[start.start():end + 2]
                    cursor = end + 2
                    continue
            else:
                end = next((token for token in re.finditer(r"`+", value[start.end():]) if len(token[0]) == len(start[0])), None)
                if end is not None:
                    stop = start.end() + end.end()
                    yield True, value[start.start():stop]
                    cursor = stop
                    continue
            yield False, start[0]
            cursor = start.end()

    fence, buffer, footnote = None, [], False
    for line in text.splitlines(keepends=True):
        match = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        indented = line.startswith(("    ", "\t"))
        if re.match(r"^ {0,3}\[\^[^\]]+\]:", line):
            footnote = True
        elif line.strip() and not indented:
            footnote = False
        code = bool(fence or match or (indented and not footnote))
        if code:
            yield from inline("".join(buffer))
            buffer.clear()
            yield True, line
            if fence:
                if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not line[match.end():].strip():
                    fence = None
            elif match:
                fence = match[1]
        else:
            buffer.append(line)
    yield from inline("".join(buffer))


class Inventory:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.entries = {}
        self.collections = []
        self.issues = []
        self.by_basename = defaultdict(list)
        self.by_stem = defaultdict(list)
        for directory in sorted(self.root.iterdir()):
            if not directory.is_dir() or directory.name.startswith(".") or directory.name in EXCLUDED:
                continue
            if not (directory / CONTENT_DIR).is_dir():
                continue
            name = directory.name
            self.collections.append(name)
            for sub in ("raw", CONTENT_DIR):
                for path in sorted((directory / sub).rglob("*")):
                    if not path.is_file() or any(part.startswith(".") for part in path.relative_to(directory / sub).parts):
                        continue
                    if path.is_symlink() or not path.resolve().is_relative_to(self.root):
                        raise ValueError(f"Refusing symlink or path outside vault: {path}")
                    data = path.read_bytes()
                    rel = path.relative_to(self.root).as_posix()
                    page = sub == CONTENT_DIR and path.suffix.lower() == ".md"
                    entry = {"path": rel, "collection": name, "kind": "page" if page else "source", "sha256": digest(data), "bytes": len(data)}
                    if page:
                        entry["text"] = data.decode("utf-8-sig")
                    else:
                        limit = (100 if path.suffix.lower() in TEXT_EXTENSIONS else 50) * 1024 * 1024
                        if not data:
                            entry["skip"] = "empty source"
                        elif data.startswith(b"version https://git-lfs.github.com/spec/v1"):
                            entry["skip"] = "Git LFS pointer"
                        elif len(data) > limit:
                            entry["skip"] = "source exceeds upload limit"
                        elif path.suffix.lower() in TEXT_EXTENSIONS:
                            try:
                                data.decode("utf-8")
                            except UnicodeDecodeError:
                                entry["skip"] = "text source is not UTF-8"
                        if "skip" in entry:
                            self.issues.append({"page": rel, "target": rel, "reason": entry["skip"]})
                    self.entries[rel] = entry
                    self.by_basename[(name, path.name)].append(entry)
                    self.by_stem[(name, path.stem)].append(entry)
        for name in self.collections:
            pages = [e for e in self.entries.values() if e["collection"] == name and e["kind"] == "page"]
            groups = defaultdict(list)
            for entry in pages:
                relative = PurePosixPath(entry["path"]).relative_to(name, CONTENT_DIR)
                base = {"index.md": "overview", "log.md": "import-history"}.get(str(relative), slugify(str(relative.with_suffix(""))))
                if base in {"index", "log"}:
                    base = "import-" + base
                groups[base].append(entry)
            for base, entries in groups.items():
                for entry in entries:
                    entry["slug"] = base if len(entries) == 1 else base + "-" + digest(entry["path"].encode())[:10]

    def resolve(self, origin, target):
        target = unquote(target).replace("\\", "/")
        if not target:
            return self.entries[origin], None
        page = self.entries[origin]
        name = page["collection"]
        explicit = target.split("/")[0] in set(self.collections) | EXCLUDED
        candidates = [target] if explicit else [str(PurePosixPath(origin).parent / target), f"{name}/{CONTENT_DIR}/{target}", f"{name}/{target}"]
        for candidate in candidates:
            normalized = os.path.normpath(candidate).replace(os.sep, "/")
            if normalized.startswith("../") or normalized.startswith("/"):
                continue
            for value in (normalized, normalized + ".md"):
                if value in self.entries:
                    return self.entries[value], None
        if "/" not in target:
            matches = self.by_basename.get((name, target), []) or self.by_stem.get((name, target), [])
            if not PurePosixPath(target).suffix:
                pages = [entry for entry in matches if entry["kind"] == "page"]
                matches = pages or matches
            if len(matches) == 1:
                return matches[0], None
            if len(matches) > 1:
                return None, "ambiguous local filename"
        return None, "missing target"

    def fingerprint(self, name):
        rows = [(e["path"], e["sha256"], e.get("slug")) for e in self.entries.values() if e["collection"] == name]
        return digest(json.dumps([VERSION, rows], sort_keys=True).encode())


class Converter:
    def __init__(self, inventory, spaces=None, sources=None):
        self.inventory = inventory
        self.spaces = spaces or {name: "000000000000000" for name in inventory.collections}
        self.sources = sources or {path: "000000000000000" for path, e in inventory.entries.items() if e["kind"] == "source" and not e.get("skip")}
        self.issues = []
        self.cross_spaces = set()
        self.references = Counter()

    def issue(self, origin, target, reason):
        self.issues.append({"page": origin, "target": target, "reason": reason})

    @staticmethod
    def label(text):
        return text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]").replace("\n", " ")

    def link(self, origin, target, label=None, embed=False, title=None):
        destination, _, heading = target.partition("#")
        entry, error = self.inventory.resolve(origin, destination)
        display = label or PurePosixPath(destination).stem or heading or "This page"
        if error or (entry and entry.get("skip")):
            self.issue(origin, target, error or entry["skip"])
            return self.label(display) + " (unresolved imported reference)"
        if heading.startswith("^"):
            self.issue(origin, target, "block references are not supported; linked to page")
            heading = ""
        if entry["kind"] == "page":
            if embed:
                self.issue(origin, target, "page transclusion preserved as a link")
            anchor = "#" + heading if heading else ""
            if entry["collection"] == self.inventory.entries[origin]["collection"]:
                self.references["local_page"] += 1
                display = re.sub(r"\s+", " ", display).strip()
                if any(character in display for character in "[]`|"):
                    uri = "page:" + entry["slug"]
                    if heading:
                        uri += "#" + quote(heading, safe="")
                    return f"[{display}]({uri})"
                return f"[[{entry['slug']}{anchor}|{display}]]"
            self.cross_spaces.add(entry["collection"])
            self.references["cross_space"] += 1
            if entry["collection"] not in self.spaces:
                raise ValueError("Missing destination space mapping: " + entry["collection"])
            uri = f"space:{self.spaces[entry['collection']]}/{entry['slug']}"
            if heading:
                uri += "#" + quote(heading, safe="")
            return f"[{self.label(display)}]({uri})"
        if entry["collection"] != self.inventory.entries[origin]["collection"]:
            self.issue(origin, target, "cross-space source reference is unsupported")
            return self.label(display) + " (unresolved imported reference)"
        if heading:
            self.issue(origin, target, "source fragment is unsupported; linked to original")
        source_id = self.sources.get(entry["path"])
        if not source_id:
            raise ValueError("Missing source mapping: " + entry["path"])
        if embed and PurePosixPath(entry["path"]).suffix.lower() not in IMAGE_EXTENSIONS:
            self.issue(origin, target, "non-image embed preserved as a source link")
            embed = False
        self.references["image" if embed else "source"] += 1
        if embed and label and re.fullmatch(r"\d+(?:x\d+)?", label):
            title, display = "size=" + label, PurePosixPath(destination).stem
        suffix = ' "' + title.replace('"', "&quot;") + '"' if title else ""
        return f"{'!' if embed else ''}[{self.label(display)}](source:{source_id}{suffix})"

    def convert(self, entry):
        origin = entry["path"]
        footnotes = {}
        def footnote(match):
            key = match[1]
            if key not in footnotes:
                footnotes[key] = "import-" + str(len(footnotes) + 1)
            return "[^" + footnotes[key] + "]"
        def transform(part):
            # Convert ordinary relative Markdown links before generating any new links.
            expression = r'(?<!!)(!?)\[([^\]\n]*)\]\((<[^>\n]*>|(?:[^()\s]+|\([^()\n]*\))+)(?:\s+"([^"]*)")?\)'
            def ordinary(match):
                target = match[3].strip("<>")
                if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith(("#", "//")):
                    return match[0]
                return self.link(origin, target, match[2], bool(match[1]), match[4])
            def bracket(match):
                target, _, alias = match[2].partition("|")
                return self.link(origin, target, alias or None, bool(match[1]))
            part = re.sub(r"(?<![\\!])(!?)\[\[((?:(?!\]\]).)+)\]\]", bracket, part, flags=re.S)
            part = re.sub(expression, ordinary, part)
            return re.sub(r"\[\^([^\]\n]+)\]", footnote, part)
        body = NOTICE + "".join(part if code else transform(part) for code, part in prose_parts(entry["text"]))
        if len(body) > 100000:
            raise ValueError(f"Converted page exceeds 100,000 characters: {origin}")
        title = next((m[1].strip() for m in re.finditer(r"^#\s+(.+)$", entry["text"], re.M)), PurePosixPath(origin).stem.replace("-", " "))
        title = title[:500]
        return {"slug": entry["slug"], "kind": "legacy", "title": title,
                "summary": "Imported Obsidian page; original references have not been verified against source passages.",
                "body": body, "properties": {"import_format": "obsidian", "original_path": origin,
                 "original_sha256": entry["sha256"]}}


class CLI:
    def __init__(self, binary, database):
        self.binary = str(Path(binary).resolve())
        self.database = str(Path(database).resolve())

    def call(self, *args, space=None, data=None):
        command = [self.binary, *map(str, args), "--db", self.database]
        if space:
            command += ["--space", space]
        result = subprocess.run(command, input=json.dumps(data) if data is not None else None,
                                capture_output=True, text=True, encoding="utf-8")
        if result.returncode:
            # Command output contains diagnostics, never shell-interpreted content.
            raise RuntimeError(f"PocketContext {args[0]} failed ({result.returncode}): {result.stderr.strip()} {result.stdout.strip()}")
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"PocketContext {args[0]} did not return JSON") from error

    def rows(self, query):
        result = self.call("sql", query)
        if result.get("truncated"):
            raise RuntimeError("SQL response was truncated; refusing an incomplete migration check")
        return [dict(zip(result["columns"], row)) for row in result["rows"]]

    def all_rows(self, table, columns, where):
        result, after = [], ""
        while True:
            rows = self.rows(f"SELECT {columns} FROM {table} WHERE ({where}) AND id > {sql_string(after)} ORDER BY id LIMIT 100")
            result.extend(rows)
            if len(rows) < 100:
                return result
            after = rows[-1]["id"]


def save_state(path, state):
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


@contextmanager
def state_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(path.suffix + ".lock").open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                lock.write(b"0")
                lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError("Another importer is using this state file") from error
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def published_unchanged(cli, space, run_id):
    revisions = cli.all_rows("page_revisions", "id, page", "run=" + sql_string(run_id))
    rows = cli.rows("SELECT manifest FROM publications WHERE space=" + sql_string(space) + " ORDER BY sequence DESC LIMIT 1")
    manifest = rows[0]["manifest"] if rows else {}
    if isinstance(manifest, str):
        manifest = json.loads(manifest)
    changed = [r["page"] for r in revisions if manifest.get(r["page"]) != r["id"]]
    if changed:
        raise RuntimeError(f"{len(changed)} imported pages changed after publication; refusing to overwrite them")


def apply(inventory, selected, args, audit):
    state_path = Path(args.state).resolve()
    repository = Path(__file__).resolve().parents[1]
    if state_path.is_relative_to(inventory.root) or state_path.is_relative_to(repository):
        raise ValueError("Keep --state outside the source vault and code repository")
    cli = CLI(args.binary, args.db)
    with state_lock(state_path):
        identity = {"version": VERSION, "vault": str(inventory.root), "database": cli.database}
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {**identity, "spaces": {}, "sources": {}, "collections": {}}
        if any(state.get(key) != value for key, value in identity.items()):
            raise ValueError("State belongs to a different vault, database, or importer version")
        # All input checks happen before the first write, including already completed collections.
        for name in selected:
            previous = state["collections"].get(name)
            fingerprint = inventory.fingerprint(name)
            if previous and previous["fingerprint"] != fingerprint:
                raise RuntimeError(f"Input changed for {name}; this importer resumes one snapshot and will not overwrite later work")
            state["collections"].setdefault(name, {"fingerprint": fingerprint})
        cli.call("ensure-running")
        needed = set(selected) | set(audit.cross_spaces)
        for name in sorted(needed):
            result = cli.call("create-space", name)
            if result.get("archived") and name in selected:
                raise RuntimeError("Selected import space is archived: " + name)
            if name in state["spaces"] and state["spaces"][name] != result["id"]:
                raise RuntimeError("Destination space identity changed: " + name)
            state["spaces"][name] = result["id"]
            save_state(state_path, state)
        completed = []
        for name in selected:
            space = state["spaces"][name]
            snapshot = state["collections"][name]
            key = "obsidian-" + digest((str(inventory.root) + "/" + name + "/" + snapshot["fingerprint"]).encode())[:48]
            runs = cli.rows("SELECT id, status, revision FROM ingestion_runs WHERE space=" + sql_string(space) + " AND key=" + sql_string(key) + " LIMIT 1")
            run = runs[0] if runs else None
            if run and run["status"] == "published":
                published_unchanged(cli, space, run["id"])
                snapshot.update({"run": run["id"], "status": "published"})
                save_state(state_path, state)
                completed.append({"collection": name, "status": "unchanged", "run": run["id"]})
                continue
            if run and run["status"] != "staging":
                raise RuntimeError("Import run was cancelled; review required: " + name)
            if not run and cli.rows("SELECT id FROM pages WHERE space=" + sql_string(space) + " LIMIT 1"):
                raise RuntimeError("Refusing to import into a nonempty space without this import run: " + name)
            if not run:
                # Reserve the run before stage can create page identities. An interrupted
                # first batch can then resume without taking over unrelated pages.
                run = cli.call("create", "ingestion_runs", "-", space=space,
                               data={"key": key, "status": "staging", "description": "Preserve an Obsidian snapshot; references are not verified passage citations."})
                snapshot["run"] = run["id"]
                save_state(state_path, state)
            sources = [e for e in inventory.entries.values() if e["collection"] == name and e["kind"] == "source" and not e.get("skip")]
            for entry in sources:
                old = state["sources"].get(entry["path"])
                if old and old["sha256"] != entry["sha256"]:
                    raise RuntimeError("Source changed: " + entry["path"])
                if not old:
                    result = cli.call("ingest", inventory.root / entry["path"], space=space)
                    if result["sha256"] != entry["sha256"]:
                        raise RuntimeError("Source changed during import: " + entry["path"])
                    state["sources"][entry["path"]] = {"id": result["source"], "sha256": result["sha256"]}
                    save_state(state_path, state)
            converter = Converter(inventory, state["spaces"], {path: value["id"] for path, value in state["sources"].items()})
            pages = [converter.convert(e) for e in inventory.entries.values() if e["collection"] == name and e["kind"] == "page"]
            if not pages:
                completed.append({"collection": name, "status": "sources-only"})
                continue
            spec = {"run_key": key, "description": "Preserve an Obsidian snapshot; imported references are not verified passage citations.", "pages": pages}
            home = inventory.entries.get(f"{name}/{CONTENT_DIR}/index.md")
            if home:
                spec["home"] = home["slug"]
            result = cli.call("stage", "-", space=space, data=spec)
            if result.get("problems"):
                raise RuntimeError("Staged import has publication problems: " + json.dumps(result["problems"]))
            checked = cli.call("check-run", result["run"], space=space)
            if not checked.get("ok"):
                raise RuntimeError("Import failed publication check: " + json.dumps(checked))
            cli.call("publish", result["run"], "--expected-revision", result["revision"], space=space)
            published_unchanged(cli, space, result["run"])
            snapshot.update({"run": result["run"], "status": "published", "pages": len(pages)})
            save_state(state_path, state)
            completed.append({"collection": name, "status": "published", "run": result["run"], "pages": len(pages)})
            print(f"Published {name}: {len(pages)} pages", file=sys.stderr, flush=True)
        return completed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vault", type=Path)
    parser.add_argument("--collection", action="append", help="Import/audit only this collection; repeat to select several")
    parser.add_argument("--apply", action="store_true", help="Write sources/pages and publish; default is offline audit")
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--state", type=Path, help="Private resumable state outside the source and code repositories")
    parser.add_argument("--report", type=Path, help="Write the JSON report here instead of stdout")
    args = parser.parse_args(argv)
    if args.apply and not all((args.binary, args.db, args.state)):
        parser.error("--apply requires --binary, --db and --state")
    if args.report:
        report_path = args.report.resolve()
        if report_path.is_relative_to(args.vault.resolve()) or report_path.is_relative_to(Path(__file__).resolve().parents[1]):
            raise ValueError("Keep reports outside the source vault and code repository")
    inventory = Inventory(args.vault)
    selected = sorted(set(args.collection or inventory.collections))
    if not set(selected).issubset(inventory.collections):
        parser.error("Unknown collection: " + ", ".join(sorted(set(selected) - set(inventory.collections))))
    converter = Converter(inventory)
    entries = [e for e in inventory.entries.values() if e["collection"] in selected]
    for entry in entries:
        if entry["kind"] == "page":
            converter.convert(entry)
    report = {"mode": "apply" if args.apply else "audit", "collections": selected,
              "counts": {"pages": sum(e["kind"] == "page" for e in entries), "source_files": sum(e["kind"] == "source" for e in entries),
                         "skipped_sources": sum(bool(e.get("skip")) for e in entries)},
              "references": dict(converter.references), "cross_space_destinations": sorted(converter.cross_spaces),
              "issues": [i for i in inventory.issues if i["page"].split("/")[0] in selected] + converter.issues}
    if args.apply:
        report["results"] = apply(inventory, selected, args, converter)
    if args.report:
        report_path = args.report.resolve()
        if report_path.is_relative_to(inventory.root) or report_path.is_relative_to(Path(__file__).resolve().parents[1]):
            raise ValueError("Keep reports outside the source vault and code repository")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"report": str(report_path), "counts": report["counts"], "issues": len(report["issues"])}))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
