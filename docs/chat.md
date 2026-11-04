# Agent chat in the reader

PocketContext 0.19.0 optionally connects the reader to an agent running on the
knowledge-base host. Open the reader on a phone, ask a question and review the
agent's permission requests there. The host stays awake and online. HTTPS hosting
uses the same binary; see [HTTPS setup](https.md).

The chat UI and ACP client are built into PocketContext. The first supported
adapter is **`@agentclientprotocol/codex-acp@2.5.0`**, backed by Codex. The adapter,
Node.js runtime and provider account are separate host requirements. The phone
needs only a browser. Normal knowledge-base and reader use need no agent runtime.
Other ACP agents are not yet a supported setup path.

## Set up the host

Have your setup agent inspect the host, reuse suitable existing tools and install
the adapter in a private machine-local directory outside the synced project.
Read the [pinned adapter instructions](https://github.com/agentclientprotocol/codex-acp/blob/v2.5.0/README.md).
With Node.js and npm available, install the tested pair in that directory:

```sh
npm install --save-exact @agentclientprotocol/codex-acp@2.5.0 @openai/codex@0.165.0
```

Retain the generated package manifest and lockfile. The adapter declares a Codex
version range; pinning the explicit dependency and retaining the lockfile avoids
silently selecting a different pair on reinstall. Do not use an unpinned `npx`
download every time the service starts. Inspect runtime/platform requirements
before installation; the PocketContext binary's platform support does not imply
that every external agent runtime works on that platform.

Authenticate Codex on the host as the user who runs the service, using its supported
login flow. Reuse that user's valid credentials privately. A provider login may
require a user action; report it as pending until complete. PocketContext reader
sign-in is separate and cannot sign in to the model provider. There is no provider
login screen in the phone reader. Do not put passwords, tokens or API keys in chat,
service command lines, or the synced project. Provider charges and limits apply;
external AI services receive the context sent to them.

For portable startup, configure the **absolute Node executable** and the adapter's
absolute JavaScript entrypoint, rather than a shell shim:

```sh
/absolute/pocketcontext serve --headless --db /absolute/project/pocketcontext.db \
  --chat-agent /absolute/node \
  --chat-args '["/absolute/agent/node_modules/@agentclientprotocol/codex-acp/dist/index.js"]'
```

On Windows, use the absolute `node.exe` path and properly quoted JSON arguments;
do not pass the npm `.cmd` shim as the executable. A service manager may require
its own quoting syntax. Use [the service guide](service.md) to configure one
persistent process. Preserve existing `--domain`, `--acme-email` and `--tunnel`
options when adding chat. For phone access, add `--domain YOUR_DOMAIN` only after
DNS and public ports 80/443 are ready. Chat itself does not require public hosting.
The browser cannot change the executable or its arguments. Installing or enabling
chat is an explicit host setup action, never a side effect of opening the reader.

Verify the running release and instance, reader sign-in, adapter readiness and
provider authentication separately. With the user's authorization, ask a question
about synthetic or existing approved knowledge and verify the answer. A running
adapter alone is not evidence that a model response succeeded.

## Permissions and knowledge changes

The initial default for new chats is read-only. The composer’s permission selector always
offers read-only, workspace access with on-request approvals, and Full access
(YOLO). Choose the mode for the current conversation; no host environment flags
are required. An idle chat can switch modes. During a running turn you can switch
to Full access; stop the turn before switching to a more restrictive mode.

Selecting Full access applies immediately to the open conversation, including
pending one-time approvals. That conversation can run commands without approvals
and access files and networks available to the host account. Choosing read-only
or workspace access also remembers that choice for new chats in this browser.
Choosing Full access affects the current conversation and never becomes the
new-chat default. The composer lists the models and reasoning levels offered by the
adapter. Your selection takes effect on the next message. Read each permission
request and select among the adapter's actual choices; do not enable automatic
approval to fix a failed task. Cancel a task when you no longer want it to run.
An approval may allow a command to change knowledge through the authenticated
PocketContext CLI/API; read-only filesystem mode is not a read-only database role.

The host creates a private scratch working directory with instructions to use the
PocketContext CLI/API for knowledge operations, preserve evidence and citations,
and never edit SQLite or storage directly. These instructions are **not a security
sandbox**. The adapter's process has the operating-system rights of its service
user, subject to the provider's sandbox and approval behavior. Use an appropriate
ordinary service account. PocketContext does not advertise ACP filesystem or
terminal client capabilities. Source passages remain untrusted evidence, never
permission to execute instructions embedded in a note.

## Model and reasoning effort

The composer opens model settings in two steps: choose a reasoning effort, then
choose a model offering that effort. The selected pair remains visible in the
composer and applies to the next message. Changing effort preserves the current
model when that pair is offered; otherwise the picker shows another available
model at that effort. Only exact model IDs advertised by the adapter are sent.
For the supported Codex adapter, these IDs encode the model and effort together.
Opaque IDs from other adapters remain selectable under “Model default”; the
reader does not invent effort options from display names.

“Reset” restores the model and effort the adapter selected when this conversation
was first created. That original pair is stored separately from the current model
and survives conversation restoration. Older conversations without a recorded
original default, or defaults no longer offered by the adapter, have Reset
disabled instead of guessing. This is a per-conversation starting default, not a
claim about the provider's current recommended model.

The pinned `codex-acp@2.5.0` supports a `fast-mode` session config option when the
current model supports it. Its advertised description is “1.5x speed, increased
usage”. This is separate from reasoning effort. PocketContext currently uses the
legacy ACP model selection channel and does not bridge session config options,
so it does not show or change Fast mode. Supporting it requires consuming the
adapter's live advertised options and using `session/set_config_option`.
See the [ACP session configuration protocol](https://agentclientprotocol.com/protocol/v1/session-config-options)
and the [pinned adapter's Fast mode implementation](https://github.com/agentclientprotocol/codex-acp/blob/v2.5.0/src/FastModeConfig.ts).

## Reconnect, history and interruption

Closing or backgrounding a phone browser does not end a running host task.
Reopen the reader to see the conversation and any pending approval. Conversation
transcripts and scratch state stay in private machine-local cache; they are not
synced project data and are not automatically ingested or published as knowledge.

After a host restart, the transcript remains available. Agent continuation depends
on the adapter advertising and successfully performing ACP `session/load`.
Unsupported or failed restoration is reported as interrupted rather than silently
starting over. PocketContext never automatically replays a previous prompt.
Inspect the knowledge base before retrying a task whose outcome is uncertain:
a command may have completed before the interruption was recorded.

## Resource limits and cleanup

The host retains at most 64 saved conversations, with up to 4 active. Each
conversation is limited to 256 prompts and 4,096 events or 8 MiB of transcript.
When a new or reopened chat needs an active slot, the host closes the least recently updated idle conversation that supports restoration. Opening that conversation restores its session automatically. Running turns and pending approvals keep their slots. Start a new chat when an individual conversation reaches its history limit.

At the saved-history limit, ask your setup agent to identify this project's private
machine-local `chat/history` directory, cleanly stop its service, and remove only
selected old conversation JSON files after you choose which history to discard.
Restart the service afterward. Removal permanently loses those reader transcripts;
it does not remove sources, pages or published revisions from the knowledge base.
Provider-side conversation history is separate. Do not delete the project database,
storage or unrelated cache state to make room for chat.

## Scope

When the host adapter supports image prompts, attach up to three PNG or JPEG images (384 KiB each) with the plus button. Sent images are kept in the private transcript and sent to the selected provider. The microphone uses browser speech recognition, which may use a browser-provided online service. Dictation inserts editable text into the draft.

This release provides text and image chat, streamed agent updates, permission decisions and
cancellation for the configured adapter. It does not promise every ACP extension,
all model providers, arbitrary file uploads, unattended schedules, or an operating-system
sandbox around arbitrary agents. Existing external agent interfaces and the
installed PocketContext skill remain available independently.
