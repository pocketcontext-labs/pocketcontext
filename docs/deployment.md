# Deployment procedures

WikiContext is deployed at `wiki.pocketcontext.com`, using the public image
`ghcr.io/pocketcontext/wikicontext`. See [the release record](../DEPLOYMENT.md) for
source/digests, completed checks and remaining browser verification.
The maintained `once-pocketcontext-v2` scaffold controls that hostname.
CI builds and exercises containers natively on AMD64 and ARM64. Publication on main
requires both architecture checks (configuration, smoke and S3/Litestream recovery) and
the full application test suite on both architectures. Release archive access follows
repository visibility; registry package visibility is configured independently.
CD runs only when `COLORS_PROFILE` names the configured GitHub deployment environment.

The container exposes HTTP port 80 and `/up`; mount persistent `/storage`.
The root URL serves the bundled read-only wiki reader. Its static assets are built
in a separate Node stage; the runtime remains the existing Go/Python image. Keep
the same Google OAuth redirect at the approved origin's `/api/oauth2-redirect`.
No new hostname, OAuth client or cloud resources are required for the reader.
It builds the commit in `POCKETCONTEXT_VERSION` with CGO. The pinned Go/base images
and Litestream checksums are inherited from AccountContext. Container CI must build
and verify them before any release. Run:

```sh
python3 docker/smoke.py config --image wikicontext:ci
python3 docker/smoke.py smoke --image wikicontext:ci
python3 docker/object_storage_smoke.py --image wikicontext:ci --minio-image wikicontext-minio-fixture:9e49d5e-7394ce0
```

The recovery check uses synthetic original attachments and an isolated MinIO fixture.
It restores an empty volume through normal startup and checks remote original bytes,
replica consistency, fail-closed recovery and graceful shutdown. Never run a restore
writer against the production replica beside the live instance.

## Configuration

Set `BASE_URL` to the approved HTTPS origin. Set paired
`WIKICONTEXT_SUPERUSER_EMAIL`/`WIKICONTEXT_SUPERUSER_PASSWORD` for maintenance provisioning;
ordinary operations use default `users`. Enable a separate Internal Google Web client
with `WIKICONTEXT_GOOGLE_CLIENT_ID`, `WIKICONTEXT_GOOGLE_CLIENT_SECRET` and
`WIKICONTEXT_GOOGLE_WORKSPACE_DOMAIN`. Configure both the CLI loopback redirect
`http://127.0.0.1:8765/callback` and the approved origin's `/api/oauth2-redirect`.
Enabled users with active company membership can read and edit company content;
personal spaces require their own membership. Google JIT must
verify trusted claims; public password signup stays blocked.

The documented production architecture uses private R2 bucket `wikicontext-replica`
and prefix `once-v2/wikicontext-production` for Litestream, and separate private
bucket `wikicontext-files` for source originals. Set `LITESTREAM_BUCKET`,
`LITESTREAM_PATH`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`,
`LITESTREAM_REGION` and `LITESTREAM_ENDPOINT`. Set all of
`WIKICONTEXT_S3_BUCKET`, `WIKICONTEXT_S3_ENDPOINT`, `WIKICONTEXT_S3_REGION`,
`WIKICONTEXT_S3_ACCESS_KEY_ID` and `WIKICONTEXT_S3_SECRET_ACCESS_KEY`;
`WIKICONTEXT_S3_FORCE_PATH_STYLE` defaults to `true`.
Use separate credentials for originals and replicas. Never reuse sibling replicas.
Keep credentials only in the maintained `once-pocketcontext-v2` scaffold's private
configuration. Groq transcription credentials belong to the ingestion agent.

The container requires both services and enables `WIKICONTEXT_RATE_LIMITS=true`.
There is no replication-disabled or local-originals mode. Run the pinned server
directly for isolated local application development.

## Startup and complete recovery

One Python entrypoint owns configuration validation, maintenance checks, database
recovery, source verification and process handoff. Normal `start` preserves an
existing database; when it is absent, a successful Litestream restore is required.
A missing replica fails startup instead of creating an empty application. Restore
uses a temporary location and validates SQLite before installing `data.db`.
Startup streams each referenced original from S3 and checks its SHA-256 before
HTTP starts. Missing, corrupt or unavailable evidence blocks startup.

Python then replaces itself with Litestream. Its internal `serve` child requires
successful initial `sync -wait` over the private IPC socket before replacing itself
with PocketContext. Litestream supervises the server and attempts final replication
after graceful shutdown. Keep exactly one application writer and replica publisher
per replica path. A clean exit alone does not establish complete replication.

For first installation only, run one-shot `init` with the same private environment
and empty volume that normal startup will use. It refuses an existing database or
replica, creates and verifies the initial database, then exits. For example, after
creating a dedicated local volume and private mode-0600 environment file:

```sh
docker run --rm --env-file /private/wikicontext.env \
  --mount source=wikicontext-data,target=/storage wikicontext:tested init
docker run --name wikicontext --env-file /private/wikicontext.env \
  --mount source=wikicontext-data,target=/storage -p 127.0.0.1:8090:80 wikicontext:tested
```

Do not run `init` during recovery. The ordinary `start` that follows establishes
replication before serving. An interrupted or failed initialization leaves a private
`initialization.pending` marker, and normal startup refuses that directory. Preserve
the failed volume for inspection and initialize a fresh volume; do not remove the
marker to bypass validation. The marker is removed only after successful database
creation, evidence verification and requested provisioning.

`verify` checks the existing database and remote
originals without starting a writer:

```sh
docker run --rm --env-file /private/wikicontext.env \
  --mount source=wikicontext-recovery,target=/storage wikicontext:tested verify
