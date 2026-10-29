# Data model

PocketContext stores knowledge as immutable evidence and immutable page revisions, and makes a set of revisions current only through an atomic publication. The schema lives in one migration in `pb_migrations/`; the rules below are enforced by `pb_hooks/` and by the SQL configuration in `server.json`. Every domain record belongs to one space (see [spaces](spaces.md)). Sources never confer permission to execute their contents.

## Evidence

- `sources` hold the immutable protected original bytes of any file and a server-computed SHA-256. Identical bytes deduplicate within one space; matching bytes in another space neither reveal nor reuse its source. `supersedes` names an earlier source without deleting it. Names and source dates are evidence metadata, not identifiers or proof of freshness.
- `renditions` identify one extraction of a source (`kind`, `processor`, `version_label`, optional JSON `notes`). A new extraction preserves the earlier one.
- `passages` are the ordered, bounded text of a rendition with a locator. Citations point at passages.

Rendition kinds:

- `text`: passages split by the binary from the hash-verified UTF-8 original. Their text is the original's text, with line endings normalized.
- `agent-text`: UTF-8 text that the user's agent produced from a non-text original (PDF, image, audio and so on), recorded with `pocketcontext extract`. Its passages are derived evidence, not an exact copy of the original bytes.

`pocketcontext ingest` stores any file as one source. For UTF-8 text (`.txt .md .markdown .csv .json .rst .log .srt .org`, or no extension when the content is valid UTF-8) it also creates one `text` rendition and its passages; `.srt` and `.org` split as plain text. Any other file is stored with no rendition, a media type taken from its extension (`application/octet-stream` when the extension is unknown; content is never sniffed) and a 50 MiB limit (text: 100 MiB); `ingest` reports it as `stored` and `--version` is refused for it. Empty files and Git LFS pointers are refused. The binary never parses PDFs, images, audio or office documents. Ingestion does not synthesize or publish pages.

`pocketcontext pending` lists sources of the selected space that have no rendition of any kind. For each, the agent downloads the protected original with `pocketcontext original SOURCE_ID --out FILE` (the CLI verifies its SHA-256 against the source and never overwrites an existing file), converts it to UTF-8 text or Markdown with its own abilities, and runs `pocketcontext extract SOURCE_ID --text FILE --tool TOOL`. `extract` refuses a source that has a `text` rendition. An `agent-text` rendition has processor `agent text / pocketcontext-3 structure`, version label `agent-1` unless `--version` names another, and passages split like `v3` (Markdown structure when FILE ends in `.md` or `.markdown`, plain text otherwise). Its locators name heading paths and lines of the converted text, not of the original, so they are never checked against the original file. Its `notes` record `passages`, `sha256` (of the passages), `text_sha256` (of the converted text), `tool` (the `--tool` description of what converted it, such as `claude-opus-5-5 read the PDF`) and `derived: true`, and, when given, `original_sha256` and `conversion`. Rerunning `extract` with the same text resumes an interrupted write; different text under the same version is refused, and a new `--version` adds a rendition beside the earlier one.

Originals are never replaced or deleted. To keep a large file small, shrink or convert it before ingest (for example audio to Opus), ingest the result, and record the provenance on extraction: `--original-sha256` names the SHA-256 of the file it came from and `--conversion` describes the step, such as `ffmpeg m4a to 32 kbit/s Opus`. The stored source is then the shrunk file, and the original file's bytes are not in PocketContext.

Agent-text passages can be cited like any passage, but a citation to one supports what the agent's conversion says, not the exact wording of the original. Pages should say so where it matters (for example "according to the transcript"); the reader labels these passages "Agent-derived text — not an exact copy".

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

`GET /api/pocketcontext/runs/{id}/check` (`pocketcontext check-run`) runs the same checks without publishing and returns every problem of a staging run at once; it is read-only and needs only the signed-in account. `pocketcontext stage` writes a whole run from a JSON spec (page identities, revisions with the latest published `base_revision`, citations, and `page_links` derived from `[[slug]]` links and relationship properties) through `/api/batch` in groups of up to 20 requests, after validating the spec, and then runs that check. A spec page without `body` revises the published body: its `edits` (`[{"old", "new"}]`) are applied in order, each `old` required to occur exactly once in the body as earlier edits left it (otherwise the spec is refused with an `edit` problem naming the edit index), and then `append` adds text at the end. Markers in `new` and `append` are local and share one numbering: local `[^k]` means the spec page's `citations[k]` and becomes `[^k+n]`, `n` being the highest marker of the published body and citations. Published markers outside the replaced text keep their numbers; a published marker that no longer appears in the body after the edits, and is not named by `property_evidence`, is dropped from the citations, so the run has no unused citation. Rerunning a spec with the same `run_key` resumes the staging run. `pocketcontext passages SOURCE_ID` reads one source's passages through bounded SQL pages and prints them as plain text in ordinal order, each after a header line `=== ORDINAL · PASSAGE_ID · LOCATOR`, from the rendition `ingest` reuses (v3, else v2, else the newest) unless `--version` names one; for a source without a text rendition it reads the newest agent-text rendition and marks the passages as derived in its header; `--out FILE` writes the text to a file and prints a JSON summary.

