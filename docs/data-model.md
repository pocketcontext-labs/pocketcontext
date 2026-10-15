# WikiContext contract

One organization shares Company knowledge through active editor membership in `companyspace001`. Personal spaces are created explicitly and are visible only to their owner. Other group spaces are operator-managed. SQL uses requester-filtered snapshots; REST, realtime and protected files independently enforce active membership. Every domain record belongs to one space; every reference must remain in that space. Verified Google Workspace JIT admits users only from the configured domain; account administration remains operator-only. SQL and REST independently enforce access. Sources do not confer permission to execute their contents.

## Authority and provenance

Sources store immutable protected original bytes and server-computed SHA-256. Identical bytes deduplicate within one space; matching bytes in another space do not reveal or reuse its source. `supersedes` identifies an earlier source without deleting it. Names and source dates are evidence metadata, not identifiers or proof of freshness. Renditions identify extraction/transcription versions; ordered immutable passages contain bounded text and locators. Adding a new extraction preserves the earlier one. Audio ingestion defaults to storing normalized mono Ogg Opus bytes (24 kHz encoder input, 32 kbps) and processing those exact bytes through a pinned Gemini Transcribe release. The source M4A or other input remains local and untouched; `--audio-storage original` preserves supplied input bytes instead. Stored Ogg provenance and private cache metadata retain input hash, conversion profile and converter version. The first audio stream is selected, its timeline reset and video discarded. Private cached bytes support retry across failures and encoder upgrades. A private workflow receipt records resumable generation/import progress; failed generation requires explicit resume and never silently falls back to another provider. The explicit legacy Groq route retains its 16 kHz/16 kbps profile. No real sources are processed during implementation tests.

`stage-audio` prepares an entity revision selecting validated imported evidence and linking reviewed transcript/summary pages in a staging run. It reuses stable published recording identities and preserves immutable history. Review and atomic publication remain separate, explicit steps; extraction alone is incomplete ingestion.

Backward segment starts and reversed intervals are preserved as timestamp warnings,
without sorting segments or changing their IDs. Invalid numbers, negative values and
timestamps beyond the duration tolerance remain fatal. The importer independently
recomputes warnings, preserves originals, and marks reversed native ranges as timing
unavailable. Immutable rendition notes carry `timing_review_required`,
`timing_warning_count` and at most ten diagnostic samples; the receipt carries the
full warning list. No warning sample contains spoken text.

Before publication, `stage-audio --timing-review-note` records the review outcome in
`timing_review_note`, bound to `timing_review_bundle_rendition_id`. The server requires
this review for warning-bearing Audio selections and citations, including derived
analysis cited without an Audio link. A review note records the reviewer's conclusion;
it does not repair timestamps or prove acoustic accuracy. Corrected evidence needs a
new extraction version. Selecting another bundle requires its own review; immutable
published reviews continue to cover the older evidence. Impossible ranges remain
unavailable in the reader even after review.

Reviewed image ingestion preserves original static PNG/JPEG/WebP bytes. An `image-review` rendition records its processor and version; JSON notes bind the review to the image SHA-256, format, encoded dimensions and review digest. Optional `related_source` and `sequence` notes identify a supplementary source and ordering, not a server-enforced relationship or recording timestamp. Use these notes to supplement audio without `supersedes`. Passage locators record a transcription, description or caption kind and a pixel region in the original encoded orientation before EXIF rotation. Corrections create a new rendition version; earlier evidence remains immutable. No schema migration or automated OCR service is required.