```

For host replacement, stop and fence the source and its deployment automation.
Restore into isolated storage, compare the recovered committed database with the
stopped source before activating the destination, and verify original bytes and
protected authenticated downloads. Keep the source volume until verification
passes. An abrupt host loss can lose unreplicated SQLite commits. Original object
retention must cover the entire database recovery history; do not delete objects
because a restored database does not reference them. A generated Obsidian vault
is not an application backup. SQLite, `maintenance.json`, and `auxiliary.db` have
different recovery needs; see the freeze procedure below.

Local tests use the pinned disposable MinIO fixture, separate synthetic original
and replica buckets, and isolated volumes. Run:

```sh
python3 tests/entrypoint.py
python3 tests/bootstrap.py
python3 tests/deploy_workflow.py
python3 docker/object_storage_smoke.py --image wikicontext:ci --minio-image wikicontext-minio-fixture:9e49d5e-7394ce0
```

### Historical local-original archives

The new container neither produces, prunes nor restores complete local-file
archives. Preserve retained archives and their historical volumes. For those
archives only, retain the old multiarchitecture image
`ghcr.io/pocketcontext/wikicontext@sha256:390cae0cadc9828bbecd63e00e88fa4019c3c0157dff37e589d85227af9d1028`
(source `1a625b7f84370abc2c4719346c27e287a7282165`, 4 October 2026).
Its `/usr/local/bin/wikicontext-backup.py restore --archive KEY` command remains
available when invoked explicitly through a Python entrypoint override. Use that
image's documented legacy replica credentials and an empty isolated destination;
never attach a recovered writer to the live replica. Check schema compatibility,
verify its database and originals, and migrate files before adopting the new
container. Removing runtime support does not authorize archive or volume deletion.

## Updates

Disable ONCE automatic updates. The maintained `once-pocketcontext-v2` scaffold
owns production provisioning and deployment configuration. Its fixed-target update
wrapper must lock, verify the exact application/image, pull, gracefully stop the
sole writer, and update only that target. Never use an overlapping ONCE update.
The older `deploy/bootstrap-wikicontext.py` is retired and always refuses execution;
it hardcoded the obsolete local-file replica target. `init` initializes application
storage only and does not provision cloud resources or change deployment policy.

For the spaces migration, review the [predeployment recovery and disposable-clone
assessment](predeployment-recovery.md) before publishing or deploying. A PocketDeploy
clone is a separate deployment; its controller checkpoint is not an application
backup, and a raw ONCE restore must not reuse production settings.

## Runtime migration freeze

The server revision in `POCKETCONTEXT_VERSION` retains the runtime maintenance API,
writable PocketBase backup support under the SQLite guard, and private search.
Verify API support before attempting a production
freeze; images predating the maintenance feature do not expose it.

An operator with an existing valid superuser token reads
`GET /api/context/maintenance`, then sends `PUT /api/context/maintenance` with
`{"readOnly":true,"expectedGeneration":N}`, using the returned generation.
Wait for `state: "read_only"` before taking the final migration snapshot. A draining
or failed transition is not a completed freeze. Ordinary users cannot change this
state, and superusers do not bypass the content freeze. Keep the operator token
private and available for the explicit unfreeze operation.

Existing authenticated sessions retain SQL queries, searches and protected file
reads. Token refresh and protected file-token requests remain available. Password
login, OAuth login/linking, signup, uploads, publication, batch writes and other
mutations are unavailable while frozen. Complete interactive login before the
freeze. This is a migration maintenance window, not permanent public read-only
hosting.

The server owns `pb_data/maintenance.json`; retain it with the active volume. On a
frozen restart, the container requires the existing database and skips
replica restore and superuser upsert. The bootstrap hook preserves stored
settings and OAuth configuration instead of applying changed environment values.
Invalid maintenance state stops startup. Do not remove or edit the marker to
unfreeze the process: send the same PUT with `readOnly:false` and the latest
generation after confirming this host remains the authorized writer.

This flag freezes application database and HTTP mutations, not the independent
Litestream process. The publisher keeps running until explicitly fenced.
Before promoting a recovered host, stop the old replica publisher and deployment
automation, and independently verify the final database and originals. Never
restart a stale source after destination writes have begun. The marker is separate
from `data.db` and is not transferred by database-only Litestream recovery; enforce
destination maintenance before making the recovered application reachable.

A cold Litestream restore supplies only `data.db`. Frozen startup also requires
PocketBase's compatible `auxiliary.db`; it cannot initialize a missing auxiliary
database while frozen. Copy that database consistently from the stopped source,
or complete a controlled bootstrap on an isolated destination before installing
the freeze. Do not expose that destination or attach a competing replica publisher
during preparation. A same-volume frozen container restart already retains both
databases and is a different operation from cold replica recovery.

Validate with synthetic isolated data:

```sh
python3 tests/entrypoint.py
python3 tests/maintenance.py --binary /absolute/path/to/maintenance-capable/pocketcontext
```

## Attribution

Container, Litestream, immutable-file backup, smoke/MinIO fixture, bootstrap and
single-writer deployment patterns were adapted from sibling AccountContext.
WikiContext changes the protected attachment collection to `sources`, tests company
sharing and private-space boundaries, and restricts operational deployment to its approved fixed target.
