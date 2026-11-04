# Reader setup

Inspect the current execution session before offering sign-in. Run the selected
binary's offline `environment` command without starting a server. It reports
session (`desktop`, `ssh`, `headless`, `unknown`) and browser availability
(`available`, `unavailable`, `unknown`). These are capability signals, not proof
that a person can see a browser. Use tool or user knowledge of remote execution
even if SSH variables were removed. A TTY, display variable or installed browser
alone does not prove local access. Ask where the reader will be viewed only when
that fact is unknown and needed.

- On a usable desktop, use the selected project's `open` command.
- In SSH, headless or uncertain sessions, default `open` skips the reader before
  local server startup, TCP activation or reader-code issuance. If tool context
  establishes remote execution despite optimistic detection, omit `open` or use
  `--skip-reader` explicitly, including for joining an intended CLI-only client. Do not replace
  that skip with `--no-browser` merely to get a link.
- `--no-browser` explicitly requests a two-minute sign-in link without launching
  a browser. Use it only when the user can open the reported address from their
  browser, including an already-established and verified forward.
- `--skip-reader` explicitly omits reader setup. With `tunnel join`, it still
  saves the connection, starts the forward and signs in the CLI. The two reader
  flags are mutually exclusive. CLI-only access is a valid completed setup.

On a remote host, finish CLI checks and requested knowledge work without a local
reader login. For requested HTTPS or phone access, follow the public HTTPS handoff
below first: preserve the configured service, verify its `publicURL` externally
and issue `open --public`. Do not install a desktop tunnel client for browser-only
access.

For requested private desktop access, reuse an existing combined tunnel instead
of starting another or replacing a running HTTPS service. Otherwise configure the
supervised server tunnel and complete client prompt; do not ask again for access
already requested. When remote access has not been requested, offer the appropriate
connection once. SSH detection does not itself authorize public hosting, a tunnel
or an invitation. For the private desktop path, the user pastes the generated
prompt into the agent on the computer where the reader will be used; do not send
them to another SSH session with an equally unreachable loopback address. The
following desktop handoff applies only to that private desktop path.

After displaying the complete client prompt, say: "Paste this prompt into the
coding agent on your desktop. When it finishes, come back here and tell me whether
the reader opened and you could access your knowledge base. If it failed, paste
its error or completion report." Keep desktop reader access pending until that
confirmation. The handoff contains the invitation and instructions, not a
pre-generated reader link: the desktop client creates its two-minute link after
its connection is ready. Do not wait for the user to return before allowing the
desktop agent to complete sign-in.

When the user returns, distinguish reader success from CLI/tunnel success. If the
reader works, mark desktop access complete. If the tunnel and CLI work but the
reader does not, direct the desktop agent to run `open --url URL --no-browser`
and immediately display its fresh `signInLink`. Diagnose pairing failures from
the reported error; issue a fresh invitation only when client authentication
still needs one. Preserve completed installation and saved connections.

On the client, establish its forward and verify server identity before reader
sign-in. Use its actual reported port. A localhost link points at the computer
running the user's browser, not automatically at the host where commands ran.
Omit reader/page links from remote-host completion reports unless reachability
from that browser is established. Report skipped reader setup separately from
completed manual import, publication and CLI checks.

Report the launch result truthfully: dispatching a browser launcher is not proof
that the page loaded or the user signed in. Keep reusable tokens, passwords and
private keys out of chat. Invitations and requested single-use reader links may
still be shown in the authorized setup-chat handoff.

On a reachable desktop, if the reader result has `readerSkipped: false` and
`browserLaunchRequested: false`, immediately display its returned `signInLink`.
If the user reports that launch or sign-in did not work, create a fresh link with
`open --url URL --no-browser` and display it immediately. Do not make the user
repeat pairing while CLI authentication works. Ask the user to confirm reader
access and return that outcome to the server agent; launcher success alone leaves
reader access pending verification.

## Public HTTPS handoff

For explicitly configured native HTTPS hosting (0.18.0+), use `open --public --db DB` on the hosting computer after external HTTPS verification. It works over SSH, prints a two-minute domain sign-in link, and neither launches a browser nor starts a server. Display the link immediately and ask the user to confirm phone access. See the installed manual `docs/https.md`. Default local/tunnel reader heuristics above are unchanged.
