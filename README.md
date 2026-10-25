# PocketContext

A local knowledge base in one binary. Ingest text notes as immutable sources, have an agent synthesize pages from their passages, and publish revisions in which every claim cites its evidence. Pages keep their full revision history; publications switch a set of revisions atomically; spaces separate shared and personal knowledge; full-text search covers published pages and original source passages. The binary contains the server (on PocketBase), the browser reader, the command-line client and a private tunnel to other computers, and installs an agent skill for Claude Code, Codex and Antigravity. Nothing else is needed at run time.

See [what changed in 0.9.2](docs/releases/0.9.2.md): `ingest` works on Windows again, and new projects start with only a private Personal space. Earlier: [0.9.1](docs/releases/0.9.1.md), with a tunnel forward that reconnects after the agent computer restarts its tunnel, [0.9.0](docs/releases/0.9.0.md), with a built-in private tunnel to use one server from another computer, and [0.8.0](docs/releases/0.8.0.md), with reader navigation, source browsing, space management and UI hot reload.

## A project

```
PocketContext/              ← any folder; may be in iCloud Drive, OneDrive, Dropbox or Google Drive
  pocketcontext[.exe]       the binary (optional here; it can live anywhere)
  pocketcontext.db          the database
  pocketcontext.json        port, account email, project ID (no secrets)
  storage/                  immutable originals of ingested notes
```

The database defaults to `pocketcontext.db` beside the binary; `--db PATH` or `POCKETCONTEXT_DB` selects another. While the server runs, a working copy lives in the per-machine cache (`os.UserCacheDir()/pocketcontext/<key>/`) together with the logs and the private local key; unpacked application files live in `os.UserCacheDir()/pocketcontext/app/`. The server writes a consistent copy (`VACUUM INTO` plus an atomic rename) back to `pocketcontext.db` a few seconds after changes and on `stop`, so sync clients only ever see complete files.

## Install

Linux (amd64, arm64) and macOS (arm64, 15 or later):

```sh
curl -fsSL https://github.com/pocketcontext-labs/pocketcontext/releases/latest/download/install.sh | sh -s -- "$HOME/Library/Mobile Documents/com~apple~CloudDocs/PocketContext"
```

Windows (PowerShell):

```powershell
$env:POCKETCONTEXT_INSTALL_DIR = "$env:OneDrive\PocketContext"
irm https://github.com/pocketcontext-labs/pocketcontext/releases/latest/download/install.ps1 | iex
```

Without a folder, the installers use `~/.local/bin` or `%LOCALAPPDATA%\Programs\PocketContext`. Each verifies the archive against the release's `checksums.txt` and installs only the executable. Releases are immutable GitHub releases; the Windows binary is unsigned, so SmartScreen may ask for confirmation.

## Quick start

```sh
./pocketcontext init --email you@example.localhost --name "Your Name"   # asks for a reader password
./pocketcontext open                                                    # reader, signed in
./pocketcontext ingest notes/meeting.md --title "Meeting notes"
./pocketcontext search "budget"
./pocketcontext skill                                                   # Claude Code, Codex, Antigravity
./pocketcontext stop
```

The server listens on `http://127.0.0.1:8096` (change `port` in `pocketcontext.json`). New projects create only a private Personal space, owned by the initial user, and use it by default in the reader and CLI. Company is not created for new projects. Existing projects retain their saved default; legacy Company defaults remain supported. Explicit space selections always win. Run `pocketcontext help` for every command.

## Authentication

The reader uses the local account's email and password. `open` signs the browser in with a single-use link valid for two minutes; `login-code` issues one-time codes for remote clients (see below). The CLI needs no password: it reads a random key that the server writes to the private cache at start and exchanges it for an ordinary `users` token. Anyone who can read that key can already read the database. All APIs still require a token, CORS allows only the server's own origin, and requests for any other `Host` are refused, so web pages cannot reach the server through `127.0.0.1`.

## Several computers

Only one computer may run a project at a time. `pocketcontext.db.lease` carries a heartbeat; another computer refuses to start for two minutes after the last one (`--take-over` overrides when that computer is off). Run `pocketcontext stop` before switching computers and wait for the sync client to finish.

