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

Sessions start in read-only mode with on-request approvals. There is no phone
control for switching to full access or changing models. Read each permission
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
Reaching a limit stops further work. End an active conversation to free an active
slot; start a new conversation when a conversation reaches its own limit.

At the saved-history limit, ask your setup agent to identify this project's private
machine-local `chat/history` directory, cleanly stop its service, and remove only
selected old conversation JSON files after you choose which history to discard.
Restart the service afterward. Removal permanently loses those reader transcripts;
it does not remove sources, pages or published revisions from the knowledge base.
Provider-side conversation history is separate. Do not delete the project database,
storage or unrelated cache state to make room for chat.

## Scope

This release provides text chat, streamed agent updates, permission decisions and
cancellation for the configured adapter. It does not promise every ACP extension,
all model providers, mobile file uploads, unattended schedules, or an operating-system
sandbox around arbitrary agents. Existing external agent interfaces and the
installed PocketContext skill remain available independently.
