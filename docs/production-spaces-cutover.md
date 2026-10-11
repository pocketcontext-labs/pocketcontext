# Company and optional personal spaces cutover

The user authorized proceeding on 11 October 2026. The candidate and local ONCE
rehearsal are recorded in [the rehearsal receipt](local-once-rehearsal.md).
The final release run
[38157742568](https://github.com/pocketcontext/wikicontext/actions/runs/38157742568)
passed application and container checks on AMD64 and ARM64. Production acceptance
completed at 17:23 UTC on 11 October 2026. The released source is
`d70b40eb479d16b809dac4b2327b067324089409`, image
`ghcr.io/pocketcontext/wikicontext@sha256:f99620c32c21540e5dddb2754d9fd03e822054b2518a5d54a274cc45b85e7c26`.

## Recovery storage and authority

The private EU R2 bucket is `wikicontext-checkpoints`, with checkpoint objects
under `once-v2/wikicontext-production/checkpoints/<checkpoint-id>/`. Its separate
credential was verified to access only that bucket and was denied access to
`wikicontext-files` and `wikicontext-replica`. Managed public access is disabled,
there are no custom domains, and completed objects have no automatic expiry.
Retain checkpoints **until the user explicitly releases them**. This is private
backup storage, not WORM protection against an authorized credential deleting it.

A dedicated age key is held in the user's default VaultContext vault. Saving,
restoring and comparison passed; a decryption probe used the restored key.
A synthetic complete checkpoint then passed actual R2 upload/download,
decryption, database and file verification using that key. Only the probe's own
synthetic objects were removed afterward. Private recovery metadata records the
vault document/version; never place key material or credentials in this document.

The [checkpoint tool](../tools/CHECKPOINT.md) includes both databases, WAL and
other local recovery state, the ONCE configuration archive, saved old image,
every originals-bucket object and an encrypted hash manifest. A private copy of the stopped
volume is retained independently; the working named volume was migrated. A registry digest alone is not the
image backup. On Docker's containerd image store, the reported image ID can be
an index digest; the saved image configuration has a separate verified digest.

## Delivery and writer fencing

`CONTEXT_DEPLOY_PAUSED=true` was set and main-branch delivery was drained.
After acceptance, the owned pending marker was archived and cleared under the
deployment locks, then the variable was removed to restore its previous unset
state. CD is enabled again.
This suppresses deployment only; main publication can still move `latest`.
ONCE auto-update is disabled. The current host dispatcher serializes using
`/run/once-deploy/wiki.pocketcontext.com.lock` and refuses delivery while
`/var/lib/once-deploy/wiki.pocketcontext.com.pending` exists. Legacy updater
markers are not a verified control on this host. Root operators must respect
the same maintenance window; this is not distributed fencing.

Capture must validate the exact current container, immutable image, revision,
single volume writer, ONCE version, private output and maintenance authority.
Under the deployment lock it creates a durable pending marker, freezes through
the API, disables restart and stops cleanly. Failed capture keeps source storage
and fences; it never automatically thaws or restarts.

Before migration, independently restore Litestream without starting a publisher
and compare complete logical database state with the stopped checkpoint. Upload
the encrypted complete checkpoint, download it anew, decrypt with the recovered
vault key, and verify both databases, all files and saved-image identity.
Bind the recovery receipt to the exact source capture receipt.

## Migration and activation

A frozen database refuses schema migration. Never delete its maintenance marker.
Keep the original ONCE container stopped and restart-disabled. Use a temporary
container on a separate bridge, with no ONCE labels or published ports, preserving
the production storage settings. Permit R2 egress, but verify there is exactly
one volume writer and replica publisher at every transition.

Start the old image frozen in isolation, explicitly thaw through its maintenance
API, then stop it. Start the exact candidate in the same isolated arrangement,
apply migrations, verify existing domain records and Company membership, freeze
the candidate through its API, and stop it. Only then expose the upgraded image
through ONCE. Its migrations are already applied, so it can start frozen.
Read-only verification precedes the explicit final thaw and restoration of CD.

If migration fails, preserve evidence and keep traffic fenced. Restore the
checkpoint and old image into fresh storage and a fresh replica path. Never
restart the old image against a migrated volume. After new writes are admitted,
reverting to the checkpoint loses those later writes.

## Completed execution

The actual operator helpers passed an isolated Docker/ONCE lifecycle before the
cutover: capture, full logical replica comparison, complete encrypted MinIO
recovery, private migration with legacy-data/membership checks, ONCE activation
while frozen, and explicit thaw. The drill identified ONCE's second mount of the
same volume at `/rails/storage`; validation accepts only those known aliases.

Production was frozen through its maintenance API and stopped cleanly with
restart disabled. The capture completed at 17:16:12 UTC with both databases,
sidecars, an actual ONCE archive and the exact old ARM64 image. Docker 29's
containerd exporter failed, including with an explicit platform and an exact
local tag. The old image was instead obtained from its immutable registry
manifest and verified through the index, configuration and every layer hash;
see [the archive procedure](../tools/CHECKPOINT.md).

A restore-only Litestream container recovered a database logically identical to
the stopped source. The complete encrypted checkpoint includes all 319 originals
bucket objects and is 538,765,928 bytes. Actual R2 upload, fresh download,
Vault-restored-key decryption, full integrity checks of both databases and every
file hash passed before migration. No recovery writer was started by verification.
Private operator receipts retain the checkpoint UUID, object key and Vault key
reference. Retention remains until explicit user release.

The isolated migration preserved every legacy column and row across all ten
domain tables. Every previous user received the expected Company membership;
disabled accounts stayed inactive. No personal spaces were created. ONCE then
started the accepted digest frozen at generation 7. Configuration, resource
limits, disabled automatic updates and one volume writer were independently
verified. Explicit thaw advanced maintenance to writable generation 8.

Ordinary `users` authentication, Company default selection, schema compatibility,
scoped search, an existing page's REST access, a protected original's exact hash,
public health and the reader shell passed. Browser authentication/privacy and
mobile scenarios passed in isolated tests; fresh interactive production Google
sign-in was not repeated. No production test records were created.

Current main and registry `latest` matched the accepted release before CD was
restored. Subsequent documentation-only commits do not change the deployed
image. Never downgrade the migrated working volume; restore the retained
checkpoint into fresh storage and a fresh replica path. Such a rollback loses
writes accepted after the checkpoint.
