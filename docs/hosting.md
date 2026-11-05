# Hosted containers

Hosted mode is an explicit alternative to the local binary. Each instance has one
owner email, domain, container and persistent volume. PocketDeploy/ONCE terminates
HTTPS and forwards HTTP port 80 on its private Docker network. Do not publish that
backend port directly on the Internet. The public reader uses email-only login;
external agents use public MCP. Existing local password login, tunnels, native
HTTPS and project layout do not change.

The image contains the Go binary and its embedded reader, plus a small Python
container supervisor for complete S3 backups. It contains no Litestream or Node
runtime. Operators either pin a verified multi-platform image digest or explicitly
enroll existing instances in PocketDeploy delivery of validated `:latest` releases.
There is no automatic signup or container creation.

## Runtime configuration

Inject settings privately through PocketDeploy bindings. Do not put secret values
in the Dockerfile, image, tracked configuration, command transcript or project.

| Environment variable | Meaning |
| --- | --- |
| `POCKETCONTEXT_DOMAIN` | Exact public DNS hostname, without scheme or port |
| `POCKETCONTEXT_OWNER_EMAIL` | Sole owner's real email address |
| `POCKETCONTEXT_SMTP_HOST` | SMTP server, e.g. `smtp.resend.com` |
| `POCKETCONTEXT_SMTP_PORT` | SMTP port, normally `465` |
| `POCKETCONTEXT_SMTP_TLS` | `tls` (default) or `starttls` |
| `POCKETCONTEXT_SMTP_USERNAME` | SMTP username, `resend` for Resend |
| `POCKETCONTEXT_SMTP_PASSWORD` | Sending-only Resend key; preferably unique per instance |
| `POCKETCONTEXT_SMTP_FROM` | Address on the verified sending domain |
| `POCKETCONTEXT_BACKUP_ENDPOINT` | HTTPS S3-compatible endpoint |
| `POCKETCONTEXT_BACKUP_REGION` | S3 region, `auto` for R2 |
| `POCKETCONTEXT_BACKUP_BUCKET` | Private bucket dedicated to this instance |
| `POCKETCONTEXT_BACKUP_ACCESS_KEY_ID` | Bucket-scoped access key |
| `POCKETCONTEXT_BACKUP_SECRET_ACCESS_KEY` | Bucket-scoped secret key |
| `POCKETCONTEXT_BACKUP_PREFIX` | Explicit safe prefix, e.g. `pocketcontext` |

SMTP configuration is runtime-only. Disable email open/click tracking so login
links remain unchanged. Configure DNS authentication for the sending domain and
verify actual recipient delivery; an accepted SMTP connection is not inbox proof.
The owner address is not returned by the public login configuration endpoint.

The volume layout is fixed:

```
/storage/
  project/                 database, project settings and immutable originals
  private/
    cache/                 live working database, OAuth state and local controls
    config/                machine configuration
    state/                 machine state
    container.json         source revision that last opened this volume
```

The supervisor holds an exclusive volume lock. PocketContext independently locks
its private working database. Hosted leases have a stable instance identity across
container recreation. Never mount the same volume into a second application writer.
The container runs as root because ONCE owns volume permissions and exposes port 80;
keep host administrative access restricted and never mount the Docker socket.

## Manual provisioning

1. Provision the private bucket, bucket-scoped credentials, verified sending domain,
   sending-only email key, instance domain and private environment bindings.
2. Select a source-tagged image whose native AMD64/ARM64 application, container and
   backup/restore checks passed. Record its immutable manifest digest.
3. For the first ONCE convergence only, add a private binding
   `POCKETCONTEXT_CONTAINER_COMMAND: app-pocketcontext-example-container-command`
   whose value is `init`. This explicitly selects `--hosted-init` on ONCE's new
   volume. Initialization refuses an existing project; normal startup refuses
   missing data. Do not invite the user during this provisioning stage.
4. After initial readiness, remove that binding from desired configuration and
   converge the **same image digest** again with normal `serve`. ONCE stops the
   initial writer and preserves its volume. Confirm a normal restart before
   inviting the user. A restart while the `init` binding remains correctly refuses
   the existing project until this second deployment removes it. Keep
   `auto_update: false`, `auto_backup: false`, `deploy-strategy: stop-first` and a
   sufficient graceful stop time (300s).
