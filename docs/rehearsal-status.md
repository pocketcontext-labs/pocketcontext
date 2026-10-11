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
See [candidate publication](release-candidate.md).

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

## Required before execution

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

- [Frozen checkpoint preparation](../tools/CLONE_PREPARATION.md) passed against
  both current and exact pre-spaces application/server fixtures. Tests cover
  fresh maintenance authentication, API thaw, database integrity, unchanged domain
  records/originals, revoked copied sessions and rejected credential reuse.
- [Rehearsal controls](../deploy/rehearsal/README.md) provide isolated configuration
  and a shared-host loopback container lifecycle through pinned PocketDeploy SSH.
  Eleven focused tests cover lifecycle boundaries. A real synthetic Docker test
  verified loopback access, absent ONCE registration and denial from a peer bridge.
- Candidate publication tests, production workflow checks and actionlint passed.
  The complete new shared-host old-image/candidate lifecycle has not yet run
  against a prepared production-derived clone or on the actual shared host.