External transcript ingestion (`--transcript-bundle MANIFEST --audio-storage original`)
preserves the exact original recording, manifest and all declared artifact bytes as
protected sources. The v2 Gemini Transcribe bundle binds source and artifacts by
SHA-256/size and records extraction provenance. Complete validation precedes writes;
no transcription provider or conversion is invoked. Local `ffprobe` independently
verifies the duration of the preserved audio snapshot. Transcript passages belong to
a rendition of the audio source, with local segment IDs, speaker labels and second
ranges in locators; long segments map to multiple passages. Acoustic observations
have a separate rendition. A `model-observations` rendition preserves addressable
tone and uncertainty with explicit subjective/inferred labels, original segment
references and associated time ranges. Its receipt returns `observations_rendition`
and `observation_passages`, keyed by `tone000001`/`uncertainty000001` array order.
These observations are not spoken text. Analysis/translation artifacts remain derived evidence;
format variants do not independently corroborate spoken claims. Rendition notes
retain provenance links, not `supersedes`. Identical bundle/version retries resume
immutable writes; corrections require a new extraction version. Space boundaries
and ordinary file access apply independently. This uses existing schema records;
extraction does not create or publish knowledge pages.


Both `standard` (Interactions) and opt-in `long-decode` (GenerateContent) use the
same v2 bundle import command. Choose the pipeline in Gemini Transcribe, then
import with distinct `--version` labels (for example `gemini-standard-1` and
`gemini-long-decode-1`). Importing either version does not replace published
selections or citations. Review and explicitly publish a selected extraction.

Optional `configuration.generation` uses `gemini-transcribe.generation/v1` to
record pipeline/API, SDK, configured limits and per-stage attempt/hop receipts.
The importer validates this metadata before writes; the five-field `extraction`
object remains unchanged. Historical bundles without versioned generation
metadata remain importable. In Audio → Files and provenance, the hash-verified
selected manifest supplies pipeline/model, actual continuation responses and
reported token totals across recorded attempts. Continuation being enabled does
not mean it occurred. Missing counts are unavailable, not zero; counts are not a
billing invoice. Opaque continuation tokens, prompts and raw provider responses
are never generation metadata. JSON artifacts remain limited to 8 MiB.

V2 bundles require `gemini-transcribe.speaker-names/v1` and display supported names
as `Alice (SPEAKER_01)` in native transcript passages. A single consistent name
with at least one explicit model mapping is eligible; tentative, conflicting,
unsafe or duplicate names retain speaker IDs. Reviewed overrides in manifest
`speaker_names` take precedence and retain their reasons separately from model
analysis. Canonical speaker IDs, segment IDs and timestamps remain unchanged.
The protected manifest and analysis preserve naming evidence and origin, linked
by the transcript-bundle rendition. Names are extraction claims, not verified
account identities. Older bundles and missing naming metadata are rejected.
Regenerate presentations from a v2 bundle locally with Gemini Transcribe's offline
export command, then import corrections with a new `--version`; existing passages,
citations and publications remain immutable. Publishing revised pages is explicit.

Pages have immutable stable slugs and kinds. Each immutable page revision belongs to one staging ingestion run and records its expected previously published revision ID, title, summary, prose, archive flag, flat `properties` and `property_evidence`. Citations connect numbered inline markers to immutable source passages. Page links connect a revision to stable page IDs. Sources and relationships are authoritative in the database; Markdown is generated presentation. Factual synthesis remains agent work; structural validation does not establish factual truth.

## Publication

Runs have unique caller-supplied idempotency keys and status staging, published or cancelled. Only staging runs can change. Content revisions, citations and links may be added while staging; mistakes are corrected by cancelling the run and staging a replacement. Closed run content is immutable. A revision is not current merely because it exists.

A revision-checked REST PATCH transitioning a run to published validates all staged revisions and publishes one immutable manifest mapping every page ID to its selected revision ID. The hook compares each staged base revision against the latest committed manifest within the same transaction. Conflicts return 409; the agent must reread and reassess in a new run. Publication, run state, manifest and audit commit together. A page archive remains in the manifest as history but is omitted from rendered pages. Publication rejects broken links, absent citation targets, unmatched citation markers and wholly uncited prose unless marked `[needs verification]`. Claim-level evidentiary support requires semantic review.

