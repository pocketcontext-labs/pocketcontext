# Filtered SQL snapshot reuse

This is the 11 October 2026 release record, which adopted PocketContext
`4b03d2905a34d9a606cb313e118d6874e74f0548`. See the
[reader performance changes](reader-performance.md) for the current adoption.
SQL snapshots are reused per authenticated requester and invalidated on every
committed source-database change. Membership and account changes therefore
invalidate cached visibility. Each request still authenticates. Search retains
its existing independent authorization and index cache.

Retention is bounded by the configured snapshot concurrency limit and existing
per-snapshot size limits. Concurrent reads for one requester share construction.
Active readers finish on their immutable snapshot; a request beginning after a
commit obtains current data. Clock-dependent visibility policies bypass reuse.
There is no refresh endpoint or client-visible snapshot session.

Ingestion keeps existing uniqueness constraints and optimistic revision checks.
Committed-but-lost responses can be reconciled through fresh SQL reads. Publication
conflicts still require rereading and reassessing in a new run.

## Validation

The server race suite and build passed. WikiContext passed all 36 backend/client/
recovery-tool commands, frontend typecheck, 104 unit tests, build and the final
23-scenario browser run. New HTTP ingestion tests cover simultaneous identical
uploads, committed response loss and incompatible extraction conflicts.

One initial browser run lost five loaded search results on back navigation.
Targeted retries passed on both baseline and candidate, then the full candidate
suite passed. No speculative UI change was made.

Active filtered applications and both demos passed synthetic privacy and lifecycle
checks; DealContext passed integration, skill, deployment and intake. Older sibling
schema fixtures needed the already-existing `maxConcurrentPerRequester` field;
older tracing assertions needed to allow warm requests without construction spans.
Those adjustments were tested in disposable copies; sibling pins are unchanged.

A local ARM64 synthetic corpus (350 pages, 3,500 revisions, 7,000 passages, about
27 MiB text) measured warm SQL reads at 4.2 ms versus 217 ms before caching.
Cold and post-commit builds remained about 210 ms. This is server benchmark evidence,
not a live browser measurement. Frequent writes still incur rebuild costs.

## Production release — 11 October 2026

[Release CI](https://github.com/pocketcontext/wikicontext/actions/runs/38165758525)
passed native AMD64/ARM64 application, browser, container configuration/smoke and
complete original-file/Litestream recovery gates. Automatic deployment was paused;
image publication completed and its deployment job was skipped.

Deployed application revision: `e098938a1172fc956ebab8afff6f30ada79dd4bd`.
Immutable image:
`ghcr.io/pocketcontext/wikicontext@sha256:60ea1b412aacab10b5f5644a386cc9ef4594a89d79a9eaed895959872dc4c93b`.

A fresh generation-9 frozen checkpoint retained both databases and sidecars,
complete originals, ONCE backup and verified old image. A separate Litestream
restore matched the stopped source logically. The encrypted checkpoint was
uploaded, downloaded again, decrypted using the VaultContext-held key, and fully
verified. Its recovered old image started with networking disabled and no replica
publisher; the database and frozen generation remained unchanged.

Checkpoint: `196607b4-8d7a-4036-93c8-182b0025ef9c`, in private R2 bucket
`wikicontext-checkpoints`, prefix
`once-v2/wikicontext-production/checkpoints/196607b4-8d7a-4036-93c8-182b0025ef9c/`.
Retain until explicitly released, with no automatic expiry. The earlier spaces
checkpoint remains separate and unchanged.

The candidate's private frozen startup preserved the complete logical database,
including schema, accounts and memberships. Public replacement remained frozen
while verifying exact settings/environment/resource preservation, one writer,
ordinary authentication, Company access, SQL schema, search, an existing page,
protected-original hash, health and reader shell. Writes resumed at generation 10.
Resource limits remain 512 MiB memory and one CPU.

Representative live requests against the same 349-page corpus measured:

| Operation | Before | After, warm |
| --- | ---: | ---: |
| Page data requests, including related evidence | 13.413 s | 1.142 s |
| Skill search | 4.991 s | 0.433 s |
| Direct search endpoint | 0.083–0.086 s | 0.084–0.093 s |

These are individual HTTP/client measurements, not full browser rendering or a
load-test guarantee. Cold reads after commits still rebuild snapshots.

After acceptance, the deployment's owned pending fence was removed and the CD
pause variable returned to its original absent state. ONCE automatic image updates
remain disabled; guarded CI delivery is enabled. Transient local plaintext copies
and the restored key file were removed; the encrypted checkpoint and receipts,
root-private stopped snapshot, and independently held Vault key remain retained.
