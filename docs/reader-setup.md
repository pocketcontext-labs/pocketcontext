# Reader setup in desktop and remote sessions

Run `pocketcontext environment` before offering reader sign-in. This offline
command reports the current session (`desktop`, `ssh`, `headless` or `unknown`),
browser availability (`available`, `unavailable` or `unknown`) and the reason for
its assessment. It does not start a server, create a database, issue credentials
or open a browser. It reports capability signals, not proof that a page is visible.

Use the agent's execution context too. A tool explicitly running commands over
SSH is remote even when it does not preserve SSH environment variables. A browser
installed on the host does not establish that the person can use it. SSH signals
take precedence over display variables, including X11 forwarding. A terminal's
presence or absence does not establish desktop access. If the result is unknown,
ask where the reader will be viewed only when that information is still needed.

## Choose the reader behavior

| Command | Behavior |
| --- | --- |
| `open` | Opens reader sign-in when the session and browser are available. Otherwise reports that reader setup was skipped, without starting the local server, activating TCP or issuing a reader code. |
| `open --no-browser` | Explicitly creates a two-minute sign-in link without launching a browser. Use only when a person can reach that address in their browser. |
| `open --skip-reader` | Explicitly skips reader setup, including code creation and browser launch. |
| `tunnel join --stdin --skip-reader` | Pairs and signs in the CLI, saves the connection and starts its managed forward, but does not create a reader sign-in link. |

The reader options also apply to remote `open --url URL` and file-based joining.
`--no-browser` and `--skip-reader` cannot be combined. Joining without either
option applies the same session assessment automatically. A successful pairing
is still useful when reader setup is skipped: the authenticated CLI can work with
the knowledge base. Later, run `open --url URL` from a suitable desktop session.

`--no-browser` means the browser is reachable but the agent cannot launch it.
It is not a headless-mode flag. Do not use it merely to get a link on an SSH host.
The server's `serve --headless` option controls its network listeners and is a
separate setting from whether the client has a usable browser.

## On an SSH or headless host

Complete initialization, registration, CLI checks and any requested manual import.
Keep the project headless and skip local reader login. Do not show the host's
`127.0.0.1` page links as working links for someone reading chat on another
computer: those addresses refer to the computer running their browser, unless a
matching forward has already been established and verified.

If the user already requested access from their computer, continue directly to
the authorized remote setup. Start `tunnel serve --db DB` under verified
supervision and generate the complete client setup prompt with
`tunnel invite --db DB`. Display that prompt for the user to paste into the agent
on the computer where they will use the reader. Do not ask for the same permission
again. Otherwise offer to connect that computer once; detecting SSH does not
itself authorize a tunnel or invitation.

A useful completion report is: “PocketContext is ready on the remote host. The
requested checks passed. This is an SSH session, so browser sign-in here was
skipped.” Then provide the authorized client handoff or offer it. Mention pending
reader access separately from completed knowledge work. Do not create a short-lived
reader code while the user is still installing the other computer's client.

## On the reader computer

Make sure command execution is on the intended computer, not another SSH host or
container whose loopback address the user's browser cannot reach. Inspect
`environment`, then follow the generated client prompt to connect, verify the
server identity and sign in. Use the actual forwarded URL reported by the client.
If the browser is reachable but automatic launching is unavailable, explicitly
use `--no-browser` and display its returned sign-in link. If the user wants a
CLI-only client, use `--skip-reader`; do not describe that choice as a browser
failure.

A browser-launch request is not evidence that a page loaded or that the person
signed in. Report only the command's actual launch result. The user can still use
an explicitly requested manual link if their browser reaches the verified local
forward. Keep reusable session tokens, passwords and private keys out of chat;
the existing invitation and single-use link handoffs remain supported.
