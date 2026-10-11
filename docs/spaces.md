# Company and optional personal spaces

Existing knowledge belongs to the stable Company space `companyspace001`.
Unqualified agent writes and browser page links continue to target Company.
The display name is not used to identify the company boundary.

Each domain record carries a required `space` relation. Active owner/editor
memberships permit writes; active reader memberships permit reads. SQL filtered
snapshots, ordinary REST, realtime and protected originals independently enforce
membership. Foreign and missing records have the same not-found behavior.
References, citations, links, publication manifests, home choices and catalog
relationships must remain within one space. Source hashes, run keys, page slugs
and publication sequence numbers are unique per space.

## Membership and admission

The populated migration gives existing enabled users company editor membership.
Disabled users receive inactive membership. No person is inferred to be a company
owner. The company membership API remains operator-only, with revision checks and
audit history. Operators may revoke or restore company membership; login and token
refresh never reinstate a revoked membership. Newly created enabled Workspace
accounts receive company editor membership in the account-creation transaction.
Workspace verification and blocked public signup remain unchanged.

Personal spaces are explicit opt-in. The browser's Create personal space button
or `wikicontext create-personal-space` calls authenticated
`POST /api/wiki/spaces/personal`. It returns `{ "id": "SPACE_ID" }` and is
idempotent. Each personal space has one fixed owner. Creation does not change the
CLI default or move existing knowledge. Ordinary callers cannot create group
spaces or manage memberships. Catalog People/Groups remain knowledge identities
and accountability metadata, not authentication or membership records.

A superuser is trusted provisioning authority, but an ordinary user's SQL session
never inherits superuser visibility. Membership is rechecked for requests; already
exported files and content previously delivered to a browser cannot be recalled.

## Reader and client

The reader starts in Company. The selector appears when multiple spaces are
available, and explicitly requested unavailable spaces produce an error instead
of silently selecting another space. Personal links retain `space` in URL state.
Old unscoped slug links select Company; explicit publication/source/passage IDs
resolve to their own authorized space. Switching clears stale page/evidence state.

`--space ID` overrides `WIKICONTEXT_SPACE`; otherwise the client uses Company.
`wikicontext spaces` lists visible memberships. Raw SQL can see all authorized
spaces and must explicitly filter for one space. Child writes inherit their
parent's space; roots without a space retain the company default.

Exports and repository-file exports pin a publication within the selected space.
Obsidian destination manifests record space identity and reject cross-space reuse.
A legacy manifest without space identity can be adopted only by Company, after
existing server/ownership/local-edit checks. Use separate export destinations.
The new package must be published, then the production launcher repinned and
verified from an unrelated directory before release. Older installed clients
assume a single shared publication history and must not be used with personal data.

## Populated migration and release

Migration `1791500000_spaces.js` runs transactionally. It adds only space metadata
to existing domain rows, preserving IDs, revision numbers, timestamps, citations,
publication manifests, home choices, audit entries and original-file bytes. It
creates memberships and scoped uniqueness, then removes the derived shared FTS
index. It does not republish, re-ingest or move evidence to a personal space.
Private search requires the server commit in `POCKETCONTEXT_VERSION`.

`tests/spaces_migration.py` starts the exact pre-spaces source `7cf5d45`, seeds
synthetic records through REST, applies the migration and compares every original
domain field and file hash. It also injects a late migration failure to prove
transactional rollback. `tests/spaces.py` exercises independent access paths,
references, membership revocation, role checks and per-space publication.

There is no down migration: restore the verified pre-migration checkpoint together
with its old image. Do not start an old image on a database containing spaces, or
use a demo reset/empty-database migration on production. Follow the
[predeployment recovery and clone assessment](predeployment-recovery.md).