If the synced `pocketcontext.db` changes while this computer has unsaved changes, nothing is overwritten. This computer's version is kept in `pocketcontext.db.conflict-<host>-<time>.db`, the server reports it, and the next start asks for `pocketcontext recover --keep local` (the other computer's file is saved as `pocketcontext.db.replaced-<time>.db`) or `--keep synced` (this computer's work stays in the conflict copy). Keep the folder available offline: online-only placeholders make the database or originals unavailable.

## Remote client

The server can run on one always-on computer (the agent computer) while a person uses the same binary on their own computer as a client only. Sign-in uses one-time codes, so no password passes through whoever operates the agent computer.

On the agent computer, create the person's own account (so the audit history separates them from the agent), open the tunnel and issue a code:

```sh
./pocketcontext account --email you@example.localhost --name "Your Name"   # no password is set or asked for
./pocketcontext tunnel serve                                               # foreground; prints {"address", "port", ...}
./pocketcontext login-code --email you@example.localhost                   # prints {"email","code","expires"}
```

On the person's computer, forward the same port and sign in with the code on standard input:

```sh
printf '%s\n' "$ADDRESS" | pocketcontext tunnel forward --address-stdin   # foreground; or ssh -L 8096:127.0.0.1:8096 <agent>
printf '%s\n' "$CODE" | pocketcontext login --url http://127.0.0.1:8096 --code-stdin
pocketcontext search "budget" --url http://127.0.0.1:8096
pocketcontext skill --url http://127.0.0.1:8096
```

For the browser reader, run `./pocketcontext open --email you@example.localhost --no-browser` on the agent computer and open the printed `signInLink` on the person's computer; the forward of the same port makes it work there.

The tunnel is built in: [tailcat](https://github.com/tailscale/tailcat) 0.7.0 (WireGuard over Tailscale's data plane, without a Tailscale account, control plane or administrator rights), bootstrapped through tailcat's public relays, which are best-effort and rate-limited, and direct between the computers when the network allows. `tunnel serve` admits only the project's port and proxies it to the server on `127.0.0.1`; there is no other port, no forwarding through the agent computer and no UDP. Its address embeds the server's public key, a pre-shared key and the relay, so anyone with it can reach the port (the server still requires sign-in): share it privately. The identity is kept in the private cache (`tunnel.json`), never in the project folder, so the address stays the same across restarts of `tunnel serve`, and a running `tunnel forward` reconnects on its own within seconds (connections open during the restart end with it); `--new-address` replaces it and invalidates the old one, which is also the remedy when its relay is retired. `tunnel forward` follows the remote-mode rules: it listens only on the loopback port of `--url` (or `POCKETCONTEXT_URL`, default `http://127.0.0.1:8096`), fails when that port is busy instead of choosing another, and never reads a database or local key. Both run in the foreground until interrupted; keep them under the agent's own process supervision when they must persist. An existing `tailcat forward ADDRESS 8096:8096` from the standalone tailcat CLI works with the same address.

Codes and links are single use and kept only in the server's memory, so a server restart invalidates them. A `login-code` code is valid for 10 minutes (`--ttl 30`-`600` seconds); an `open` link for 2 minutes. `account` without `--password-stdin` never prompts: a new account gets a random password nobody knows, an existing account keeps its password. Password sign-in remains available: set one with `account --email E --password-stdin` and use `login --url URL --email E`.

A different local port is refused by the server's Host check. `--url` (or `POCKETCONTEXT_URL`; an explicit `--db` overrides it) accepts only `http://127.0.0.1:PORT` or `http://localhost:PORT`. Remote mode never resolves or creates a database, never starts a server and never reads the local key; if the server does not answer it fails and says so. `login` stores only the token, in `os.UserCacheDir()/pocketcontext/remote-<hash>/session.json` (private), refreshes it daily and asks for a new sign-in when it expires (7 days) or when the URL serves a different project. `logout` deletes it. Server commands (`serve`, `start`, `ensure-running`, `stop`, `flush`, `recover`, `init`, `password`, `account`, `login-code`) run on the agent computer only.

## Scope

Ingestion accepts UTF-8 text notes only (`.txt .md .markdown .csv .json .rst .log` or no extension); anything else is rejected before upload. There is no audio, image or PDF ingestion, no export, no external identity provider, no object storage and no hosted deployment. See [docs/data-model.md](docs/data-model.md) and [docs/spaces.md](docs/spaces.md) for the rules the server enforces, and [origin](docs/origin.md) for maintenance history.

The reader's topics and custom catalogs come from published page properties: `topics` and `catalogs` list group keys. Optional definition pages (`navigation_kind: "topic"` or `"catalog"`, keyed by their slug) supply labels, order and catalog columns. Existing pages with no topic membership appear under the unassigned group; titles never assign membership. Definitions, memberships and catalog settings follow the selected publication, including historical views. See the [navigation contract and examples](docs/data-model.md#topic-and-catalog-navigation).

Manage spaces beside the space selector creates private named spaces and provides owner-only rename and reversible archive/restore controls. Archived spaces retain readable evidence and history; Company and Personal remain protected.

Overview shows recent knowledge, guides and topic shortcuts; All pages is a separate filterable directory. Opening a published-page search result scrolls to and highlights the matching paragraph, preserving the selected space and publication. Catalog navigation shows populated built-in catalogs and explicitly defined custom catalogs.

Sources includes uncited originals in the selected space. Its directory loads 50 metadata rows per page, with name/date ordering and direct page navigation; original files load only when opened. Sidebar search follows the selected section: publication-scoped search under Overview and All pages, and space-scoped source search under Sources. Source results cover filenames, metadata and extracted passage text. Evidence excerpts render safe Markdown; View in source opens the verified passage range in its original. It offers safe Markdown or plain-text previews of protected UTF-8 originals up to 2 MiB after verifying their hash, alongside protected downloads. Source text remains untrusted evidence.

## Build

Requires Go (see `go.mod`) with CGO and a C compiler, Node.js 24 and pnpm 10.33.2. `build-tags.txt` lists the Go build tags every build and test uses: SQLite features and the `ts_omit_` tags of the tailcat release in `go.mod`, which leave out tailscale.com features the tunnel does not use (a test checks them against tailcat's own list).

```sh
make ui      # build the reader into ui/dist (embedded by go build)
make build   # bin/pocketcontext
make test    # Go unit tests, including the vendored server's
make names   # name check of the repository and bin/pocketcontext (tests/name_check.py)
make e2e     # name check, then CLI and source-search end-to-end tests with synthetic notes in a temporary folder
make windows ZIG=/path/to/zig   # cross-compile bin/windows_amd64/pocketcontext.exe
```

Native Windows builds use MinGW-w64 gcc.

Releases (`scripts/release.py`, `.github/workflows/release.yml`): pushing a `vX.Y.Z` tag on `main` builds native static binaries on Linux amd64/arm64, macOS arm64 and Windows amd64, runs the name check and the end-to-end test against each, assembles `pocketcontext_<version>_<platform>.tar.gz`/`.zip`, `install.sh`, `install.ps1` and `checksums.txt`, publishes an immutable release, and then installs it with the one-line installers on every platform and tests again. CI (`.github/workflows/test.yml`) runs the unit tests, the name check and the end-to-end test on Linux (amd64, arm64), macOS and Windows.

## Develop the reader

Build the executable once with `make ui && make build`, then use Vite hot reload while editing `ui/src` in Codex. Choose a separate local development project with synthetic notes. Initialize it once and stop the server that `init` starts:

```sh
bin/pocketcontext init --db /absolute/path/to/dev/pocketcontext.db --port 18096 --email dev@example.localhost --name Developer
bin/pocketcontext stop --db /absolute/path/to/dev/pocketcontext.db
node scripts/dev.mjs --db /absolute/path/to/dev/pocketcontext.db
# Equivalent: make dev DB=/absolute/path/to/dev/pocketcontext.db
```

The launcher requires an explicit existing database, reads its port from `pocketcontext.json`, starts Vite on `127.0.0.1:5173`, then runs the existing binary with `serve --ui-dev http://127.0.0.1:5173`. It refuses occupied ports, waits for readiness and stops its processes on Ctrl-C, using the normal authenticated shutdown to flush database snapshots. It neither installs dependencies nor rebuilds the executable. Use `--binary PATH` for another executable or `--vite-port PORT` when 5173 is occupied. On Windows use `bin/pocketcontext.exe` for the initialization commands; the Node launcher selects that default automatically.

Open the reader at the project port (18096 in this example) and sign in with the development account. Alternatively, run `bin/pocketcontext open --db /absolute/path/to/dev/pocketcontext.db` in another terminal. Keep that browser open beside the Codex chat. CSS and compatible React edits update immediately; some module changes reload the page. The browser stays on PocketContext's origin: Go serves authentication and APIs, and proxies UI modules and the hot-reload WebSocket to Vite. The Vite port is an internal development upstream.

After downloading an original, restarting Vite may require manually refreshing the reader to reconnect hot reload.

`--ui-dev` is a foreground `serve` option, accepts only a loopback HTTP upstream, and is never stored in project configuration. Without it the executable serves its embedded reader. Go code, hooks and migrations still need a rebuild and restart. For manual process management, run Vite with `POCKETCONTEXT_DEV_PORT` set to the project port and start `serve --db PATH --ui-dev http://127.0.0.1:5173` separately.

Hot reload does not type-check. Run `pnpm --dir ui typecheck`, `pnpm --dir ui test`, and `pnpm --dir ui build` after changes, plus `node --test tests/dev_launcher.test.mjs` after launcher changes. Before shipping, rebuild the embedded reader and executable and run the Go, name and end-to-end checks above.

For a source-directory volume check, run `python3 tests/source_directory.py --binary bin/pocketcontext`; it creates 2,001 small synthetic originals in an isolated project and checks first, middle and last pages plus each sort order.

The browser regression check uses synthetic data and a temporary UI copy. Install its pinned Chromium once with `pnpm --dir ui exec playwright install chromium`, then run `node tests/ui_dev_browser.mjs --binary bin/pocketcontext`. Run `node tests/reader_ui_browser.mjs --binary bin/pocketcontext` for reader navigation, version links, Overview, All pages, search and evidence checks at desktop, split-window and mobile widths. Add `--screenshots /absolute/path/to/output` to retain screenshots in a chosen folder. CI runs both checks on Linux amd64. Use `--browser /path/to/chromium` for a custom browser executable, or `--playwright /absolute/path/to/playwright/index.mjs` for a separate Playwright installation.

## Layout

| Path | Content |
| --- | --- |
| `cmd/pocketcontext` | entry point |
| `internal/bundle` | project resolution, working copy and write-back, lease, local routes, server lifecycle |
| `internal/client` | CLI commands, text ingestion, search, lint, skill installation |
| `internal/tunnel` | `tunnel serve` and `tunnel forward` on tailcat: identity, port filter, loopback proxy |
| `internal/pocketcontext` | vendored server (SQL reads, snapshots, search); see `VENDORED.md` |
| `pb_hooks`, `pb_migrations` | schema and server-side rules |
| `server.json` | SQL allowlist, snapshot filters and search index configuration |
| `ui` | browser reader |
| `embed.go` | embeds `pb_hooks`, `pb_migrations`, `server.json`, `ui/dist` and `skills/pocketcontext` |
| `skills/pocketcontext` | skill template (`SKILL.remote.md` for `skill --url`); `pocketcontext skill` fills in absolute paths |
| `tests/e2e.py` | end-to-end test (standard-library Python) |
| `tests/name_check.py` | name check of the repository and the binary |
| `tests/test_release.py` | release tooling tests |
| `scripts/dev.mjs`, `tests/dev_launcher.test.mjs` | development launcher and its tests |
| `tests/reader_ui_browser.mjs` | reader interaction and responsive-layout browser regression |
| `tests/ui_dev_browser.mjs` | browser regression for hot reload and development routing |
