## Company spaces and authentication — 11 October 2026

Production runs source `d70b40eb479d16b809dac4b2327b067324089409`, image
`sha256:f99620c32c21540e5dddb2754d9fd03e822054b2518a5d54a274cc45b85e7c26`.
Existing knowledge and access remain in Company; personal spaces are optional.
The [cutover record](docs/production-spaces-cutover.md) records the verified
complete encrypted R2 checkpoint, isolated migration, live ordinary-user checks
and restored CD. The checkpoint remains retained until explicitly released.

## Current container recovery contract

The maintained deployment procedure is [docs/deployment.md](docs/deployment.md).
Production's documented 5 October migration uses S3 originals in `wikicontext-files`
and Litestream in `wikicontext-replica` under `once-v2/wikicontext-production`.
The entries below are historical release evidence; their local-original archives,
old bucket names and bootstrap procedures do not describe the current runtime.
The single Python entrypoint refactor is not a deployment record and makes no
claim that the new image has been released or installed.

Local validation on 6 October 2026 passed against the unchanged server pin
`976ddf71a4734530adefe4a56633658a0894b449`: all documented backend commands,
37 Python entrypoint tests, 10 file-migration tests, and the synthetic search
benchmark. Node 24.15.0 and pnpm 10.33.2 passed typecheck, 57 unit tests,
production build and all eight actual-server browser scenarios.

The ARM64 image built and passed Docker's build check, configuration and smoke
tests, S3 integration, standalone Litestream recovery and the expanded actual-image
MinIO recovery drill. Checks included stopped-source database equivalence,
empty-volume entrypoint restore, confirmed-write crash recovery, frozen restarts,
missing replicas, unavailable/missing/corrupt originals and failed-restore cleanup.
All storage was synthetic and isolated. AMD64 execution remains a native CI release
gate; it was not run locally. No production deployment or cloud changes were made.

## Packaged CLI and opt-in tracing — 4 October 2026

Deployed source `1a625b7f84370abc2c4719346c27e287a7282165` at `https://wiki.pocketcontext.com`.
Image `sha256:390cae0cadc9828bbecd63e00e88fa4019c3c0157dff37e589d85227af9d1028`; server pin `91d7ef14b02a476b2212aa80b365b6c024a19c15` is unchanged.
The standalone `wikicontext` uv launcher pins package `1561039568946564b3027a51be0e8de596683b9b`.
Old script entry points are removed; no compatibility wrappers are provided.