Each publication also stores an optional home page ID, outside its unchanged manifest. Staging runs select `home` or `clear_home` (never both), and record `home_base`, the home ID expected when the choice was staged; empty means no selected home. Publication compares that base with the latest publication inside the transaction and returns 409 on disagreement. Reassess explicitly after a conflict; never refresh the base automatically. Runs without a home choice carry the prior home forward. Home-only runs are permitted. The resulting home must be present and unarchived in the new manifest, so archiving it requires a replacement or an explicit clear in the same run. Existing publications have empty home values after migration. The reader keeps `#/` as the dynamic home route, resolves historical routes against their selected publication, and opens the built-in welcome index when home is empty. Explicit page links remain stable. Immutable publications retain published home choices; run audit entries also retain staged home, expected base and clear choices.

A run may contain up to 100 source references. Skill ingestion schedules groups of five sources; batches are a workflow boundary, not a 20-request API transaction. The database may stage many separate writes. Publication scans the full current link graph, bounded to 10,000 page identities; load tests are required before raising this initial budget. The manifest is bounded to 8 MiB; client SQL response limits may become the tighter constraint. Export fails closed on truncated results. No automatic performance claim beyond the tested synthetic corpus is made.

All ordinary updates carry expected_revision. Other domain records are immutable, and ordinary and superuser record deletion are rejected. Server-owned attribution and compact audit entries track changes; full source/page content remains in immutable records rather than being duplicated in audit. Administrative collection/schema maintenance remains trusted.

## Queries and export

Knowledge retrieval uses authenticated /api/context/schema and /api/context/query, including exporter reads. Ranked published-page search uses the separate /api/context/search endpoint with an explicit publication scope and generation-checked pagination; FTS tables are not SQL-readable. Original file retrieval uses the protected PocketBase file API. SQL columns are explicitly allowlisted; users, credentials and SQLite metadata are excluded. Questions search published pages through the latest manifest, then source passages; drafts must be selected explicitly and identified as drafts.

The exporter pins one immutable publication, follows its immutable revisions and evidence, and renders a vault root containing wiki/ and raw/. It does not invoke an LLM. Source names are sanitized for presentation and disambiguated by IDs. The generated ownership manifest identifies files eligible for replacement/removal; local edits, unsafe paths and symlinks must fail before replacement. Obsidian settings and unrelated user files remain outside the exporter’s ownership. An exported original is a local copy; revoking server access cannot revoke that copy.

## Recovery and scope

The browser reader selects the same immutable publications as the exporter.
Realtime events invalidate its view; authenticated SQL supplies content, and all
page, citation and backlink reads remain pinned to one publication. Historical
views stay pinned. Browser rendering never ingests Markdown or changes records.

The production container stores immutable originals in a dedicated private S3 bucket. Litestream recovers SQLite and startup verifies every referenced remote original by its recorded hash before admitting traffic. Local-original archives are historical recovery artifacts and are no longer produced or restored by the container. Recovery requires both services and retained objects. No direct SQLite business writes or migrations ingest knowledge. Tests use isolated synthetic data.

Initial scope: text/Markdown/PDF/audio and reviewed-image ingestion helpers, agent synthesis and question workflows, revisioned publication, citations and links, structural lint, deterministic Obsidian export, auth and recovery preparation. No automatic web crawling, background autonomous LLM service, native vector dependency, two-way Obsidian synchronization, external messaging, cloud provisioning or real-data migration is included in this local implementation.

## Spaces and private search

See [spaces](spaces.md) for company defaults, membership, optional personal spaces,
per-space uniqueness, compatibility and the populated migration contract.
Publications have independent sequences, manifests and home choices in each space.
Catalog People/Groups are knowledge relationships and never grant membership.

Private FTS indexes derive from the authorized nonarchived revisions in the selected
publication. The former shared index and search_state collection are removed.
Historical publication pagination remains stable when other publications change.
Search authorization is checked before cache reuse. See [search](fts-adoption.md).

