#!/usr/bin/env python3
"""Exercise the importer against the actual CLI using only temporary synthetic data."""
import argparse
import base64
import importlib.util
import json
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import os
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("obsidian_import", ROOT / "scripts/import_obsidian.py")
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=ROOT / "bin/pocketcontext")
    args = parser.parse_args()
    binary = args.binary.resolve()
    with tempfile.TemporaryDirectory(prefix="obsidian-import-") as temporary:
        root = Path(temporary).resolve()
        db = root / "project/pocketcontext.db"
        vault = root / "vault"
        for name in ("alpha", "beta"):
            (vault / name / m.CONTENT_DIR).mkdir(parents=True)
            (vault / name / "raw").mkdir()
        (vault / "alpha/raw/note.md").write_text("# Synthetic evidence\nAn example only.")
        (vault / "alpha/raw/empty.md").write_text("")
        (vault / "alpha" / m.CONTENT_DIR / "figure.png").write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII="))
        (vault / "alpha" / m.CONTENT_DIR / "index.md").write_text("# Alpha — café 日本語\n[[detail|Detail]] and [[detail|the `[CLS]` scheme]] and [[beta/" + m.CONTENT_DIR + "/index.md|Beta]].\n![[figure.png|120]]\nExample.[^1]\n\n[^1]: [[raw/note.md|Original]]\n\n```text\n[[literal]] [^9]\n```\n", encoding="utf-8")
        (vault / "alpha" / m.CONTENT_DIR / "detail.md").write_text("# Detail\n[[index|Home]]")
        (vault / "beta" / m.CONTENT_DIR / "index.md").write_text("# Beta")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        subprocess.run([str(binary), "init", "--db", str(db), "--port", str(port), "--password-stdin"],
                       input=secrets.token_urlsafe(32) + "\n", text=True, encoding="utf-8", capture_output=True, check=True)
        cli = m.CLI(binary, db)
        command = [sys.executable, str(ROOT / "scripts/import_obsidian.py"), str(vault), "--apply", "--binary", str(binary), "--db", str(db), "--state", str(root / "state.json")]
        # The importer emits UTF-8 even under a non-UTF-8 console encoding.
        import_env = {**os.environ, "PYTHONIOENCODING": "ascii"}
        try:
            result = subprocess.run(command, env=import_env, capture_output=True, text=True, encoding="utf-8")
            if result.returncode:
                raise AssertionError(result.stderr)
            first = json.loads(result.stdout)
            assert first["counts"] == {"pages": 3, "source_files": 3, "skipped_sources": 1}, first
            assert all(row["status"] == "published" for row in first["results"])
            second = subprocess.run(command, env=import_env, capture_output=True, text=True, encoding="utf-8", check=True)
            assert all(row["status"] == "unchanged" for row in json.loads(second.stdout)["results"])
            page = cli.call("page", "overview", space="alpha")
            assert page["title"] == "Alpha — café 日本語"
            assert "[^import-1]" in page["body"] and "source:" in page["body"] and "space:" in page["body"]
            assert "[[literal]] [^9]" in page["body"]
            assert "[the `[CLS]` scheme](page:detail)" in page["body"]
            assert '"size=120"' in page["body"]
            source_rows = cli.rows("SELECT count(*) AS n FROM sources")
            assert source_rows[0]["n"] == 2, source_rows
            edited = cli.call("stage", "-", space="alpha", data={"run_key": "manual-edit", "pages": [{"slug": "overview", "append": "\nA later manual change. [needs verification]"}]})
            cli.call("publish", edited["run"], "--expected-revision", edited["revision"], space="alpha")
            refused = subprocess.run(command, env=import_env, capture_output=True, text=True, encoding="utf-8")
            assert refused.returncode != 0 and "changed after publication" in refused.stderr, refused.stderr
            print("Obsidian importer e2e passed: sources, images, footnotes, local/cross-space links, resume, and manual-edit protection")
        finally:
            cli.call("stop")


if __name__ == "__main__":
    main()