5. Verify `/up`, HTTPS, anonymous knowledge denial, email login, and MCP consent.
   The MCP endpoint is `https://INSTANCE_DOMAIN/mcp`. No private tunnel is started.
6. Run `pocketcontext-container backup` inside the container and verify its successful
   receipt before declaring the instance backed up. Rehearse restore into a separate
   empty volume and keep that recovered server isolated from production traffic.

Never edit deployment state databases or forge ONCE labels. ONCE creates and
retains its own volume across the two provisioning deployments. The provisioning
operator must preserve exactly one writer throughout the handover.

Example desired configuration (replace placeholders; values reference private
`COLORS_PAR_*` bindings, never literal secrets):

```yaml
once:
  applications:
    - host: knowledge.example.com
      image: ghcr.io/pocketcontext-labs/pocketcontext@sha256:REPLACE_WITH_VERIFIED_DIGEST
      health-path: /up
      deploy-strategy: stop-first
      deploy-stop-timeout: 300
      deploy-ready-timeout: 120
      auto_update: false
      auto_backup: false
      smtp: false
      manage-dns: true
      env:
        POCKETCONTEXT_DOMAIN: app-pocketcontext-example-domain
        POCKETCONTEXT_OWNER_EMAIL: app-pocketcontext-example-owner-email
        POCKETCONTEXT_SMTP_HOST: app-pocketcontext-example-smtp-host
        POCKETCONTEXT_SMTP_PORT: app-pocketcontext-example-smtp-port
        POCKETCONTEXT_SMTP_TLS: app-pocketcontext-example-smtp-tls
        POCKETCONTEXT_SMTP_USERNAME: app-pocketcontext-example-smtp-username
        POCKETCONTEXT_SMTP_PASSWORD: app-pocketcontext-example-smtp-password
        POCKETCONTEXT_SMTP_FROM: app-pocketcontext-example-smtp-from
        POCKETCONTEXT_BACKUP_ENDPOINT: app-pocketcontext-example-backup-endpoint
        POCKETCONTEXT_BACKUP_REGION: app-pocketcontext-example-backup-region
        POCKETCONTEXT_BACKUP_BUCKET: app-pocketcontext-example-backup-bucket
        POCKETCONTEXT_BACKUP_ACCESS_KEY_ID: app-pocketcontext-example-backup-access-key-id
        POCKETCONTEXT_BACKUP_SECRET_ACCESS_KEY: app-pocketcontext-example-backup-secret-access-key
        POCKETCONTEXT_BACKUP_PREFIX: app-pocketcontext-example-backup-prefix
```

ONCE v0.3.3 has a fixed 120-second container startup budget; the controller readiness
setting does not extend ONCE's internal budget. `/up` accepts internal container
health probes; all application routes require the configured public Host. Public
`/up` does not expose knowledge or credentials.

## Automatic release enrollment

Enroll only initialized, healthy instances already owned by the deployment.
The application entries for a shared repository use one GitHub environment and
restricted SSH key; their configured order determines sequential rollout. Keep
separate domains, volumes, owner bindings and backup buckets. Add these fields to
each enrolled application's existing configuration:

```yaml
image: ghcr.io/pocketcontext-labs/pocketcontext:latest
github: pocketcontext-labs/pocketcontext
deploy-strategy: stop-first
deploy-prepare-command: [pocketcontext-container, prepare-upgrade]
deploy-prepare-timeout: 900
```

Use a PocketDeploy release supporting grouped repository targets and preparation
hooks. Its convergence installs the host policy and GitHub environment, including
`SSH_PRIVATE_KEY`, pinned `SSH_KNOWN_HOSTS`, `SERVER_IP`, `SERVER_USER`, and the
`SITE_URLS` JSON array. Set the repository variable `COLORS_PROFILE` to that
managed environment's name. Set repository variable `CONTEXT_DEPLOY_PAUSED=true`
to pause CI delivery; this does not prevent operator convergence or publication
of `:latest`.

The image workflow runs the application checks, native AMD64/ARM64 container
checks and populated backup/restore rehearsals before publication. A current-main
check protects publication of the source tag and `:latest`; a second check protects
deployment. CI sends the resulting immutable manifest digest through the restricted
SSH dispatcher, rather than resolving a mutable tag during deployment. Main
workflows and deploy jobs serialize without cancelling an active deployment.