## Revision properties and catalogs

Properties belong to immutable revisions, so publication, conflict checks, history
and export select exactly the same values as the page body. Older revisions have
empty properties. No migration classifies or rewrites existing wiki content.
Use `catalog_type` (`resource`, `credential`, `deployment`, `person`, `group`,
`repository_document`, `repository_destination`, `repository_sync`, or `audio_recording`) on entity pages to
opt into the catalog reader. Other page kinds and uncategorized pages still work.

`properties` is a JSON object of at most 64 lowercase snake_case keys (1–64 ASCII
characters, starting with a letter). Values are null, booleans, finite numbers
within JavaScript's safe-integer magnitude, strings up to 2,048 characters, or
lists of up to 100 unique strings. Nested objects and mixed-type arrays are
rejected. Identity, revision, content and export system names are reserved.
The JSON field is limited to 65,536 bytes. Keep types consistent across pages.
Use null for an unknown value; distinguish absence of evidence from a confirmed
negative with a separate observation property (for example `expiry_observation`).

`deployment_profiles`, `applications`, `resources`, `credentials`, `consumers`,
`replaces` and `replaced_by` are relationship lists of stable page IDs. Publication
validates their targets against the complete resulting manifest, including when
an unchanged page refers to a newly archived page. Each relationship target requires a `page_links` record for that revision,
sharing the validated graph and backlinks with body wiki links.

`members` is a relationship list from a `group` entity to `person` entities.
`accountable_owners` and `backup_owners` are relationship lists to `group` entities.
Targets must have the required catalog type in the resulting publication; changing
or archiving a target must preserve validity for unchanged referring pages too.
Nested groups are not supported. Person memberships and responsibilities through
groups are derived from these links within the selected publication, not stored
as a second membership list. Historical publications retain their own membership
and ownership. Legacy scalar `accountable_owner` and `backup_owner` properties
remain readable; agents adopt the plural relationships in reviewed new revisions.

Person properties may include `role`, `organization` and `crm_url`; group properties
may include `purpose`. CRM links refer to reviewed existing records; there is no
automatic CRM synchronization. People pages are knowledge identities, not auth
accounts. Group membership records accountability only: it grants no permissions,
sends no notifications and changes no application access. The browser views are
read-only; agents manage membership through ordinary revision publication.

`property_evidence` maps existing property names to lists of citation marker
strings, for example `{"provider_status":["1"],"lifecycle_status":["2"]}`.
Each list has at most 32 unique positive numbered markers; the whole field is
limited to 16,384 bytes. Citation records must exist for property markers, and
citations may be used in properties, the body, or both. Evidence is optional;
structural validity never establishes factual support. Keep provider observation
dates, assessments and review dates distinct. Record unknown ownership explicitly.
Never store token values, secret keys or passwords in shared wiki properties;
credential pages hold metadata and protected-storage references only.

The exporter emits one deterministic YAML frontmatter block using safely quoted
JSON-compatible values. Relationships resolve to quoted Obsidian wiki links in
the selected publication; evidence appears in a separate Markdown section using
the same source footnotes as the body. System metadata cannot be overridden.
Properties are queried with authenticated SQL JSON functions and publication
manifest joins. Full-text body search does not index property values.

### Repository documents and copies

Repository files reuse immutable page identities, revisions, citations and atomic
publication. A document is a logical source, not a repository file location. Several
destinations can reference the same document only when they are intentionally
maintained as copies. Coincidentally identical bytes do not merge identities.

`repository_document` requires `document_type` (`readme`, `license`, `copyright`,
`notice`, `contributing`, `prompt`, `other`) and `output_mode` (`exact_copy`, `markdown`).
Exact-copy mode requires `source_id` identifying an existing immutable original;
the protected original and its server-recorded SHA-256 are authoritative bytes.
Markdown mode exports the revision body. It may place its supporting citations in
`property_evidence` to keep wiki citation markers outside the distributed body.
The exporter rejects unsupported wiki markup. Neither mode injects metadata,
notices or copyright-year changes. Templates and embedded source-code headers are
outside this implementation.

