package client

// Usage is the help text.
const Usage = `pocketcontext — local knowledge base in one binary

The project is the database file (default: pocketcontext.db beside this binary, or
--db PATH, or POCKETCONTEXT_DB), the storage/ folder and pocketcontext.json beside
it. They may live in iCloud Drive, OneDrive, Dropbox or Google Drive.

Setup and server:
  init --email EMAIL [--name NAME] [--port N] [--password-stdin]
                       create the project and local account, start the server
  ensure-running       start the server in the background unless it runs (alias: start)
  serve                run the server in the foreground
  stop                 write back the database and stop the server
  status               show paths, port, lease and whether the server runs
  open [--email EMAIL] [--no-browser]
                       open the reader signed in (single-use link, valid for
                       2 minutes); --email signs in as that account, e.g. to
                       open the printed link on a computer that uses --url
  password [--password-stdin]
                       change the reader password
  account --email EMAIL [--name NAME] [--password-stdin]
                       create another account on this server, e.g. for a
                       person using it with --url. Without --password-stdin
                       it never prompts: a new account gets a random password
                       nobody knows and an existing one keeps its password
  login-code --email EMAIL [--ttl SECONDS]
                       print a one-time sign-in code for that account (single
                       use, kept in server memory only, default 600 seconds,
                       30-600) for ` + "`login --url URL --code-stdin`" + `
  flush                write the database back to the synced folder now
  recover --keep local|synced
                       resolve unsaved changes when the synced file also changed
  skill [--agent claude-code|codex|antigravity|all] [--dir DIR]
                       install the agent skill with this computer's paths

Knowledge (reads use SQL, writes use the records API; there is no delete):
  whoami | spaces | create-personal-space | check | schema
  query|sql SQL|-                    run one read-only SELECT
  get COLLECTION ID                  read one record
  create COLLECTION JSON|-           create one record
  update COLLECTION ID JSON|-        change fields (needs expected_revision)
  batch JSON|-                       up to 20 writes in one transaction
  newid                              print a new 15-character record ID
  ingest PATH [--title T] [--version V]
                                     store a UTF-8 text note and extract passages
  search TERMS [--limit N] [--offset N --generation G --publication ID] [--sequence N]
  lint                               check published graph structure
  stage-home RUN_ID --expected-revision N (--home SLUG | --clear-home) [--home-base ID]
  publish RUN_ID --expected-revision N [--home SLUG | --clear-home --home-base ID]

Remote client (the server runs on another computer, reached through a
tailcat or SSH forward of the same port; --url URL or POCKETCONTEXT_URL):
  login --url URL --code-stdin
                       sign in with a one-time code from ` + "`login-code`" + ` on the
                       agent computer, read from standard input; stores only
                       a token in the private cache
  login --url URL --email EMAIL [--password-stdin]
                       sign in with a password instead
  logout --url URL     forget the stored session
  status --url URL     show whether the server answers and the sign-in
  open --url URL [--no-browser]
                       open the reader (sign in with email and password, or
                       open a link from ` + "`open --email EMAIL --no-browser`" + ` run
                       on the agent computer)
  skill --url URL [--agent A] [--dir DIR]
                       install the agent skill for the remote server
  Knowledge commands work with --url. URL must be http://127.0.0.1:PORT or
  http://localhost:PORT. Remote mode never creates a database or starts a
  server; serve, start, ensure-running, stop, flush, recover, init, password,
  account and login-code are not available with --url.

Options for every command: --db PATH or --url URL, --space ID, --pretty.
--url and --db exclude each other; --db overrides POCKETCONTEXT_URL.
Exit codes: 0 ok, 1 HTTP or transport error, 2 usage, 3 check differences, 4 HTTP 409.
`
