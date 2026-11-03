# 0.17.0 validation

## Candidate checks (2026-11-03)

Linux arm64, Go 1.27.3, synthetic temporary projects:

- Built the stripped 0.17.0 candidate with CGO and all repository build tags.
- Full tagged `go test ./...`, repository/binary name check and complete
  `tests/e2e.py` passed against the final implementation.
- `TestInvitationCLIRehearsal` passed against the candidate using a local
  synthetic DERP/STUN relay. Its existing invitation, managed-forward, reader
  sign-in and independent `tunnel serve` checks remain intact. Added combined
  service checks prove server and tunnel share one PID, work with the reader TCP
  port occupied, refuse duplicate/existing-server startup without changing
  identity, and stop together with snapshot write-back on authenticated stop
  and interrupt. Forced termination leaves no detached server. Restart and
  malformed-identity startup cleanup preserve the identity, and the saved client
  forward reconnects with authenticated access across restarts.
- Focused tests cover companion startup cancellation, shutdown waiting for
  cleanup, component errors, joined cancellation/cleanup errors, joined HTTP
  closure/cleanup errors, active proxy connection closure, listener failures and
  cancellation during actual tailcat relay discovery.
- An isolated transient systemd user unit ran the combined candidate with a
  synthetic project and public relay discovery. Its server PID matched the unit
  main PID with reader TCP off. SIGKILL triggered `Restart=on-failure`; the new
  process served the same project with the same tunnel address. A normal service
  stop left neither component running and persisted the final test write. The
  transient unit was stopped afterward. No real installation was upgraded.
- `tests/upgrades.py` and `tests/release013.py` passed for compatibility guards,
  clean upgrade/backup restore, profiles, manual export and reader setup.
- Node launcher/navigation tests, importer unit tests and release-tooling tests
  passed.

Windows process interruption is not simulated as Ctrl+C by the rehearsal;
authenticated shutdown and process termination provide its portable coverage.
Native platform CI and the published installer checks are separate release gates.
No machine reboot/logout test or physical two-computer desktop walkthrough was
performed. Tailcat exposes listener errors but no general terminal-health channel;
the new lifecycle does not add a relay-availability watchdog. No database,
authentication protocol or dependency changes are introduced.
