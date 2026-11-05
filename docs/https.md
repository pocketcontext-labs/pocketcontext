# HTTPS hosting and phone access

Since 0.18.0, PocketContext can serve the reader at a domain with HTTPS, obtain a
Let's Encrypt certificate and renew it automatically. The same binary owns the
database, reader, HTTP and HTTPS listeners. No reverse proxy or certificate utility
is needed. Hosting is opt-in; local-only use remains unchanged.

## One setup prompt

Give your setup agent this request, replacing the domain:

> Set up PocketContext 0.24.0 for phone access at knowledge.example.com on this
> host. Use the release's HTTPS hosting manual. Confirm the project folder and
> name, inspect existing installations before replacing anything, and preserve
> existing data. Configure DNS and the host firewall using my authorized tools,
> asking for missing access only when needed. Install one persistent OS service
> running PocketContext as an unprivileged account with permission to bind ports
> 80 and 443. Verify valid HTTPS and authentication, then give me a fresh
> `open --public` link to open on my phone. Do not report phone sign-in as complete
> until I confirm it. Do not install a proxy or tunnel client on my phone.

The setup agent must read the exact installed release's manual. A setup prompt
cannot grant missing DNS-provider access or make a host behind CGNAT reachable.
Detect those prerequisites before promising completion.

## Prerequisites

- A lowercase ASCII DNS hostname you control, such as `knowledge.example.com`.
  Supply no scheme, path, port, wildcard or IP address to `--domain`.
- DNS pointing to this host's reachable public address. Publish an AAAA record
  only when IPv6 routing and the listener are actually reachable. Remove stale
  records before validation.
- Inbound TCP ports 80 and 443 routed to this host, with no conflicting service.
  A home router may need forwarding; CGNAT may require another hosting location.
- Outbound HTTPS access for ACME. Start with correct system time and DNS.
- A persistent unprivileged OS account for PocketContext. Keep its home and cache
  stable across restarts so the database working copy and certificates survive.

Port 80 serves ACME HTTP validation and redirects to HTTPS, never the application.
Port 443 serves the reader and its authenticated APIs. The domain is explicitly
allowlisted for certificate issuance. Supplying `--domain` accepts the Let's Encrypt
subscriber agreement; the optional `--acme-email` is its contact address.

## Start the service

Initialize a new project normally, or follow the upgrade procedure for an existing
one. Stop the existing server before handing ownership to the service:

```sh
/absolute/project/pocketcontext stop --db /absolute/project/pocketcontext.db
/absolute/project/pocketcontext serve --headless --domain knowledge.example.com --db /absolute/project/pocketcontext.db
```

`--domain` requires `--headless` and excludes `--port`, `--tcp-only` and `--ui-dev`.
The ports are fixed at 80 and 443. Add `--acme-email owner@example.com` if desired.
Add `--tunnel` only when desktop CLI clients also need the private tunnel. The
domain and ACME contact are process/service arguments, not synced project settings.

SIGTERM, Ctrl+C and authenticated local `stop` drain the service and flush the
database. The OS service manager handles boot and restart policy; the CLI does not
install it. Public HTTPS does not expose local administration or the dashboard.
The private socket remains available for the local CLI. Public CLI `--url` access
is not added: remote CLI clients continue to use a private loopback forward.

For an explicitly requested external assistant connection, add `--mcp` to this
same HTTPS service. See [MCP setup](mcp.md) for account linking and revocation.
Preserve `--mcp` when changing other service options. No private tunnel is needed
for MCP; keep `--tunnel` only for separately requested desktop CLI clients.

## Linux systemd service

Use a system service running as the actual existing project owner. Replace paths
and `User`/`Group` below; do not change a real project's ownership casually. Save
the unit as `/etc/systemd/system/pocketcontext.service` with administrator access:

```ini
[Unit]
Description=PocketContext HTTPS knowledge reader
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=pocketcontext
Group=pocketcontext
Environment=HOME=/home/pocketcontext
ExecStart=/absolute/project/pocketcontext serve --headless --domain knowledge.example.com --db /absolute/project/pocketcontext.db
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

Use `systemctl daemon-reload`, `systemctl enable --now pocketcontext.service`,
`systemctl status pocketcontext.service` and
`journalctl -u pocketcontext.service` under the host's normal administrator workflow.
Do not run the binary as root to solve a low-port permission error. For macOS and
Windows, configure their native service manager and firewall explicitly; do not
claim the Linux unit works on those systems. The setup agent must verify the
selected platform's listener permissions and restart behavior.

## Verify, then sign in

1. Run `status --db PATH` as the service's project owner. Confirm the expected
   project identity and `publicURL`. Listener readiness alone does not prove a
   certificate was issued or that the phone can reach the domain.
2. From an external network, open or request `https://knowledge.example.com/`
   with normal certificate verification. Check that HTTP redirects to that exact
   HTTPS origin. Never use `curl -k` as evidence of successful TLS setup.
3. Confirm unauthenticated knowledge requests are refused. Sign in with the
   project's password or generate a one-time link on the hosting computer:

   ```sh
   /absolute/project/pocketcontext open --public --db /absolute/project/pocketcontext.db
   ```

4. Display the returned `signInLink` immediately in the user's setup chat. It
   expires in two minutes and grants access to the project's account. The command
   never launches a browser, starts another server, or proves public reachability.
   Ask the user to open it on their phone and confirm they can read their knowledge.
5. Verify restart and, when practical, reboot recovery using the OS service. A
   certificate is reused from the private cache; unattended renewal is automatic
   while the service remains reachable. A short rehearsal does not prove a future
   renewal occurred.

If a link expires, issue `open --public` again. Keep passwords, reusable tokens,
certificate private keys and the local key out of chat. Existing reader sessions
retain the ordinary single-user access model; spaces are not security boundaries.

## Troubleshooting

- **Port permission denied:** verify the service account and its low-port binding
  permission. A file capability on a binary can disappear when it is replaced.
- **Address already in use:** identify the current owner before changing services.
  Do not stop an unrelated website just to obtain these ports.
- **Certificate not issued:** check DNS, every published address, inbound routing,
  system time and outbound ACME access; inspect the service logs. Certificate
  issuance begins when the configured domain is accessed. Do not repeatedly
  delete the certificate cache, which can trigger issuance limits.
- **Works on the host, not on the phone:** test from the phone's network and check
  public routing. A loopback check is insufficient. DNS validation does not bypass
  a firewall or CGNAT.
- **Renewal trouble:** keep the service and ACME challenge ports reachable and
  the cache writable. Fix the reported cause before certificate expiry; never
  disable TLS verification as a workaround.

Certificates and ACME state stay in the private machine cache. They are operational
secrets, not knowledge sources, and are excluded from synced project backups. A
restored host must re-establish its hosting configuration and certificate state.
