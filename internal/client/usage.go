package client

// Usage is the help text.
const Usage = `wikicontext — local WikiContext knowledge base in one binary

The project is the database file (default: wiki.db beside this binary, or
--db PATH, or WIKICONTEXT_DB), the storage/ folder and wikicontext.json beside
it. They may live in iCloud Drive, OneDrive, Dropbox or Google Drive.

Setup and server:
  init --email EMAIL [--name NAME] [--port N] [--password-stdin]
                       create the project and local account, start the server
  ensure-running       start the server in the background unless it runs (alias: start)
  serve                run the server in the foreground
  stop                 write back the database and stop the server
  status               show paths, port, lease and whether the server runs
  open [--no-browser]  open the reader signed in (single-use link)
  password [--password-stdin]
                       change the reader password
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

Options for every command: --db PATH, --space ID, --pretty.
Exit codes: 0 ok, 1 HTTP or transport error, 2 usage, 3 check differences, 4 HTTP 409.
`
