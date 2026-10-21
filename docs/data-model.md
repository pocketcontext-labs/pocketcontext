# Data model

PocketContext stores knowledge as immutable evidence and immutable page revisions, and makes a set of revisions current only through an atomic publication. The schema lives in `pb_migrations/`; the rules below are enforced by `pb_hooks/` and by the SQL configuration in `server.json`. Every domain record belongs to one space (see [spaces](spaces.md)). Sources never confer permission to execute their contents.

## Evidence

- `sources` hold the immutable protected original bytes and a server-computed SHA-256. Identical bytes deduplicate within one space; matching bytes in another space neither reveal nor reuse its source. `supersedes` names an earlier source without deleting it. Names and source dates are evidence metadata, not identifiers or proof of freshness.
- `renditions` identify one extraction of a source (`kind`, `processor`, `version_label`, optional JSON `notes`). A new extraction preserves the earlier one.
- `passages` are the ordered, bounded text of a rendition with a locator. Citations point at passages.

`pocketcontext ingest` accepts UTF-8 text notes only and creates one source, one rendition and its passages. Ingestion does not synthesize or publish pages.

## Pages and runs

Pages have immutable stable slugs (`^[a-z0-9]+(-[a-z0-9]+)*$`; `index` and `log` are reserved) and kinds (`summary`, `concept`, `entity`, `transcript`, `answer`, `legacy`). Each immutable page revision belongs to one staging ingestion run and records the previously published revision it expects (`base_revision`), title, summary, Markdown body, archive flag, `properties` and `property_evidence`. Citations connect numbered body markers (`[^1]`) to passages. Page links connect a revision to stable page IDs; every `[[slug]]` in a body needs a matching `page_links` record.

Runs have unique caller-supplied keys and status `staging`, `published` or `cancelled`. Only staging runs change; revisions, citations and links may be added while staging. Correct a mistake by cancelling the run and staging a replacement. A revision is not current merely because it exists.

## Publication

A revision-checked update that moves a run to `published` validates every staged revision and writes one immutable publication whose manifest maps each page ID to its selected revision ID. Inside the same transaction the hook compares every staged base revision with the latest manifest of the space; a difference returns 409, and the agent rereads and reassesses in a new run. Publication, run state, manifest and audit entries commit together.

Publication rejects:

- body footnote definitions (they are rendered from citations), citation markers without a citation record and citations without a marker;
- prose without any citation unless it contains `[needs verification]`;
- `[[slug]]` links and relationship properties without a `page_links` record;
- links or relationships to pages that are absent or archived in the resulting manifest, including links from unchanged published pages to a newly archived page;
- more than 10,000 pages in one manifest.

`GET /api/pocketcontext/runs/{id}/check` (`pocketcontext check-run`) runs the same checks without publishing and returns every problem of a staging run at once; it is read-only and open to members of the run's space. `pocketcontext stage` writes a whole run from a JSON spec (page identities, revisions with the latest published `base_revision`, citations, and `page_links` derived from `[[slug]]` links and relationship properties) through `/api/batch` in groups of up to 20 requests, after validating the spec, and then runs that check. A spec page with `append` extends the published body; its local markers are renumbered after the page's highest marker. Rerunning a spec with the same `run_key` resumes the staging run.

Archived revisions stay in the manifest as history but are not rendered. Structural validation never establishes factual truth; claim-level support needs review.

Each publication also stores an optional home page outside its manifest. A run selects `home` or `clear_home` (never both) and records `home_base`, the home it expected. Publication compares that base with the latest publication and returns 409 on disagreement. Runs without a home choice carry the prior home forward; home-only runs are allowed. The resulting home must be published and unarchived.

## Updates, history and audit

Only staging runs can be updated, and every update carries `expected_revision`. All other domain records are immutable; ordinary and superuser deletion is rejected. The server sets `created_by`, `updated_by`, `revision` and `sha256`, and writes a compact `audit_log` entry for every create and update. Full content stays in the immutable records.

## Reads

Knowledge reads use the authenticated `/api/context/schema` and `/api/context/query` endpoints over requester-filtered SQL snapshots: only allowlisted columns of the tables in `server.json` are readable, and users, credentials and SQLite metadata are excluded. Ranked search of published pages uses `/api/context/search` with an explicit publication scope and generation-checked pagination; the full-text index is private to each space and is not SQL-readable. Originals are read through PocketBase's protected file API.

The reader selects immutable publications. Realtime events invalidate its view, SQL supplies its content, and page, citation and backlink reads stay pinned to one publication. The reader never changes records.

## Revision properties and catalogs

Properties belong to immutable revisions, so publication, conflicts and history select exactly the same values as the body. `properties` is a JSON object of at most 64 lowercase snake_case keys. Values are null, booleans, finite numbers within the safe-integer range, strings up to 2,048 characters or lists of up to 100 unique strings. Identity, revision and content field names are reserved, as are `pocketcontext_page` and `pocketcontext_revision`. Use null for an unknown value and a separate observation property for a confirmed absence.

`property_evidence` maps property names to up to 32 citation marker strings, for example `{"provider_status":["1"]}`. Every marker needs a citation record; a citation may support properties, the body or both. Never store secret values in properties.

`catalog_type` on an entity page opts into a catalog view: `resource`, `credential`, `deployment`, `person`, `group`, `repository_document`, `repository_destination`, or `repository_sync`.

- Relationship properties (`deployment_profiles`, `applications`, `resources`, `credentials`, `consumers`, `replaces`, `replaced_by`, `members`, `accountable_owners`, `backup_owners`, `documents`, `destinations`) are lists of page IDs; each target needs a `page_links` record and must be published and unarchived.
- `members` (on `group` pages) target `person` pages; `accountable_owners` and `backup_owners` target `group` pages. Groups record accountability only and grant no access.
- `repository_document` requires `document_type` (`readme`, `license`, `copyright`, `notice`, `contributing`, `prompt`, `other`) and `output_mode` (`exact_copy` with a `source_id`, or `markdown`). Documents with `document_type: prompt` appear in the Prompts view; prompts are never executed.
- `repository_destination` requires one `documents` relationship, `github_repository`, `github_branch` and a safe relative `github_path`; one active destination per repository, branch and path.
- `repository_sync` is a dated observation with one `destinations` relationship, the synced destination and document revisions, `rendered_sha256`, `checked_at`, `sync_status` and, when known, `github_commit`. PocketContext never pushes to GitHub.
