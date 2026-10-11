# Recovery checkpoint and disposable-clone assessment

Assessed 11 October 2026 for the Company/optional-personal-spaces migration.
This is a source-based deployment design, not evidence of a production backup,
cloud provisioning, copied production data or a completed live rehearsal.

## Recommendation

Rehearse the exact old-image → new-image migration on a private, disposable
PocketDeploy installation before production. Capture a named, verified
pre-migration recovery set. Retain Litestream for continuous SQLite PITR, and
retain all original evidence independently. Test restoration of the old state and
old image, not just successful startup of the new schema.

A useful recovery receipt identifies the source image digest, application/server
commits, capture UTC time, database hashes/integrity results, publication sequence,
original count/hash manifest, auxiliary database, maintenance state, off-host
artifact location and successful restore/comparison. Do not include credentials,
raw ONCE settings, content or file tokens in the receipt.

## Backup choices

| Mechanism | Included | Limits and appropriate use |
| --- | --- | --- |
| Litestream 0.5.17 | Continuous replica of `data.db`; restore by timestamp or inclusive transaction ID | Does not capture `auxiliary.db`, `maintenance.json`, application image/configuration or R2 originals. Normal Wiki startup restores latest, not a chosen checkpoint. Use an explicit isolated restore and compare it with the stopped source. |
| PocketBase v0.40.4 backup | ZIP containing consistent `data.db` and `auxiliary.db` copies plus other included `pb_data` files/local originals | Remote S3 originals are excluded. Not continuous PITR. Backups may live locally or in separately configured backup S3 storage. Useful before freeze or under a separately enforced ingress fence. |
| Basecamp ONCE backup | Gzip tar of persistent application volume plus application/legacy volume settings | External originals and the image itself are excluded. Archive is unencrypted and contains credentials. Useful as a stopped-volume/configuration checkpoint, retained off-host with private access. |
| PocketDeploy `vault-save` | Controller state, private bindings and SSH authority | Does not back up application databases or originals. Needed separately to recover deployment control. |

### PocketBase findings

The pinned PocketBase source uses `VACUUM INTO` for each database and copies other
included files into a ZIP. It excludes its backup/temp/notification/certificate
cache directories and explicitly does not fetch S3 collection files. Creation is
superuser-only through `POST /api/backups`, which rejects existing names and calls
backup creation synchronously before returning HTTP 204. Verify artifact availability
and integrity afterward, including eventual visibility on backup S3 storage. The
underlying core method can overwrite an archive; use a unique name regardless of
which interface invokes it.

PocketContext's maintenance controller intentionally refuses `VACUUM INTO` when
frozen; its tests cover both writable backup success and frozen refusal. HTTP
backup creation is also a mutation. Therefore **do not prescribe PocketBase
backup creation after the read-only freeze**. Either create and verify it before
freezing, then account for intervening writes, or use a stopped-volume checkpoint
as the exact cutover boundary. Avoid weakening the maintenance guard for backup.

Built-in restore replaces `pb_data` and restarts the current process. It does not
coordinate the independent Litestream publisher, select the old application
image or restore R2 originals. Do not invoke it in place beside a running
production replica publisher for this schema rollback. Restore into isolated
storage and deliberately promote one authorized writer instead.

A synthetic isolated probe against the pinned server successfully created a
PocketBase backup containing integrity-checked `data.db` and `auxiliary.db`,
including a company-space record, and confirmed HTTP 503 with no new archive
when creation was attempted during maintenance freeze. This does not establish
remote-original inclusion or a live production backup.

Source references: pinned PocketBase `core/backup_create.go`,
`core/backup_restore.go`, `apis/backup_create.go`; pinned PocketContext
`internal/database/maintenance_test.go`; Wiki `docker/entrypoint.py` and
`tests/object_storage_recovery.py`.

### ONCE findings

