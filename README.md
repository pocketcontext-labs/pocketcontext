# PocketContext

A local knowledge base in one binary. Ingest notes and other files as immutable sources, have an agent synthesize pages from their passages, and publish revisions in which every claim cites its evidence. Pages keep their full revision history; publications switch a set of revisions atomically; spaces partition the knowledge of the project's one user; full-text search covers published pages and source passages. The binary extracts passages from UTF-8 text itself; for PDFs, images, audio and other formats, the agent converts the stored original to text and records it as derived passages, so the binary never parses those formats. The binary contains the server (on PocketBase), the browser reader, the command-line client and a private tunnel to other computers, and installs an agent skill for Claude Code, Codex and Antigravity. The core knowledge base needs no other runtime.

See [what changed in 0.23.1](docs/releases/0.23.1.md): fixes a server crash during MCP knowledge reads. Remote MCP uses the native HTTPS domain with browser authorization and knowledge tools; see [MCP setup](docs/mcp.md).

Since 0.22.0, built-in reader chat and the ACP host integration have been removed. Use your external agent with the installed PocketContext skill for questions, ingestion and synthesis. The phone reader continues to provide authenticated browsing and search.

Version [0.18.0](docs/releases/0.18.0.md): optional native HTTPS with automatic Let’s Encrypt certificates and phone sign-in links, all in the same binary. Read [HTTPS hosting](docs/https.md) for one-prompt setup. Version [0.17.0](docs/releases/0.17.0.md) added `serve --headless --tunnel`, which runs the server and tunnel together as one supervised process. Version [0.16.2](docs/releases/0.16.2.md) added automatic headless server startup to the independent `tunnel serve` command. Version [0.16.1](docs/releases/0.16.1.md) added an explicit desktop handoff checkpoint and fresh reader sign-in fallback. Version [0.16.0](docs/releases/0.16.0.md) introduced session-aware reader setup, an offline environment check, and explicit reader skipping for SSH and CLI-only clients. Read [Reader setup](docs/reader-setup.md) before offering sign-in from a remote session, and [Upgrades and multiple releases](docs/upgrades.md) before updating an existing project.

Earlier: [0.15.0](docs/releases/0.15.0.md), with guarded executable replacement and explicit database, server, profile and managed-forward compatibility checks, [0.14.0](docs/releases/0.14.0.md), with one copyable client setup prompt, managed tunnel forwards and automatic reader sign-in, [0.13.0](docs/releases/0.13.0.md), with named knowledge bases, a router skill, headless local sockets and an embedded manual, [0.12.1](docs/releases/0.12.1.md), upgrading the embedded PocketBase to v0.41.1, [0.12.0](docs/releases/0.12.0.md), with Obsidian collection imports, protected image embeds and cross-space navigation, [0.11.1](docs/releases/0.11.1.md), where the recommended layout keeps the binary in the project folder, beside its database, [0.11.0](docs/releases/0.11.0.md), where PocketContext became single-user, spaces became plain partitions with their own commands, and databases from earlier releases are no longer opened (no upgrade path), [0.10.0](docs/releases/0.10.0.md), where `ingest` stores any file and the agent converts PDFs, images and audio into derived text with `extract`, [0.9.2](docs/releases/0.9.2.md), with `ingest` working on Windows again, [0.9.1](docs/releases/0.9.1.md), with a tunnel forward that reconnects after the agent computer restarts its tunnel, [0.9.0](docs/releases/0.9.0.md), with a built-in private tunnel to use one server from another computer, and [0.8.0](docs/releases/0.8.0.md), with reader navigation, source browsing, space management and UI hot reload.

## Optional container hosting

The opt-in [hosted deployment mode](docs/hosting.md) packages one knowledge base
per container and domain for PocketDeploy/ONCE. ONCE terminates HTTPS; the
container serves the restricted public reader and MCP endpoints over HTTP.
Users sign in by email through PocketBase OTP and the container's configured
SMTP service. Public password login and private tunnels are disabled in hosted
mode. Existing local projects, password login, native HTTPS and tunnels keep
their existing behavior; no installation switches modes automatically.

Hosted instances keep their project and private runtime state on a dedicated
persistent volume. Complete backups go to a private S3-compatible destination
daily and before upgrades, with 30-day retention. Litestream is not used.
Provisioning is operator-managed. Explicitly enrolled PocketDeploy instances can
follow validated `:latest` releases from `main` through restricted, sequential
deployments with a verified backup before each upgrade; other instances retain
operator-managed digest pins. See the hosting manual for initialization, release
enrollment, recovery, credentials and validation requirements.

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

