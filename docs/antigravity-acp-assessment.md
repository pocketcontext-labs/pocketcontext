# Antigravity (`agy`) ACP assessment

Historical assessment of the pre-0.22.0 integration. Built-in ACP chat was removed in 0.22.0; this is not current setup guidance. Code references describe the earlier checkout.

Assessed 4 November 2026 against installed `agy` 1.5.0 and PocketContext checkout
`f166673f0a1765ce3b697c2f19ea6463f938c8bb`, including the concurrent, uncommitted
change that makes all three chat permission choices available. This is an
integration assessment, not a supported-backend announcement.

## Verdict

**Use the official native `agy acp` as the candidate backend. It is present on
this host and passes ACP initialization. Do not switch PocketContext's working
Codex backend to it yet.** Session creation could not be validated because the
ACP runtime returned `Authentication required`. PocketContext also contains
Codex-specific permission, model and authentication assumptions that need an
explicit compatibility implementation and tests.

No third-party adapter is needed merely to obtain an ACP server. Google now
documents `agy acp` as a stdio JSON-RPC subprocess using the CLI's agent and
cached sign-in. This is different from running the desktop IDE, using
`agy --print --output-format stream-json`, or wrapping CLI output in another
protocol. [Google CLI ACP guide](https://antigravity.google/docs/cli/acp/)

The existing installable PocketContext skill for Antigravity is a separate
integration: it lets an external agent operate the knowledge CLI. It does not
establish that the reader's ACP bridge supports Antigravity.

## Evidence collected

Only help/version commands and no-prompt protocol requests were run. No
credentials were read or printed, login flow started, model prompt submitted,
third-party adapter installed, or running development backend replaced.

| Check | Observed result |
| --- | --- |
| Executable | `~/.local/bin/agy`, version `1.5.0`, on Linux arm64 |
| Binary SHA-256 | `aa2006a2310f6f76c76949a9314d998456cf270de781f903b2d2d9958b92ed81` |
| `agy --help` | Lists `acp` as the native ACP stdio server command |
| `agy acp --help` | Supports stdio, sandbox, process-per-session, log path, telemetry control and explicit interactive login |
| `initialize` | Protocol `1`; agent name `Antigravity ACP Server`, version `1.5.0` |
| Client capabilities used | Exactly PocketContext's current `fs.readTextFile=false`, `fs.writeTextFile=false`, `terminal=false` |
| Advertised prompt capabilities | Images and embedded context supported; audio not supported |
| Advertised session capabilities | Load, resume, list, close and additional directories |
| Advertised authentication IDs | `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` |
| `session/new` | JSON-RPC error `-32000`, `Authentication required`; no session created |
| Model generation, permissions, cancellation, restored transcript | Not exercised |

Each probe used a new temporary scratch directory, `NO_BROWSER=1`,
`--disable-telemetry`, a private log path, and no `authenticate` request. The
probe terminated its own process group afterward. `NO_BROWSER` is not claimed
as an Antigravity security control; no login operation was invoked. The session
probe inherited the invoking environment rather than PocketContext's narrower
child environment, so it does not prove production authentication compatibility.
Sanitized initialization evidence was saved during the run under
`/tmp/pocketcontext-agy-acp-7hkdxs10/initialize-summary.json`; temporary evidence
may disappear and is not required to understand this report.

## Compatibility with the current bridge

The transport is promising; the application-level contract is not generic yet.
Source references below point to the implementation reviewed, rather than to
claims that an authenticated Antigravity session passed.

| Area | PocketContext today | Assessment and required work |
| --- | --- | --- |
| Transport and initialization | Newline-delimited JSON-RPC, ACP v1, 1 MiB response-frame limit in [rpc.go](https://github.com/pocketcontext-labs/pocketcontext/blob/v0.21.1/internal/chat/rpc.go) | Initialization passed with the same advertised client capabilities. Validate large tool output and malformed/partial frames with fixtures. |
| Provider identity | `Status()` reports `codex-acp`; initialization ignores `agentInfo` in [manager.go](https://github.com/pocketcontext-labs/pocketcontext/blob/v0.21.1/internal/chat/manager.go) | Capture and persist real provider/version identity. Do not label an Antigravity session as Codex or restore a Codex session ID into another backend. |
| Permission modes | Requires an advertised mode matching `read-only`, `workspace-write` or `agent-full-access`, then calls `session/set_mode` | Antigravity's actual session mode IDs remain unknown because session creation failed. CLI help's `plan`, `accept-edits`, `auto` values are not evidence of equivalent ACP modes or filesystem guarantees. Keep failure closed until a verified mapping exists. |
| Startup policy | Injects `INITIAL_AGENT_MODE` and `CODEX_CONFIG` with Codex approval/sandbox settings | These are Codex-specific, not a portable ACP policy. Use a provider-specific launch policy; never assume Antigravity honors these variables. |
| Live permissions | [turn.go](https://github.com/pocketcontext-labs/pocketcontext/blob/v0.21.1/internal/chat/turn.go) changes modes and auto-selects `allow_once` for full access | Verify exact Antigravity behavior, including restrictive changes, pending approvals and persisted rules. Availability of all three UI choices does not prove the backend can enforce all three. |
| Model and effort | Reads legacy `models` and calls `session/set_model`; no `configOptions` handling | Add capability-driven config selectors and updates. Preserve native model IDs and independent effort choices; do not infer options from the CLI's model list. |
| Images | Checks advertised image support and sends ACP image blocks; accepts at most three PNG/JPEG inputs with existing size bounds | Image capability was advertised. Actual image interpretation and provider limits are untested. Embedded-resource support is advertised but the current reader does not send general ACP embedded resources. |
| Tools and filesystem | Does not provide ACP client filesystem/terminal services; other client requests get `-32601` | Initialization accepted this. Tool execution still needs testing with these services disabled. Do not enable them merely to make an adapter work. Agent-owned tools may execute under the host user's rights. |
| Questions and permissions | Handles `session/request_permission` only; other client requests are unsupported | Add explicit elicitation handling or a clear unsupported-question state. Never treat a user's multiple-choice answer as a tool approval, especially in full-access mode. |
| History and restore | Stores local transcript, calls `session/load` if advertised, suppresses replayed updates | Load capability passed initialization; actual history, session-ID scope and restoration remain unverified. Provider identity must accompany persisted sessions. |
| Cancellation and steering | Sends cancellation and supervises the process; rejects new prompts while busy | Test real cancellation and pending permission cleanup. Antigravity steering is not automatically supported by this UI/manager. |
| Host instructions | Writes a scratch `AGENTS.md` containing authenticated CLI/space instructions | Verify Antigravity reads and follows it. Initialization advertises an Antigravity system-prompt-append extension, but it was not exercised. Instructions are not a filesystem sandbox. |

ACP defines mode IDs as agent-provided values. Its current guidance prefers
`configOptions` for session controls rather than assuming universal mode names.
These are protocol requirements, not proof of any particular Antigravity
session's response. [ACP modes](https://agentclientprotocol.com/protocol/v1/session-modes),
[ACP configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options)

Google documents model and thinking-level selectors, image/resource input,
permission requests, cancellation and session restoration. It also documents
client-specific model availability: third-party models are restricted to named
editor clients. PocketContext must identify itself truthfully and accept only
what its own session advertises. Native ACP authentication can reuse cached CLI
sign-in; the documented login command is `agy acp --login`. No login was run for
this assessment. [Google ACP client guide](https://antigravity.google/docs/ide/extensions/acp/)

## Permissions and authentication boundaries

The concurrent PocketContext change removes the host environment gates for the
three existing Codex permission choices and keeps read-only as the fresh default.
That change does **not** remove the native-mode validation in `manager.start`,
and it should not be used to bypass it for Antigravity. A provider that lacks a
verified read-only contract must not be silently launched in a broader mode.

Antigravity has its own permission rules and sandbox controls. A planning mode,
a command-approval policy and an operating-system sandbox are different
mechanisms; none should be relabelled as another without tests. Avoid adding
`--dangerously-skip-permissions` to a generic startup command as a substitute for
three live choices. [Google permission rules](https://antigravity.google/docs/permissions),
[Google terminal sandbox](https://antigravity.google/docs/sandbox)

[chatEnvironment()](../internal/bundle/chat_setup.go) currently forwards selected
OpenAI credential variables but not `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT` or
`GOOGLE_CLOUD_LOCATION`. It preserves `HOME`, which may allow default cached
credentials, but that path did not authenticate this probe. Design a narrowly
scoped provider-specific environment contract if key/enterprise authentication
is required. Do not forward every environment variable or copy credentials into
project configuration. Browser reader authentication remains separate from the
host's model-provider sign-in.

Older instructions can describe a separately packaged `agy_acp_server.par`
runtime and helper. The acpx project still describes that integration; it is
first-party evidence about **acpx's launcher**, not grounds to replace the
locally verified `agy acp` entrypoint or claim shared credential behavior.
[acpx Antigravity integration](https://github.com/openclaw/acpx/blob/main/agents/Antigravity.md)
Third-party wrappers around print mode should be assessed separately for approval,
streaming and session semantics, not installed as the default solution.

## Recommended implementation and acceptance sequence

1. **Authenticate the candidate independently.** Let the user complete the
   documented host login if needed; then repeat initialize and session/new with
   PocketContext's exact filtered environment. Capture only sanitized capability,
   mode and configuration metadata. Do not change the working Codex service.
2. **Make provider handling explicit.** Add provider identity/version and native
   capabilities to session state. Isolate Codex environment configuration from
   Antigravity launch configuration. Retain strict protocol/error handling and
   truthful unsupported states.
3. **Prove permission semantics before exposing the backend.** Establish mappings
   for all advertised choices, or report that a desired mode is unsupported.
   Use synthetic files and a disposable workspace to test read/write/network and
   approval behavior, live changes, denials and failures. An expanded UI must not
   weaken enforcement.
4. **Implement modern session controls and questions.** Support native model and
   effort configuration, config-update notifications, and elicitation without
   conflating user decisions with permissions. Add provider-shaped fixtures for
   these paths, missing auth, unsupported modes and unexpected client requests.
5. **Validate real sessions with explicit model-use authorization.** Test one
   synthetic text turn, an image, a denied tool request, approved scratch edit,
   cancel during work, browser disconnect/reconnect and server restart/load.
   Verify no prompt replay and correct selected-space CLI access. Test full
   access only in a disposable environment.
6. **Qualify platforms and packaging.** Pin an official CLI release and record its
   provenance for each supported OS/architecture. This assessment ran only Linux
   arm64; it establishes no macOS or Windows runtime/sandbox result. Avoid an
   unpinned installer or auto-upgrade in the server startup path.

A candidate launch would use an absolute `agy` executable with `--chat-args
'["acp"]'`, but this is **not yet a working or supported PocketContext recipe**.
The immediate next useful result is authenticated session metadata, not a paid
prompt or a replacement of the current development chat.

All external links were checked on 4 November 2026. Local protocol observations
and source inspection are distinguished from documented features and proposed
work. No product implementation was changed by this assessment.
