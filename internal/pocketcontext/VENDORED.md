# Vendored PocketContext server

Copied from github.com/pocketcontext/pocketcontext at commit
20843b7c888daaba55f0646dd77455b7b309d4cc, under its MIT license (LICENSE).
Import paths were rewritten to this module. For the origin of the application
(hooks, migrations, reader) see [docs/origin.md](../../docs/origin.md).

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
