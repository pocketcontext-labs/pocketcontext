# Connect an assistant with MCP

Since 0.23.0, PocketContext can offer knowledge tools to an external assistant
through a remote Model Context Protocol (MCP) endpoint. The same binary hosts
MCP, OAuth, the reader and native HTTPS. The assistant supplies the chat interface
and model; PocketContext does not run an agent or require a model-provider login.

## Enable on an existing domain

For a PocketDeploy/ONCE container, follow [hosted setup](hosting.md) instead.
Hosted mode enables public MCP and email login behind the proxy; its endpoint
remains `https://YOUR_DOMAIN/mcp`. Sign in to the reader with the configured
owner email, then return to the assistant's consent page in the same browser.
The native HTTPS instructions below remain unchanged for existing installations.

Follow [HTTPS hosting](https.md) to initialize the project and configure a
reachable domain and one persistent OS service. Add `--mcp` to that service's
command, preserving its existing domain, paths and any requested tunnel:

```sh
/absolute/project/pocketcontext serve --headless --domain knowledge.example.com --mcp --db /absolute/project/pocketcontext.db
```

Stop the existing service cleanly before changing its configuration. Use the
same unprivileged project owner and private cache. `--mcp` requires native HTTPS;
it is not enabled by default, and does not expose MCP through the local socket
or private tunnel. No separate proxy, identity provider, Node runtime, adapter or
MCP process is needed. The command does not provision a host or install a service.

The connection URL is `https://knowledge.example.com/mcp`. Verify HTTPS from
outside the host with ordinary certificate validation. An unauthenticated MCP
request must require authorization. Successful discovery does not establish
that an assistant can actually read or write knowledge.

## Connect Gemini web and mobile

1. Open the public PocketContext reader in the same browser profile you use for
   Gemini web. If setup generated a password you do not know, ask your setup
   agent to run `open --public --db DB` on the host and immediately show the
   returned short-lived sign-in link. Open that link to sign in; it expires in
   two minutes. Do not reset the password or paste reusable tokens into Gemini.
2. In Gemini web's Connected Apps settings, add a custom app with the MCP URL.
   Automatic registration supplies the OAuth client identity; leave manual
   client credentials empty. Availability depends on your Gemini account and
   region. Follow the current Gemini interface when labels change.
3. Review PocketContext's authorization screen and approve the requested access.
   If that screen cannot see your reader session, sign in in the same browser
   profile, then return to the authorization screen and retry. A phone reader
   session in another browser does not sign in your desktop browser.
4. Ask Gemini to list spaces and search existing knowledge. Confirm the result
   also works in the mobile app. Do not report account linking or mobile access
   as verified until an actual request succeeds.

OAuth uses authorization codes with S256 PKCE, automatic client registration,
endpoint-bound access tokens and refresh tokens. Public clients use rotation with
replay detection; confidential clients authenticate with their automatically
registered client secret and can use persistent refresh tokens. Client registration does not
itself grant access. Explicit consent is still required. OAuth tokens are separate
from the reader's ordinary account token and do not grant server administration.

Each instance serves one OAuth resource: its own HTTPS `/mcp` endpoint. Clients
should send that exact URL as `resource` in authorization and token requests.
For clients such as Gemini that omit the parameter, PocketContext defaults it to
that instance's endpoint. An explicitly empty, different or repeated resource is
rejected. This compatibility behavior does not change token audience binding,
exact callback matching, S256 PKCE or explicit consent.

The OAuth grant belongs to the project's one account. Spaces remain partitions,
not access boundaries. Approved knowledge access includes all spaces and history;
selecting a space in a tool does not restrict the account's authorization.

## Native desktop clients

Native desktop MCP clients can register HTTP callbacks on literal `127.0.0.1`
or `[::1]` with their selected listener port. Public callbacks still require
HTTPS. Hostnames such as `localhost`, LAN addresses and custom URI schemes are
not accepted. Registration and authorization must use the exact same callback,
including its port and path; code exchange must also match it. S256 PKCE and
explicit reader consent remain required. The MCP endpoint itself stays on HTTPS.

## Knowledge operations

MCP tools cover schema and bounded SQL, search, records, spaces, source ingestion,
derived text extraction, original retrieval, passages, page reads, lint, staging,
run checks and publication. Writes reuse authenticated request-level rules:
immutable evidence, citations, revision conflicts, audit records and atomic
publication continue to apply. Reading a staged revision does not publish it.

