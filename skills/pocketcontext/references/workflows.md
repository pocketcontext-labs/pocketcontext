# Workflows

## Preserve, extract, synthesize, publish

1. Verify the live schema (`pocketcontext check`) and confirm the selected space (`pocketcontext spaces`). Group inputs into at most five sources per synthesis batch.
2. Run `pocketcontext ingest PATH` for each file. Exact bytes deduplicate by server SHA-256 within the space, even after lost upload responses. This build accepts UTF-8 text notes only: `.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.rst`, `.log` and extension-less text. Any other file type is rejected before upload; tell the user and suggest converting it to text or Markdown first. Git LFS pointer files fail before upload.
3. A complete rendition is reused across machines. Partial extraction resumes against immutable passage ordinals; rerun the same command after an interruption.
4. Retrieve passages with SQL, ordered by rendition and ordinal. Read all chunks. Retrieve the latest publication manifest of the space (`WHERE space = ...`) and the published pages relevant to the new sources. Use scoped full-text search for title/summary/body matches, then traverse citations and links with SQL. Keep the returned publication pinned when paging and retrieving evidence. Do not assume latest-created page revisions are published.
5. Choose a stable, descriptive run key. Query that key before creating it. If published, report the existing result. If staging, inspect staged revisions/citations/links and resume missing work. For a conflicting or unsuitable immutable draft, cancel the run with expected_revision and create a new run.
6. Create or reuse page identities. For each affected page, synthesize one revision with its current published revision ID as base_revision. Include summary, main body with citation markers, and explicit disagreements. Use `WORKSPACE/...` for local repository paths in authored prose; preserve verbatim source paths inside quotations.
7. Create citations pointing to exact passages and page_links pointing to page identities. Ensure every factual claim has evidence or `[needs verification]`. Synthesis can affect many pages; the server's atomic publication is separate from REST batches (maximum 20 requests each).
8. Re-read the run revision and update status to published with expected_revision. A conflict requires fresh evidence review and a new staging run, never blind retry. Return the publication sequence and page changes.


## Query and audit

Pin the latest published manifest of the selected space before traversing knowledge; raw SQL spans every space you can read. Retrieve relevant page revisions by its IDs and join citations to passages/renditions/sources. Bound each result, inspect `truncated`, and paginate with stable ordering. Full-text search uses a separate fixed endpoint, not SQL access to FTS tables. It searches published revision text only. Fetch source passages through SQL for evidentiary support; never attach a passage ID to an excerpt without retrieving that passage. Search pagination requires the returned publication and generation; a generation conflict requires discarding prior pages and restarting. Token matching replaces the former substring behavior; no semantic, prefix or typo matching is supplied.

For an audit, check orphan pages, missing concept pages, older claims challenged by newer evidence, explicit contradictions, and weak citation support. Server validation catches structural problems but cannot judge whether a passage supports a claim. Report numbered findings with evidence and proposed fixes; publish revisions only within the requested scope.

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

Keep a resource, credential, deployment, person or group as an `entity` page with stable identity.
Add `properties.catalog_type` as `resource`, `credential`, `deployment`, `person`, or `group`. Read the
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

