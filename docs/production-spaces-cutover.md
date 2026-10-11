# Company and optional personal spaces cutover

The user authorized proceeding on 11 October 2026. The candidate and local ONCE
rehearsal are recorded in [the rehearsal receipt](local-once-rehearsal.md).
The final pre-checkpoint PR run
[38154996889](https://github.com/pocketcontext/wikicontext/actions/runs/38154996889)
passed application and container checks on AMD64 and ARM64.

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
every originals-bucket object and an encrypted hash manifest. The original
stopped volume is retained independently. A registry digest alone is not the
image backup. On Docker's containerd image store, the reported image ID can be
an index digest; the saved image configuration has a separate verified digest.

## Delivery and writer fencing

`CONTEXT_DEPLOY_PAUSED=true` is set and main-branch delivery was drained.
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

## Current execution boundary

Storage provisioning and synthetic off-host recovery verification are complete.
The live application remains writable while capture/activation tooling and
maintenance authentication are verified. No production checkpoint, freeze,
migration or activation is claimed by this preparation record.
