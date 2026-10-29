# PocketContext

Local knowledge base built as one Go binary. Read README.md and docs/data-model.md before changes.

- Keep the project to the database file, `storage/`, `pocketcontext.json` and the binary. Everything machine-specific (working copy, logs, local key, unpacked assets, tokens) belongs in the per-machine cache. Never write PocketBase runtime files (`.notify`, `auxiliary.db`, `types.d.ts`, backups) into the project folder.
- Never let the server open the synced database directly. Copy it in on start and write back only through consistent snapshots and atomic renames. Never overwrite a synced file that changed elsewhere; keep both and require an explicit `recover`.
- The binary stores any file as an immutable source but extracts only UTF-8 text. Other formats (PDF, images, audio, office documents) are converted by the user's agent and recorded with `extract` as derived `agent-text` renditions. Never parse PDFs, images or audio in the binary. Do not add dependencies on external tools, Python or network services.
  The one exception is the opt-in `tunnel` command (`internal/tunnel`), which uses the tailcat library and its relays: it admits only the project's port, proxies it to `127.0.0.1` only, keeps its identity in the per-machine cache and never logs or echoes the address. Do not widen it (other ports, forwarding through the server, UDP, exit nodes, shells or files), and keep `build-tags.txt` in step with the tailcat release in `go.mod`.
- Keep authentication on: loopback only, Host check, own-origin CORS, ordinary `users` tokens. The local key never leaves the private cache.
- Remote mode (`--url`) is a client only: it never resolves or creates a database, never starts a server and never reads the local key. It accepts loopback URLs only and stores a token, never a password.
- PocketContext is a full fork. Review security fixes in its origin (see `docs/origin.md`) and in the vendored server (`internal/pocketcontext/VENDORED.md`) and port them by hand.
- Never reintroduce the retired product name outside `docs/origin.md`: not in files, file names, messages, tests or the binary. `tests/name_check.py` enforces it.
- Windows is a supported platform: use `filepath`, `sqliteuri.File` for SQLite URIs, and platform files for locks and process creation.
- Tests use synthetic notes in temporary folders. After changes run `go test ./...` (CGO, tags in `build-tags.txt`), `python3 tests/name_check.py --binary bin/pocketcontext` and `python3 tests/e2e.py --binary bin/pocketcontext`; rebuild `ui/dist` first when the reader changes.
- Never commit `bin/`, `ui/dist`, databases or real notes.
