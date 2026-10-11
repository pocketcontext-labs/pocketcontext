# Private WikiContext migration rehearsal

For the completed **local, synthetic Basecamp ONCE test**, use
[LOCAL_ONCE.md](LOCAL_ONCE.md). It runs an isolated Docker-in-Docker engine with
loopback-only outer ports and exercises actual ONCE restore, backup, stop-first
update, rollback, and repeat migration. The recorded result is in
[the local rehearsal receipt](../../docs/local-once-rehearsal.md).
The shared-host preparation below is a separate option and was not run on OCI.


These are preparation tools, not a record of a cloud deployment or production-data
copy. [The recovery assessment](../../docs/predeployment-recovery.md) defines the
checkpoint, original-file and old-image requirements. The existing
`pocketdeploy-v1` host serves two public demos; their configuration, volumes,
network, credentials and deployment identity must remain intact.

## Preferred shared-host preparation

`shared_host.py` uses the existing controller's pinned SSH authority without
calling `converge`, `adopt-app`, `delete`, or cloud provisioning. It runs an
independent Docker container, named volume and bridge. The only published port
binds **127.0.0.1**, and the image/container cannot carry an ONCE label. There is
no ONCE route and the clone never joins ONCE's network. A `.localhost` name alone
would not protect an application registered with the existing public proxy:
anyone could supply that HTTP Host header.

This mode tests restored application startup, the old-to-candidate schema change,
private reader/CLI behavior, and rollback. It **does not test ONCE adoption or
PocketDeploy's managed application replacement**. The helper implements an
explicit stop-first transition independently. Full managed delivery rehearsal
requires a separately isolated host or separately reviewed ingress support.

Copy `shared-host.example.json` to a private location and supply:

- A fresh rehearsal UUID and the **existing** `pocketdeploy-v1` deployment UUID.
  Obtain the latter from safe controller status, never from a copied production
  state database. No controller identity/state/keys are created or replaced.
- Exact old and candidate registry digests, a distinct `.localhost` name, and an
  unused high loopback port. Both images must support the restored data and
  `/api/health`; the old image's extracted server hash must match preparation.
- Source originals/replica **bucket names only**, for explicit reuse rejection.
  Provisioning and data-copy authorization for separate clone buckets/credentials
  remain separate from using the existing compute.
- Approved resource/data limits and a UTC cleanup deadline. Shared-host limits
  cannot exceed **0.5 CPU and 1024 MiB**. The example permits at most 1 GB prepared
  data; increase only after reviewing host capacity. Startup checks available
  memory and disk headroom, and retains fixed PID/log bounds. Docker volumes have
  no enforced growth quota; monitor capacity during the short test.

The deadline prevents new starts after expiry; **it does not schedule a stop**.
Assign an operator to stop/remove the clone by that deadline. The container has
`restart=no`. These tools do not stop or resize the existing demos.

`--scope` and `--private-env` must be owned regular mode-0600 JSON files, not shell
scripts or symlinks. The startup environment accepts exactly these names:

```text
WIKICONTEXT_S3_BUCKET
WIKICONTEXT_S3_ENDPOINT
WIKICONTEXT_S3_REGION
WIKICONTEXT_S3_ACCESS_KEY_ID
WIKICONTEXT_S3_SECRET_ACCESS_KEY
WIKICONTEXT_S3_FORCE_PATH_STYLE
LITESTREAM_BUCKET
LITESTREAM_PATH
LITESTREAM_ENDPOINT
LITESTREAM_REGION
LITESTREAM_ACCESS_KEY_ID
LITESTREAM_SECRET_ACCESS_KEY
LITESTREAM_SYNC_INTERVAL
```

Use nonempty explicit values, for example the provider's actual region rather than
an omitted default. Both buckets must differ from both source buckets and from
each other; their access-key identities must differ. `LITESTREAM_PATH` must be
`rehearsals/REHEARSAL_UUID/data.db`. `BASE_URL` is derived from the selected host
and loopback port. No Google, SMTP, Groq, superuser-provisioning or arbitrary extra
bindings are accepted. Persisted settings and copied account sessions must already
have been sanitized by the preparation tool. Original-file contents must be
copied to the independent clone bucket at their preserved keys before startup.

### Prepare and transfer

