# 0.16.0 validation

## Candidate checks (2026-11-02)

Linux arm64 checks use synthetic projects, isolated homes and temporary files:

- Full Go tests with the repository build tags cover SSH precedence, unknown
  sessions, display access, missing and wrapped browser handlers, bounded browser
  launcher dispatch, suppressed launcher output and child cleanup.
- CLI tests verify that offline environment inspection and skipped local reader
  setup create no project, and skipped remote setup makes no HTTP request or
  session file. Conflicting reader flags fail before reading invitation input.
- The end-to-end suite checks SSH reader skipping before project initialization
  and on a running headless server. Explicit manual links retain their existing
  single-use authenticated behavior.
- The actual CLI pairing rehearsal covers both automatic SSH detection and
  explicit `--skip-reader`. Both connect the authenticated CLI and managed forward
  without returning a browser sign-in link. The manual-link path still redeems a
  reader code and preserves the CLI session.
- The upgrade rehearsal uses checksum-verified published 0.15.0 and candidate
  0.16.0 binaries, with concurrent independent projects, mismatch refusal, clean
  upgrade and complete-backup rollback preserving identity and source evidence.

Native Test and Release workflows run on Linux amd64/arm64, macOS arm64 and
Windows amd64, including published-installer tests in Release. Their run results
are separate evidence from local candidate checks. The macOS implementation uses
system graphical-session and LaunchServices APIs; Windows uses process window
station and HTTP association APIs. CI compilation and headless tests do not
establish that every desktop, remote desktop, browser or SSH configuration was
interactively exercised.

The website records Node 22 rendering, prompt immutability, browser and analytics
checks separately. No autonomous-agent setup or two-physical-computer rehearsal
is claimed. Environment inspection reports capability signals, not proof that a
browser window opened, a page loaded or the user signed in.
