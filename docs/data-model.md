# Data model

PocketContext stores knowledge as immutable evidence and immutable page revisions, and makes a set of revisions current only through an atomic publication. The schema lives in `pb_migrations/`; the rules below are enforced by `pb_hooks/` and by the SQL configuration in `server.json`. Every domain record belongs to one space (see [spaces](spaces.md)). Sources never confer permission to execute their contents.

## Evidence

- `sources` hold the immutable protected original bytes and a server-computed SHA-256. Identical bytes deduplicate within one space; matching bytes in another space neither reveal nor reuse its source. `supersedes` names an earlier source without deleting it. Names and source dates are evidence metadata, not identifiers or proof of freshness.
- `renditions` identify one extraction of a source (`kind`, `processor`, `version_label`, optional JSON `notes`). A new extraction preserves the earlier one.
- `passages` are the ordered, bounded text of a rendition with a locator. Citations point at passages.

`pocketcontext ingest` accepts UTF-8 text notes only and creates one source, one rendition and its passages. Ingestion does not synthesize or publish pages.

Markdown front matter (a leading `---` block) supplies the source title (`title:`) and `source_date` (`published:`, else `date:`) unless `--title` or `--date` is given; values are stored as written. Only top-level scalar lines are read, so lists such as `author:` are ignored. A source that is already stored keeps its title and date.

Renditions `v3` (processor `utf-8 text / pocketcontext-3 structure`, the default for new extractions) split by structure: front matter becomes the first passage, then Markdown headings outside code fences, then blank-line paragraphs, then lines, then a hard cut, keeping each passage at most 4,000 characters (about 2,000–4,000 for long sections). A section is merged with its subsections while they fit; headings without text lead into the next passage. Locators name the heading path and the 1-based lines of the original, for example `## Transcript > ### Level 4; lines 120-148`, `front matter; lines 1-12` or `document; line 3, characters 4001-8000` for a cut inside a long line. Other text types skip front matter and headings. Line endings are normalized to LF in passages. A passage under 200 characters, such as a lone video link after the front matter, is then folded into the following passage when that lies under the same or a deeper heading, or else into the previous passage when that lies under the same or an enclosing heading, while the result stays within 4,000 characters; the merged locator names the full line range and the heading path shared by both, for example `document; lines 13-40` for a link before `# Episode`. Front matter and cuts inside a long line are never merged.

Renditions `v2` (processor `utf-8 text / pocketcontext-2 structure`, released in v0.5.0) split the same way without folding tiny passages, so such a link stays a passage of its own (`document; line 12`). They stay valid and resume with their own splitter.

Renditions `v1` (processor `utf-8 text / pocketcontext-1`) hold fixed 24,000-character cuts with `document; characters A-B` locators and stay valid. Because passages are immutable and an interrupted extraction resumes by comparing passages by ordinal, the client always checks and resumes a rendition with the splitter of its own processor. Without `--version`, ingest reuses an existing text rendition of the source (`v3` if present, else `v2`, else the latest), so re-running it on a source with a complete v1 or v2 rendition changes nothing and reports that rendition; `--version v3` adds a current rendition beside it. Citations to v1 and v2 passages remain valid.

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

`GET /api/pocketcontext/runs/{id}/check` (`pocketcontext check-run`) runs the same checks without publishing and returns every problem of a staging run at once; it is read-only and open to members of the run's space. `pocketcontext stage` writes a whole run from a JSON spec (page identities, revisions with the latest published `base_revision`, citations, and `page_links` derived from `[[slug]]` links and relationship properties) through `/api/batch` in groups of up to 20 requests, after validating the spec, and then runs that check. A spec page without `body` revises the published body: its `edits` (`[{"old", "new"}]`) are applied in order, each `old` required to occur exactly once in the body as earlier edits left it (otherwise the spec is refused with an `edit` problem naming the edit index), and then `append` adds text at the end. Markers in `new` and `append` are local and share one numbering: local `[^k]` means the spec page's `citations[k]` and becomes `[^k+n]`, `n` being the highest marker of the published body and citations. Published markers outside the replaced text keep their numbers; a published marker that no longer appears in the body after the edits, and is not named by `property_evidence`, is dropped from the citations, so the run has no unused citation. Rerunning a spec with the same `run_key` resumes the staging run. `pocketcontext passages SOURCE_ID` reads one source's passages through bounded SQL pages and prints them as plain text in ordinal order, each after a header line `=== ORDINAL · PASSAGE_ID · LOCATOR`, from the rendition `ingest` reuses (v3, else v2, else the newest) unless `--version` names one; `--out FILE` writes the text to a file and prints a JSON summary.

