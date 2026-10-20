# WikiContext bundle

A local, text-only fork of [WikiContext](https://github.com/pocketcontext/wikicontext) that runs as one binary. The binary contains the server (vendored PocketContext on PocketBase), the WikiContext hooks and migrations, the browser reader and the command-line client. No Python, uv, Node, Docker, FFmpeg or Poppler is needed at run time.

## A project

```
WikiContext/                  ← any folder; may be in iCloud Drive, OneDrive, Dropbox or Google Drive
  wikicontext[.exe]           the binary (optional here; it can live anywhere)
  wiki.db                     the database
  wikicontext.json            port, account email, project ID (no secrets)
  storage/                    immutable originals of ingested notes
```

The database defaults to `wiki.db` beside the binary; `--db PATH` or `WIKICONTEXT_DB` selects another. While the server runs, a working copy lives in the per-machine cache (`os.UserCacheDir()/wikicontext-bundle/<id>/`) together with the logs, unpacked application files and the private local key. The server writes a consistent copy (`VACUUM INTO` plus an atomic rename) back to `wiki.db` a few seconds after changes and on `stop`, so sync clients only ever see complete files.

## Install

Linux (amd64, arm64) and macOS (arm64, 15 or later):

```sh
curl -fsSL https://github.com/pocketcontext/wikicontext-bundle/releases/latest/download/install.sh | sh -s -- "$HOME/Library/Mobile Documents/com~apple~CloudDocs/WikiContext"
```

Windows (PowerShell):

```powershell
$env:WIKICONTEXT_INSTALL_DIR = "$env:OneDrive\WikiContext"
irm https://github.com/pocketcontext/wikicontext-bundle/releases/latest/download/install.ps1 | iex
```

Without a folder, the installers use `~/.local/bin` or `%LOCALAPPDATA%\Programs\WikiContext`. Each verifies the archive against the release's `checksums.txt` and installs only the executable. Releases are immutable GitHub releases; the Windows binary is unsigned, so SmartScreen may ask for confirmation.

## Quick start

```sh
./wikicontext init --email you@wiki.localhost --name "Your Name"   # asks for a reader password
./wikicontext open                                                 # reader, signed in
./wikicontext ingest notes/meeting.md --title "Meeting notes"
./wikicontext search "budget"
./wikicontext skill                                                # Claude Code, Codex, Antigravity
./wikicontext stop
```

The server listens on `http://127.0.0.1:8096` (change `port` in `wikicontext.json`), so it runs alongside other Context applications. Run `wikicontext help` for every command.

## Authentication

The reader uses the local account's email and password. `open` signs the browser in with a single-use link valid for two minutes; `login-code` issues one-time codes for remote clients (see below). The CLI needs no password: it reads a random key that the server writes to the private cache at start and exchanges it for an ordinary `users` token. Anyone who can read that key can already read the database. All APIs still require a token, CORS allows only the server's own origin, and requests for any other `Host` are refused, so web pages cannot reach the wiki through `127.0.0.1`.

## Several computers

Only one computer may run a project at a time. `wiki.db.lease` carries a heartbeat; another computer refuses to start for two minutes after the last one (`--take-over` overrides when that computer is off). Run `wikicontext stop` before switching computers and wait for the sync client to finish.

If the synced `wiki.db` changes while this computer has unsaved changes, nothing is overwritten. This computer's version is kept in `wiki.db.conflict-<host>-<time>.db`, the server reports it, and the next start asks for `wikicontext recover --keep local` (the other computer's file is saved as `wiki.db.replaced-<time>.db`) or `--keep synced` (this computer's work stays in the conflict copy). Keep the folder available offline: online-only placeholders make the database or originals unavailable.

## Remote client

The server can run on one always-on computer (the agent computer) while a person uses the same binary on their own computer as a client only. Sign-in uses one-time codes, so no password passes through whoever operates the agent computer.

On the agent computer, create the person's own account (so the audit history separates them from the agent) and issue a code:

```sh
./wikicontext account --email you@wiki.localhost --name "Your Name"   # no password is set or asked for
./wikicontext login-code --email you@wiki.localhost                   # prints {"email","code","expires"}
```

On the person's computer, forward the same port and sign in with the code on standard input:

```sh
tailcat forward <agent-address> 8096:8096        # or ssh -L 8096:127.0.0.1:8096 <agent>
printf '%s\n' "$CODE" | wikicontext login --url http://127.0.0.1:8096 --code-stdin
wikicontext search "budget" --url http://127.0.0.1:8096
wikicontext skill --url http://127.0.0.1:8096
```

For the browser reader, run `./wikicontext open --email you@wiki.localhost --no-browser` on the agent computer and open the printed `signInLink` on the person's computer; the forward of the same port makes it work there.

Codes and links are single use and kept only in the server's memory, so a server restart invalidates them. A `login-code` code is valid for 10 minutes (`--ttl 30`-`600` seconds); an `open` link for 2 minutes. `account` without `--password-stdin` never prompts: a new account gets a random password nobody knows, an existing account keeps its password. Password sign-in remains available: set one with `account --email E --password-stdin` and use `login --url URL --email E`.

A different local port is refused by the server's Host check. `--url` (or `WIKICONTEXT_BUNDLE_URL`; an explicit `--db` overrides it) accepts only `http://127.0.0.1:PORT` or `http://localhost:PORT`. Remote mode never resolves or creates a database, never starts a server and never reads the local key; if the server does not answer it fails and says so. `login` stores only the token, in `os.UserCacheDir()/wikicontext-bundle/remote-<hash>/session.json` (private), refreshes it daily and asks for a new sign-in when it expires (7 days) or when the URL serves a different WikiContext. `logout` deletes it. Server commands (`serve`, `start`, `ensure-running`, `stop`, `flush`, `recover`, `init`, `password`, `account`, `login-code`) run on the agent computer only.

## Scope

Ingestion accepts UTF-8 text notes only (`.txt .md .markdown .csv .json .rst .log` or no extension); anything else is rejected before upload. Audio, image and PDF ingestion, Gemini/Groq, Obsidian and repository-file export, Google sign-in, S3 storage and the hosted deployment tooling are removed. The schema, hooks and reader are otherwise upstream WikiContext, so spaces, immutable revisions, citations, atomic publication and full-text search behave the same.

## Build

Requires Go (see `go.mod`) with CGO and a C compiler, Node.js 24 and pnpm 10.33.2.

```sh
make ui      # build the reader into ui/dist (embedded by go build)
make build   # bin/wikicontext
make test    # Go unit tests, including the vendored server's
make e2e     # end-to-end test with synthetic notes in a temporary folder
make windows ZIG=/path/to/zig   # cross-compile bin/windows_amd64/wikicontext.exe
```

Native Windows builds use MinGW-w64 gcc.

Releases follow PocketContext's process (`scripts/release.py`, `.github/workflows/release.yml`): pushing a `vX.Y.Z` tag on `main` builds native static binaries on Linux amd64/arm64, macOS arm64 and Windows amd64, runs the end-to-end test against each, assembles archives, `install.sh`, `install.ps1` and `checksums.txt`, publishes an immutable release, and then installs it with the one-line installers on every platform and tests again. CI (`.github/workflows/test.yml`) runs the unit and end-to-end tests on Linux (amd64, arm64), macOS and Windows.

## Layout

| Path | Content |
| --- | --- |
| `cmd/wikicontext` | entry point |
| `internal/bundle` | project resolution, working copy and write-back, lease, local routes, server lifecycle |
| `internal/client` | CLI commands, text ingestion, search, lint, skill installation |
| `internal/pocketcontext` | vendored PocketContext server; see `VENDORED.md` |
| `embed.go` | embeds `pb_hooks`, `pb_migrations`, `pocketcontext.json`, `ui/dist` and `skills/wikicontext` |
| `skills/wikicontext` | skill template (`SKILL.remote.md` for `skill --url`); `wikicontext skill` fills in absolute paths |
| `tests/e2e.py` | end-to-end test (standard-library Python) |