The [published ONCE manual](https://wiki.pocketcontext.com/#/page/once-cli-manual?publication=y71atcxc2gk1wp5)
was read together with its cited source passages, including
[backup implementation evidence](https://wiki.pocketcontext.com/#/passages/cnyfbcdsw9mstlp).
The local Basecamp ONCE checkout matches its source revision
`864ec7c61ebeb11ede79dbe6eef1beb5b4cbe19f`. This does not establish the binary
installed on any live host. PocketDeploy separately pins ONCE v0.3.3; verify its
actual backup behavior in the disposable rehearsal.

`once backup HOST NEW_FILE` creates a new private archive and refuses overwrite.
It runs `/hooks/pre-backup` if present. Successful hooks permit copying without
pause; absent/failing hooks cause a running container to be paused during copy.
Wiki supplies no such hook. Pausing is not a remote-original backup or proof that
Litestream's last writes reached remote storage. For the exact release checkpoint,
prefer capture after a clean, fenced stop; test the installed ONCE path on the clone.

`once restore FILE` restores recorded configuration into a newly named application,
using the recorded hostname/image reference, with an optional post-restore hook.
It has no host/image override flags in the reviewed source and can pull different
bytes from a mutable image tag. It is not an in-place rollback. A raw production
archive may recreate production credentials, endpoints and hostname; **do not run
it unchanged as a test-clone shortcut**. Prepare clone-specific configuration and
extract/restore only the reviewed application state through an explicit procedure.

ONCE's automatic backup loop checks every five minutes, backs up roughly daily and
trims matching files after 30 days. PocketDeploy currently rejects `auto_backup:
true` and `auto_update: true`, so enabling that loop is not supported by the chosen
platform. Manual backup is a separate operator action under the deployment lock;
it is not automatically invoked by PocketDeploy.

## Exact predeployment checkpoint

1. Record the actual old image digest, release/server pins and maintenance support.
   Disable/drain competing delivery and automated updates. Keep an existing private
   operator session for maintenance; interactive login is unavailable while frozen.
   A durable restore also needs a reviewed fresh maintenance-authentication path:
   saved bearer tokens can expire. That bootstrap remains a prerequisite, not a
   reason to delete the maintenance marker or retain an indefinitely valid token.
2. Freeze through the authenticated maintenance API and wait for `read_only`.
   Gracefully stop the sole application/replica publisher and prevent restart.
3. Retain the stopped volume. Capture both SQLite databases, their recovery-relevant
   sidecars if any, maintenance marker and required local state. A manual ONCE archive
   is a candidate packaging mechanism, subject to the installed-version rehearsal.
   Never copy only a live `data.db` while excluding its WAL.
4. Restore Litestream to a separate empty location, selecting the recorded boundary
   with `-timestamp` or `-txid` when appropriate. Verify integrity and logical
   equality with the stopped `data.db`. A timestamp or successful process exit is
   not proof that the last committed transaction replicated.
5. Independently retain/verify every original referenced by that database. Preserve
   all production objects for the full rollback window. Keep recovery artifacts
   outside the source host under private access; protect credential-bearing archives.
6. Record success only after a complete isolated restore, content comparison and
   original hash verification. Keep the old image available by digest.

A frozen marker intentionally prevents schema writes. Do not delete or edit it to
make the new migration run. An application-aware rehearsal must restore the old
image behind a network fence, use its maintenance API for the explicit thaw, then
stop it and run the new migration while ingress and other writers remain fenced.
For production, keep that fence in place across thaw/stop/replacement and verify the
new application before admitting traffic. New schema migration is not a normal
frozen-reader restart. Rollback after admitting new writes requires an explicit
plan for those writes; restoring the checkpoint discards them.

## Disposable PocketDeploy clone

Reviewed PocketDeploy source `950cfa39c0403ff920f3e92620824ed451292943`, README,
configuration validation, application delivery and recorded provider verification.
It supports OCI, DigitalOcean and GCP on existing networks, fresh deployment
identity/state/keys, digest-pinned ONCE apps, stop-first replacement, private bindings,
safe status evidence and owned-resource deletion. It has **no application clone or
restore command**, and no automatic rollback after a possible migration.

Use a fresh deployment directory/profile/UUID; never restore production controller
state as the clone. Keep production under its existing controller. Select the
provider/account/region, existing network, bounded machine/storage size, hostname,
access restriction and teardown deadline explicitly before provisioning.

| Boundary | Rehearsal requirement |
| --- | --- |
| Host and state | Dedicated disposable compute and volume, new controller identity/keys; no production ownership transfer. |
| Network | Restrict access to the test operators. Check inherited network rules, not only the new firewall. PocketDeploy's public TLS/HTTP verification needs a reachable verifier path; do not assume SSH-only access works unchanged. |
| Database | Restore the verified old checkpoint; no production SQLite mounts or replica publisher. Compare before applying any deliberate clone-only settings. |
| Replica | Dedicated clone bucket/prefix and independent credentials. Never publish to production's replica, even briefly. |
| Originals | Prefer a dedicated private clone bucket containing the exact manifest-referenced bytes at preserved object keys, with independent credentials. A production bucket mount or write credential defeats isolation. |
| Authentication | Separate OAuth client/callback and clone hostname; disable/revoke copied sessions and restrict eligible test accounts before exposure. Preserve an unmodified checkpoint for data comparison. |
| Settings and egress | Rebind both environment and persisted PocketBase settings. Disable SMTP and unrelated integrations; no production email or transcription. Frozen bootstrap preserves old settings, so changed environment alone is not sufficient. |
| Delivery | Immutable old/new image digests, `deploy-strategy: stop-first`, `auto_update: false`, `auto_backup: false`, `smtp: false`. Omit GitHub automatic delivery for a one-off rehearsal. |
| Recovery authority | Separate PocketDeploy checkpoint if used. It does not replace application backup or authorize retrieving production credentials. |

### Proposed sequence

1. Finish native release validation and publish the candidate client/image without
   production delivery. Keep the exact old release and new candidate digests.
2. Prepare a reviewed clone configuration and read-only PocketDeploy plan. Provision
   only after explicit authorization for compute, storage/OAuth and production-data
   copying. A restored production wiki remains private production-derived data.
3. Provision the host initially without a managed application. Under isolated access,
   restore, verify and rebind the checkpoint before any application can reach public
   traffic or production services. PocketDeploy cannot seed an application volume as
   part of first convergence: use a reviewed app-specific restore bootstrap, then its
   explicit `adopt-app` flow if the bootstrap created the ONCE application. Do not
   let a normal first deployment initialize empty storage and call it a clone.
   Normal frozen startup rejects clone S3 settings that differ from persisted
   production settings. Before normal startup, the bootstrap must run the old
   server in an isolated maintenance context with production egress and replica
   publication blocked, obtain authorized maintenance authentication, explicitly
   thaw, and rebind persisted settings to clone services. This bootstrap and its
   fresh-authentication path must be implemented and tested; changing environment
   variables alone does not satisfy them. Preserve the original frozen checkpoint.
4. Start the old image with clone-only services and verify the checkpoint and existing
   links/authentication. Deliberate clone-only security/settings changes are recorded
   separately from immutable domain-data comparison.
5. Apply the new digest with stop-first delivery. Check migration data equivalence,
   company defaults, optional personal spaces, cross-user denial, search performance,
   login/cancellation, old links, source previews, CLI publication and fresh exports.
6. Stop the candidate; restore the checkpoint into fresh isolated storage with the
   old image and verify rollback. Then repeat the forward migration to demonstrate
   reproducibility. Never attach two publishers to either replica path.
7. Retain only reviewed validation receipts and the required recovery checkpoint;
   delete the clone through owned-resource deletion plus separate cleanup of its
   externally provisioned buckets/OAuth client/data copies. PocketDeploy deletion
   does not automatically remove those external resources or make a backup.

The app-aware restore/bootstrap and frozen-state transition must be rehearsed;
source inspection does not establish them as an existing one-command workflow.
No infrastructure or production-data transfer has been authorized or performed by
this assessment. The next deployment approval should name the provider/network,
resource/cost bound, clone hostname/access, storage/OAuth scope, data-copy permission
and lifetime after a concrete configuration and restore plan are prepared.
