# Upgrades and multiple releases

Choose one release for each project. Different projects can use different releases
on the same computer, with separate project folders, registered absolute binary
paths and dedicated skills. One project's upgrade does not upgrade the others.
Only one server may open a given project at a time.

## Compatibility

Application version and database format are separate. PocketContext 0.24.0 uses
logical database format 1, the single-user format used by 0.11.x–0.23.1. Upgrading
those projects to 0.24.0 requires no data conversion. The startup guard checks the
recorded application and PocketBase system migrations on the private working copy
before PocketBase bootstrap; unknown migrations and unsupported formats are
refused. Databases from
0.10.0 and earlier remain unsupported. Keep their original binary to read them,
then transfer the needed sources into a new project.

Future releases must declare their supported database formats and any migration.
Review PocketBase system migrations as well as application migrations when
updating dependencies. A release number change alone does not require a database
migration. An unchanged format does not promise that every older binary supports
newer commands, settings, content conventions or remote APIs.

Use the same release for a project's CLI and server, including remote clients.
Local startup and remote access refuse a different running server release;
status and stop remain available for diagnosis and recovery. Registered profiles
also check the server version. Stop and restart managed forwards after replacing
their executable; a worker from another release is not silently reused.

## Upgrade a project

These steps are an explicit procedure, not an automatic upgrade command. The
installers install an executable; they do not stop processes, create backups or
prove that a database is compatible.

1. Inspect the existing executable with `--version`. Record its absolute path,
   project path, identity, name, port, profile and any client connections. Use its
   own commands to check that the project is healthy. Read the target release's
   notes and verify that it supports this project's database. Do not infer the
   database's origin from an unrelated executable beside it.
2. Download and review the target release's pinned installer. Install into a new
   private staging directory to download and checksum-verify the release without
   replacing anything. Run the staged binary's `--version` only; do not start the
   project with it yet. Keep the stage outside the synced project. If using the
   staged binary permanently, register that machine-local path explicitly.
3. Stop affected client forwards with their own binary's
   `tunnel stop --url URL`. Stop combined services or supervised server tunnels
   through their owning terminal or supervisor, then run the existing project's `stop --db DB` and
   wait for success. If an executable serves several projects, stop and upgrade
   all affected projects together, or give the selected project a separate binary.
   Wait for cloud sync to finish before changing computers.
4. Copy the complete stopped project to a separate backup destination:
   `pocketcontext.db`, `pocketcontext.json`, `storage/` and its matching binary.
   Keep the old release with the backup when the binary lives elsewhere. Verify
   the copy. Keep machine-local caches, tokens and profiles out of the project
   backup; record the profile paths needed to recreate registration. Do not use a
   live private working database as the backup.
5. Either retain the verified release in its separate machine-local directory or
   explicitly replace the stopped executable. The installer refuses an existing
   executable unless `POCKETCONTEXT_REPLACE_VERSION` equals its actual version.
   This is an assertion about the old executable, not a compatibility override:

   ```sh
   POCKETCONTEXT_REPLACE_VERSION=0.14.0 sh /private/stage/install.sh /absolute/project
   ```

   ```powershell
   $env:POCKETCONTEXT_INSTALL_DIR = 'C:\absolute\project'
   $env:POCKETCONTEXT_REPLACE_VERSION = '0.14.0'
   try { & 'C:\private\stage\install.ps1' }
   finally { Remove-Item Env:POCKETCONTEXT_REPLACE_VERSION -ErrorAction SilentlyContinue }
   ```

   Substitute the inspected old version. The installer checks it before download
   and again before replacement. It still verifies the downloaded archive.
   For an offline switch, use the already verified staged executable and the
   platform's file-copy tools after the same stop and backup steps.
6. Verify the installed binary's `--version`. Start it with
   `ensure-running --db DB`, or start the owning service for a combined
   `serve --headless --tunnel` installation, then inspect `status --db DB` and
   confirm the running version, project identity and port. Never run `init` over an existing project.
   If the project is registered at an old binary path, explicitly reconcile its
   registration with `profile update NAME --binary NEW_BINARY`, then regenerate
   its skill with the selected binary's `skill --db DB`. Reconcile any reported
   name changes explicitly. Run `profile check NAME`, `whoami --db DB`,
   `spaces --db DB`, `check --db DB` and a read of known synthetic or user-selected
   evidence. Open the reader and confirm the expected project.
7. Upgrade affected remote clients to the same release, restart the server tunnel
   and saved forwards, refresh remote skills, then verify remote identity and
   reads. Preserve saved addresses and sign-ins unless they actually need repair;
   an upgrade is not a reason to rotate the address. Refresh manual evidence and
   existing guides when the user requests it.

A failed verification is not a reason to initialize or discard the database.
Stop the affected processes and diagnose it with the retained release and backup.

## Rollback

Restore the complete stopped backup together with its matching binary. Regenerate
its profile and skill and verify its identity before writes. Restoring the backup
returns knowledge to the backup time: preserve any later work separately before
restoring. Binary-only downgrades are supported only when that exact path has
been tested and documented; no blanket downgrade guarantee is made for 0.19.0.
Never force an older release past an unsupported-format or migration error.

## Several versions and computers

Keep each project in its own folder and select it by its registered name. Use
absolute binary paths and explicit `--db` paths when the binary is separate;
never rely on a global PATH executable for several releases. The shared router
selects the project's own skill. Legacy skill installers can replace the router;
repair it with a current registered binary's `profile repair` afterward.

For synced projects used by different operating systems, keep executables in
machine-local versioned directories. Linux and macOS share the executable name
`pocketcontext`; neither should overwrite the other's executable through sync.
Register the correct local binary on each computer, and coordinate releases
before switching the project's server between computers.

New projects select available ports while avoiding registered ones. Existing
projects retain their ports. Multiple readers and tunnel forwards need distinct
ports on the computer that hosts them. Remote forwards currently require the
server's port, so two servers independently configured with the same port cannot
both be forwarded on one client. Stop and explicitly reconfigure one project's
port and affected profiles/invitations; never kill an unrelated process or
silently remap a port.

## HTTPS hosting upgrades

Since 0.18.0, native HTTPS is an opt-in foreground service configuration. Keep the
service’s domain, ACME contact and machine-local certificate cache when upgrading;
none belongs in the synced project. Stop the owning OS service, back up the complete
project and replace the binary through the normal procedure, then restart the
service with the same arguments. If the binary has a file capability for low ports,
replacement may remove it; reapply the documented service permission and verify
HTTPS without disabling certificate verification. Prefer a system service with
only `CAP_NET_BIND_SERVICE` rather than running PocketContext as root.

Verify the public reader and authentication after restart, then generate a fresh
`open --public` link only when needed. Existing unused sign-in codes do not survive
a server restart. Never delete the certificate cache merely to retry a deployment.
