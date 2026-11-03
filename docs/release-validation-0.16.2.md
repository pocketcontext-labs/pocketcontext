# 0.16.2 validation

## Candidate checks (2026-11-03)

Linux arm64, Go 1.27.3, synthetic temporary projects:

- Built the 0.16.2 candidate with CGO and all repository build tags.
- Full tagged `go test ./...`, repository/binary name check and complete
  `tests/e2e.py` passed.
- Expanded `TestInvitationCLIRehearsal` passed against the candidate with a local
  synthetic DERP/STUN relay. It starts an initialized but stopped project using
  only `tunnel serve`, with an unrelated service occupying the reader port;
  verifies headless socket readiness; refuses duplicate `--new-address` without
  changing identity; pairs the authenticated client and reader; terminates the
  tunnel while preserving the server; and restarts the tunnel while preserving
  the server PID and explicitly activated TCP listener.
- Focused tests verify cancellation before startup and during initial health
  probing, unchanged tunnel identity on cancellation or release mismatch, and
  tunnel-lock release after cancellation.
- `tests/upgrades.py` and `tests/release013.py` passed: compatibility guards,
  clean upgrade/backup restore, named profiles, manual export and reader setup.
- Six Node launcher/navigation tests, fifteen importer unit tests and six
  release-tooling tests passed.

The local rehearsal verifies graceful tunnel interruption on Linux. Its existing
Windows helper falls back to terminating the tunnel process, so native Windows
coverage verifies independent server lifetime after termination rather than
interactive Ctrl+C. A physical two-computer/desktop walkthrough was not run.
Native CI, published installer checks and website deployment are separate gates.
No database, authentication protocol or dependency changes are introduced.
