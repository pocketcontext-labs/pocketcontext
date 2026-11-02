# 0.16.1 validation

## Candidate checks (2026-11-02)

Linux arm64, Go 1.27.3, synthetic projects and isolated temporary homes:

- Built the candidate with CGO and the repository build tags, reporting 0.16.1.
- Full `go test ./...` with those tags passed. Existing tests cover session
  detection, skipped reader setup, launcher handling, authenticated one-time
  reader links and preservation of CLI sessions. The generated-prompt test
  verifies invitation round-trip and the new release pin.
- `tests/name_check.py --binary bin/pocketcontext` and the complete
  `tests/e2e.py --binary bin/pocketcontext` suite passed.
- The actual CLI pairing rehearsal passed with the candidate binary: generated
  prompt to stdin join, managed forward, authenticated single-use reader-code
  redemption, saved-connection stop/reconnect, automatic SSH and explicit reader
  skipping, and rejection of used invitations and occupied ports. Its relay is
  local and synthetic; this is not a public-relay or two-computer rehearsal.
- The six Node development/navigation tests and fifteen Python Obsidian importer
  unit tests passed.

Prompt, skill and manual review checks the server-agent return checkpoint,
late desktop reader-link generation, immediate clickable fallback, recovery
without repeating authenticated pairing, and separate CLI/tunnel/reader reports.
No autonomous agent followed the full conversation on two physical computers,
and no interactive macOS or Windows desktop result is claimed by these checks.

Native CI and release workflow results, published-installer verification and
website rendering/deployment checks are separate evidence. This patch changes
instructions and embedded documentation, not the authentication protocol,
database format or session-detection implementation.