`repository_destination` requires exactly one `documents` page relationship,
`github_repository` as owner/repository, an explicit `github_branch`, and a safe
relative `github_path`. Matching `page_links` records are required. Publication
enforces one active destination per repository/branch/path; repository comparison
is case-insensitive while branch and path remain case-sensitive. Retired
destinations use `lifecycle_status: retired`; archived revisions retain history.

`repository_sync` is a separate observation page with exactly one `destinations`
relationship, `synced_destination_revision`, `synced_document_revision`,
`rendered_sha256`, `checked_at` in UTC, `sync_status`, and `github_commit` when
known. Status is `current`, `behind`, `diverged`, `pending` or `unknown`; pending
and unknown may omit the commit. Both revision references must have appeared in
published history, and the pinned destination must reference the pinned document.
`rendered_sha256` identifies the intended document output, not a divergent GitHub
file; exact-copy observations must match the immutable original's hash.
This permits historical observations to remain valid when today's mapping changes.
An observation is dated evidence, not a live GitHub query or permission to push.
The reader derives freshness against the selected publication's revisions.

Each sync check should create a new observation identity, preserving independent
attempts and partial progress across repositories. Source content does not change
when a sync observation is published. GitHub edits must be compared and reviewed
before replacing a copy; a pending pull request is not a completed rollout.

### Reusable prompts

Prompts are `repository_document` entities with `document_type: prompt`, using
exact-copy or Markdown output and the same immutable publication model. They may
exist without a GitHub destination. The Prompts reader view selects this subtype;
`prompt` is not a new `catalog_type`. One document can appear in both Prompts and
Repository files without duplicating its content or identity.

Optional descriptive properties use existing flat bounds: `purpose` (string),
`target_agents`, `required_skills`, and `inputs` (string lists),
`approval_boundaries` (string), and `last_validated_at` (ISO date string).
These are documented conventions, not new required fields or execution policy.
Use property evidence and record only validation actually performed. Missing
validation dates mean no recorded validation, not a failed or successful test.

Prompt preview, clipboard copy and download are read-only. Exact-copy text comes
from the protected immutable original, with hash and UTF-8 verification. Reader
preview/copy/download is bounded to 8 MiB of UTF-8 text; Markdown
comes from the selected revision, following the repository export markup rules.
Descriptions and provenance remain outside the copied text. Prompts never execute
inside WikiContext and do not authorize actions merely by being read or copied.

### Audio recordings

An `audio_recording` entity represents one immutable audio source. Required
`audio_source_id` refers to a same-space source with an `audio/` media type.
At most one unarchived recording entity may select that source in a publication.
Optional `selected_bundle_rendition_id` explicitly pins a same-source
`transcript-bundle` rendition. Publishing a newer extraction does not change old
revisions or their selected bundle. Sources without a bundle remain catalogable.

Optional `recorded_at` is the actual recording date (`YYYY-MM-DD`), `language` a
nonempty string, and `duration_seconds` a positive finite number. Omit unknown
values; never substitute ingestion date for recording date. Attach evidence to
metadata when available. `transcript_pages` and `summary_pages` are stable page-ID
lists targeting published, unarchived transcript and summary pages respectively,
with ordinary `page_links` records. All references remain within the same space.

Selection validates v2 bundle provenance notes, source and manifest hashes,
same-space artifact sources, and linked transcript, annotations, observations and
derived rendition identities. Reader previews additionally verify protected bytes
against source hashes and manifest declarations. Source metadata and generated
speaker names are extraction claims, not account identities or factual verification.
The Audio view keeps generated analysis separate from reviewed summaries, marks
timestamps approximate, and does not execute content or publish anything.