Archived revisions stay in the manifest as history but are not rendered. Structural validation never establishes factual truth; claim-level support needs review.

Each publication also stores an optional home page outside its manifest. A run selects `home` or `clear_home` (never both) and records `home_base`, the home it expected. Publication compares that base with the latest publication and returns 409 on disagreement. Runs without a home choice carry the prior home forward; home-only runs are allowed. The resulting home must be published and unarchived.

## Updates, history and audit

Only staging runs can be updated, and every update carries `expected_revision`. All other domain records are immutable; ordinary and superuser deletion is rejected. The server sets `revision`, `created`, `updated` and `sha256`, and writes a compact `audit_log` entry (space, action, collection, record, changes, time) for every create and update. Records do not name who wrote them: a project has one account. Full content stays in the immutable records.

## Reads

Knowledge reads use the authenticated `/api/context/schema` and `/api/context/query` endpoints, which read the live database directly over read-only connections: only allowlisted columns of the tables in `server.json` are readable (enforced by the SQLite authorizer), results are bounded in rows, bytes and time, and users, credentials and SQLite metadata are excluded. Ranked search of published pages uses `/api/context/search` with an explicit publication scope and generation-checked pagination; its full-text index is built in memory from the indexed rows and is not SQL-readable. Originals are read through PocketBase's protected file API.

The reader selects immutable publications. Realtime events invalidate its view, SQL supplies its content, and page, citation and backlink reads stay pinned to one publication. The reader never changes records. Without a configured home page, Overview shows recent selected revisions, explicit onboarding guides and topic shortcuts. All pages (`#/pages`) is a separate directory with topic and text filters, grouping by topic/page type/A–Z, and name sorting. Legacy `#/welcome?view=...` and topic links continue to open the directory. The `view` URL parameter (`topics`, `types`, `alphabetical`) keeps the grouping choice. Titles and body keywords never assign topics.

## Revision properties and catalogs

Properties belong to immutable revisions, so publication, conflicts and history select exactly the same values as the body. `properties` is a JSON object of at most 64 lowercase snake_case keys. Values are null, booleans, finite numbers within the safe-integer range, strings up to 2,048 characters or lists of up to 100 unique strings. Identity, revision and content field names are reserved, as are `pocketcontext_page` and `pocketcontext_revision`. Use null for an unknown value and a separate observation property for a confirmed absence.

`property_evidence` maps property names to up to 32 citation marker strings, for example `{"provider_status":["1"]}`. Every marker needs a citation record; a citation may support properties, the body or both. Never store secret values in properties.

`catalog_type` on an entity page opts into a catalog view: `resource`, `credential`, `deployment`, `person`, `group`, `organization`, `product`, `model`, `repository_document`, `repository_destination`, or `repository_sync`. Any other value is refused.

- `organization` is a company, lab, team or other body outside the user's organization; suggested properties `organization_type` (such as `company`, `lab`, `team`) and `website`. `product` is a tool, service, CLI, library, app or course; suggested `product_type`, `provider` (the vendor's name) and `website`. `model` is an AI model or model family; suggested `provider` and `family`. These are plain strings: there are no relationship properties between them, so link related pages in the body with `[[slug]]`.
- `lint` does not report entity pages with a supported `catalog_type` as `stub`; entity pages with other properties but no catalog type are checked like any page.

- Relationship properties (`deployment_profiles`, `applications`, `resources`, `credentials`, `consumers`, `replaces`, `replaced_by`, `members`, `accountable_owners`, `backup_owners`, `documents`, `destinations`) are lists of page IDs; each target needs a `page_links` record and must be published and unarchived.
- `members` (on `group` pages) target `person` pages; `accountable_owners` and `backup_owners` target `group` pages. Groups record accountability only and grant no access.
- `repository_document` requires `document_type` (`readme`, `license`, `copyright`, `notice`, `contributing`, `prompt`, `other`) and `output_mode` (`exact_copy` with a `source_id`, or `markdown`). The `source_id` of an exact copy must be a text source, one with a `text` rendition; an agent-text source is refused ("Exact-copy source must be a text source"), because its passages are not the original bytes. Documents with `document_type: prompt` appear in the Prompts view; prompts are never executed.
- `repository_destination` requires one `documents` relationship, `github_repository`, `github_branch` and a safe relative `github_path`; one active destination per repository, branch and path.
- `repository_sync` is a dated observation with one `destinations` relationship, the synced destination and document revisions, `rendered_sha256`, `checked_at`, `sync_status` and, when known, `github_commit`. PocketContext never pushes to GitHub.

