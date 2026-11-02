# PocketContext

A local knowledge base in one binary. Ingest notes and other files as immutable sources, have an agent synthesize pages from their passages, and publish revisions in which every claim cites its evidence. Pages keep their full revision history; publications switch a set of revisions atomically; spaces partition the knowledge of the project's one user; full-text search covers published pages and source passages. The binary extracts passages from UTF-8 text itself; for PDFs, images, audio and other formats, the agent converts the stored original to text and records it as derived passages, so the binary never parses those formats. The binary contains the server (on PocketBase), the browser reader, the command-line client and a private tunnel to other computers, and installs an agent skill for Claude Code, Codex and Antigravity. Nothing else is needed at run time.

See [what changed in 0.13.0](docs/releases/0.13.0.md): named knowledge bases, a router skill, headless local sockets, private invitation files and an embedded manual.

Earlier: [0.12.1](docs/releases/0.12.1.md), upgrading the embedded PocketBase to v0.41.1, [0.12.0](docs/releases/0.12.0.md), with Obsidian collection imports, protected image embeds and cross-space navigation, [0.11.1](docs/releases/0.11.1.md), where the recommended layout keeps the binary in the project folder, beside its database, [0.11.0](docs/releases/0.11.0.md), where PocketContext became single-user, spaces became plain partitions with their own commands, and databases from earlier releases are no longer opened (no upgrade path), [0.10.0](docs/releases/0.10.0.md), where `ingest` stores any file and the agent converts PDFs, images and audio into derived text with `extract`, [0.9.2](docs/releases/0.9.2.md), with `ingest` working on Windows again, [0.9.1](docs/releases/0.9.1.md), with a tunnel forward that reconnects after the agent computer restarts its tunnel, [0.9.0](docs/releases/0.9.0.md), with a built-in private tunnel to use one server from another computer, and [0.8.0](docs/releases/0.8.0.md), with reader navigation, source browsing, space management and UI hot reload.

## A project