First use [prepare_clone.py](../../tools/prepare_clone.py) on a stopped frozen
checkpoint, with the exact old server binary and its private configuration. Follow
its `--help` and the recovery assessment. It creates a **new** prepared `pb_data`
and a sibling `NAME.preparation.json`; never edit the immutable checkpoint or
maintenance marker to force migration. Its receipt must show an unchanged source,
unchanged domain/original data, rotated copied sessions, a writable clone and
complete prepared-file hashes. Preparation alone does not verify remote originals.

Run the helper in the existing deployment's tool environment (OCI CLI/SSH/rsync
available), with the same reviewed PocketDeploy package pin as its launcher.
The repository README currently pins
`eec9401ab1ff56aad5377ece3b71dc45c4faca0a`; its source supplies all used APIs.
For example, this shell function selects that immutable package without sourcing
private binding files:

```sh
rehearsal() {
  uv run --with 'pocketdeploy @ git+https://github.com/pocketcontext/pocketdeploy@eec9401ab1ff56aad5377ece3b71dc45c4faca0a' \
    python /home/ubuntu/code/pocketcontext/wikicontext/deploy/rehearsal/shared_host.py "$@"
}
```

Once the precise scope/data-copy action is authorized, commands use explicit
private paths. `stage` creates only the UUID-specific staging directory and
transfers the prepared files/receipt through pinned SSH with `sudo rsync`, under
the existing controller lock. It starts no application. A partial transfer is
retained, never treated as a successful restore; use a fresh reviewed UUID for a
retry. No live `colors.yml`, ONCE settings or application volume is changed.

```sh
rehearsal stage --config /home/ubuntu/code/pocketcontext/pocketdeploy-v1/colors.yml \
  --scope /PRIVATE/rehearsal-scope.json --prepared-dir /PRIVATE/prepared-pb-data
rehearsal start-old --config /home/ubuntu/code/pocketcontext/pocketdeploy-v1/colors.yml \
  --scope /PRIVATE/rehearsal-scope.json --private-env /PRIVATE/clone-environment.json
rehearsal status --config /home/ubuntu/code/pocketcontext/pocketdeploy-v1/colors.yml \
  --scope /PRIVATE/rehearsal-scope.json
```

Remote prepared files live under
`/var/lib/wikicontext-rehearsal/UUID/prepared`. The helper compares every file,
old-image server hash, clone origin and canonical S3 binding fingerprint to the
preparation receipt before copying into a new named volume. A detached loader has
no network and never starts the application. The old entrypoint then verifies all
referenced remote originals and starts only the clone replica publisher.

The helper verifies PocketDeploy's existing metadata-denial rules in DOCKER-USER
and FORWARD before startup; it does not rewrite firewall rules. The dedicated
bridge permits outbound access because S3/Litestream require it. This is not a
complete egress allowlist: safety also depends on sanitized persisted settings and
clone-scoped credentials. Missing metadata protection refuses startup.

### Private access and checks

After safe controller status confirms the recorded host address, create a tunnel
using its existing key and pinned known-hosts file. The example below runs from
`pocketdeploy-v1`; replace `RECORDED_HOST_IPV4` and the selected port. Bind the
forward only to loopback and keep agent forwarding disabled:

```sh
ssh -F /dev/null -i .ssh/id_ed25519 -o IdentitiesOnly=yes \
  -o IdentityAgent=none -o ForwardAgent=no -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=.ssh/known_hosts -o GlobalKnownHostsFile=/dev/null \
  -o ExitOnForwardFailure=yes -N -L 127.0.0.1:18081:127.0.0.1:18081 \
  ubuntu@RECORDED_HOST_IPV4
```

Open `http://wiki-rehearsal.localhost:18081` in the browser on the tunnel computer.
Use only the copied test identities whose passwords were deliberately changed.
Confirm the local origin resolves to loopback before entering credentials. No
OAuth client is configured: this phase makes **no claim** that Google accepts a
`.localhost` redirect or that real provider login has been validated. Real Google
OAuth requires a separately reviewed registered HTTPS origin/client and callback.

Verify the selected local origin, normal test-user access, private evidence and
old publication links. From outside the host, confirm the selected high port is
unreachable and that HTTP to the public host with
`Host: wiki-rehearsal.localhost` cannot serve the clone. Do not print the public
response body; check status and absence of the clone's private content in-process.
A public proxy 404 alone is insufficient: also verify the actual loopback binding,
absence of ONCE labels/routes and absence from ONCE's network. The helper returns
only allowlisted status, never Docker metadata or application response bodies.

Then run the candidate transition and application validation:

