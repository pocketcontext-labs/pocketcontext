# 0.18.0 validation

## Candidate checks (2026-11-03)

Linux arm64, Go 1.27.3, synthetic temporary projects:

- Full tagged `go test ./...` passed after native HTTPS integration.
- Reader typecheck, all 227 unit tests, and production asset build passed.
- Repository/binary name check and full `tests/e2e.py` passed against a stripped
  0.18.0 candidate. Upgrade/complete-backup rollback and profile/manual rehearsals
  (`tests/upgrades.py`, `tests/release013.py`) passed.
- `TestInvitationCLIRehearsal` passed against the candidate, preserving private
  client pairing, reader handoff and combined foreground tunnel behavior.
- Installer tests passed, including guarded replacement and checksum failures.
- Desktop/mobile reader browser regressions passed with synthetic sources,
  authenticated sign-in, navigation, evidence, search and space management.
- The mobile HTTPS browser smoke passed against the built reader using
  `POCKETCONTEXT_HTTPS_BROWSER_TEST=1 go test -tags "$(cat build-tags.txt)" ./internal/bundle -run TestPublicHTTPSPhoneBrowser -count=1 -v`.
  It checks link/password sign-in, session persistence on reload, source browsing,
  and public/private route isolation at a phone viewport. Chromium maps the
  synthetic hostname to an ephemeral loopback TLS port; its self-signed
  certificate bypass applies only to that browser context. No system trust
  changes or external requests occur. The Linux browser CI step runs this check.
- Release-tooling, launcher/navigation and importer unit tests passed.
- Native HTTPS tests exercise verified TLS with synthetic certificates,
  authentication and single-use codes, SQL/default-space reads, protected source
  bytes, denied private routes, Host/Origin and path handling, bounded sign-in
  throttling, spoofed-header removal and listener shutdown.
- Certificate tests check private persistent cache permissions, exact hostname
  policy, and cached certificate reuse across fresh managers over verified TLS
  with external ACME network access forbidden.
- Listener lifecycle tests cover failed second-port binding, cleanup of the
  private socket after public startup failure, and coordinated companion shutdown.
  Tests needing standard ports skip explicitly when those ports are unavailable.

Native platform CI and published installer checks are separate release gates.
No real knowledge base was upgraded. No production Let's Encrypt issuance,
long-term renewal, physical-phone sign-in or machine reboot was claimed by these
local checks. Certificate acquisition starts on the configured hostname's first
TLS connection; listener readiness is not proof of externally reachable HTTPS.

The website's new 0.18.0 prompts retain all earlier released bytes. Its typecheck,
noindex build, prompt integrity, mocked analytics variants and desktop/mobile
browser checks passed before deployment. Prompt descriptions are instructions,
not evidence that a user's domain or service has already been configured.
