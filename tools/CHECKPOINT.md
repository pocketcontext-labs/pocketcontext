# Complete encrypted recovery checkpoint

`checkpoint.py` packages an **already stopped, frozen** WikiContext snapshot. It
never freezes/stops a service or establishes writer fencing. The operator must
stop every writer, prevent restart, and retain an immutable copy of the stopped
volume. The production cutover migrates the existing working volume; that named
volume is not an unchanged rollback copy. The retained stopped-volume snapshot,
ONCE archive and verified off-host checkpoint supply the old state. The helper
preserves WAL, SHM and journal sidecars. SQLite validation runs on a second
disposable copy with WAL-aware read-only connections; raw checkpoint and ONCE
bytes remain unchanged. Never delete sidecars to force validation. Both databases
must pass full integrity checks.

Requirements: Python 3.11+, `boto3`, `age`, sufficient private local disk for all
objects and copied recovery files, plus encrypted output. The single conditional
upload is deliberately limited to 5 GiB; larger checkpoints require reviewed
multipart upload support before cutover. The helper copies the **entire originals
bucket**, including unreferenced objects and mutable file fields. Use a dedicated
application originals bucket. No object is deleted. Listings and conditional GETs
detect concurrent changes, but do not replace stopping external writers.

Supply an actual ONCE backup of the same stopped volume and a Docker-format
archive of the exact old image. The helper checks every snapshot file against the
ONCE archive, checks saved-image manifest members exist, and verifies its sole
configuration SHA-256 against `--image-id`. This argument identifies the saved
image **configuration digest**. With Docker's containerd image store, both the
container's `Image` and image-inspect `Id` can instead identify a registry index;
do not assume those values equal the configuration digest. Capture receipts keep
`image_id` and `image_config_digest` separately. Pass `image_config_digest` to the
packaging command.

First attempt a platform-specific export of the verified immutable image:
`docker image save --platform linux/arm64 --output NEW_ARCHIVE EXACT_DIGEST_REF`.
Use the inspected OS/architecture, not an assumed host platform. Preserve partial
outputs on failure. If the daemon cannot export its retained index, obtain the
same immutable image directly from the registry with `skopeo copy` into a new
`docker-archive:` destination. Verify this complete chain before accepting it:

1. Hash the raw registry index and match the recorded running digest.
2. Select its exact OS/architecture manifest; hash its raw bytes and match the
   index descriptor.
3. Match the archive configuration bytes to that manifest's configuration digest;
   verify platform and application revision.
4. Verify every archive layer against the configuration's ordered `rootfs.diff_ids`.
5. Record the archive SHA-256, size, index, platform manifest and configuration
   digests in the private recovery receipt.

Use immutable digest references for registry reads. Never substitute a moved
`latest` tag, and never recreate the image by committing a running container.
Docker-format archives do not reliably retain registry RepoDigests; the packaging
helper does not independently establish this chain, so retain its verification
receipt. Do not print raw Docker metadata or ONCE settings.

Generate/use an age recipient under operator-controlled recovery key custody.
Only the public recipient is needed for capture. Retain the private identity
independently of the application host and backup bucket; verify it can decrypt
before cutover. A key left solely on the failed source host is not recovery.

## Capture

Load originals credentials privately using `WIKICONTEXT_S3_ENDPOINT` (HTTPS URL),
`REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and `BUCKET` under that same prefix.
The originals authority needs listing and read access only. Never paste secrets
into command arguments or logs.

```sh
python3 tools/checkpoint.py capture \
  --source /private/stopped/pb_data \
  --once /private/stopped/once.tar.gz \
  --image-archive /private/stopped/old-image.tar \
  --image-digest ghcr.io/pocketcontext/wikicontext@sha256:EXACT_DIGEST \
  --image-id sha256:VERIFIED_IMAGE_CONFIG_DIGEST \
  --recipient age1PUBLIC_RECIPIENT \
  --output /private/new-checkpoint
```

All input/output ancestors must be free of symlinks. The source directory, archive
files, recovery identity and output parent must be private and owned by the current
user. The new mode-0700 output directory contains `checkpoint.tar.age` and a safe
mode-0600 receipt. Plaintext staging exists only inside that private directory
while capturing and is removed afterward; deletion is not secure disk erasure.
The tar stream is encrypted directly, so no plaintext tar is written. Encrypted
contents include both databases, all snapshot files, ONCE credential-bearing
settings, saved old image, every original-bucket object and complete hash/key
manifest. Object paths use key hashes to avoid unsafe filesystem names. All
referenced file fields must exist; source originals must match database SHA-256.
A frozen marker is required. The private DB/manifest is never printed.

## Upload and verify independently

Configure separate `WIKICONTEXT_BACKUP_ENDPOINT`, `REGION`, `ACCESS_KEY_ID`,
`SECRET_ACCESS_KEY`, and `BUCKET`. Set `WIKICONTEXT_BACKUP_PREFIX` to
`once-v2/wikicontext-production/checkpoints` for the production recovery location
(the default is `checkpoints`). Use a dedicated private backup bucket and
credentials; the CLI rejects reuse of live bindings when those are loaded.
Credential IAM separation, bucket privacy, deletion prevention and retention must
also be verified at provisioning: the helper cannot infer provider policy from
credentials. Do not configure lifecycle deletion until the rollback window is
explicitly released. Use no automatic deletion policy for this release checkpoint.

```sh
python3 tools/checkpoint.py upload --directory /private/new-checkpoint
python3 tools/checkpoint.py verify \
  --receipt /private/new-checkpoint/receipt.json \
  --identity /private/independent-recovery.agekey \
  --destination /private/new-recovery
```

Upload uses a UUID `<configured-prefix>/<id>/` and conditional no-overwrite writes for
ciphertext and receipt. Failure can leave a partial checkpoint; it never reports
verification success and never deletes remote objects. Preserve the safe receipt
independently; its copy is also stored next to the ciphertext. Receipt upload is
last, but its existence alone is not a recovery proof. Retry by inspecting private
state or capturing a new UUID, not overwriting an existing checkpoint.

Verification downloads remote ciphertext, compares its SHA-256 and length,
authenticates/decrypts with age, rejects unsafe/duplicate/nonregular archive
entries, compares every restored file with its encrypted manifest, checks both
SQLite databases and all referenced originals. Only then does it create the new
recovery destination and report success. No application or replica writer starts.
The recovered files remain private. This proves stored-artifact recovery; perform
the independently fenced old-image application restore before deployment acceptance.
Keep the immutable checkpoint and retained stopped-volume snapshot until rollback
release; the migrated working volume no longer contains the original state.

## Synthetic validation

```sh
python3 tests/checkpoint.py
```

Uses real age encryption and an in-memory synthetic object store, covering full
bucket recovery, mutable file references, unreferenced object preservation,
duplicate upload refusal, ciphertext corruption, wrong keys, missing/corrupt
originals, symlinks, unsafe paths, missing freeze, image-ID mismatch and a committed row
present only in WAL with unchanged raw checkpoint hashes. It makes no cloud calls
and contains no production data. Provisioned R2/IAM and live scale remain separate
operator gates.
