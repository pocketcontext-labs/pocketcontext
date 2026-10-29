# Knowledge schema

Sources may hold any file. The binary extracts UTF-8 text itself; other formats are converted by you and recorded with `extract` as derived `agent-text` renditions (see [Convert non-text sources](workflows.md#convert-non-text-sources)). Repository-document properties remain in the schema, but this build never exports or pushes files.

Use `pocketcontext schema` for live SQL columns and `pocketcontext check` for differences from `schema.json`. Business reads use explicit columns. SQL returns `{columns, rows, truncated}`; never act on a truncated result as if complete. Page or narrow the query.

Every domain table has an immutable `space`. A project has one user, so SQL returns rows of every space. Filter by `space` when you mean one space.

| Collection | Content and invariants |
| --- | --- |
| spaces | `name` (1-200 characters, not necessarily unique), `archived`, `revision`, `created`, `updated`. Partitions of the knowledge; never deleted. A new project has one space, `Default`. Manage them with `create-space`, `rename-space`, `archive-space`, `restore-space`; renames and archive changes need `expected_revision`. An archived space is readable but refuses writes. |
| settings | One row, `projectsettings`: `default_space`, `revision`. Root records created without a `space` go to the default space; the default cannot be archived and an archived space cannot become the default. Change it with `default-space SPACE`. |
| sources | `space` (defaults to the default space), `title`, `original_name`, `media_type`, `source_date`, `sha256`, optional same-space `supersedes`, protected required `original`. Immutable. Server computes SHA-256 from stored bytes, unique per space. Originals of any type are stored in `storage/` beside the database; `media_type` comes from the file extension (`application/octet-stream` when unknown). A source with no rendition still needs extraction (`pocketcontext pending`). `ingest` fills `source_date` from `--date` or Markdown front matter (`published:`, else `date:`). |
| renditions | `source`, `kind`, `processor`, `version_label`, `notes`. Immutable extraction provenance. Unique source/kind/version. Client notes contain extraction count/hash for retry checks. `ingest` creates `v3` (processor `utf-8 text / pocketcontext-3 structure`); `v2` (`utf-8 text / pocketcontext-2 structure`, tiny passages kept apart) and `v1` (`utf-8 text / pocketcontext-1`, fixed 24,000-character cuts) stay valid. `kind` is `text` for these. `extract` creates `kind` `agent-text` (processor `agent text / pocketcontext-3 structure`, default version `agent-1`): text you converted from a non-text original, derived evidence and not an exact copy. Its JSON `notes` hold `passages`, `sha256`, `text_sha256`, `tool`, `derived: true` and, when given, `original_sha256` and `conversion`. |
| passages | `rendition`, positive `ordinal`, `locator`, `body` (30,000 characters maximum). Immutable, unique rendition/ordinal. v2 and v3 passages hold at most 4,000 characters (v3 folds passages under 200 characters into a neighbour); locators give heading path and lines (`## A > ### B; lines 12-30`, `front matter; lines 1-8`). Agent-text passages split like v3; their lines are lines of the converted text, not of the original. |
| ingestion_runs | `space` (as for sources), `key` unique per space, `status` (`staging`, `published`, `cancelled`), `description`, `sources` (up to 100), `issue`, optional `home` page ID, `home_base` expected previous home page ID, and `clear_home`. Home and clear are mutually exclusive; empty home with clear false carries the previous choice. New runs must be staging. Only staging runs can change. |
| pages | `space` (as for sources), stable `slug` unique per space, `kind` (`summary`, `concept`, `entity`, `transcript`, `answer`, `legacy`). Immutable identities; slug uses lowercase ASCII words and hyphens. `index` and `log` are reserved. |
| page_revisions | `run`, `page`, `base_revision`, `title`, `summary`, `body`, `archived`, flat JSON `properties`, JSON `property_evidence`. Immutable. One revision per page per run. Base is the published revision ID, empty for a new page. |
| citations | `page_revision`, `passage`, numbered string `marker`, optional `note`. Immutable, unique revision/marker. |
| page_links | `page_revision`, `target` page identity. Immutable, unique pair. |
| publications | Server-owned `space`, `sequence` increasing per space, `run`, immutable `manifest` mapping page IDs to published revision IDs, optional `home` page ID, `created`. |
| audit_log | Server-owned space, action, collection, record, changes and timestamp. There is no actor: the project has one account. |

The project's one account lives in `users`, which is not SQL-readable.

Renditions, passages, page revisions, citations and page links take `space` from their parent; a supplied `space` must match. Every referenced source, passage, page, revision, link target, relationship target and home page must belong to the same space; references to another space fail exactly like missing IDs (HTTP 404).

Writable records have server-managed `revision`, `created`, `updated`; do not submit them. A run update requires `expected_revision` from a fresh read. Original attachments are uploaded as multipart form data through the records API; the normal JSON create command cannot upload file bytes.

Publishing changes the run status through the records API. In one transaction the server verifies page base revisions, expected home, citation markers, and links against the latest publication of the run's space, creates that space's next manifest, closes the run and records history. HTTP 409 means reassess against the current publication in a new run. Failed publication exposes no partial published pages. Staging records remain readable but are not published knowledge.

Body markers use `[^1]`. Create corresponding citation records; do not embed footnote definitions in the body. The reader renders definitions. Body `[[target-slug]]` links require page_links records. Link targets must be present and unarchived in the resulting publication. Uncited prose must explicitly contain `[needs verification]`; this structural allowance does not establish factual accuracy.

The authenticated search endpoint is separate from SQL. Index `pages` takes a required publication ID as `scope`; manifest values select revisions before pagination, and archived revisions are excluded. Index `sources` takes a space ID as `scope` and covers source metadata and passage text. The server builds each index in memory from the indexed rows; its generation changes when those rows change. No FTS table is SQL-readable. Search results may be incomplete when `hasMore`/`truncated` is true; paginate using the same scope and generation.

Revision properties follow the [catalog workflow](workflows.md#catalog-properties).
`topics` and `catalogs` contain canonical group slugs, not relation IDs. Optional
definition pages use `navigation_kind` and their immutable page slug; see the
[reader navigation workflow](workflows.md#reader-navigation). No new collection
or authorization rule is involved.
Relationship properties contain stable page IDs and are checked against the resulting
publication and require matching page_links records for each target. `catalog_type` supports resource, credential, deployment, person, group, organization, product, model, repository_document, repository_destination and repository_sync entities; other values are refused.
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
must match the original source, and an exact copy's `source_id` must be a text source (one with a `text` rendition); an agent-text source is refused. 

Prompt catalog entries are repository documents with `document_type: prompt`, not
an additional catalog type. Optional prompt metadata follows the flat property
contract; see [catalog properties](workflows.md#catalog-properties). Destinations remain optional and copying
never executes the prompt.
