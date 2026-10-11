# Local ONCE rehearsal receipt

On 2026-10-11, the actual unmodified ONCE v0.3.3 restored an isolated synthetic
WikiContext database, backed it up, updated it to the spaces candidate, restored
the old backup on fresh storage, and updated that restored instance again.
All baseline and personal-space authorization probes passed. No production data,
cloud resources, existing OCI applications, or existing PocketDeploy state were
used or changed.

Reproduction: [local ONCE procedure](../deploy/rehearsal/LOCAL_ONCE.md).

## Exact inputs

| Input | Identity |
| --- | --- |
| ONCE | v0.3.3, source tag `8fc88f99174efb8d9f91aee756a1e44102c2f9fe` |
| Official Linux ARM64 binary SHA-256 | `97e32ba0fdac0ad5e6010851b306e3cb2616285a9eeb2e869ff7e71f4b442bbb` |
| Docker-in-Docker | Docker 28.5.2, `docker.io/library/docker@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac` |
| Old WikiContext image index | `ghcr.io/pocketcontext/wikicontext@sha256:a3a07948e97d9ee0a576bf2441bcbfd9c1567c879638cfa02643a0475daf0217` |
| Old ARM64 image ID | `sha256:d1acc077a07300274a40869d97bbe27de29aed0f96dad01889ce323e1952852f` |
| Candidate image index | `ghcr.io/pocketcontext/wikicontext@sha256:4173b30442993ffaec5388e2774af5bec729103e72553d5f695cbbb7d1102412` |
| Candidate ARM64 manifest | `sha256:7fd9092225a559d6e7f5333aa37c2f26498a21ecc9adc24d48f8f4167f78930a` |
| Candidate ARM64 image ID | `sha256:a6111b33dc10b1a6c440e8c1af1427c2bf89fa3b145114f4dcfd2bb1f182b59f` |
| Candidate release validation | GitHub Actions run `38153600045`, successful native ARM64/AMD64 gates and combined image publication |
| Litestream | v0.5.17 in the application images |

The prepared clone was regenerated using the server binary extracted from the
exact old registry image after an initial checksum check correctly rejected a
locally rebuilt binary. Preparation verified unchanged source/domain/original
files, revoked copied sessions, full SQLite integrity, and every prepared file's
hash. All credentials were generated for this synthetic test and retained only
in private scratch files.

## Observed lifecycle

1. Actual `once restore` loaded the prepared old archive into volume
   `once-app-wikicontext.b97110`. The old image served both historical cited
   publications and the protected original. Every historical row/column in ten
   domain tables matched the pre-migration baseline.
2. An exclusive PITR probe added two synthetic sources around a replica boundary.
   Transaction-ID and timestamp restores contained the earlier source and
   excluded the later one. Latest restore contained both. Every restored
   database passed full integrity checking; both protected originals remained
   byte-exact. No restored database writer was started.
3. Actual `once backup` created the private old-image archive. SHA-256:
   `c358c955b6fccd5291dafbb89b0de0014451e78e8b35761296596c1e77f06482`.
4. A clean 300-second-bounded stop, exit-zero proof, and actual `once update`
   migrated that same volume to the exact candidate. Historical evidence was
   unchanged. Explicit/idempotent personal-space creation, owner access,
   outsider denial across SQL/REST/search/protected files, and company-default
   writes passed.
5. Rollback stopped the candidate, removed only its ONCE registration, and kept
   its volume detached. A separate copy of the actual backup changed only
   `env.LITESTREAM_PATH` to
   `rehearsals/4cf3fd08-cf6b-44f3-97d4-58bbe91b3b37/data.db`.
   Database/original-file archive entries remained byte-identical; the original
   archive and its hash remained unchanged. Rebound archive SHA-256:
   `8fa524e8691846864fd914277eb1e7e592cc47c2ab56cd294e31febf599f3e23`.
6. Actual `once restore` created fresh volume `once-app-wikicontext.6040e9` using
   the exact old image. The old schema and historical baseline returned;
   candidate personal/company probe rows were absent. It published into the
   fresh replica path, never into the candidate's earlier replica history.
7. A second stop-first actual `once update` migrated the new volume to the same
   candidate. The full baseline and personal authorization probes passed again.
   The helper explicitly sets `restart=no` before stopping; rollback and repeat
   used this fence. The first forward stop used Docker's explicit manual-stop
   fence and proved exit zero before updating.

PITR boundary: transaction ID `0000000000000004`, timestamp
`2026-10-11T16:13:27+00:00`. The synthetic PITR receipt records earlier-only for
both boundary restores, both sources for latest, full integrity, retained
originals, and `restored_writer_started=false`.

The final candidate also passed a headless browser smoke through the actual ONCE
proxy: password login, Company selected by default, personal-space selection,
opening a private page, retaining that selection after reload, clearing private
content when returning to Company, and logout. The reproducible check is
`deploy/rehearsal/browser_smoke.mjs`; it reads only private synthetic fixture
credentials and never emits them.

## Isolation and limits

The outer engine published only `127.0.0.1:32911` (ONCE HTTP) and
`127.0.0.1:32912` (synthetic S3), had a single owned Docker-data named volume,
no host paths or host Docker socket, and 2 CPU / 4 GiB limits. The inner Docker
API used a Unix socket only; ports 2375/2376 were not listening or published.
Inner app resource controls initially failed because nested cgroup controllers
were unavailable; the successful run used empty inner resource settings under
the unchanged outer limits. This is not evidence of production per-app resource
enforcement.

This exercised real ONCE lifecycle operations and real object-backed evidence
recovery on trusted synthetic images. It does not validate production scale,
cloud IAM or storage retention policy, production credentials, public DNS/TLS,
real Google OAuth, or a live production deployment. Docker-in-Docker requires a
privileged outer container and is not a hostile-code sandbox.

The focused rehearsal helper suite passed 17 tests, including checksum rejection,
loopback isolation checks, stop failure fencing, archive traversal refusal, and
preservation of original backup/data bytes during replica rebinding.

After browser validation, the final application stopped cleanly with exit 0 and
no OOM. The owned outer engine `wiki-once-33c60524-b4e4-480a-85bc-546e09aec4c5`
and its Docker-data named volume were removed; exact-name container/volume
queries confirmed their absence. No rehearsal service remains running. Only
private synthetic scratch archives and safe receipts were retained locally.
