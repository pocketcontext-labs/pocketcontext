# Filtered SQL snapshot reuse

WikiContext pins PocketContext `4b03d2905a34d9a606cb313e118d6874e74f0548`.
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
