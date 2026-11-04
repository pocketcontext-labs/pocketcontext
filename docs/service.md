# Running a permanent service

Since 0.17.0, one command runs an initialized project's server and private tunnel
in one foreground process:

```sh
/absolute/project/pocketcontext serve --headless --tunnel --db /absolute/project/pocketcontext.db
```

The project must be stopped first. This command refuses an existing server or
tunnel instead of adopting it. It uses the private socket, leaves reader TCP off,
and starts the tunnel only after the server is ready. It preserves the cached
tunnel identity and address. `tunnel invite --db DB` works after combined readiness.
`--tunnel` requires `--headless`; it cannot be combined with TCP, port or UI
development options. Configure the project's port before starting the service.

SIGTERM, Ctrl+C and authenticated `stop --db DB` stop the tunnel and server and
flush the database through the normal snapshot write-back path. Startup and
terminal component errors shut down the other component and return a nonzero exit
status. The operating-system service manager handles restart policy. A forced
kill cannot flush pending writes; normal conflict and recovery guards still apply.

The separate `tunnel serve` command retains its earlier behavior: start or reuse
an independent background server and leave it running when the tunnel exits.
Supervising that tunnel alone does not supervise the independent database server.

## Native HTTPS service

Since 0.18.0, `serve --headless --domain knowledge.example.com` runs native HTTPS
without a tunnel or proxy. Add `--tunnel` only when private desktop clients also
need it. See [HTTPS hosting](https.md) for the public route boundary, certificate
automation, phone sign-in and a Linux system service running as an unprivileged
account with permission to bind ports 80/443. The user unit below remains the
private-tunnel deployment; it does not grant low-port binding privileges.

## MCP on the HTTPS service

Since 0.23.0, add `--mcp` to the same `serve --headless --domain HOST`
command to allow external assistants to connect through OAuth. It requires the
native HTTPS domain and remains disabled when omitted. No additional process,
agent adapter or private tunnel is needed. Preserve the flag when adding private
CLI access. See [MCP setup](mcp.md).

## Linux systemd user service

Use absolute paths for the actual installation. For example, save this as
`~/.config/systemd/user/pocketcontext.service`:

```ini
[Unit]
Description=PocketContext server and private tunnel

[Service]
Type=simple
ExecStart=/absolute/project/pocketcontext serve --headless --tunnel --db /absolute/project/pocketcontext.db
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=default.target
```

Then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now pocketcontext.service
systemctl --user status pocketcontext.service
journalctl --user -u pocketcontext.service -f
```

Systemd's started state is not application readiness. Confirm the combined
`ready: true` output in the journal and check `pocketcontext status --db DB`.
Verify remote access through an authenticated client. For startup at boot and
continued operation after logout, configure user lingering for the service's
account (`loginctl enable-linger USER`, with administrator authorization if
required), then verify `loginctl show-user USER -p Linger` and test reboot/logout.

Use `systemctl --user stop pocketcontext.service` for upgrades and backups, then
verify the project stopped successfully. The normal `stop` command also stops
the combined process cleanly; `Restart=on-failure` does not restart a successful
exit. `systemctl --user restart pocketcontext.service` restarts both components.

## Replace separate units

1. Record the existing units and project identity. Follow [Upgrades](upgrades.md)
   to stop the owning services, back up the complete stopped project and install
   the matching release. Stop the old server unit before its dependent tunnel if
   it has `Upholds=` or another dependency that would otherwise restart the tunnel.
2. Disable the separate tunnel unit and remove the old inter-unit dependencies
   and readiness polling from the server unit. Keep copies outside the active
   unit directory for rollback. Do not delete the private tunnel identity.
3. Replace the server unit with the combined command, reload units and start it.
   Do not also run `ensure-running` or an independent `tunnel serve`.
4. Confirm one process owns the server and tunnel, clean shutdown writes back,
   and restarting preserves the tunnel address. Test failure recovery with a
   synthetic project before relying on it for real knowledge. Upgrade clients to
   the same release and restart their saved forwards; no new invitation is needed
   solely because of this service change.

The command is also available on macOS and Windows; configure the corresponding
service manager explicitly. The CLI does not install an operating-system service.
