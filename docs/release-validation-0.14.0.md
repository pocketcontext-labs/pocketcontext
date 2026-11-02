# 0.14.0 validation

## Candidate checks (2026-11-02)

On Linux arm64, using a candidate built with version 0.14.0:

- The complete Go test suite passed with the repository's build tags.
- The name check and CLI end-to-end suite passed, including authenticated remote reader-code issuance, redemption and preservation of the CLI session.
- The existing profile/manual rehearsal passed: named projects, distinct ports, manual export and import reruns, cited guide publication, reader activation, rename reconciliation and profile removal preserving data.
- The complete Chromium reader regression passed. A separate client home signs in through a code, requests a reader link with remote `open`, and reaches Overview in a fresh browser. Reusing the browser code is refused, and the CLI remains signed in.
- The CLI pairing rehearsal uses separate server/client homes and a local test relay. It extracts the invitation from the actual generated prompt, joins through stdin, checks the managed forward and authenticated reader link, installs the remote skill, stops and reconnects, and checks idempotent reconnect, used-code cleanup and occupied-port refusal. This rehearsal is also required by the test and release workflows on every supported platform.
- A separate public-relay rehearsal passed using two isolated homes on the same Linux arm64 host: generated prompt, stdin join, reader-code redemption, remote skill installation, headless host, managed stop and saved reconnect.
- Release tooling unit tests passed.

These checks exercise real processes and an actual browser, but are not a rehearsal of an autonomous agent installing on two physical computers. The website's rendering, copy/download, immutability and analytics tests are recorded in its own prompt provenance. Native platform and released-installer checks run in the release workflow.

## Access and lifecycle checks

Only authenticated project users can issue a remote reader code; an absent or invalid token and a mismatching Host are refused. Codes expire at the two-minute boundary and are single use. The client validates its saved server identity before sending its token, validates the returned reader link, and does not put its reusable token in the link or output.

Managed forwards hold an OS lock and publish a private heartbeat. Stop requests target a random worker generation rather than an arbitrary recorded PID. Failed pairing stops only a worker started by that attempt; a successful CLI connection remains available if browser opening fails. Client processes retain no project database or server local key. Invites are deliberately printable for the authorized setup-chat handoff; diagnostic output and background logs do not intentionally echo invitation data.
