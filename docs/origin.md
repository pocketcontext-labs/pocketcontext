# Origin

Internal maintenance note. This is the only file in the repository that may name the origin project; `tests/name_check.py` enforces that.

PocketContext was forked from WikiContext (github.com/pocketcontext/wikicontext) at commit `5d92f8c923f311b00d841d1bcd07b193ab596528` ("Pin portable launcher to bounded audio retry workflow release", 2026-10-16). Fork commit `7b81830` ("Package WikiContext as a local text-only single binary") turned it into the local single binary; v0.4.0 renamed the binary, module, files and messages to PocketContext. Releases v0.1.0–v0.3.0 used the old names and are not compatible.

`pb_hooks/` and `pb_migrations/` are derived from WikiContext's hooks and migrations at that commit (the reader in `ui/` too). Since then they have diverged: Google sign-in, deployment settings, audio catalog validation and the product name were removed, and migration `1790300100_knowledge.js` was renamed (content unchanged). PocketContext is a full fork and adopts nothing automatically.

Review WikiContext's security fixes to hooks, migrations, the reader and the SQL configuration, and port the relevant ones here by hand. Review fixes to the vendored server separately (`internal/pocketcontext/VENDORED.md`).

A v0.3.0 database is not supported, but it can be opened once by hand: stop the old server (`wikicontext stop`), rename `wiki.db` to `pocketcontext.db`, and with no server running execute `UPDATE _migrations SET file = '1790300100_knowledge.js' WHERE file = '1790300100_wikicontext.js';` on it before the first v0.4.0 start. Without that, the renamed migration runs again and the start fails with "Collection name must be unique".
