# Vendored PocketContext

Copied from github.com/pocketcontext/pocketcontext at commit
20843b7c888daaba55f0646dd77455b7b309d4cc (the server WikiContext pinned when
this fork was made), under its MIT license (LICENSE). Import paths were
rewritten to this module.

Local changes:

- `sqliteuri/`: SQLite `file:` URIs built with forward slashes. `url.URL{Path: "C:\\..."}`
  encodes a Windows drive path as a URI authority, which SQLite rejects.
- `database/` and `tracing/`: platform files. Windows has no `O_NOFOLLOW`, and
  its mode bits cannot prove that a file is private.
- `server.RegisterDatabase`: reads SQL from an explicit database path, because
  the bundle keeps its live database in a per-machine cache.

Review upstream security fixes to the SQL authorizer, snapshots and search
for adoption here.
