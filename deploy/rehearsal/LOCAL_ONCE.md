# Local ONCE rehearsal

This is a synthetic migration/recovery test using the real, unmodified Basecamp
ONCE v0.3.3 binary. It does not access the existing OCI deployment or copy real
WikiContext data. Do not supply production settings or backups to this fixture.

`local_once.py` starts a disposable Docker-in-Docker engine from a pinned image.
The engine has one private named Docker data volume, no host filesystem or
Docker socket mounts, a 2 CPU / 4 GiB limit, and two randomly assigned host ports
bound only to `127.0.0.1` (HTTP and synthetic S3). Its Docker API listens only on
its internal Unix socket. ONCE's ordinary wildcard proxy ports exist inside this
engine. They are not published on the host's public interfaces.

Docker-in-Docker requires a privileged outer container. This is a test for trusted
application images, not a sandbox for hostile code. Inner application resource
limits are omitted because nested cgroup controllers are unavailable on this
host; the outer resource limits remain enforced. This test does not establish
production ONCE application CPU/memory enforcement, TLS issuance, real Google
OAuth, cloud IAM, or production recovery performance.

Use the official ONCE v0.3.3 Linux binary matching this host's architecture.
`create` verifies its SHA-256 against the same release pins as PocketDeploy before
starting Docker. No ONCE background service is installed on the host.

## Procedure

Run from the WikiContext repository. Paths below are placeholders for new private
scratch locations. The state file and fixture contain synthetic credentials and
must stay outside Git. Keep the actual old image digest, historical application
checkout, and server binary consistent. Extract the server binary from that
exact old image for `--binary`; a source rebuild may have a different checksum.

```sh
python3 deploy/rehearsal/local_once.py create \
  --state /private/scratch/engine.json --once-binary /private/scratch/once

python3 deploy/rehearsal/local_fixture.py \
  --engine-state /private/scratch/engine.json \
  --output /private/scratch/fixture \
  --binary /private/scratch/exact-old-pocketcontext \
  --fixture-app /private/scratch/exact-old-application

python3 deploy/rehearsal/local_once.py pack \
  --state /private/scratch/engine.json \
  --prepared-dir /private/scratch/fixture/prepared \
  --private-env /private/scratch/fixture/environment.private.json \
  --archive /private/scratch/prepared-old.tar.gz \
  --image ghcr.io/pocketcontext/wikicontext@sha256:OLD_DIGEST

python3 deploy/rehearsal/local_once.py restore \
  --state /private/scratch/engine.json --archive /private/scratch/prepared-old.tar.gz
```

The fixture needs the synthetic MinIO image declared in `local_fixture.py`
available in the outer Docker daemon; build it with the repository's existing
`docker/minio.Dockerfile` fixture process. It loads that image into the isolated
engine and creates private originals and replica buckets. The initial archive
uses ONCE v0.3.3's real `once.application.json`, `once.volume.json`, and `data/`
layout. Packaging checks the prepared receipt and every file hash, SQLite
integrity confirmation, storage binding fingerprint, and exact old-image server
binary hash. There are no application backup/restore hooks in these WikiContext
images. ONCE pauses the running application while copying its volume.

Read the safe `http_port` from `local_once.py status`. The verification client
supplies the `wiki-rehearsal.localhost` Host header to the loopback proxy:

```sh
python3 deploy/rehearsal/verify_fixture.py \
  --url http://127.0.0.1:HTTP_PORT --fixture /private/scratch/fixture
```

Run `pitr_test.py` during an exclusive fixture write window before the old backup.
Its private input contains the current inner app container name plus the fixture
host, user email, and password. It inserts two synthetic sources around a replica
boundary and restores separate temporary databases using `-txid`, `-timestamp`,
and latest. It checks full integrity, the expected source sets, and protected
original bytes. It never starts another restored database writer. Finish this
step before backup or migration; the baseline verifier permits these additional
synthetic rows.

```sh
python3 deploy/rehearsal/pitr_test.py \
  --engine-state /private/scratch/engine.json \
  --fixture /private/scratch/pitr.private.json \
  --receipt /private/scratch/pitr-receipt.json

python3 deploy/rehearsal/local_once.py backup \
  --state /private/scratch/engine.json --archive /private/scratch/actual-old.tar.gz

python3 deploy/rehearsal/local_once.py update \
  --state /private/scratch/engine.json \
  --image ghcr.io/pocketcontext/wikicontext@sha256:CANDIDATE_DIGEST

python3 deploy/rehearsal/verify_fixture.py \
  --url http://127.0.0.1:HTTP_PORT --fixture /private/scratch/fixture \
  --migrated --personal-probe

python3 deploy/rehearsal/local_once.py rollback \
  --state /private/scratch/engine.json \
  --archive /private/scratch/actual-old.tar.gz \
  --rebound-archive /private/scratch/rollback-old.tar.gz

python3 deploy/rehearsal/verify_fixture.py \
  --url http://127.0.0.1:HTTP_PORT --fixture /private/scratch/fixture --rollback

python3 deploy/rehearsal/local_once.py update \
  --state /private/scratch/engine.json \
  --image ghcr.io/pocketcontext/wikicontext@sha256:CANDIDATE_DIGEST

python3 deploy/rehearsal/verify_fixture.py \
  --url http://127.0.0.1:HTTP_PORT --fixture /private/scratch/fixture --migrated
```

Each update disables the current container's restart policy, gives it 300 seconds
to stop, and requires exit 0 without OOM before invoking actual `once update`.
Rollback keeps the candidate volume detached, removes its ONCE registration,
and invokes actual `once restore` into a fresh named volume. It preserves the
original backup unchanged and changes only `env.LITESTREAM_PATH` in a separate
private archive to a fresh UUID prefix. Database/original-file archive entries
remain byte-identical. This prevents an older snapshot from publishing into the
candidate's replica history. Repeating the update uses the new rollback volume.

The final browser smoke uses Node.js 24 and the installed `ui` dependencies:

```sh
ASDF_NODEJS_VERSION=24.21.0 node deploy/rehearsal/browser_smoke.mjs \
  /private/scratch/fixture /private/scratch/engine.json
```

After API and browser checks, remove only this owned engine and its named data
volume. This also removes its inner ONCE proxy, applications, detached rollback
volumes, and synthetic object storage. Private local scratch archives remain for
review and should be deleted when the rehearsal evidence is no longer needed.

```sh
python3 deploy/rehearsal/local_once.py stop --state /private/scratch/engine.json
python3 deploy/rehearsal/local_once.py destroy --state /private/scratch/engine.json
python3 -B -m unittest discover -s deploy/rehearsal/tests
```

There is no scheduled expiry. Stop and destroy the engine when finished; do not
leave a privileged test daemon running indefinitely.
