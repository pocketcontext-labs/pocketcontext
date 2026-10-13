# Prompts catalog release — 13 October 2026

Released application revision: `2146d2c36e1332e954f5347678849bfab55bc65a`.
Portable client package: `eaf04f8baa111bb301b32809345db7e4d11b5399`.
PocketContext remains pinned to `4b03d2905a34d9a606cb313e118d6874e74f0548`.

[Release CI](https://github.com/pocketcontext/wikicontext/actions/runs/38356871035)
passed application, browser, container configuration, smoke and strict object
storage/Litestream recovery checks on native AMD64 and ARM64, then published
images and archives and deployed through the guarded single-writer dispatcher.

Independent read-only runtime inspection found one running WikiContext container
at the expected full revision. Its image ID and repository digest were
`sha256:e712291c72996da8c3e28cff50fd7f08e1abe373989838a4247e7594d668f5e6`.
Inspection emitted only allowlisted runtime fields. The default OCI inventory
lookup returned HTTP 401; verification used the existing scoped SSH authority,
known production address and strict host-key checks without provisioning keys or
changing infrastructure configuration.

Public health returned 200; anonymous SQL-schema access returned 401. Both served
reader assets matched the tested local production build byte-for-byte. The
ordinary-user CLI schema check passed. Authenticated browser verification using
an existing ordinary-user session confirmed prompt preview, copied-text hash,
filter persistence through reload and mobile layout. This was not a new
interactive Google login. The approved initial prompt was classified by a new
wiki revision and its existing repository copy was reverified unchanged.

Local validation passed all 30 README backend commands, eight additional release
and checkpoint checks, 17 rehearsal unit tests, frontend typechecking, 111 UI unit
tests and production build. The 23 existing browser scenarios passed; the added
prompt scenario passed after correcting its accessible filter labels and fixture
provenance. Native release CI subsequently passed the full 24-scenario suite.
An unchanged copied launcher resolved the published package from an unrelated
directory and passed ordinary and tracing-enabled synthetic skill workflows.

Prompts reuse repository documents with `document_type: prompt`; there is no
schema migration, new collection or automatic execution. Existing content is not
automatically classified. Reader previews/copies/downloads are bounded to 8 MiB
of UTF-8 text; originals retain protected access and checksum verification.
