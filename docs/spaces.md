# Spaces

Spaces are the access boundary. Every domain record carries a required `space`; references, citations, links, publication manifests, home choices and catalog relationships stay within one space. Source hashes, run keys, page slugs and publication sequence numbers are unique per space.

## Project default

A new project creates only the initial account's Personal space with that account as its sole owner; later accounts receive their own Personal spaces. Company is not created for new projects. Existing databases retain their saved default, including databases restored or opened on another computer. Legacy projects with a Company (`companyspace001`) default keep it. No existing knowledge moves, and existing Company spaces keep their name and membership rules.

The default policy belongs to the database, not a computer or an account ID. Bundle startup marks a database as new only when no working database exists after synchronized-file recovery and before PocketBase bootstrap. The migration writes a private `project_policy` record once: `personal` for a new database, `company` otherwise. The record travels with complete backups and synchronized snapshots; it is not exposed in ordinary REST or SQL. No ordinary policy-changing endpoint exists.

Authenticated `GET /api/spaces/default` returns `{id, kind, name, policy}` for the signed-in account. For a Personal-first project it resolves the personal space owned by that account; for a legacy Company-default project it resolves Company. It checks active account and membership, never creates a space, never reactivates a membership, and never falls back to another space when access is missing. An inaccessible default returns not found.

## Membership

Active `owner` and `editor` memberships permit writes; active `reader` memberships permit reads. SQL snapshots, REST, realtime and protected originals check membership independently. A record in another space and a missing record produce the same not-found response.

Account creation (`init`, `account`) on new projects creates only that account's Personal space and sole owner membership atomically. Where Company already exists, new accounts retain the existing Company editor admission behavior. Existing spaces and memberships are not removed on upgrade. An inactive membership is a revocation and is never reactivated by sign-in. Authenticated accounts can create named group spaces, atomically becoming their sole owner. These spaces are private until an operator explicitly adds members. Membership changes remain superuser-only; the hooks validate trusted writes with revision checks and audit entries.

## Personal spaces

A Personal space has one fixed owner and is visible only to that owner. On existing projects, the reader's Create personal space button and `pocketcontext create-personal-space` explicitly create one through authenticated `POST /api/spaces/personal`. The endpoint returns `{"id": "SPACE_ID"}` and is idempotent, including when a new project already created the space. Creating one does not change an existing project's Company default or move existing knowledge.

## Reader and client

Without a space in the URL, the reader resolves the signed-in account's project default. An explicit unavailable space is an error, never a silent switch. Navigation preserves the selected `space` in links.

`--space ID` overrides `POCKETCONTEXT_SPACE`; without either, the client resolves the same authenticated project default. `pocketcontext whoami` reports the selected space, and `pocketcontext spaces` lists visible memberships with a `selected` flag. If the default is inaccessible, `spaces` still lists available memberships without selecting a replacement. Use `--space companyspace001` only on projects where Company already exists; create additional spaces explicitly on new projects.

Raw SQL spans every space the account can read, so filter by `space`. Child records inherit their parent's space. Ordinary root record creates without a space use the same project default; superuser root creates must name a space explicitly. Explicit choices retain their independent membership and write-role checks.

## Reader space management

Manage spaces beside the selector creates a named space, opens existing spaces, and lets active owners rename their spaces. Writes use the standard spaces REST collection; names contain 1–200 characters and updates require `expected_revision`. A stale revision returns 409 and the reader reloads the current metadata before another attempt. Editors and readers cannot rename or archive a space. Creator, kind and membership fields cannot be changed through these controls.

Archive is the reversible removal action. It sets `archived: true` with the same ownership and revision checks, hides the space from the ordinary selector (except an explicitly selected archived space), and blocks ordinary content writes. Existing authorized links, sources and publication history remain readable. Show archived spaces exposes Restore. Archiving does not revoke membership or erase evidence, and direct deletion remains blocked. Company and Personal spaces cannot be archived, so the project's default stays available. Owners can rename Personal without changing its identity or default policy.