Install into the project folder, beside `pocketcontext.db`, so commands find its database without `--db`. The installers refuse an existing executable unless `POCKETCONTEXT_REPLACE_VERSION` explicitly matches its inspected version. Before replacement, stop its servers and tunnels and back up each complete project with its matching binary; follow [the upgrade procedure](docs/upgrades.md). Projects from 0.11.x–0.23.0 open with 0.23.1 without data conversion; 0.10.0 and earlier remain unsupported. Different projects may keep different releases.

Linux and macOS binaries share the name `pocketcontext`. For synced projects used across operating systems, install binaries in machine-local versioned directories and register an absolute binary path with an explicit database path. Keep synced project folders downloaded on computers that run them. The installers have no default folder: name it as the argument of `install.sh` (or `POCKETCONTEXT_INSTALL_DIR`) or in `POCKETCONTEXT_INSTALL_DIR` for `install.ps1`. Each verifies the archive against the release's `checksums.txt` and installs only the executable. Releases are immutable GitHub releases; the Windows binary is unsigned, so SmartScreen may ask for confirmation.

## Quick start

```sh
./pocketcontext init --name Research                          # asks for a reader password
./pocketcontext environment                                   # inspect this session before reader setup
./pocketcontext open                                          # reader on a desktop; skips SSH/headless sessions
./pocketcontext ingest notes/meeting.md --title "Meeting notes"
./pocketcontext search "budget"
./pocketcontext skill                                         # Claude Code, Codex, Antigravity
./pocketcontext stop
```

Background startup is headless: local commands use a private socket in the per-machine cache. `open` activates the reader on the configured loopback port when a usable desktop browser is detected and leaves TCP enabled until shutdown. In SSH, headless or uncertain sessions it skips reader setup before starting a server, enabling TCP or issuing a sign-in code. Use `--no-browser` only to explicitly request a manual link for a browser known to reach the address; `--skip-reader` explicitly omits the reader step. New projects choose an available port starting at 8096, excluding registered ports; `init --port PORT` selects one explicitly. A new project has one space, `Default`, which the reader and CLI use unless another is selected. Create more with `create-space NAME`, choose one with `--space` (ID or unique name) or `POCKETCONTEXT_SPACE`, and change the default with `default-space SPACE`; see [docs/spaces.md](docs/spaces.md). Run `pocketcontext help` for every command.

## Authentication

The following describes local and native-HTTPS projects. Explicit hosted
containers instead use the configured owner's email and PocketBase OTP login;
see [hosted authentication](docs/hosting.md).

