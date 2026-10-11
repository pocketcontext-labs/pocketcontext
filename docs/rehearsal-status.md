# Wiki spaces rehearsal status

Prepared 11 October 2026. This record distinguishes source publication, local
synthetic verification and live operations.

## Candidate source

The implementation package is published on `feature/wiki-spaces-rehearsal` at
`69082e24ed83d8df11a5d34a734f336283aa9bee`. The portable launcher now selects that
commit. The unchanged executable passed the complete synthetic skill integration,
both normally and with tracing, from an unrelated temporary directory.

The candidate workflow publishes only explicit `release-candidates/**` branches,
runs native application/container/recovery and published-launcher checks, and
assembles the exact tested image digests. It does not update `latest` or perform
production deployment. Candidate commit B is
`dc62cfef69702a86ebbd7a4045d2aa05bea8805d`; its gated publication run is
[38153600045](https://github.com/pocketcontext/wikicontext/actions/runs/38153600045).
Duplicate ordinary validation runs for B were cancelled; this candidate run retains
the complete native application/container gates plus the published-launcher check.
The run completed successfully on both AMD64 and ARM64 and published the candidate
index `ghcr.io/pocketcontext/wikicontext@sha256:4173b30442993ffaec5388e2774af5bec729103e72553d5f695cbbb7d1102412`.
Rehearsal tooling's separate native validation
[38153989824](https://github.com/pocketcontext/wikicontext/actions/runs/38153989824)
also passed. No production deployment or `latest` promotion occurred.
See [candidate publication](release-candidate.md).

## Production delivery freeze

Local synthetic ONCE testing and the isolated candidate publication do not require
a production delivery pause. On 11 October 2026, the read-only repository check
found `COLORS_PROFILE=once-v2`, no `CONTEXT_DEPLOY_PAUSED` variable, and no queued or
running main-branch workflow. No repository variable was changed.

Before a production checkpoint or main-branch cutover, set
`CONTEXT_DEPLOY_PAUSED=true` and verify that previously queued/running deployments
have drained. The workflow condition prevents subsequent deployment jobs; it does
not cancel a job already running or prevent image publication and `latest`
promotion. Pin the reviewed image digest and coordinate the checkpoint/write
fence separately. ONCE automatic updates, manual ONCE operations and other host
controllers are independent delivery paths and must also be paused or excluded
for the cutover window. Resume delivery only after the agreed recovery and
post-migration checks succeed.

## PITR retention boundary

The image pins Litestream 0.5.17. Its unchanged defaults are a 24-hour snapshot
interval and snapshot retention, with raw level-zero files retained for five
minutes after compaction. Default compaction intervals are 30 seconds, five
minutes and one hour. These are retention settings, not a guarantee that every
requested transaction or wall-clock instant remains recoverable. See the pinned
[store defaults](https://github.com/benbjohnson/litestream/blob/v0.5.17/store.go)
and [compaction levels](https://github.com/benbjohnson/litestream/blob/v0.5.17/compaction_level.go).

The pinned restore planner selects complete available LTX files whose maximum
transaction ID is at or below the requested ID, or whose timestamp is strictly
before the requested time. Compaction can remove finer boundaries. Confirm the
actual restored records and available plan; do not equate the timestamp argument
with arbitrary SQL-transaction precision. See the pinned
[restore planner](https://github.com/benbjohnson/litestream/blob/v0.5.17/replica.go).
Retain the verified pre-deployment full checkpoint, original objects and exact
old image independently of rolling replica retention until rollback is explicitly
released. Database PITR alone does not restore auxiliary files, maintenance state
or externally deleted originals.

## Reusing pocketdeploy-v1

The deployment repository identifies an existing OCI A1 host in Frankfurt with
one CPU, 6 GiB RAM and a 50 GiB boot disk. It currently declares the public Vault
and Wiki demo applications. These are configuration facts, not current capacity
or health measurements. Existing controller state, SSH trust, desired applications,
volumes and delivery authority must remain intact.

The existing ONCE proxy accepts public HTTP/HTTPS. A `.localhost` hostname does
not prevent an external caller from supplying that Host header. A production-data
clone must not be registered there without verified application-specific ingress
control.

The bounded reuse option is a separate Docker container/network and named volume,
with its port bound only to host loopback and accessed through pinned SSH. Do not
attach ONCE routing metadata. This can rehearse old-image startup, forward
migration and rollback; it does not prove PocketDeploy's managed ONCE adoption or
replacement flow. A separate SSH-only host remains the option for that full test.

Live status was blocked by an expired OCI security token. Refresh using the
configured `oracle-ampere-2` identity failed. Renew that same identity before
capacity/ownership inspection; do not substitute a different cloud account.
No live clone, production-data copy, storage provisioning or production change has
been performed.

## Required before a production-derived or shared-host rehearsal

- Renew provider authentication and verify current host health, ownership, free
  memory/disk and absence of conflicting deployment work.
- Select the loopback port, resource limits and removal deadline; verify external
  access denial independently of browser hostname resolution.
- Use a verified stopped production checkpoint and retain the untouched original.
  Prepare the clone through the isolated maintenance tool and verify its receipt.
- Supply separate files/replica storage credentials and copy only required original
  objects with their exact keys and hashes. Never start with production publishers
  or credentials.
- Test old → candidate → restored old → candidate, including company/personal
  authorization, files, searches, CLI/export and row-equivalence checks.
- Remove only the rehearsal-owned container/network/volume and separate storage
  after preserving the required receipts. Never delete the shared deployment.

## Prepared tooling and local evidence

The official checksum-pinned ONCE v0.3.3 ARM64 binary runs inside a disposable
Docker-in-Docker engine with a Unix-only inner Docker API and outer HTTP/S3 ports
bound to loopback. It has no host Docker socket or production data mounts. The
privileged engine runs trusted synthetic test code; it is not a hostile-code
sandbox. Actual ONCE old-image restore, real backup, stop-first candidate update,
rollback from the real backup into a fresh named volume and fresh replica path,
and repeat candidate update all passed. Historical rows/original bytes and
company/personal SQL, REST, file and search boundaries passed. Browser login,
Company default, personal selection/reload, stale-content clearing and logout
also passed through the actual ONCE proxy. See the
[complete local receipt](local-once-rehearsal.md) and
[reproducible procedure](../deploy/rehearsal/LOCAL_ONCE.md).

Inner per-app resource limits could not be used because nested cgroup controllers
were unavailable; the outer engine retained its 2 CPU / 4 GiB bound. This does
not validate production per-app limits, real Google OAuth, live R2/IAM, public
TLS or production scale. Production delivery configuration remains unchanged.

The real old-image application passed
[timestamp/TXID recovery](../deploy/rehearsal/pitr_test.py). At
`2026-10-11T16:13:27Z`, TXID `0000000000000004` separated two synthetic source/file
writes. Explicit TXID and timestamp restores contained the first source and
excluded the later source; latest restore contained both. All three databases
passed full integrity checks and both protected originals remained byte-exact.
Restored databases were read-only verification copies; no restored publisher was
started. This proves the tested recent boundary, not longer-term retention or
production recovery. The local safe receipt is
`/scratch/ubuntu/tmp/wiki-local-once-fixture-v2/pitr-receipt.json`.

- [Frozen checkpoint preparation](../tools/CLONE_PREPARATION.md) passed against
  both current and exact pre-spaces application/server fixtures. Tests cover
  fresh maintenance authentication, API thaw, database integrity, unchanged domain
  records/originals, revoked copied sessions and rejected credential reuse.
- [Rehearsal controls](../deploy/rehearsal/README.md) provide isolated configuration
  and a shared-host loopback container lifecycle through pinned PocketDeploy SSH.
  Seventeen focused tests cover configuration, shared-host and local ONCE lifecycle boundaries. A real synthetic Docker test
  verified loopback access, absent ONCE registration and denial from a peer bridge.
- Candidate publication tests, production workflow checks and actionlint passed.
  The complete new shared-host old-image/candidate lifecycle has not yet run
  against a prepared production-derived clone or on the actual shared host.