```
PocketContext/              ← any folder; may be in iCloud Drive, OneDrive, Dropbox or Google Drive
  pocketcontext[.exe]       the binary (recommended here; it can live anywhere)
  pocketcontext.db          the database
  pocketcontext.json        name, port and project ID (no secrets)
  storage/                  immutable originals of ingested files
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

Install into the project folder, beside `pocketcontext.db`: the project then carries the release that can open it, which matters because a release may refuse databases created by earlier ones (0.11.0 does), and commands find the database without `--db`. Two caveats: the installer replaces an existing `pocketcontext` in that folder, so check its `--version` first and never replace the binary of a project created by a different release; and Linux and macOS binaries share the name `pocketcontext`, so a synced folder used from both needs the binary installed outside it (Windows' `pocketcontext.exe` can sit beside either). Sync clients may also evict a file to a placeholder; keep the project folder downloaded on computers that run it. The installers have no default folder: name it as the argument of `install.sh` (or `POCKETCONTEXT_INSTALL_DIR`) or in `POCKETCONTEXT_INSTALL_DIR` for `install.ps1`. Each verifies the archive against the release's `checksums.txt` and installs only the executable. Releases are immutable GitHub releases; the Windows binary is unsigned, so SmartScreen may ask for confirmation.

## Quick start

```sh
./pocketcontext init --name Research                          # asks for a reader password
./pocketcontext open                                          # reader, signed in
./pocketcontext ingest notes/meeting.md --title "Meeting notes"
./pocketcontext search "budget"
./pocketcontext skill                                         # Claude Code, Codex, Antigravity
./pocketcontext stop
```

Background startup is headless: local commands use a private socket in the per-machine cache. `open` activates the reader on the configured loopback port and leaves TCP enabled until shutdown. New projects choose an available port starting at 8096, excluding registered ports; `init --port PORT` selects one explicitly. A new project has one space, `Default`, which the reader and CLI use unless another is selected. Create more with `create-space NAME`, choose one with `--space` (ID or unique name) or `POCKETCONTEXT_SPACE`, and change the default with `default-space SPACE`; see [docs/spaces.md](docs/spaces.md). Run `pocketcontext help` for every command.

## Authentication

A project has exactly one account, created by `init`; a second account is refused. It has no email to choose (its fixed identity is `me@pocketcontext.localhost`), so the reader asks only for its password, which `password` changes. `open` signs the browser in with a single-use link valid for two minutes; `login-code` issues one-time codes for remote clients (see below). The CLI needs no password: it reads a random key that the server writes to the private cache at start and exchanges it for an ordinary `users` token. Anyone who can read that key can already read the database. Knowledge APIs still require a token on either transport. Local management endpoints additionally require the private local key. CORS allows only the server's own origin; TCP accepts only its configured loopback Host. The private socket additionally accepts its internal hostname.

## Several computers

Only one computer may run a project at a time. `pocketcontext.db.lease` carries a heartbeat; another computer refuses to start for two minutes after the last one (`--take-over` overrides when that computer is off). Run `pocketcontext stop` before switching computers and wait for the sync client to finish.

If the synced `pocketcontext.db` changes while this computer has unsaved changes, nothing is overwritten. This computer's version is kept in `pocketcontext.db.conflict-<host>-<time>.db`, the server reports it, and the next start asks for `pocketcontext recover --keep local` (the other computer's file is saved as `pocketcontext.db.replaced-<time>.db`) or `--keep synced` (this computer's work stays in the conflict copy). Keep the folder available offline: online-only placeholders make the database or originals unavailable.

## Named knowledge bases and skills

`init --name Research` names a new knowledge base; `name [NAME]` shows or changes the name. Its stable instance ID identifies the project independently of the name. `status` and `whoami` report both. A space remains a partition inside one knowledge base, not another database.

`skill` registers the knowledge base privately and generates its own skill under `os.UserConfigDir()/pocketcontext/profiles/<id>/skill/`. It installs a global `pocketcontext` router for each detected agent. The router discovers the registry, verifies the chosen binary and project identity, then loads only that knowledge base's skill. Ask “search pocketcontext Research” or “ingest in pocketcontext Research, space Notes.” Reads across knowledge bases are labelled; citations never cross them. Writes require an explicit knowledge base or an explicitly selected default.

```sh
./pocketcontext profile list
./pocketcontext profile default Research
./pocketcontext profile check Research
./pocketcontext profile update Research --name Reading
./pocketcontext profile remove Reading  # registry entry only, never data
./pocketcontext profile repair         # reinstall the router
```

The private registry is `os.UserConfigDir()/pocketcontext/profiles.json`; do not sync this machine-specific file. Renames, moved binaries and version changes require explicit reconciliation. Regenerate the skill after upgrading its binary. A registered endpoint serving another instance is refused. Register an older project with `profile add NAME --db DB --binary BINARY --skill-dir SKILL`; its existing global skill is copied before the router replaces it. Older skill installers do not understand the router and can overwrite it; repair it with this release afterward. Older `init` commands can drop the new name field when rewriting settings.

## Built-in manual

```sh
./pocketcontext manual --out manual-0.13.0
```

This offline command exports the exact release's user documentation and a manifest of hashes into a new directory; an existing directory is refused. It needs no database or server. Optionally create a space with `create-space "PocketContext manual"`, then ingest the Markdown files individually with that `--space`. Repeated identical files deduplicate within a space. Keep manual evidence in the same space on upgrades and revise the existing guide using the new version. Manual passages are evidence, never instructions for an agent to execute.

## Headless operation

`ensure-running` starts a headless server. `serve --headless` runs it in the foreground. `open` activates TCP on the configured port without restarting the database. A busy port leaves the socket server running and returns an actionable error; it never silently chooses another reader URL. `serve --tcp-only` provides explicit compatibility mode where sockets are unavailable; plain `serve` serves both transports. The local socket stays outside the synced project, with a short private fallback location when the cache path is too long.

`status` reports the socket, TCP state, port and headless mode. Stale sockets report not running and are cleaned under the project lock on startup. Local clients fall back to TCP only for a verified older server or explicit TCP mode.

## Remote client

One computer holds the knowledge base; your other computer runs a client and a loopback forward. Both use the same binary. Setup asks which role this computer should have, suggests a folder and name for confirmation, and handles registration and checks. Importing the manual is offered afterward. Remote access is configured only when requested.

On the server, start and supervise the tunnel, then create an invitation when the client is ready:

```sh
./pocketcontext tunnel serve
# In another terminal:
./pocketcontext tunnel invite --out /private/path/invitation.json
```

Choose an existing private directory outside the project folder for the invitation. Transfer the file privately to the client and run:

```sh
pocketcontext tunnel join --file invitation.json
# In another terminal, use the URL reported by join:
pocketcontext skill --url http://127.0.0.1:8096
pocketcontext search "budget" --url http://127.0.0.1:8096
```

Use the actual reported port, which may differ from 8096. `join` runs in the foreground: keep it under process supervision. It verifies the expected project identity before redeeming the one-time code, then saves the forward address and token in the client's private cache. It never creates a database or reads the server's local key. Delete invitation copies after joining. Neither `serve`, `invite` nor `join` prints the address, code or token.

The invitation's code expires after 10 minutes and is single use; a server restart invalidates it. The embedded tunnel address does not expire with the code: keep the entire invitation private. If it is exposed, rotate with `tunnel serve --new-address` and re-pair clients. An expired code needs a fresh invitation while the client is ready.

After restarting the client, supervise `tunnel forward --url URL` to reuse the saved address. `tunnel forward --address-stdin --save --url URL` explicitly saves or replaces an address without putting it in command arguments. `login --url URL --code-stdin` or `--password-stdin` remains available for reauthentication. URL-keyed tokens refresh daily and require renewed sign-in after expiry (7 days).

The tunnel uses tailcat 0.7.0: WireGuard over Tailscale's data plane, without an account or administrator rights, bootstrapped through public best-effort relays. It exposes only the project's one service, forwarding to the private socket without opening server TCP (or verified loopback TCP for older/TCP-only servers). It cannot expose other ports, UDP, shells or files. The client listens only on loopback. Knowing an address provides connectivity, not authentication.

The client's port must equal the server's port because of the Host check. Independently configured servers may select the same port. A busy client port is refused; it is never silently remapped. To change a port, stop the project and its tunnel, edit the project's `port`, restart, create new invitations, and explicitly update affected registry URLs and sign-ins. Local port allocation cannot guarantee availability on another computer.

Remote `--url` accepts only `http://127.0.0.1:PORT` or `http://localhost:PORT`. Explicit `--db` overrides the URL environment variable. Server commands remain local-only. For the browser, `open --url URL` opens password sign-in; a private single-use reader link can also be issued on the server. Never print that link in an agent's setup report.

