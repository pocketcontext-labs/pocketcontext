# Private-search rehearsal — 11 October 2026

Synthetic benchmark against PocketContext `dc1dc6b0e88bbc46f36fa8441c8f6959bada4732`
using the spaces implementation. No production records were copied. The approximate
shape came from authenticated aggregate counts: 350 pages, 800 revisions, 190
publications, 4.24 million revision-body characters, and 6,400 evidence passages
with 2.592 million characters. The local database was 14,282,752 bytes.

Seeding took 51.53 seconds. Publication median/max was 110.64/178.34 ms.
A filtered SQL count snapshot took 237.02 ms. Three-query search medians were
23.99 ms (topic token), 23.50 ms (broad token) and 20.23 ms (no match).
The first scope build/query took 23.99 ms. Twelve requests from four distinct
company readers completed with median 35.32 ms and maximum 48.05 ms, with no
failures. Current 32 MiB snapshot and 8 MiB per-index limits accommodated this
synthetic corpus. These are observations on the shared ARM64 development host,
not a production latency or capacity guarantee; repeat on the proposed clone.

Reproduce with the installed source client and exact pinned binary:

```sh
python3 tests/search_benchmark.py --binary /absolute/path/to/pinned/pocketcontext
```

The shared-index results below are historical and describe a different ranking
and indexing contract. They do not validate private search.

---

# Published-page search benchmark

Measured on 2026-09-28 using synthetic HTTP-created WikiContext records and the
scoped PocketContext search implementation. This establishes bounded operation
at the current 10,000-page budget; it does **not** establish a general FTS speedup
or real-world editorial relevance.

## Fixture and methods

The final read measurements use 10,000 selected pages, 14,000 distinct indexed
published revisions across three publications, and 2,000 unindexed drafts. Twenty
synthetic topics have varying repeated paragraphs, titles and summaries. Search
selects publication 3 and returns at most 20 hits. The server uses the configured
8/3/1 title/summary/body weights and its normal 2-second request timeout.

Three baselines run through authenticated local HTTP:

- Client lexical scan: fetch manifest-selected title/summary/body in batches of
  200, count weighted literal substrings locally, then return the top 20.
- Ranked SQL: one manifest-scoped SQL request counts the same weighted literal
  substrings and returns 20 IDs, scores and bounded 240-character excerpts.
- Scoped FTS: one search request, including normal source/index/scope validation,
  BM25 ranking and excerpts. This includes the final scope/configuration-bound
  opaque generation token.

The table gives medians of three sequential repetitions on a shared development
host. These are request-level wall times, including authentication, HTTP and JSON.
They are not isolated SQLite timings, cold-cache measurements or percentile
estimates. Client scans transfer considerably more data; browser display metadata
hydration is excluded from every result. FTS excerpts and SQL prefix excerpts
also have different semantics.

| Query | Client scan | Ranked SQL | Scoped FTS |
| --- | ---: | ---: | ---: |
| Topic (`topic3`) | 2,081.85 ms | 121.55 ms | 169.15 ms |
| Broad (`evidence`) | 1,955.57 ms | 188.90 ms | 223.63 ms |
| Missing (`nonexistentterm`) | 1,760.74 ms | 109.93 ms | 132.37 ms |

FTS was slower than the single-query SQL baseline for all three queries in this
final run. It was faster than transferring all text to the client. Its adoption
benefits here are a common ranked-search contract, token matching, excerpts and
consistent publication-scoped pagination. Index validation still scans the
historical corpus for every request; performance should be rechecked as history
or document lengths grow.

Twelve broad-query requests with four concurrent readers had a median of 331.71 ms
and a maximum of 441.23 ms. All completed within the configured timeout. This
small sample is not a sustained-load or tail-latency guarantee.

## Relevance and consistency

Across all 20 exact topic queries, FTS precision at 20 was 100%. Ranked substring
SQL was 100% on 19 topics and 10% on `topic1` (95.5% mean). The latter matches
`topic10` through `topic19` as substrings; FTS treats these as different tokens.
This is an intentional matching-semantics distinction in a simple labeled
fixture, not evidence that BM25 gives better editorial ordering or that these
weights are optimal. No human relevance judgments or real wiki records were used.

The fixture confirms that drafts do not become search hits. Rebuild and publication
rotate application state, causing old pagination tokens to fail with 409. The
separate search integration suite covers historical archives, failed publication
and rebuild rollback, malformed manifests, protected maintenance and restored
search results under the final token contract.

## Maintenance and storage

An earlier phase of the same fixture had 12,000 indexed published revisions:

| Operation | Observed wall time |
| --- | ---: |
| Create 10,000 pages and initial revisions via REST batches | 174.41 s |
| Publish the initial 10,000-page manifest before FTS adoption | 8.98 s |
| Publish 2,000 replacement revisions before FTS adoption | 4.09 s |
| Migrate/backfill, including setup and server startup | 1.97 s |
| Rebuild the 12,000-revision index transactionally | 0.97 s |
| Publish a further 2,000 replacement revisions with FTS | 3.95 s |

The two replacement-publication timings occur at different points in the fixture
and under shared-host noise. They do not establish that indexing reduces
publication cost. Rebuild holds a write transaction; larger histories warrant a
maintenance window and workload-specific measurements. Publication exceeds the
SQL search timeout in this fixture because it is a separate write operation.

A verified complete backup of the final 14,000-indexed-revision fixture occupied
51,064,832 database bytes. Read-only `dbstat` page accounting on that synthetic
backup attributed 19,783,680 bytes to FTS tables and 8,192 bytes to the state table
and its primary-key index. These are allocated database pages, not peak memory,
network transfer, or the entire migration overhead. Residual WAL files make raw
main-file size comparisons unreliable; source records also grow between phases.

## Reproduce

Use the tested scoped server binary. The default run uses an isolated temporary
database and removes it afterward:

```sh
python3 tests/search_benchmark.py --binary /absolute/path/to/pocketcontext
```

To retain a synthetic fixture for final-binary read measurements:

```sh
python3 tests/search_benchmark.py --binary /absolute/path/to/pocketcontext \
  --fixture /absolute/path/to/new-empty-synthetic-fixture --output /tmp/initial.json
python3 tests/search_benchmark.py --binary /absolute/path/to/pocketcontext \
  --measure-existing /absolute/path/to/new-empty-synthetic-fixture/app/pb_data \
  --output /tmp/final.json
```

Only the benchmark's marked synthetic directories may be remeasured. Never point
these commands at an application's data directory. Use a private disk-backed
`TMPDIR` if the shared temporary filesystem cannot hold complete backup copies.
The final read measurements above used that arrangement. Container smoke and
populated-restore gates separately verify published search and generation-based
pagination alongside protected originals.