[Release CI](https://github.com/pocketcontext/wikicontext/actions/runs/37193946894) passed application, browser, container configuration,
smoke and populated recovery gates before publication. Copied remote launchers
passed isolated workflow and tracing tests. A predeployment backup was verified;
the update used the gated CI locked wrapper. Exact runtime revision, one writer,
existing resource settings and disabled automatic updates were verified.
Public health and anonymous SQL-schema rejection passed; the installed CLI's
live schema check passed. Eight source apps passed a live `SELECT 1` capture
with paired client/server traces and SQL text excluded. No business records
were created; diagnostic traces were uploaded to ObserveContext.

VaultContext was excluded from this migration. A separate VaultContext release
was observed during the window and was left untouched. Five other unrelated
containers retained their IDs, images and settings. The private scaffold records
the coordinated release matrix and verification evidence.

# WikiContext deployment

## Live reader release

The read-only browser reader is deployed at https://wiki.pocketcontext.com/.
Released source: `ca55c6e0c7658a522f7a7a9af74568128a1726f3`.
PocketContext remains pinned to `a92b0de5e1b66b6d3b6135b90092d2d6da5f7cc8`.
The multiarchitecture image digest is
`sha256:57ffa4d4d1d63175ddb0bb892dddc76ceed3b396f2d98204791116db8ff58055`.

[Release CI](https://github.com/pocketcontext/wikicontext/actions/runs/36353967650)
passed application, authentication, publication realtime, reader type/unit/browser,
container smoke and complete recovery checks on AMD64 and ARM64 before publishing
the image and deploying through the locked graceful-stop wrapper.
[Source-pinned image archives](https://github.com/pocketcontext/wikicontext/releases/tag/image-ca55c6e0c7658a522f7a7a9af74568128a1726f3)
are available with checksums. Local validation passed all 19 backend commands,
18 frontend unit tests and the real-browser suite against synthetic isolated data.
The browser suite covers publication updates, draft exclusion, pinned history,
reconnect, protected original downloads, revoked sessions, hostile Markdown,
keyboard focus and mobile layout.

The pre-deployment backup `before-wiki-reader-20260927215636.zip` was created and
its ZIP integrity and database entry verified. Post-deployment inspection confirmed
the released revision and server pin, one writer, persistent storage, one CPU,
512 MiB and disabled automatic updates. Every sibling container ID was preserved;
all eight application health endpoints, the website and both demos returned 200.

Production browser checks passed desktop/mobile login layout, keyboard access,
CSP/no-store headers, anonymous SQL rejection, and byte-for-byte equality of
served assets with the tested build. The initial Google authorization URL uses
the registered callback and S256 PKCE. An interactive production Google login
remains unverified; authenticated reading was exercised with synthetic identities
in isolated browser tests. No production knowledge records were changed.

## Initial release record

Deployed on 25 September 2026 at https://wiki.pocketcontext.com through the existing ONCE host. The application starts empty; the prior Markdown wiki has not been migrated.

| Item | Verified value |
| --- | --- |
| Public source repository | https://github.com/pocketcontext/wikicontext |
| Released application source | `3269b646190809e6b19e985a1386787beea7813b` |
| PocketContext pin | `381f81042586afdaa6498b8c0e2a78229a55bdff` |
| Public image | `ghcr.io/pocketcontext/wikicontext:latest` |
| Multiarchitecture image digest | `sha256:73084165c8631653c148e47d1ea0da773fb6c704306fe6efaaafa55fc72816e0` |
| ARM64 platform manifest | `sha256:b6dfd1cbf798cc78200e552b6f4233d6cd0e92c2cd4b57a044068134d54e0589` |
| AMD64 platform manifest | `sha256:21fdd2b03546e0696c40c2ac9e82afa6edf811f7b53d1679963bf7b81c383bf2` |
| Release CI | [36191718062](https://github.com/pocketcontext/wikicontext/actions/runs/36191718062) — passed |
| Source-pinned image archives | [Release](https://github.com/pocketcontext/wikicontext/releases/tag/image-3269b646190809e6b19e985a1386787beea7813b) |
| Production resources | ARM64, one CPU, 512 MiB, persistent `/storage`, one writer, automatic updates disabled |
| R2 backup | Dedicated `wikicontext-backup` EU bucket; prefix `once-pocketcontext/wikicontext` |

## Release and live checks

All application validation commands passed on AMD64 and ARM64 in CI. Each architecture passed container configuration, startup/persistence, populated crash restore and graceful-stop recovery before publication. Anonymous registry requests verified the multiarchitecture manifest, both platform manifests, configurations and all layers; the image can be pulled without credentials. Package visibility was verified independently of repository visibility.

Scaffold build/dry-run passed. A targeted DNS plan created only the proxied WikiContext A record at the existing host; authenticated record and public DNS checks passed. No compute/SMTP convergence or sibling replacement was performed.

HTTPS health, maintenance login, the existing default `users` collection, OAuth-only signup rule, dedicated Google provider/client, anonymous schema/SQL rejection and initially empty knowledge collections passed. The server environment matches the configured Workspace domain and dedicated OAuth/R2 settings. No production test user or knowledge record was created. One writer, resource limits, persistent storage, image revision/architecture and disabled automatic updates were checked after the controlled update. Sibling container IDs, running state and deployment keys were preserved; public health checks passed for the sibling applications and demos.

Google Workspace JIT is configured for `pocketcontext.com`: verified first login creates an ordinary shared-workspace identity. The client is separate from sibling clients; a Google invalid-code credential probe returned `invalid_grant`. This does not prove the provider audience, redirect configuration or a successful human login. **A real Google Workspace browser sign-in remains unverified.** Live Groq transcription was not exercised by deployment.

## Backups and recovery

Dedicated R2 write/read/list/delete probes passed and the temporary probe was removed. Nonempty database replicas, a complete database/original archive and its latest-complete pointer were verified.

An isolated read-only recovery drill fetched the complete production snapshot, verified the database/original manifest, then started a disposable loopback-only server with replication disabled. An ordinary synthetic identity created only in that disposable database authenticated and queried the allowed SQL schema; auth-table access was rejected. Complete restore plus hash verification took **1.48 seconds** for the initial empty knowledge base. This is not a populated-production recovery benchmark; populated-original recovery is covered by the native container gates. The drill container and temporary restored storage were removed. No second writer used the production replica.

Complete snapshots run shortly after startup, hourly by default, and on graceful shutdown. Actual recovery-point age includes upload time and failures; monitor the latest successful complete pointer. Database replication alone does not recover newer missing originals. Follow [recovery instructions](docs/deployment.md) and preserve a single production writer. A generated Obsidian vault is not a complete application backup.

## Deployment control

A dedicated restricted key invokes `/usr/local/sbin/deploy-wikicontext` with no command arguments. Its root-owned wrapper locks, pulls, gracefully stops the exact current writer, verifies clean exit, and updates only WikiContext with automatic updates disabled. A controlled update from the initial pinned image to the verified `latest` image passed. Sibling keys remain intact. No temporary bootstrap key or payload was used.

The GitHub environment `once-pocketcontext` holds the dedicated SSH secret and pinned host identity. `COLORS_PROFILE=once-pocketcontext` enables later gated CI deployments. Registry credentials supplied by CI exist only in a private temporary Docker configuration; the tested image also supports anonymous pulls.

Operator, Google and R2 credentials and the dedicated key reference remain only in the scaffold's ignored mode-0600 `.envrc.private` under `COLORS_PAR_APP_WIKICONTEXT_*`. Never print full ONCE labels, environments or private backup contents.

## Rollback

Acquire `/run/lock/deploy-wikicontext.lock`, stop the sole writer gracefully, and preserve its volume. Use a tested earlier image only after checking schema compatibility. For incompatible schema changes, restore a selected complete backup into isolated storage, verify it, and choose a deliberate replica strategy before switching traffic; do not connect a restored writer to the active production replica. The normal fixed-target wrapper is an update command, not a general rollback interface. Repeat auth, original-byte, health, image and sibling checks after recovery.