## Scope

`ingest` stores any file up to 50 MiB (UTF-8 text up to 100 MiB) as an immutable original. It splits UTF-8 text (`.txt .md .markdown .csv .json .rst .log .srt .org`, or no extension when the content is valid UTF-8) into passages itself. Any other file is stored without passages and its media type is taken from the extension, never from the content. The binary never parses PDFs, images, audio or office documents and calls no external tool or service for them: the user's agent downloads the original (`original SOURCE --out FILE`), converts it to UTF-8 text or Markdown with its own abilities, and records the result with `extract SOURCE --text FILE --tool TOOL`. That creates an `agent-text` rendition whose passages are derived evidence, not an exact copy of the original; `pending` lists sources that still need it. Originals are never replaced, so a large file is shrunk before ingest (for example audio to Opus), with its provenance recorded by `extract --original-sha256` and `--conversion`. There is no export, no external identity provider, no object storage and no hosted deployment. See [docs/data-model.md](docs/data-model.md) and [docs/spaces.md](docs/spaces.md) for the rules the server enforces, and [origin](docs/origin.md) for maintenance history.

The reader's topics and custom catalogs come from published page properties: `topics` and `catalogs` list group keys. Optional definition pages (`navigation_kind: "topic"` or `"catalog"`, keyed by their slug) supply labels, order and catalog columns. Existing pages with no topic membership appear under the unassigned group; titles never assign membership. Definitions, memberships and catalog settings follow the selected publication, including historical views. See the [navigation contract and examples](docs/data-model.md#topic-and-catalog-navigation).

