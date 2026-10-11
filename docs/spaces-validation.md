# Spaces validation — 11 October 2026

Local implementation and synthetic verification; not a deployed release.
PocketContext was built from an archive of exact pinned commit
`dc1dc6b0e88bbc46f36fa8441c8f6959bada4732` using Go 1.27.1 and CGO.
Frontend commands used Node.js 24.21.0 and pnpm 10.33.2. The current source client
was installed in a virtual environment before client validation.

## Application checks

The README backend/client checks passed, including integration, space isolation,
populated migration with injected rollback, publication review, home/properties,
account/OAuth, realtime revocation/publication, copied skill with and without
tracing, knowledge/search/ingestion/export, deployment, maintenance, entrypoint,
OAuth client, client utilities, bootstrap and workflow validation. The migration
fixture uses exact historical WikiContext `7cf5d45` from Git and no real data.
CI now includes space isolation and populated migration on both native architectures.

Checks cover company defaults and preserved legacy rows/files, optional personal
creation, independent SQL/REST/realtime/file permissions, reader roles, revoked
memberships, per-space uniqueness, cross-space reference rejection, stable scoped
search and populated restoration. Old export manifests adopt Company only; private
exports cannot reuse a company destination. Identical original bytes remain
independent sources in different spaces.

See [private-search measurements](search-benchmark.md) for the production-shaped
synthetic benchmark. These local timings do not establish deployed performance.

## Frontend and container checks

Final frontend validation passed type checking, production build, 104 unit tests
and 23 real Chromium scenarios. Client unit validation passed 73 tests.

The final native ARM64 image `wikicontext:spaces-port-final-20261011` passed build,
configuration, smoke and complete S3/Litestream graceful-stop and crash recovery.
Recovery verifies private originals, publications and memberships, with outsider
SQL, REST and protected-file access denied after both restoration paths. These
checks use isolated synthetic storage and do not establish live-provider recovery.

## Release gates still outstanding

Client source commit `69082e24ed83d8df11a5d34a734f336283aa9bee` is published on
`feature/wiki-spaces-rehearsal`. The local portable launcher now pins that commit;
an unchanged copied uv launcher passed the isolated skill integration both normally
and with tracing. The launcher/rehearsal/workflow commit and candidate image digest
remain to be published and verified as described in
[the candidate release procedure](release-candidate.md).

Native local ARM64 container checks are distinct from required remote AMD64/ARM64
release CI. Initial package-commit CI run
[38152851034](https://github.com/pocketcontext/wikicontext/actions/runs/38152851034)
passed both native ARM64 and AMD64 container jobs. Both application jobs stopped at deployment
workflow validation: package commit A contains the new CI assertions but intentionally
excludes the in-flight workflow changes. The final candidate commit must include
those changes and pass both complete suites; A is not a passing release candidate. No actual Google browser sign-in, production checkpoint, live R2
recovery, disposable PocketDeploy clone or production rollout has been performed.
Follow [the recovery and clone assessment](predeployment-recovery.md) before release.
