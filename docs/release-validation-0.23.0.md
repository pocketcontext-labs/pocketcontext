# PocketContext 0.23.0 validation

Implementation and local validation on 4 November 2026, Linux arm64, Go 1.27.3.
All knowledge tests use synthetic temporary projects. This record distinguishes
component tests from actual provider account linking.

## Automated checks

- Reader typecheck, all 230 tests, and production asset build passed.
- `CGO_ENABLED=1 go test -tags "$(cat build-tags.txt)" ./...` passed.
- Bundle and client package race tests passed.
- Built the stripped 0.23.0 binary; repository/binary name check passed.
- Full `tests/e2e.py` passed, including immutable evidence, authenticated access,
  snapshot write-back and remote-client behavior.
- `tests/upgrades.py` passed: mismatch refusal, clean upgrade, complete-backup
  rollback, preserved evidence and identity alongside 0.15.0.
- Release assembly unit tests, launcher/navigation JavaScript tests, and importer
  unit tests passed.

## MCP and OAuth coverage

The official Go SDK negotiates MCP 2025-11-25 and exposes 29 typed tools. Tests
cover per-request identity isolation, administrative route rejection, arbitrary
path rejection, malformed/oversized input, cancellation, bounded output, and
redaction of protected-file credentials in transport errors.

A synthetic headless server rehearsal exercises the SDK tools and bounded API
adapter against real authenticated knowledge request hooks: deduplicated ingest,
source passages, cited staging, run validation, atomic publication, conflicting
publication rejection, immutable-record rejection, search, lint, spaces,
hash-verified originals and client-derived text extraction. This fixture injects
the ordinary account identity; OAuth is tested separately.

OAuth tests cover discovery, registration, S256 PKCE, exact callback/resource
binding, code expiry and replay, restart persistence, account token-key changes,
revocation, failed state persistence, rate/body limits and disabled endpoints.
Public-client refresh rotation/replay revocation and confidential basic/post
client authentication with persistent refresh tokens are checked separately.

The opt-in Playwright browser test uses synthetic TLS and a synthetic client,
not a Google account. It checks an existing reader sign-in link without entering
the password, consent retry in another tab, escaped client metadata, the actual
selected callback, token exchange, an authenticated middleware request, and
browser revocation. Layout checks cover 390px and 320px. Synthetic TLS trust is
relaxed only inside that test; it is not evidence of public certificate issuance.
The browser test runs in the Linux browser CI job.

## Product and provider boundaries

Actual Gemini authorization, refresh and mobile tool use require a user account
and remain unverified by these tests. No phone attachment transfer, connector
voice support, external DNS/TLS, certificate renewal or real-host reboot was
claimed. MCP file content is explicit and bounded to 4 MiB; non-text conversion
stays on the client. Source ingestion alone does not publish knowledge.

Native release builds, published-download installer checks and website deployment
are performed by their respective GitHub workflows. Inspect the workflows for
the tagged commit rather than treating this local record as cross-platform or
live-site evidence. The website's separate validation covers preview content,
prompt immutability and analytics, not a completed human setup walkthrough.
