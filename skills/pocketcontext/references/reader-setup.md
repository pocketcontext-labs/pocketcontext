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

On a remote host, finish CLI checks and requested knowledge work without a reader
login. If the user already requested access from their computer, proceed directly
to the supervised server tunnel and complete client prompt; do not ask again.
Otherwise offer to connect their computer once. SSH detection does not itself
authorize a tunnel or invitation. The user pastes the generated prompt into the
agent on the computer where the reader will be used; do not send them to another
SSH session with an equally unreachable loopback address.

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