Under the host lock, PocketDeploy prepares one instance, replaces it stop-first,
checks health and volume continuity, then advances to the next. Preparation must
succeed before replacement. A failed or uncertain deployment stops the remaining
targets for operator inspection; previously completed targets remain upgraded.
Never automatically downgrade a volume that a newer release has opened. Public
HTTPS health is checked for every configured target after the dispatcher succeeds.

Initialization and disaster recovery remain explicit operator operations. An
ordinary convergence follows the enrolled `:latest` channel; reverting the scaffold
to an old digest is not a safe rollback procedure.

## Complete backups and upgrades

Daily backups run every 24 hours after the latest successful backup; a new instance
attempts its first backup after one minute. Each backup briefly stops the Go server,
checks database integrity and every referenced original's SHA-256, and creates a
complete local archive. It then restarts the same binary before uploading. **There
is a reader/MCP outage while the local archive is created.** Large datasets need
measured snapshot and restart times. Upload time does not extend the daily outage.
Failures are logged without provider details and retried after an hour.

Archives contain the project and private runtime state, including OAuth state at
the snapshot. Process locks/sockets/logs, embedded assets, and injected SMTP/S3
credentials are excluded. Archives are confidential: use private bucket access and
transport encryption. Server-side bucket encryption is provider-managed; this
format does not add client-side encryption. Keep credential recovery separately.

An uploaded archive is downloaded and SHA-256 verified before success is recorded.
Only this instance's correctly named, ownership-marked archives older than 30 days
are pruned, after a new backup succeeds. Foreign keys and unrelated prefixes are
untouched. Bucket versioning can retain old versions beyond this application policy;
configure provider lifecycle deliberately if strict physical deletion is required.
A daily schedule can lose up to a day of writes after total volume loss.

For manual upgrades, run this command in the current container (the configured
automatic deployment hook runs it for enrolled instances):

```sh
pocketcontext-container prepare-upgrade
```

It stops the writer, verifies and uploads a complete backup, then leaves the service
paused. Keep its successful receipt and advance the PocketDeploy digest pin using
stop-first delivery. The new image verifies the receipt still matches every stopped
file and verifies the remote archive before invoking the new binary. A stale receipt
or changed data forces a fresh stopped backup. A backup failure prevents the new
binary from running migrations. An upgrade without preparation also takes that
backup before starting, which can exceed ONCE's 120-second budget; preparation is
therefore recommended. If deployment is postponed, restart the original image to
resume service; this invalidates its prepared receipt. Never use a newer image to
open an old volume merely to inspect it.

## Disaster restore

Preserve the source volume if it still exists and stop/fence its writer first.
Choose an exact successful backup key. Mount a separate **empty** destination volume
and run the image's `restore BACKUP_KEY` command with the same runtime configuration.
Restore verifies the remote checksum, manifest, safe archive paths, every file hash,
SQLite integrity and all original hashes before publishing recovered state. It never
silently initializes missing data or restores over an existing project.

Prefer the exact source revision recorded in the backup. Start the recovered image
with the normal command. A restore marker forces the backend to revoke old reader
sessions and pending email OTPs before serving; old MCP authorization files are
removed and assistants must reconnect. This prevents disaster recovery from reviving
a session revoked after the backup. Normal restarts and upgrades preserve sessions.
Owner email/domain changes are not an implicit recovery operation.

Verify the recovered evidence, reader email login, MCP consent and a new verified
backup before pointing traffic at the destination. Keep the old volume until the
recovery is accepted. Image rollback alone is not database rollback; preserve later
writes and deliberately restore the appropriate backup when schema changes require it.

## Validation

`uv run tests/hosted_deploy_workflow.py -v` checks stale-release refusal, exact-digest
SSH delivery, host-key requirements and all-target public health using synthetic
executables. `python3 docker/test_backups.py -v` exercises populated backup/restore, checksums,
original-file integrity, retained runtime state, credential revocation markers,
archive path safety, ownership-scoped retention, writer locks and failed upgrade
backup gates using synthetic local fixtures. `python3 docker/smoke.py --image IMAGE`
checks the actual image's initialization, public boundary, MCP discovery, populated
persistence, SIGKILL recovery and graceful shutdown. `uv run docker/recovery.py --image IMAGE`
uses the real image and a synthetic HTTPS S3 service to rehearse upload, download,
pre-upgrade pause, populated restoration, original checksums and revocation of old
reader/MCP credentials. Synthetic tests do not prove
production email delivery or S3 account permissions; verify those during provisioning.
