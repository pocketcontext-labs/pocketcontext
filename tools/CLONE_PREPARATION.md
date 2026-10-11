# Prepare a frozen checkpoint for a private clone

`prepare_clone.py` creates a new local clone `pb_data` directory. It does not
provision infrastructure, copy remote originals, start Litestream, deploy ONCE,
run application migrations or establish that the clone is ready for traffic.
Use it only on an authorized, stopped, frozen checkpoint, never the live volume.

The source checkpoint remains unchanged. Preparation copies both SQLite databases,
any recovery sidecars, `maintenance.json` and local `storage/` files into a new
mode-0700 destination. Source backup archives, temporary files and unrelated local
configuration are not copied. Both databases pass integrity checks before and
after preparation. Every domain column and local original is compared for equality.
A failure leaves an incomplete private destination for review, without a success
receipt. Choose another new destination after correcting the cause.

## Requirements

Use Linux with `unshare`, `iproute2`, Python 3.11+ and the exact old compatible
PocketContext executable extracted from the retained old application image.
The caller needs root or passwordless `sudo -n` for creating a network namespace.
The namespace contains only its own loopback interface; production network
endpoints and host-loopback services are unreachable. No production environment
bindings are inherited by the child. Do not substitute an unfenced normal server.

The checkpoint must contain `data.db`, `auxiliary.db` and a valid private frozen
maintenance marker. Stop the original server and publisher before capturing it.
The helper verifies source bytes remain unchanged but cannot prove the operator
stopped every external writer. Keep an independent verified recovery checkpoint.

Select an existing copied superuser by email. No saved bearer token or old
password is required: trusted local possession of the copied database permits a
temporary PocketBase JS command to call `newStaticAuthToken` with a five-minute,
nonrefreshable lifetime. The token is held in a private temporary file briefly,
then memory; never stdout. This uses existing supported PocketBase mechanisms,
not a maintenance bypass or a new production authentication route. The temporary
hooks and commands are outside the destination and deleted afterward.

## Private configuration

Create a mode-0600 JSON file outside Git with exactly these fields:

```json
{
  "clone_url": "http://wiki-rehearsal.localhost",
  "operator_email": "existing-operator@example.test",
  "operator_password": "REPLACE_WITH_NEW_RANDOM_CLONE_PASSWORD",
  "s3": {
    "enabled": true,
    "bucket": "distinct-clone-originals",
    "endpoint": "https://CLONE_STORAGE_ENDPOINT",
    "region": "auto",
    "accessKey": "CLONE_ONLY_ACCESS_KEY",
    "secret": "CLONE_ONLY_SECRET",
    "forcePathStyle": true
  },
  "test_users": [
    {
      "email": "existing-test-user@example.test",
      "password": "REPLACE_WITH_NEW_RANDOM_TEST_PASSWORD"
    }
  ]
}
```

Passwords must contain at least 20 characters and differ from the copied account's
password. The selected identities must already exist. All other ordinary users
are disabled. Other copied superuser passwords are replaced with unretained random
values. The production `pocketcontext.com` domain is rejected, including trailing-dot
aliases; use the private rehearsal hostname.

For remote evidence, the clone bucket name, access key and secret must each differ
from the copied production binding. Pointing different credentials at the same
bucket is rejected. This check does not prove the credentials lack broader access;
provision clone-only grants separately. A remote-storage checkpoint cannot be
silently changed to local storage. Synthetic local-storage fixtures may set
`enabled: false`, empty storage strings and an explicit `forcePathStyle` boolean.

No Litestream credentials enter this configuration. The eventual container must
receive separate clone replica bindings, exact matching clone original-storage
bindings and the clone URL. OAuth remains disabled during preparation; any later
OAuth rehearsal needs a separate clone client and explicitly reviewed admission.

## Run and inspect

```sh
python3 tools/prepare_clone.py \
  --binary /private/old-image/pocketcontext \
  --checkpoint /private/checkpoint/pb_data \
  --destination /private/rehearsal/pb_data \
  --private-config /private/rehearsal-bindings.json
```

The helper starts only the bare old server, with temporary maintenance hooks and
an empty application migrations directory. It never invokes the container
entrypoint or copied application hooks. It uses the authenticated maintenance API
to thaw the clone; it never deletes or edits the maintenance marker. Through
PocketBase REST it then replaces the URL/storage settings, clears SMTP and backup
service credentials, disables OAuth/OTP/MFA on both auth collections and rotates
all copied authentication/link/file signing secrets. A fresh password login proves
the new clone operator credentials before final signing-secret rotation. The
preparation server stops before the helper returns.

The private sibling `pb_data.preparation.json` receipt binds the prepared file set
and hashes, source/prepared database hashes, binary hash, clone URL, canonical
storage-binding fingerprint, domain fingerprints and successful checks. It contains
no credentials or source contents. Treat its file paths and fingerprints as private
metadata. Stdout contains only completion booleans and maintenance/isolation state.
Verify every file and the old-image executable hash before packaging or starting
this directory. Preparation leaves maintenance writable **inside the isolated
clone**, ready for the controlled old-image startup and later candidate migration.

The receipt explicitly records `remote_originals_verified: false` and
`ready_for_public_traffic: false`. Copy the authorized originals into the separate
clone bucket, initialize an independent replica through the reviewed deployment
bootstrap, and verify full evidence recovery before any exposure. The original
checkpoint stays frozen and suitable for the independently tested rollback path.

## Validation evidence

Run the synthetic test with the pinned server:

```sh
python3 tests/clone_preparation.py --binary /absolute/path/to/pocketcontext
```

It exercises a stopped populated checkpoint, private fresh maintenance authority,
API thaw/settings changes, preservation of all domain fields/local originals,
revoked copied sessions including users whose password was not reset, new operator
password login without provisioning shortcuts, disabled alternate authentication,
cleared service secrets, reused storage/password rejection and no success receipt
on failure. It requires a working privileged network namespace; it does not skip
isolation when unavailable.

On 11 October 2026 the test also passed against pre-spaces WikiContext source
`7cf5d4548fd22a7cb250adbd4034f1060c9bd53e` with PocketContext
`976ddf71a4734530adefe4a56633658a0894b449`, using `--fixture-app` to select the
archived source. These are synthetic local checks, not a production-data restore,
remote-original recovery, published candidate or cloud deployment.
