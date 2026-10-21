# Workflows

## Preserve, extract, synthesize, publish

1. Verify the live schema (`pocketcontext check`) and confirm the selected space (`pocketcontext spaces`). Group the inputs into synthesis batches (see [Batch size](#batch-size)), in source date order when views change over time.
2. Run `pocketcontext ingest PATH` for each file. Exact bytes deduplicate by server SHA-256 within the space, even after lost upload responses. Markdown front matter supplies the title (`title:`) and the source date (`published:`, else `date:`); pass `--title` and `--date` when a note has none. This build accepts UTF-8 text notes only: `.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.rst`, `.log` and extension-less text. Any other file type is rejected before upload; tell the user and suggest converting it to text or Markdown first. Git LFS pointer files fail before upload.
3. A complete rendition is reused across machines. Partial extraction resumes against immutable passage ordinals; rerun the same command after an interruption. Passages follow headings and paragraphs (at most 4,000 characters; a passage under 200 characters, such as a lone video link, joins its neighbour) with locators such as `## Transcript > ### Level 4; lines 120-148`; Markdown front matter becomes the first passage and supplies the title and `source_date` (`published:` or `date:`) unless `--title`/`--date` is given. Without `--version` an existing rendition is reused; older sources may have a v1 rendition with 24,000-character passages or a v2 rendition with tiny passages kept apart, and `--version v3` re-extracts them.
4. Read every passage of each source with `pocketcontext passages SOURCE_ID --out FILE` (plain text in ordinal order; each passage follows a header line `=== ORDINAL · PASSAGE_ID · LOCATOR`, and the `locator` names its heading path and line range), then read the file. It takes the source ID that `ingest` printed; `--version V` reads another rendition. SQL, ordered by rendition and ordinal, remains for selective reads. Retrieve the latest publication manifest of the space (`WHERE space = ...`) and the published pages relevant to the new sources. Use scoped full-text search for title/summary/body matches, then traverse citations and links with SQL. Keep the returned publication pinned when paging and retrieving evidence. Do not assume latest-created page revisions are published.
5. Choose a stable, descriptive run key. Query that key before creating it. If published, report the existing result. If staging, `stage` with the same `run_key` resumes it and skips pages already staged. For a conflicting or unsuitable immutable draft, cancel the run with expected_revision and use a new key.
6. Plan the pages (see [Page structure](#page-structure-and-maintenance)). For each existing page you revise in substance, export it with `pocketcontext page SLUG > page.json`, edit that object and put it in the spec. For targeted changes to a page that otherwise stays right (correct a figure, add a sentence, re-cite a claim), give the spec page `edits` instead: `[{"old": "exact text from the published body", "new": "replacement"}]`, each `old` occurring exactly once. Write each full revision in full: summary, body with citation markers `[^1]` mapped to exact passage IDs, `[[slug]]` links and explicit disagreements. Ensure every factual claim has evidence or `[needs verification]`. Use `WORKSPACE/...` for local repository paths in authored prose; preserve verbatim source paths inside quotations.
7. Write the spec and run `pocketcontext stage SPEC.json --dry-run`, then without `--dry-run`. `stage` creates missing page identities, sets base revisions from the latest publication, writes citations and the page links derived from the body, and writes nothing when a check fails (exit 3 with the problems). Use `edits` and `append` only for targeted changes to a page that otherwise stays right; a concept page that changed in substance is rewritten. Markers in edits' `new` text and in `append` are local (`[^1]`, `[^2]`, ... mapped by the spec page's `citations`) and share one numbering; `stage` renumbers them after the page's highest marker. Published markers you leave outside `old` keep their citations; a published marker that disappears with the replaced text loses its citation. To keep a published citation in rewritten text, leave its marker outside `old`, or cite the passage again under a local marker.
8. Run `pocketcontext check-run RUN_ID`. It lists every problem that would block publication, for all pages at once; fix them by staging again under the same key or, for a stale base revision, by re-reading the published page and preparing a new run.
9. Re-read the run and `publish RUN_ID --expected-revision N`. A conflict requires fresh evidence review and a new staging run, never blind retry. Return the publication sequence and page changes.
10. Run `pocketcontext lint` and act on its findings within the request: link unlinked mentions, create or merge pages for recurring terms, and fill or merge stubs in the next run.

`create`, `update` and `batch` remain for single records and repairs; `batch` takes up to 20 requests in one transaction (`pocketcontext help batch`).

### Batch size

One synthesis batch is one ingestion run and one publication. When writing records one by one with `create` or `batch`, keep a batch to at most five sources. With `stage` and `check-run`, a batch may hold up to 10–15 sources when they revise heavily overlapping pages (episodes of one series, chapters of one book): fewer runs mean each concept page is rewritten once per batch instead of once per five sources. Keep at most five for unrelated sources, and fewer whenever you cannot read every passage of the batch before writing. Take sources in date order so that later batches revise the views of earlier ones. Still one run per batch; never spread a batch over several runs or publish half a batch.

## Page structure and maintenance

- **One summary page per source** (`kind` `summary`): what the source says, cited to its passages, with its source date, and links to the concept and entity pages it feeds.
- **Concept pages** (`concept`): give a term its own page once it recurs in two or more sources, or when `lint` reports it as `missing-page`. Keep one idea per page; link related concepts instead of folding them into one large page.
- **Entity pages** (`entity`) for people, products, organizations and other named things, with catalog properties where they apply (see below). A named product, company, system, tool, model or person mentioned in two or more sources gets its own entity page, even when a broader concept page already covers it; the concept page links to it. Set `properties.catalog_type` when a supported type fits: `person`, `organization` (companies, labs, outside teams), `product` (tools, services, CLIs, libraries, apps, courses), `model` (AI models and families), `group`, `resource`, ... (see Catalog properties). Do not invent an `entity_type` or similar property instead: only `catalog_type` puts a page in a catalog and excuses it from `stub`. Resolve `lint` `missing-page` findings for names by creating such a page or by linking the name to the page that covers it.
- **A hub page**: keep one overview page (for example slug `overview`, kind `concept`; `index` and `log` are reserved slugs) that links every summary and the main concepts by theme, update it in every run that adds pages, and set it as home with `stage-home` (or `"home"` in the spec).
- **Rewrite, do not stack**: when new sources change a concept, rewrite the page as a single current synthesis that reads well on its own. Do not append dated sections. End the body with a short `## How this changed` list of dated one-line entries (for example `- 2026-03: shifted from X to Y.[^4]`), each cited.
- **Reconcile contradictions explicitly**: when sources disagree, say so in the body, cite both sides, and state which is newer, which is better supported, or that it is unresolved. Never silently keep only one side.
- **Date time-sensitive claims**: write "as of 2026-06" (from the source date) for prices, versions, rankings, roles and plans, so later readers can tell when a claim may be outdated.
- Prefer linking to repeating: when a page names another page, link it with `[[slug]]` (`lint` reports `unlinked-mention` otherwise).

## Query and audit

Pin the latest published manifest of the selected space before traversing knowledge; raw SQL spans every space you can read. Retrieve relevant page revisions by its IDs and join citations to passages/renditions/sources. Bound each result, inspect `truncated`, and paginate with stable ordering. Full-text search uses a separate fixed endpoint, not SQL access to FTS tables. It searches published revision text only. Fetch source passages through SQL for evidentiary support; never attach a passage ID to an excerpt without retrieving that passage. Search pagination requires the returned publication and generation; a generation conflict requires discarding prior pages and restarting. Token matching replaces the former substring behavior; no semantic, prefix or typo matching is supplied.

For an audit, start with `pocketcontext lint`. Its structural findings (`broken-link`, `orphan`, `no-citations`, `needs-verification`, `missing-property-citation`, `invalid-property-target`) need fixing; its editorial hints need judgment:

- `unlinked-mention` (`page`, `target`, `term`): the page names another page's title or slug words, as whole words outside code, without linking it. Link it unless the words mean something else there.
- `missing-page` (`term`, `pages`): a term appears on three or more pages and no page has that title or slug. Terms are `**bold**` text (except field labels such as `**Video:**` opening a line or list item), Markdown link text and capitalized names in prose (title-case runs such as "Mario Zechner", single capitalized words not opening a sentence such as "Cloudflare", product-like tokens such as "OpenCode" or "GPT-5.5"); common words, weekdays, months and names that are whole words of a page title or slug (punctuation ignored: "Anysphere" is part of "Cursor (Anysphere)", "ZTE" of "ZTE: zero-touch engineering") are skipped. Create an entity page for a named thing (or a concept page for an idea) and link it from those pages, or add the term to an existing page's title if it is the same thing. Leave a finding only when the name is incidental.
- `stub` (`page`, `words`, `citations`): under 80 words of prose or a single citation (entity pages with a `catalog_type` excluded; other entity pages are checked even when they carry properties). Expand it from the evidence, merge it into a broader page, or leave it when it is complete.

Then check older claims challenged by newer evidence, explicit contradictions, and weak citation support. Server validation catches structural problems but cannot judge whether a passage supports a claim. Report numbered findings with evidence and proposed fixes; publish revisions only within the requested scope.

## Choose the reader home page

Home belongs to an immutable publication; `/#/` remains the dynamic home route.
Create a staging run or reuse your current staging run, then select a page:

```sh
pocketcontext stage-home RUN_ID_________ --home onboarding --expected-revision 1
pocketcontext publish RUN_ID_________ --expected-revision 2
```

Use actual returned IDs and run revisions. `stage-home` resolves the slug and captures
`home_base` from the latest publication when the choice is staged. Publishing without
home flags preserves that choice and base, including after a failed publication.
A run may only change home without staging page revisions. The selected page must
be present and unarchived in the resulting manifest; archiving the current home
requires choosing a replacement or clearing it in the same run.

Use `stage-home RUN_ID --clear-home --expected-revision N` to restore the welcome index. Runs without either choice carry the previous home forward. Historical
home links such as `/#/?publication=PUBLICATION_ID` use that publication's choice;
explicit page links continue to select their requested page.

A concurrent home change produces HTTP 409 (exit 4) and leaves the run staged.
Re-read the latest publication and reassess the choice; never automatically replace
its expected base or retry. `stage-home` refuses to refresh an already-staged choice
unless an explicit `--home-base PAGE_ID` is supplied after review. Use `--home-base ''`
when you expect no configured home. After reassessment, an explicit example is:

```sh
pocketcontext stage-home RUN_ID_________ --home onboarding --home-base PAGE_ID________ --expected-revision 2
pocketcontext publish RUN_ID_________ --expected-revision 3
```

For a reviewed immediate choice, `publish` also accepts `--home SLUG` or
`--clear-home`, but requires explicit `--home-base PAGE_ID` (or `''`). It never
fetches a replacement base implicitly. Published home choices remain in publication
history; run audit changes also record staging home fields, without copying page prose.

## Catalog properties

Keep a resource, credential, deployment, person, group, organization, product or model as an `entity` page with stable identity.
Add `properties.catalog_type` as `resource`, `credential`, `deployment`, `person`, `group`, `organization`,
`product`, or `model` (repository files use the `repository_*` types below); any other value is refused. Read the
published revision and full supporting passages before preparing a replacement;
copy forward still-valid properties and property evidence explicitly. Revisions do
not merge omitted fields. Use normal staging, base revision checks and publication.
Do not classify existing pages merely from their names or rewrite historical revisions.

Properties are flat JSON: null, boolean, finite number within ±9007199254740991,
string (up to 2,048 characters), or up to 100 unique strings. Use at most 64 keys,
matching `[a-z][a-z0-9_]{0,63}`. Nested maps are not supported. Identity, content,
and revision keys are reserved. Use consistent types; ISO dates
are strings. Distinguish unknown/null, confirmed absence and missing observations.

Use `provider`, `provider_account`, `provider_id`, `exact_name`, `jurisdiction`,
`lifecycle_status`, `provider_status`,
`provider_observed_at`, `consumer_verification`, and `next_review` as applicable.
Credential metadata may include `permission_groups`, `scope`, `expires_at`,
`expiry_observation` and `secret_reference`. Never include secret values: every
member of the space shares access. A secret reference describes protected storage;
it does not authorize retrieving or executing its contents.

Relationship keys `deployment_profiles`, `applications`, `resources`, `credentials`,
`consumers`, `replaces`, `replaced_by` contain arrays of actual queried page IDs.
Targets must be published and unarchived in the resulting publication. Create
a matching page_links record for every relationship target, as for `[[slug]]` links in the body.

For people, reuse existing entity identities after reviewing their published
revisions and source evidence. Suggested fields are `role`, `organization` and
`crm_url`; use an actual verified CRM reader link, not an inferred record ID.
For organizations (companies, labs and teams outside the user's organization), suggested
fields are `organization_type` (such as `company`, `lab` or `team`) and `website`. For products
(tools, services, CLIs, libraries, apps, courses), use `product_type`, `provider` (the vendor's
name) and `website`. For AI models and model families, use `provider` and `family`. These are
plain strings, not relationships: link the vendor's or family's page in the body with `[[slug]]`.
For groups, use `purpose` and `members`, an array of person page IDs. Membership
is stored only on the group: derive a person's groups from the selected
publication. Nested groups are unsupported.

Use `accountable_owners` and `backup_owners` as arrays of group page IDs. These
and `members` require matching `page_links` records and correctly typed targets
in the resulting publication. Stage new people, the group and owned resources
in the same run when needed. Reclassifying or archiving a referenced page also
requires resolving its incoming relationships. Preserve unrelated properties,
evidence and links when replacing revisions. Legacy `accountable_owner` and
`backup_owner` scalar text remains readable; adopt group relationships only
after reviewing the assignment, rather than treating old text as a person ID.

People and group catalog views are read-only. Membership and ownership are
accountability metadata, not auth identities, access grants or notification
recipients. Do not provision users, change permissions, send messages or perform
automatic CRM synchronization as part of membership maintenance. Historical
memberships and derived responsibilities use that publication's revisions.

Create ordinary citations, then map property names to their marker strings in
`property_evidence`, such as `{"provider_status":["1"]}`. Each mapping must name
an existing property; lists contain at most 32 unique markers. A citation may
support properties without also appearing in the body. Evidence is optional but
missing evidence is not verification. Date provider observations and human
assessments separately and review whether each cited passage supports its claim.
Keep caveats, unresolved contradictions and explanations in the Markdown body.

Query properties through a pinned publication manifest, never by selecting the
latest revision timestamp. Catalog filters search structured values separately
from full-text title/summary/body search. Change properties only through new revisions.