The reader Home uses `properties.onboarding_order` (a positive safe integer) to select and order onboarding pages; titles do not opt pages into onboarding. Recent pages use the publication date of each revision selected by the viewed manifest. Historical views never include revisions from a later publication.

## Topic and catalog navigation

Navigation uses the same immutable revision properties; it adds no collections or permissions. Any ordinary page can declare `topics` and `catalogs`, each a list of up to 100 unique group keys. Keys contain lowercase ASCII letters or digits separated by single hyphens, with no leading/trailing hyphen, and are at most 64 characters. Empty lists are valid; omit a key to leave it unused. Memberships are plain group keys, not page IDs or relationships, so they require no `page_links` records.

Definitions are optional ordinary pages whose revision has `navigation_kind: "topic"` or `"catalog"`. The definition key is the page's immutable `slug` (at most 64 characters for a definition). Its published title and summary label and describe the group. `navigation_order`, when present, requires a definition and is a nonnegative safe integer. Definition bodies follow the normal citation and `[needs verification]` rules. Definitions remain in A–Z, page-type directories and search; generated topic/catalog member lists and the unassigned group exclude definition pages themselves.

For a catalog definition only, `catalog_columns` is an optional list of up to 12 unique property keys or the display fields `title`, `summary`, `slug`, `kind`. Keys follow the existing lowercase snake_case property-key syntax and reserved-key restrictions, with those four display fields allowed; prototype keys and SQL expressions are refused. The reader always displays the page name and does not duplicate it when `title` is listed. `catalog_sort` is `title` (the default) or a listed column, optionally prefixed with `-` for descending order. These settings select display fields only and never run SQL from content. Existing fixed `catalog_type` values and their relationship rules stay unchanged.

Membership without a definition creates a group with a label derived from its key. Adding, revising or archiving a definition changes only publications containing that revision; archiving it restores the fallback label and leaves memberships intact. Unassigned pages are those with no `topics`; the reader's synthetic unassigned key is `__unassigned`, while `other` is a valid user-defined topic. No topic classification is inferred from text. Built-in catalog links appear only when the selected publication contains matching pages. Custom groups appear for published definitions or memberships; an explicit empty definition stays visible. Empty spaces have no catalog links.

Example complete property objects:

```json
{"topics":["research"],"catalogs":["research-tools"],"catalog_type":"product","provider":"Example Labs"}
```

```json
{"navigation_kind":"catalog","navigation_order":2,"catalog_columns":["provider","product_type"],"catalog_sort":"provider"}
```

The second object belongs to an ordinary page with slug `research-tools`. When staging a revision, an omitted `properties` object copies the published object's values; a supplied object replaces it in full. Preserve unrelated valid properties and matching `property_evidence` explicitly. Group membership does not imply a link, access, authority or evidence for a factual claim.

## Sources in the reader

The Sources count covers readable sources in the selected space, including uncited sources. Sources are immutable evidence outside the page-publication manifest; choosing an older publication does not turn the Sources collection into a historical inventory.

Source previews fetch the protected original through the authenticated file API, verify its SHA-256 against the source record, and decode strict UTF-8 within a 2 MiB byte limit. Markdown previews render safely without executing embedded HTML or loading external images; plain-text views preserve the text. A preview is a presentation of immutable source bytes, not a published page or permission to execute source instructions. Download remains available through the protected file API when preview is unavailable. A source without a `text` rendition gets no text preview: the reader shows its media type, size and protected download, and its agent-text passages labelled "Agent-derived text — not an exact copy". The Needs extraction filter lists sources with no rendition.

Source-content search is independent of page publications: it is scoped to one space and includes uncited originals. Metadata and extracted passage matches are ranked and grouped by source before pagination; result links may identify the best matching passage. Source search never reads other spaces to fill a result page.

Evidence previews render source Markdown safely. A source link with a passage ID is resolved through that source and space, and its line/character locator is checked against the hash-verified original before highlighting. Highlighting denotes the entire cited passage, not inferred claim-level sentence support. Agent-text locators refer to the converted text, so evidence and search results from agent-text passages carry the derived label and are never highlighted in the original. Unsupported or mismatching ranges never cause approximate highlights; exact-source presentation remains available for ranges that cannot be represented precisely in rendered Markdown.