```sh
rehearsal candidate --config /home/ubuntu/code/pocketcontext/pocketdeploy-v1/colors.yml \
  --scope /PRIVATE/rehearsal-scope.json --private-env /PRIVATE/clone-environment.json
```

The candidate requires a completed old-image readiness receipt and exactly the
same binding fingerprint. It cleanly stops the old process, proves exit zero and
no OOM, removes only that exact owned container, then starts the candidate on the
same owned volume. A pending marker fences replay after an uncertain mutation;
a candidate that might have written is never automatically rolled back. Readiness
has a 900-second deadline; timeout stops the clone and preserves its volume.
An uncertain graceful stop attempts to disconnect only the clone's network,
preserves storage and fails for explicit recovery. Do not clear markers or force
volume removal to bypass that failure.

### Rollback and cleanup

Stop the candidate before any rollback restore. Confirm no publisher remains;
clean process exit alone is not proof of final remote synchronization. Preserve
its volume while assessing any writes made after the checkpoint.

```sh
rehearsal stop --config /home/ubuntu/code/pocketcontext/pocketdeploy-v1/colors.yml \
  --scope /PRIVATE/rehearsal-scope.json
```

Rehearse rollback with the old image, a fresh prepared copy, **new rehearsal UUID,
new volume/network and UUID-bound replica path**, after the previous publisher is
stopped. Never attach restored old data beside an active publisher sharing its
replica. Use the immutable checkpoint and compare domain/original evidence again;
keep deliberate clone account/settings changes separate from that comparison.

After retaining the required private receipts, explicit `remove` deletes only
UUID-labeled rehearsal resources after a proven clean stop. It never invokes
PocketDeploy deletion, touches ONCE applications, removes shared images, or deletes
the staged checkpoint. A retired UUID cannot be started again.

```sh
rehearsal remove --config /home/ubuntu/code/pocketcontext/pocketdeploy-v1/colors.yml \
  --scope /PRIVATE/rehearsal-scope.json
```

Securely remove retained staging/private files and independently provisioned clone
objects/credentials through their separately authorized procedures. They are not
silently deleted by this helper. Check both public demos remain healthy throughout.

## Fresh-host alternative

`prepare_config.py spec.json NEW_DIRECTORY` generates non-secret JSON-compatible
YAML phases using the current PocketDeploy schema: empty `host.yml`, old-image
`restored.yml`, candidate `candidate.yml`, and an initially empty `colors.yml`.
It refuses existing directories, broad SSH CIDRs, non-loopback clone names, mutable
images and reused source profiles. Its deadline must be within seven days; cost
ceiling/deadline are recorded scope, not provider billing or automatic cleanup.

Fill `spec.example.json` with the approved provider/network identifiers, machine
and disk bounds, operator /32 addresses, source identity, digests, deadline and
cost ceiling. GCP fields are shown; OCI and DigitalOcean exact field sets are
listed in `prepare_config.py` and PocketDeploy's provider reference. No cloud
credential is accepted in the specification. All nine generated provider/phase
combinations were checked against PocketDeploy's current schema without resolving
bindings or contacting providers.

These files are **only for a new dedicated host**, never the existing
`pocketdeploy-v1` directory: converging an empty application list there would remove
managed applications. On a dedicated host, no HTTP ingress is allowed; ONCE's local
HTTP health probe works with `disable_tls`, `manage-dns:false`, no SMTP and no
GitHub delivery. After a separately verified ONCE restore bootstrap, adoption must
use the running old image, all exact named-volume destinations, its safe settings
fingerprint and disabled previous delivery. Then activate the candidate phase and
use stop-first convergence. The shared-host helper does not supply that ONCE
bootstrap, and these templates are not evidence that adoption has been rehearsed.

## Validation performed

```sh
python3 -B -m unittest discover -s deploy/rehearsal/tests
python3 deploy/rehearsal/isolation_test.py --image LOCAL_WIKICONTEXT_TEST_IMAGE
```

The first command uses synthetic mocked lifecycle operations and checks scopes,
source-bucket/credential separation, preparation hashes, phase/binding fences,
clean-stop requirements, exact mounts and cleanup. The second uses temporary local
Docker networks/container/volume with synthetic HTTP content and verifies loopback
publication plus denial from another application bridge; it does not invoke cloud
APIs or the shared host. It passed with the final locally built WikiContext image.
The complete remote old-image→candidate lifecycle and production-derived restore
remain unexecuted until exact published digests, authorized prepared data, clone
storage and the approved operator scope are available.