A project has exactly one account, created by `init`; a second account is refused. It has no email to choose (its fixed identity is `me@pocketcontext.localhost`), so the reader asks only for its password, which `password` changes. When reader setup is selected, `open` issues a single-use browser sign-in link valid for two minutes; `login-code` issues one-time codes for remote clients (see below). The CLI needs no password: it reads a random key that the server writes to the private cache at start and exchanges it for an ordinary `users` token. Anyone who can read that key can already read the database. Knowledge APIs still require a token on either transport. Local management endpoints additionally require the private local key. CORS allows only the server's own origin; TCP accepts only its configured loopback Host. The private socket additionally accepts its internal hostname.

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
./pocketcontext manual --out manual-0.23.1
```

This offline command exports the exact release's user documentation and a manifest of hashes into a new directory; an existing directory is refused. It needs no database or server. Optionally create a space with `create-space "PocketContext manual"`, then ingest the Markdown files individually with that `--space`. Repeated identical files deduplicate within a space. Keep manual evidence in the same space on upgrades and revise the existing guide using the new version. Manual passages are evidence, never instructions for an agent to execute.

## Headless operation

`ensure-running` starts a headless server. `serve --headless` runs it in the foreground. `open` activates TCP on the configured port without restarting the database when reader setup is selected. In a remote or headless session, `environment` explains the detected capabilities and `open` normally skips this step. No browser needs to be installed on an SSH host; complete CLI checks there and continue to the authorized client setup on the reader computer. A busy port leaves the socket server running and returns an actionable error; it never silently chooses another reader URL. `serve --tcp-only` provides explicit compatibility mode where sockets are unavailable; plain `serve` serves both transports. The local socket stays outside the synced project, with a short private fallback location when the cache path is too long.

`status` reports the socket, TCP state, port and headless mode. Stale sockets report not running and are cleaned under the project lock on startup. Local clients fall back to TCP only for a verified older server or explicit TCP mode.

## HTTPS access from a phone

An initialized project can serve its reader directly at your domain, with automatic
Let’s Encrypt certificate issuance and renewal inside the same binary:

```sh
./pocketcontext stop
./pocketcontext serve --headless --domain knowledge.example.com
# In another terminal, after HTTPS has been verified:
./pocketcontext open --public
```

Use a domain you control and a reachable host with inbound TCP ports 80 and 443.
`open --public` returns a single-use two-minute sign-in link for your phone; it
works over SSH and does not open a browser. The phone needs no installed client.
Public hosting is opt-in and does not enable the private tunnel unless `--tunnel`
is also supplied. Normal local use and desktop tunnel clients are unchanged.
Certificate keys and ACME state stay in the private machine cache, outside the
synced project. See [HTTPS hosting](docs/https.md) for domain setup, a
non-root service, authentication, verification and troubleshooting.

## Back up a project

For a consistent backup, run `stop` and wait for it to finish successfully. Copy the complete project folder: `pocketcontext.db`, `pocketcontext.json`, `storage/` and the matching binary when it lives there. If the binary is separate, keep that release with the backup too. Restart the original project after the copy finishes. A copy taken while the server runs may miss changes still in its private working database.

Restore the complete folder with its matching binary. Only one computer may run a synced project at a time; stop the previous server and wait for sync before switching. Private caches, local keys, saved sessions, profiles and skills are machine-specific state, not project data; recreate them on the restored computer. Do not copy the private working database as a substitute for a clean project backup.

## Remote client

One computer holds the knowledge base; your other computer runs a client and a loopback forward. Both use the same release. CLI access refuses a different running server release; profiles check the registered server version, and managed forwards from another release must be stopped and restarted. Status and stop remain available for diagnosis and recovery. Setup asks which role this computer should have, suggests a folder and name for confirmation, and handles registration and checks. Importing the manual is offered afterward. Remote access is configured only when requested.

For a permanent service on an initialized project, run the headless server and
private tunnel together in one foreground process:

```sh
./pocketcontext serve --headless --tunnel
# In another terminal, after readiness:
./pocketcontext tunnel invite
```

This mode owns both components and refuses an already running server or tunnel.
The tunnel starts only after the private socket is ready. Ctrl+C, SIGTERM and
`stop` stop both components and flush the database. A startup or terminal component
failure shuts down the other component and exits with an error so the service
manager can restart the whole process. The tunnel identity and address are reused.
See [Running a permanent service](docs/service.md) for systemd setup and migration
from separate units. No browser or reader TCP listener is enabled.

For an independently managed tunnel, one command starts a headless server in the background when needed and runs its tunnel in the foreground. An already running compatible server is reused with its current listeners. In another terminal, generate a client setup prompt:

```sh
./pocketcontext tunnel serve
# In another terminal:
./pocketcontext tunnel invite
```

Ctrl+C stops the tunnel; the database server remains running, including after a tunnel failure. Use `./pocketcontext stop` to flush and stop the server. Keep the tunnel supervised for remote access. This command does not initialize a missing database, open a browser or enable reader TCP.

Copy the complete generated prompt into the other computer's agent conversation. It contains the release-pinned installation instructions and invitation together. The agent checks that it is executing on the intended reader computer, installs or reuses the client, passes the embedded JSON to `tunnel join --stdin`, verifies the server identity, signs in and saves the connection. Reader sign-in follows when the client has a usable desktop browser. A client reached over SSH can pair for CLI work with `--skip-reader` without issuing a reader code. There is no separate setup prompt, invitation file or login code to copy. The client never creates a database or reads the server's local key. The server agent asks you to return after desktop setup and confirm whether the reader opened and the knowledge base was accessible, or share its error/completion report. The desktop agent completes sign-in first; this return checkpoint verifies the result and guides recovery. The invitation contains no reader sign-in URL: the desktop client generates its fresh two-minute link only after connecting.

`join` starts a managed background forward by default and returns when connected. Its reader step follows the same environment check as `open`; SSH, headless or uncertain sessions skip that step automatically. `--skip-reader` explicitly pairs the CLI without creating a reader code. `--no-browser` explicitly returns a single-use link when the user has a browser that reaches the forwarded address but the agent cannot launch it; it is not a headless-mode flag. These two options cannot be combined. `--foreground` keeps the forward attached to the terminal. The agent registers the remote skill with `skill --url URL` after joining; use the actual reported URL and port, which may differ from 8096.

Invitations, one-time codes and reader sign-in links may be displayed in the user's setup chat and copied to their other agent. This intended handoff needs no separate file-transfer step or additional confirmation and is not a reason to rotate the tunnel address. They grant access: an unused invitation signs a client into the project's one account, and its address continues to provide connectivity after the code expires. Keep passwords, session tokens, local keys and private tunnel identity keys out of chat. Do not publish live invitations in public documentation.

An invitation code expires after 10 minutes, is single use and is invalidated by a server restart. If installation takes longer, keep the installed client and request a fresh invitation. Expiry limits when the code can be redeemed; it does not end a session already established with it. A fresh standalone `login-code` can also be shared in the setup chat and passed to `login --url URL --code-stdin`.

For file-based automation, `tunnel invite --out FILE` and `tunnel join --file FILE` remain available. Invitation files must be created outside the project folder; remove temporary copies after use. `tunnel forward --url URL --background` restarts a saved connection without another invitation. URL-keyed tokens refresh daily and require renewed sign-in after expiry (7 days). The server and its supervised tunnel must remain running. Inspect the client worker with `tunnel status --url URL` and stop it with `tunnel stop --url URL`. Managed forwards survive the invoking terminal, but do not install an operating-system login service; after a computer restart, run the saved background forward again.

The tunnel uses tailcat 0.7.0: WireGuard over Tailscale's data plane, without an account or administrator rights, bootstrapped through public best-effort relays. It exposes only the project's one service, forwarding to the private socket without opening server TCP (or verified loopback TCP for older/TCP-only servers). It cannot expose other ports, UDP, shells or files. The client listens only on loopback. Knowing an address provides connectivity, not authentication.

The client's port must equal the server's port because of the Host check. Independently configured servers may select the same port. A busy client port is refused; it is never silently remapped. To change a port, stop the project and its tunnel, edit the project's `port`, restart, create new invitations, and explicitly update affected registry URLs and sign-ins. Local port allocation cannot guarantee availability on another computer.

Remote `--url` accepts only `http://127.0.0.1:PORT` or `http://localhost:PORT`. Explicit `--db` overrides the URL environment variable. Server commands remain local-only. For the browser, `open --url URL` uses the signed-in client session to issue a two-minute, single-use reader link when reader setup is selected. `--no-browser` explicitly requests a manual link for a browser known to reach that forward; `--skip-reader` omits the reader step. A successful launcher request does not prove a page loaded. No password is needed; an expired client session must sign in again before reader sign-in.

