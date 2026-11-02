# PocketContext 0.13.0 candidate validation

These observations were made on 2026-11-02 against a locally built 0.13.0
candidate on Linux arm64. They are candidate checks, not verification of the
published release archives or installers. All projects contained synthetic data.

## Mixed versions and legacy skill migration

A scratch home, configuration directory and cache were used. A copied released
0.12.1 binary reported commit `ae2099dbf7f6162d94474ce75cbc3bfb28cee8d2`.
The new candidate reported `pocketcontext 0.13.0`.

The completed rehearsal:

1. Initialized Alpha with 0.12.1 on a free test port, ingested a synthetic note,
   and installed its legacy Claude Code global skill.
2. Used the new binary to register Alpha with its old binary and global skill
   directory (`profile add Alpha --db ... --binary ... --skill-dir ...`).
3. Initialized Beta with 0.13.0 and installed its skill and router.
4. Verified that Alpha's legacy skill was copied byte-for-byte into a dedicated
   profile directory before replacing the global skill. Its schema reference
   was retained and the registry pointed to the preserved directory.
5. Ran `profile check` successfully for both projects while they were running.
   Alpha continued using the old binary and TCP server; Beta was headless.
6. Stopped Alpha, replaced only its copied executable with the candidate and
   restarted it. A domain read was rejected because the registered binary
   version no longer matched.
7. Regenerated Alpha's skill and verified its profile. Source IDs, titles and
   SHA-256 hashes were unchanged; every column returned by `SELECT * FROM
   passages ORDER BY id` was unchanged. Alpha now ran headless.
8. Renamed Alpha on the server. Access was refused until an explicit
   `profile update Alpha` reconciled the same project instance.

Both servers were stopped after the rehearsal. This demonstrates compatibility
with the tested 0.12.1 project; it does not independently rehearse every 0.11.x
release.

## Invitation and saved-forward CLI rehearsal

`internal/client/pairing_cli_test.go` runs real candidate CLI processes using
separate scratch server/client homes, configuration directories and caches.
The relay and STUN server run locally inside the test. It can be repeated with:

```sh
POCKETCONTEXT_REHEARSAL_BINARY="$PWD/bin/pocketcontext" \
  go test -tags "$(cat build-tags.txt)" ./internal/client \
  -run TestInvitationCLIRehearsal -count=1 -v
```

The completed sequence initializes a headless server, supplies a private test
identity configured for the local relay, starts `tunnel serve`, exports an
invitation outside the project folder, and runs `tunnel join --file` on the
client. It verifies authenticated identity and SQL reads, installs the remote
skill and verifies its profile, and confirms that the server remains headless.
It then stops the join process, starts `tunnel forward --url` using the saved
address, and verifies that the stored authentication still works. Reusing the
consumed invitation is refused. Captured process output is checked for absence
of both the invitation code and address.

This is a same-machine process/relay simulation. It does not establish behavior
across two real networks or validate a human-operated file transfer.

The coordinating agent also completed the actual CLI invitation/join flow over
a public relay using two scratch Linux arm64 homes. Its checks included a
saved-forward restart and a scan confirming that command output did not expose
the address or code. Both homes were on the same machine/network; this does not
constitute a two-network rehearsal.

Separate automated regressions verify that:

- a mismatched project instance is rejected before sending an invitation code;
- successful redemption persists a token without persisting the code;
- expired invitation files are refused;
- the socket backend carries the original Host and user authentication through
  a local relay, refuses unauthenticated requests and does not inject the local
  management key;
- registry updates preserve concurrent changes, reject duplicate names and
  identity replacement, and remove registrations without deleting data;
- a newer router is not downgraded, and unrelated skills are not replaced.

## Other observed checks and limits

The coordinating agent reported a passing complete `go test ./...` run with
repository build tags on Linux arm64 and a passing bundle race test.

The agent compatibility checks must be interpreted separately from product
transport tests:

- Claude Code completed an explicitly instructed router flow involving two
  synthetic knowledge bases. An independent ambiguous-write check then asked
  for a destination without ingesting the supplied synthetic note; both source
  counts remained unchanged. Automatic skill discovery was not exercised.
- Codex's workspace-write launch failed while configuring its bubblewrap
  loopback interface (`RTM_NEWADDR: Operation not permitted`), before product
  socket behavior could be assessed.
- An unsandboxed Codex attempt read the router but was interrupted after a
  model-capacity failure. This is not a completed Codex router rehearsal.
- Antigravity was not rehearsed here.

Native Windows/macOS runtime tests, actual transfers between separate users'
terminals, two-network connectivity, and the released installers are not
claimed by this record. Record subsequent CI, release-artifact and live-site
checks separately with their actual outcomes.

## Native candidate CI

Commit `069af85f8addaea824bb81f668147528aa6a4390` passed the
[Test matrix](https://github.com/pocketcontext-labs/pocketcontext/actions/runs/41401947436)
on Linux amd64/arm64, macOS arm64 and Windows amd64. The separate
[non-publishing release rehearsal](https://github.com/pocketcontext-labs/pocketcontext/actions/runs/41401964266)
also built, inspected, tested and assembled all four native release archives.
This candidate CI does not claim published-installer verification.

The subsequent local follow-up additionally tested occupied-port headless
startup/restart, refusal to change a running project's port, and a manual-backed
guide: reading actual passages, staging and checking citations, publishing,
searching and linting while TCP remained off. Those follow-up changes are
subject to their own final CI before release.
