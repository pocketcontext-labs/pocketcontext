# Knowledge schema

Use `wikicontext schema` for live SQL columns and `wikicontext check` for differences from `schema.json`. Business reads use explicit columns. SQL returns `{columns, rows, truncated}`; never act on a truncated result as if complete. Page or narrow the query.

Every domain table has an immutable `space`. SQL returns only rows of spaces where you are an active member. Filter by `space` when you mean one space.

| Collection | Content and invariants |
| --- | --- |
| spaces | `kind` (`personal`, `group`), `name`, `created_by`, `revision`. One personal space per account. Server-managed: personal creation uses the explicit `/api/wiki/spaces/personal` endpoint; membership changes require operator maintenance. |
| space_members | `space`, `account`, `role` (`owner`, `editor`, `reader`), `active`. Your memberships and your co-members' memberships of shared spaces. |
| sources | `space` (required on create; defaults to the company space), `title`, `original_name`, `media_type`, `source_date`, `sha256`, optional same-space `supersedes`, protected required `original`. Immutable. Server computes SHA-256 from stored bytes, unique per space. Default audio sources contain mono 24 kHz encoder-input/32 kbps Opus `.ogg` bytes processed by Gemini, not the input recording bytes; explicit legacy Groq retains 16 kHz/16 kbps. |
| renditions | `source`, `kind`, `processor`, `version_label`, `notes`. Immutable extraction provenance. Unique source/kind/version. Client notes contain extraction count/hash for retry checks. Default normalized audio notes also contain input filename/hash, conversion settings and converter version; the stored Ogg already embeds the input hash, profile and converter version before transcription. |
| passages | `rendition`, positive `ordinal`, `locator`, `body` (30,000 characters maximum). Immutable, unique rendition/ordinal. |
| ingestion_runs | `space` (as for sources), `key` unique per space, `status` (`staging`, `published`, `cancelled`), `description`, `sources` (up to 100), `issue`, optional `home` page ID, `home_base` expected previous home page ID, and `clear_home`. Home and clear are mutually exclusive; empty home with clear false carries the previous choice. New runs must be staging. Only staging runs can change. |
| pages | `space` (as for sources), stable `slug` unique per space, `kind` (`summary`, `concept`, `entity`, `transcript`, `answer`, `legacy`). Immutable identities; slug uses lowercase ASCII words and hyphens. `index` and `log` are reserved. |
| page_revisions | `run`, `page`, `base_revision`, `title`, `summary`, `body`, `archived`, flat JSON `properties`, JSON `property_evidence`. Immutable. One revision per page per run. Base is the published revision ID, empty for a new page. |
| citations | `page_revision`, `passage`, numbered string `marker`, optional `note`. Immutable, unique revision/marker. |
| page_links | `page_revision`, `target` page identity. Immutable, unique pair. |
| publications | Server-owned `space`, `sequence` increasing per space, `run`, immutable `manifest` mapping page IDs to published revision IDs, optional `home` page ID, `created`. |
| audit_log | Server-owned space, action, collection, record, actor/type (`user`, `superuser`, `system`), changes and timestamp. |
| user_directory | Safe user ID/name projection: yourself and active co-members of your shared spaces only; auth records are excluded from SQL. |

Renditions, passages, page revisions, citations and page links take `space` from their parent; a supplied `space` must match. Every referenced source, passage, page, revision, link target, relationship target and home page must belong to the same space; references to another space fail exactly like missing IDs (HTTP 404).

Writable records have server-managed `revision`, `created_by`, `updated_by`, `created`, `updated`; do not submit them. A run update requires `expected_revision` from a fresh read. Original attachments are uploaded as multipart form data through the records API; the normal JSON create command cannot upload file bytes.

Publishing changes the run status through the records API. In one transaction the server verifies page base revisions, expected home, citation markers, and links against the latest publication of the run's space, creates that space's next manifest, closes the run and records history. HTTP 409 means reassess against the current publication in a new run. Failed publication exposes no partial published pages. Staging records remain visible to active members of their space but are not published knowledge.

Body markers use `[^1]`. Create corresponding citation records; do not embed footnote definitions in the body. The exporter renders definitions. Body `[[target-slug]]` links require page_links records. Link targets must be present and unarchived in the resulting publication. Uncited prose must explicitly contain `[needs verification]`; this structural allowance does not establish factual accuracy.

The authenticated search endpoint is separate from SQL. Index `pages` takes a required publication ID of a space you can read as `scope`; manifest values select revisions before pagination. The server builds a private index from your visible rows; its generation changes when your visible data changes. No FTS table is SQL-readable. Search results may be incomplete when `hasMore`/`truncated` is true; paginate using the same scope and generation.

Revision properties follow the [catalog workflow](workflows.md#catalog-properties).
Relationship properties contain stable page IDs and are checked against the resulting
publication and require matching page_links records for each target. `catalog_type` supports resource, credential, deployment, person, group, repository_document, repository_destination, repository_sync and audio_recording entities.
`members` links groups to people; `accountable_owners` and `backup_owners` link to
groups. Membership is accountability metadata without authentication significance.
Citation markers may be
used in the body or `property_evidence` (or both). JSON SQL values may need decoding.

Repository files use existing entity pages and revision properties, not new collections.
`documents` links each repository destination to one document; `destinations` links
each sync observation to one destination. Both require page links and typed targets.
Documents declare `document_type`, `output_mode` and an immutable `source_id` for
exact copies. Destinations declare `github_repository`, `github_branch` and safe
relative `github_path`. Sync observations pin `synced_document_revision` and
`synced_destination_revision`, with intended-byte `rendered_sha256`, `checked_at`,
`sync_status` and a Git commit (optional for pending/unknown). Exact-copy hashes
must match the original source. See [repository files](workflows.md#repository-files).

Prompt catalog entries are repository documents with `document_type: prompt`, not
an additional catalog type. Optional prompt metadata follows the flat property
contract; see the prompt workflow. Destinations remain optional and copy/export
never executes the prompt.

Audio recording entities reference an immutable `audio_source_id` and may pin a
`selected_bundle_rendition_id`. `transcript_pages` and `summary_pages` are typed
page relationships. See the [audio catalog workflow](workflows.md#audio-recording-catalog).