Archived revisions stay in the manifest as history but are not rendered. Structural validation never establishes factual truth; claim-level support needs review.

Each publication also stores an optional home page outside its manifest. A run selects `home` or `clear_home` (never both) and records `home_base`, the home it expected. Publication compares that base with the latest publication and returns 409 on disagreement. Runs without a home choice carry the prior home forward; home-only runs are allowed. The resulting home must be published and unarchived.

## Updates, history and audit

Only staging runs can be updated, and every update carries `expected_revision`. All other domain records are immutable; ordinary and superuser deletion is rejected. The server sets `created_by`, `updated_by`, `revision` and `sha256`, and writes a compact `audit_log` entry for every create and update. Full content stays in the immutable records.

## Reads

Knowledge reads use the authenticated `/api/context/schema` and `/api/context/query` endpoints over requester-filtered SQL snapshots: only allowlisted columns of the tables in `server.json` are readable, and users, credentials and SQLite metadata are excluded. Ranked search of published pages uses `/api/context/search` with an explicit publication scope and generation-checked pagination; the full-text index is private to each space and is not SQL-readable. Originals are read through PocketBase's protected file API.

The reader selects immutable publications. Realtime events invalidate its view, SQL supplies its content, and page, citation and backlink reads stay pinned to one publication. The reader never changes records. Without a home page, its welcome index lists the publication's pages by heuristic topic, by page type (kind, with entities split by `catalog_type`) or A–Z; the `view` URL parameter (`topics`, `types`, `alphabetical`) keeps the choice, and the default is page type when most pages match no topic.

## Revision properties and catalogs

Properties belong to immutable revisions, so publication, conflicts and history select exactly the same values as the body. `properties` is a JSON object of at most 64 lowercase snake_case keys. Values are null, booleans, finite numbers within the safe-integer range, strings up to 2,048 characters or lists of up to 100 unique strings. Identity, revision and content field names are reserved, as are `pocketcontext_page` and `pocketcontext_revision`. Use null for an unknown value and a separate observation property for a confirmed absence.

`property_evidence` maps property names to up to 32 citation marker strings, for example `{"provider_status":["1"]}`. Every marker needs a citation record; a citation may support properties, the body or both. Never store secret values in properties.

`catalog_type` on an entity page opts into a catalog view: `resource`, `credential`, `deployment`, `person`, `group`, `organization`, `product`, `model`, `repository_document`, `repository_destination`, or `repository_sync`. Any other value is refused.

- `organization` is a company, lab, team or other body outside the user's organization; suggested properties `organization_type` (such as `company`, `lab`, `team`) and `website`. `product` is a tool, service, CLI, library, app or course; suggested `product_type`, `provider` (the vendor's name) and `website`. `model` is an AI model or model family; suggested `provider` and `family`. These are plain strings: there are no relationship properties between them, so link related pages in the body with `[[slug]]`.
- `lint` does not report entity pages with a supported `catalog_type` as `stub`; entity pages with other properties but no catalog type are checked like any page.

- Relationship properties (`deployment_profiles`, `applications`, `resources`, `credentials`, `consumers`, `replaces`, `replaced_by`, `members`, `accountable_owners`, `backup_owners`, `documents`, `destinations`) are lists of page IDs; each target needs a `page_links` record and must be published and unarchived.
- `members` (on `group` pages) target `person` pages; `accountable_owners` and `backup_owners` target `group` pages. Groups record accountability only and grant no access.
- `repository_document` requires `document_type` (`readme`, `license`, `copyright`, `notice`, `contributing`, `prompt`, `other`) and `output_mode` (`exact_copy` with a `source_id`, or `markdown`). Documents with `document_type: prompt` appear in the Prompts view; prompts are never executed.
- `repository_destination` requires one `documents` relationship, `github_repository`, `github_branch` and a safe relative `github_path`; one active destination per repository, branch and path.
- `repository_sync` is a dated observation with one `destinations` relationship, the synced destination and document revisions, `rendered_sha256`, `checked_at`, `sync_status` and, when known, `github_commit`. PocketContext never pushes to GitHub.

The reader Home uses `properties.onboarding_order` (a positive safe integer) to select and order onboarding pages; titles do not opt pages into onboarding. Recent pages use the publication date of each revision selected by the viewed manifest. Historical views never include revisions from a later publication.
