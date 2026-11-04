# Local development

Use a dedicated development knowledge base containing synthetic notes. Keep it
outside a synced or production project. The source checkout and development
project are separate: Go compiles the application; the application owns its
working database, snapshots and private machine cache.

## Toolchain with devenv

On Linux or macOS, install [Nix and devenv](https://devenv.sh/getting-started/),
then run from the repository root:

```sh
devenv shell
pc-dev-build
```

`devenv.nix`, `devenv.yaml` and `devenv.lock` provide Go 1.27.3 with CGO and a C
compiler, Node.js 24, pnpm 10.33.2, Make, Python, Git, curl, jq, Caddy and
cloudflared. `pc-dev-build` runs `make ui` and `make build`; the frontend install
uses the frozen lockfile. The first shell entry downloads Nix packages. It does
not install an agent adapter, authenticate to a provider, create a database or
start services. `devenv up` is not configured; use the commands below.

Keep the lockfile with the configuration. Update inputs deliberately with
`devenv update`, check the resulting tool versions and rerun the build. The Go
version assertion prevents a nixpkgs update from silently changing the required
toolchain. Native Windows development uses the tools listed in the README and
MinGW-w64 for CGO; this Nix shell is not the Windows setup path.

For optional direnv activation, merge this into the Git-ignored `.envrc`, preserving
any existing local settings and keeping private values in `.envrc.private`:

```sh
# -*- mode: sh; -*-
eval "$(devenv direnvrc)"
use devenv
source_env_if_exists .envrc.private
```

Review the file, then run `direnv allow`. Give `.envrc.private` mode `600`.
Never import private environment files from Nix expressions: their contents must
not enter the Nix store. `devenv shell` itself does not source `.envrc.private`.
See [devenv's direnv integration](https://devenv.sh/integrations/direnv/).

## Initialize once, then start hot reload

Inside the development shell, choose an absolute path for a new development
project. The following path is deliberately inside Git-ignored `.private/`:

```sh
mkdir -p .private/dev/project
chmod 700 .private .private/dev .private/dev/project
DEV_DB="$PWD/.private/dev/project/pocketcontext.db"
bin/pocketcontext init --db "$DEV_DB" --name "PocketContext Development" --port 18096
bin/pocketcontext stop --db "$DEV_DB"
pc-dev --db "$DEV_DB"
```

`init` asks for the development account password and starts a headless server;
`stop` flushes and stops it before the foreground development launcher starts.
Do not repeat initialization to start an existing project. On subsequent runs:

```sh
devenv shell
pc-dev --db "$PWD/.private/dev/project/pocketcontext.db"
```

Without devenv, the equivalent launcher is
`node scripts/dev.mjs --db /absolute/path/to/dev/pocketcontext.db` or
`make dev DB=/absolute/path/to/dev/pocketcontext.db`.

The launcher checks the database and ports, starts Vite on `127.0.0.1:5173`,
then starts PocketContext on the project's configured port, with Vite as its
loopback UI upstream. Open **http://127.0.0.1:18096**, not port 5173, and sign in.
For a fresh sign-in link, run this in another terminal with access to the project:

```sh
bin/pocketcontext open --db "$PWD/.private/dev/project/pocketcontext.db" --no-browser
```

A link expires after two minutes. On a remote host, the host's loopback URL is
not reachable from your desktop without forwarding. For private desktop access,
forward the project port over SSH:

```sh
ssh -N -L 18096:127.0.0.1:18096 USER@DEV_HOST
```

Press Ctrl-C in the launcher terminal to stop both processes and flush the
application's database normally. The launcher refuses occupied ports rather than
stopping another process. `--vite-port PORT` selects another Vite port; changing
the project reader port is a separate project configuration change.

Edits to `ui/src` hot reload. Go code, hooks and migrations require stopping the
server, rebuilding with `make build`, and restarting it. Before testing the
embedded/release reader, rebuild both UI and binary. Hot reload does not
perform TypeScript checks.

## Temporary Cloudflare previews

The shell includes Caddy and cloudflared for explicitly configured previews;
it does not automatically publish a service. A direct Quick Tunnel to either
Vite or the PocketContext reader is not a working configuration: the reader
validates loopback Host/Origin, and Vite's hot-reload client normally uses the
reader's local port.

A development gateway must validate the exact temporary HTTPS hostname and
browser Origin, proxy only reader/authentication/knowledge routes and development
assets, and block local administration and the PocketBase dashboard. Configure
the hot-reload WebSocket for WSS on external port 443. Do not disable backend
authentication or globally allow arbitrary Hosts/Origins to make a tunnel work.

Machine-local gateway configuration, process helpers, logs and tunnel URLs belong
in `.private/`; they are not supplied by a fresh clone. The temporary setup on an
individual machine may provide `.private/dev/manage.py`; consult its local README
before using it. It is distinct from the committed `scripts/dev.mjs` launcher.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
change hostname on restart and do not support Server-Sent Events. Vite hot reload
uses WebSockets, but cross-client PocketBase realtime updates need a refresh
through such a preview. Keep full realtime checks on the loopback/SSH path.

## Validation

After reader edits:

```sh
pnpm --dir ui typecheck
pnpm --dir ui test
pnpm --dir ui build
```

After launcher changes, run `node --test tests/dev_launcher.test.mjs`. For real
browser checks, install the pinned browser once with
`pnpm --dir ui exec playwright install chromium`, then run
`node tests/ui_dev_browser.mjs --binary bin/pocketcontext` and the reader/browser
checks in the README. Native browser system dependencies are separate from the
Nix toolchain; the scripts also accept an explicitly supplied browser executable.

Before shipping application changes, rebuild and run the Go, name and end-to-end
checks in the README. Tests must use temporary projects and synthetic data, never
the running development or production database.
