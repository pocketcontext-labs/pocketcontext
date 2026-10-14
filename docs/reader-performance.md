# Reader performance changes

WikiContext pins the published PocketContext source commit
`20843b7c888daaba55f0646dd77455b7b309d4cc` for this change. Production measurements
in the 14 October handoff are historical; no production benchmark or deployment
is part of this source adoption.

## Reader behavior

Published directories, page details, publication headers and successful manifest
validation are cached in bounded session memory. Private content is never stored
in browser persistent storage. Duplicate reads share pending requests. Logout,
identity changes and observed membership loss clear and fence cached work.

Same-space page navigation and publication refresh keep a complete displayed
view until its replacement is ready. The directory, page, links and citations
swap together. Transient errors retain the previous view with a retry action;
confirmed loss of access clears affected content. Historical publications stay
pinned. Evidence views retain their independent file authorization and expiring
token lifecycle.

Realtime subscriptions last for the session instead of restarting on every
navigation. Focus, reconnect, publication events and the 60-second interval
recheck membership and publication state. Navigation can reuse a recent membership
check. Permission reconciliation is never queued behind a slow page download.
Unchanged publications reuse their content; changed publications load in the
background. Page list batches start at 200 and shrink on response-size limits.
Successful manifest validation records the expected visible page count. Page
details record expected citation and relationship counts in the same SQL snapshot
as their revision. Separate paginated reads must match those counts before caching;
interrupted or partially authorized reads remain retryable instead of becoming
permanent incomplete cache entries.

Caches are bounded to 8 directories/8 MiB, 48 page details/16 MiB, 128 publication
headers/256 KiB and 128 successful validations. These are serialized-content
budgets with separate entry limits, not a measurement of total browser memory.
No speculative hover requests are issued.

## Server adoption

The pinned PocketContext server reconstructs safe indexes over exported values.
It also offers `snapshot.trackChanges`, which remains disabled in this application
configuration. SQL therefore retains global commit invalidation. Enabling tracked
refresh is a separate configuration adoption; read PocketContext's
`docs/filtered-snapshots.md` first.

Tracking installs private transactional table tokens and triggers through the
normal application writer. Unrelated table writes can retain snapshots; changed
tables refresh every export whose filter depends on them. Refresh uses a separate
file and verifies consistency before returning results. Concurrent conflicting
changes discard the partial refresh and fall back to a full source transaction.
Authentication changes revalidate all exports. The server never serves stale SQL
as a background-refresh shortcut and does not share snapshots across identities.

First installation requires a writable maintenance state; frozen startup only
verifies already installed tracking. Include installation, ordinary record writes,
revocation, rollback, complete restore and frozen restart in release rehearsals.
Tracking uses table granularity, so it does not yet isolate writes by space or
copy only appended rows. Direct private FTS search retains its independent fresh
authorized source reads and content-fingerprint cache.

## Measurement

Use the isolated benchmark with the previous server, then the adopted server:

```sh
python3 tests/search_benchmark.py --binary /absolute/path/to/previous/server
python3 tests/search_benchmark.py --binary /absolute/path/to/adopted/server --track-changes
```

The script reports a fresh identity's first SQL request before any warmup, repeated
warm requests, and the first read after a controlled visible REST write. Direct
private-search timing is separate. HTTP elapsed time includes transport and
execution; it does not isolate snapshot construction. For attribution, use the
existing opt-in trace spans (`snapshot.wait`, `snapshot.acquire`, `snapshot.build`,
`snapshot.copy`, `snapshot.indexes` and query execution) without SQL-text capture.

The server's `BenchmarkSnapshotWikiJoins` additionally exercises real-shaped
manifest, page, citation and relationship joins. Browser regression tests verify
request counts and view behavior without asserting hardware-dependent latency.

Local ARM64 measurements on 14 October used 350 pages, 800 revisions, 190
publications and 6,400 passages. Both runs used the candidate server and three
warm samples; these are illustrative development timings, not production claims.

| SQL count request | Default invalidation | Tracked refresh |
| --- | ---: | ---: |
| First read by a fresh identity | 249 ms | 246 ms |
| Warm median | 1.41 ms | 1.45 ms |
| First read after a visible run creation | 249 ms | 113 ms |

The separate server join benchmark measured six representative warm reader
queries at 86–88 ms without indexes and 3.16–3.36 ms with indexes, with 2.2% more
snapshot storage. Building indexes has a cost; compare complete workloads and
inspect cold build spans before changing timeouts.

## Validation record

The local candidate passed PocketContext's full race-enabled test suite and
build, targeted tracking/index/privacy tests, and all four required DealContext
checks. WikiContext passed all 35 documented backend/client commands, including
the traced skill and mocked Gemini handoff. Server-based WikiContext commands
used a temporary configuration overlay to enable tracking; maintained application
configuration was not edited.

The reader passed type checking, 133 unit tests, a production build and the full
31-scenario isolated browser suite. Seven focused browser checks passed again
after the final cache accounting and membership coalescing fixes. They cover
retained content, atomic publication swaps, warm request counts, revocation during
pending work and identity changes. Mobile and keyboard checks are included in
the full browser suite. The final seven focused scenarios and actual reader SQL
integration also passed against the previous server pin, `4b03d2905a34d9a606cb313e118d6874e74f0548`.

An additional 49 compatibility commands passed across PeopleContext,
AccountContext, ChatContext, NotifyContext, ObserveContext, VaultContext and the
PeopleContext, WikiContext and VaultContext demos: 36 with default invalidation
and 13 privacy/lifecycle checks with tracking enabled. Those repositories remain
unchanged. All application fixtures used synthetic isolated databases.

Tracking-enabled object-storage integration and complete Litestream recovery also
passed against a disposable loopback MinIO fixture. Recovery compared the full
database schema and rows, deleted the source, and verified protected original
bytes and private search on the restored instance. A server race test separately
checks tracking metadata preservation, frozen reopening, subsequent writes and
revocation after restore.

The native recovery fixture normally starts the reader before Litestream's first
initialization. Tracking correctly rejected the resulting schema change. The
successful drill used a temporary fixture overlay to initialize replication and
complete `litestream sync -wait` before starting the reader, matching the existing
production entrypoint. This creates Litestream's internal tables before tracking
captures the schema; no schema-validation checks were relaxed.

The server source is published and pinned here. Native candidate-image
configuration, smoke and complete restore checks remain release gates. The
application change is prepared on `feature/reader-performance`; merging to main
invokes the existing guarded image-publication and deployment workflow.
Production measurement and tracked-refresh configuration adoption remain separate.
