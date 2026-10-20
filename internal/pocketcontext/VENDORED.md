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

Review upstream security fixes to the SQL authorizer, snapshots and search
and port them here by hand.
