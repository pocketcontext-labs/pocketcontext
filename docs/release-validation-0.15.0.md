# 0.15.0 validation

## Candidate checks (2026-11-02)

The Linux arm64 candidate was checked with synthetic projects and isolated homes:

- The full Go suite with the repository build tags, repository/binary name check,
  and complete CLI end-to-end suite passed.
- The profile/manual rehearsal passed with two independent projects, dedicated
  skills, distinct ports, manual export/import, cited publication and explicit
  profile reconciliation.
- The CLI pairing rehearsal passed with managed forwards and authenticated
  remote reader access.
- The native installer rehearsal passed: fresh installation, existing-binary
  refusal before download, expected-version replacement, checksum failure and
  absent/non-file destinations. Release tooling unit tests also passed.
- The cross-version rehearsal downloaded the published 0.14.0 archive and checked
  its release checksum. Separate 0.14.0 and 0.15.0 projects ran concurrently. The
  new client refused the old running server while status and stop still worked.
  Clean upgrade and complete-backup rollback preserved the project identity and
  synthetic source, while the independent project remained available.
- Regression tests cover remote compatibility checks before sending credentials,
  matching legacy profile verification, stale worker refusal, unknown application
  and PocketBase migrations, and system-migration snapshot persistence.
  Management preflight tests also preserve settings and tunnel identity when
  a running server has another version.

Both Test and Release workflows run the installer and cross-version rehearsals
on Linux amd64/arm64, macOS arm64 and Windows amd64. The release workflow also
installs and retests published artifacts. Their run results are separate evidence
from the local candidate checks above.

The website records its own Node 22 checks and immutable prompt validation. No
claim is made here of an autonomous-agent setup rehearsal, two physical computers,
or arbitrary binary-only downgrades. The upgrade procedure is explicit; this
release does not add an automatic upgrade or backup command.