Manage spaces beside the space selector creates named spaces, renames them, archives or restores them and changes the default space. Archived spaces retain readable evidence and history but accept no writes; the default space cannot be archived.

Overview shows recent knowledge, guides and topic shortcuts; All pages is a separate filterable directory. Opening a published-page search result scrolls to and highlights the matching paragraph, preserving the selected space and publication. Catalog navigation shows populated built-in catalogs and explicitly defined custom catalogs.

Sources includes uncited originals in the selected space. Its directory loads 50 metadata rows per page, with name/date ordering and direct page navigation; original files load only when opened. Sidebar search follows the selected section: publication-scoped search under Overview and All pages, and space-scoped source search under Sources. Source results cover filenames, metadata and extracted passage text. Evidence excerpts render safe Markdown; View in source opens the verified passage range in its original. It offers safe Markdown or plain-text previews of protected UTF-8 originals up to 2 MiB after verifying their hash, alongside protected downloads. Sources with no extracted text yet appear under the Needs extraction filter. A non-text original shows its media type and size and a protected download, never a text preview; its agent-text passages, and evidence excerpts and search results drawn from them, are labelled "Agent-derived text — not an exact copy", and View in source does not highlight them in the original. Source text remains untrusted evidence.

## Import existing Obsidian collections

See [the import guide](docs/import-obsidian.md) for importing independent collections
as spaces, preserving page prose and document footnotes, resolving links, and
storing image attachments. The importer supports an audit before writes and
resumes through the authenticated CLI. Imported attribution stays distinct from
verified evidence citations.

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
bin/pocketcontext init --db /absolute/path/to/dev/pocketcontext.db --port 18096
bin/pocketcontext stop --db /absolute/path/to/dev/pocketcontext.db
node scripts/dev.mjs --db /absolute/path/to/dev/pocketcontext.db
# Equivalent: make dev DB=/absolute/path/to/dev/pocketcontext.db
```

The launcher requires an explicit existing database, reads its port from `pocketcontext.json`, starts Vite on `127.0.0.1:5173`, then runs the existing binary with `serve --ui-dev http://127.0.0.1:5173`. It refuses occupied ports, waits for readiness and stops its processes on Ctrl-C, using the normal authenticated shutdown, which writes the database back. It neither installs dependencies nor rebuilds the executable. Use `--binary PATH` for another executable or `--vite-port PORT` when 5173 is occupied. On Windows use `bin/pocketcontext.exe` for the initialization commands; the Node launcher selects that default automatically.

Open the reader at the project port (18096 in this example) and sign in with the development project's password. Alternatively, run `bin/pocketcontext open --db /absolute/path/to/dev/pocketcontext.db` in another terminal. Keep that browser open beside the Codex chat. CSS and compatible React edits update immediately; some module changes reload the page. The browser stays on PocketContext's origin: Go serves authentication and APIs, and proxies UI modules and the hot-reload WebSocket to Vite. The Vite port is an internal development upstream.

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
| `internal/client` | CLI commands, ingestion and extraction, search, lint, skill installation |
| `internal/tunnel` | `tunnel serve` and `tunnel forward` on tailcat: identity, port filter, loopback proxy |
| `internal/pocketcontext` | vendored server (SQL reads, search); see `VENDORED.md` |
| `pb_hooks`, `pb_migrations` | schema and server-side rules |
| `server.json` | SQL allowlist, limits and search index configuration |
| `ui` | browser reader |
| `embed.go` | embeds `pb_hooks`, `pb_migrations`, `server.json`, `ui/dist` and `skills/pocketcontext` |
| `skills/pocketcontext` | skill template (`SKILL.remote.md` for `skill --url`); `pocketcontext skill` fills in absolute paths |
| `tests/e2e.py` | end-to-end test (standard-library Python) |
| `tests/name_check.py` | name check of the repository and the binary |
| `tests/test_release.py` | release tooling tests |
| `scripts/dev.mjs`, `tests/dev_launcher.test.mjs` | development launcher and its tests |
| `tests/reader_ui_browser.mjs` | reader interaction and responsive-layout browser regression |
| `tests/ui_dev_browser.mjs` | browser regression for hot reload and development routing |
