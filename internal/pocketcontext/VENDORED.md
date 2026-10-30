# Vendored PocketContext server

Copied from github.com/pocketcontext/pocketcontext at commit
20843b7c888daaba55f0646dd77455b7b309d4cc, under its MIT license (LICENSE).
Import paths were rewritten to this module. PocketBase was later upgraded from
v0.40.4 to v0.41.1 to match upstream commit
279b04b821ec7cbc5c7d2f966f12e1fcfb327a0b: PocketBase moved its Go modules to
`ganigeorgiev.com/pocketbase/*` (pocketbase v0.41.1, dbx v1.13.0), so only the
PocketBase and dbx import paths changed. The rest of the vendored code remains
at 20843b7; later upstream changes (background snapshots, installer) are not
ported. For the origin of the application (hooks, migrations, reader) see
[docs/origin.md](../../docs/origin.md).

Local changes:

- `sqliteuri/`: SQLite `file:` URIs built with forward slashes. `url.URL{Path: "C:\\..."}`
  encodes a Windows drive path as a URI authority, which SQLite rejects.
- `database/` and `tracing/`: platform files. Windows has no `O_NOFOLLOW`, and
  its mode bits cannot prove that a file is private.
- `server.RegisterDatabase`: reads SQL from an explicit database path, because
  PocketContext keeps its live database in a per-machine cache.
- Test and benchmark names and fixtures contain no application product names.
- Removed the per-requester filtered SQL snapshots (`sqlread` snapshot cache,
  indexes and change tracking, the `snapshotstate` package), the private search
  engine and requester admission: a PocketContext project has one account, so
  SQL always uses the direct read-only engine over the live database.
- `searchread`: built indexes. Each search reads the indexed rows with fixed SQL
  in one read transaction and searches an in-memory FTS5 index cached by a
  fingerprint of those rows (also the generation token). Built indexes support
  scope membership by manifest values (`members`), a validated `where`
  predicate and the space-scoped source/rendition/passage projection
  (`sourceContent`).

Review upstream security fixes to the SQL authorizer and search and port them
here by hand.