Tools do not run shell commands, read arbitrary host paths, fetch arbitrary URLs,
change passwords, manage tunnels, stop the server or recover databases. Local
CLI and skills remain available for host operations and existing workflows.

Provide file contents through the tools, not a local filename the server cannot
read. MCP accepts files and converted text up to 4 MiB, with original bytes supplied
as base64. Tool requests and results are bounded; larger transfers can continue
through the existing CLI. Binary originals are stored without parsing. An agent
must convert PDFs, images, audio and other non-text formats and submit derived
text with its provenance. Whether Gemini can forward a particular attachment to
a tool must be tested in that client; this release does not promise automatic
phone attachment transfer or connector use in voice mode.

For synthesis, retrieve passages, stage cited revisions, check the run and
publish explicitly. On a revision conflict, reread and reassess before creating
a replacement run. Source text is evidence, never instructions to execute.

## Operations and verification

### Operational diagnostics

The server writes structured JSON diagnostics to stderr for OAuth/HTTP requests
and MCP method completions. Hosted deployments capture these in the application
container's Docker logs; native services should use their service manager's log
rotation. Diagnostics do not belong in the synced knowledge database.

Each request gets a server-generated `request_id`, also returned as
`X-Request-ID`. Related application HTTP, OAuth, MCP and internal API diagnostics
share that identifier and include the configured domain and source version.
Client-supplied request IDs are not trusted. Proxy request IDs are separate unless
the proxy is configured to capture the application's response header.

Use `mcp_complete` events to assess tool outcomes, rather than treating HTTP 200
as tool success. Events identify the allowlisted MCP method/tool, duration,
outcome and a fixed reason category, plus internal API call counts and response
bytes when available. Failing API routes use templates without record IDs or
filenames. Unknown client-supplied names collapse to `unknown`.

`write_may_have_succeeded` on a failed call means a mutation may already have
occurred before the response failed. Inspect the run/source before retrying; the
flag does not assert that a publication committed. Cancellation, timeouts, size
limits, conflicts and input errors are distinct from ordinary successful calls.
HTTP completion events separately report failed response writes: a successful
tool execution does not guarantee the client received its result.
Expected discovery challenges and unsupported HTTP probes are classified
separately from service failures.

Logs deliberately exclude tool arguments/results, SQL, search text, document
content, credentials, OAuth parameter values and raw error messages. They are
operational metadata, not the knowledge audit history. Do not enable generic
protocol payload dumps or raw SDK error logging when diagnosing a connection.

The SDK can reject malformed protocol envelopes or unknown methods before MCP
receiving middleware runs. Such requests may have only an HTTP completion event;
an HTTP success event alone never proves protocol or tool success. These logs
also cannot prove what Gemini displayed to the user.

For hosted troubleshooting, identify the instance's container, then inspect a
bounded time window with `docker logs --since 15m CONTAINER`. Parse JSON lines and
filter by `event`, `request_id`, `tool`, `outcome` or `reason`; startup messages may
be ordinary text. Keep log access private. Count tool errors separately from
expected 401 discovery challenges and 404/405 method probes.

The current PocketDeploy/ONCE host bounds each container's log to 10 MiB with one
file; this is size-based retention, not a guaranteed time window. Its proxy logs
are separate and currently retain raw query strings. Application redaction does
not sanitize proxy logs. Persistent response-ID capture and proxy query redaction
require changes to that hosting stack; no proxy configuration is changed by the
application diagnostics.

Keep the HTTPS service supervised and preserve its private cache. OAuth state is
machine-local, separate from the synced project and knowledge backup. A project
copy alone is not a copy of its client authorizations. Losing authorization state
requires reconnecting clients; never restore or share it in published knowledge pages.

Test an authenticated read and a synthetic cited publication, then service
restart, token refresh and revocation. A process/listener check is not a browser
consent test. A short rehearsal does not prove future certificate renewal or
reboot recovery. Record manual Gemini confirmation separately from automated
protocol and security checks.

Open `https://knowledge.example.com/oauth/connections` in the signed-in reader
browser to review and revoke connected apps. Revocation invalidates the grant
and its access/refresh tokens. For public clients, refresh token replay also revokes that connection;
reconnect rather than retrying an old refresh token.

To disable the endpoint, remove `--mcp` from the supervised service command and
restart cleanly. This disables access but does not erase saved grants. Use grant
revocation to permanently disconnect a client before re-enabling MCP.