## Scope

`ingest` stores any file up to 50 MiB (UTF-8 text up to 100 MiB) as an immutable original. It splits UTF-8 text (`.txt .md .markdown .csv .json .rst .log .srt .org`, or no extension when the content is valid UTF-8) into passages itself. Any other file is stored without passages and its media type is taken from the extension, never from the content. The binary never parses PDFs, images, audio or office documents and calls no external tool or service for them: the user's agent downloads the original (`original SOURCE --out FILE`), converts it to UTF-8 text or Markdown with its own abilities, and records the result with `extract SOURCE --text FILE --tool TOOL`. That creates an `agent-text` rendition whose passages are derived evidence, not an exact copy of the original; `pending` lists sources that still need it. Originals are never replaced, so a large file is shrunk before ingest (for example audio to Opus), with its provenance recorded by `extract --original-sha256` and `--conversion`. There is no external identity provider or hosted provisioning portal. Originals stay on local storage; the optional container supervisor stores complete backups in private S3-compatible storage. Optional native HTTPS serves the reader at your own domain; hosted containers use the explicitly configured HTTPS proxy. See [docs/data-model.md](docs/data-model.md) and [docs/spaces.md](docs/spaces.md) for the rules the server enforces, and [origin](docs/origin.md) for maintenance history.

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

See [local development](docs/development.md) for the pinned `devenv` shell,
first-time project setup, daily startup, SSH access and temporary
Cloudflare preview constraints. With Nix and devenv installed, start with
`devenv shell`, then `pc-dev-build`; use `pc-dev --db PATH` for the launcher below.

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
