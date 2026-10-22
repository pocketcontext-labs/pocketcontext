# Spaces

Spaces are the access boundary. Every domain record carries a required `space`; references, citations, links, publication manifests, home choices and catalog relationships stay within one space. Source hashes, run keys, page slugs and publication sequence numbers are unique per space.

## Project default

A new project creates and selects each account's own Personal space automatically. Existing databases keep Company (`companyspace001`) as their default, including databases restored or opened on another computer. No existing knowledge moves, and Company keeps its name and membership rules.

The default policy belongs to the database, not a computer or an account ID. Bundle startup marks a database as new only when no working database exists after synchronized-file recovery and before PocketBase bootstrap. The migration writes a private `project_policy` record once: `personal` for a new database, `company` otherwise. The record travels with complete backups and synchronized snapshots; it is not exposed in ordinary REST or SQL. No ordinary policy-changing endpoint exists.

Authenticated `GET /api/spaces/default` returns `{id, kind, name, policy}` for the signed-in account. For a Personal-first project it resolves the personal space owned by that account; for an existing project it resolves Company. It checks active account and membership, never creates a space, never reactivates a membership, and never falls back to another space when access is missing. An inaccessible default returns not found.

## Membership

Active `owner` and `editor` memberships permit writes; active `reader` memberships permit reads. SQL snapshots, REST, realtime and protected originals check membership independently. A record in another space and a missing record produce the same not-found response.

Every account created on the server (`init`, `account`) still receives Company editor membership in the same transaction. On new Personal-first projects, account creation also creates that account's Personal space and sole owner membership atomically. An inactive membership is a revocation and is never reactivated by sign-in. Ordinary users cannot create group spaces or change memberships; the collection rules are superuser-only and the hooks validate those trusted writes with revision checks and audit entries.

## Personal spaces

A Personal space has one fixed owner and is visible only to that owner. On existing projects, the reader's Create personal space button and `pocketcontext create-personal-space` explicitly create one through authenticated `POST /api/spaces/personal`. The endpoint returns `{"id": "SPACE_ID"}` and is idempotent, including when a new project already created the space. Creating one does not change an existing project's Company default or move existing knowledge.

## Reader and client

Without a space in the URL, the reader resolves the signed-in account's project default. An explicit unavailable space is an error, never a silent switch. Navigation preserves the selected `space` in links.

`--space ID` overrides `POCKETCONTEXT_SPACE`; without either, the client resolves the same authenticated project default. `pocketcontext whoami` reports the selected space, and `pocketcontext spaces` lists visible memberships with a `selected` flag. If the default is inaccessible, `spaces` still lists available memberships without selecting a replacement. Use `--space companyspace001` explicitly for shared Company work on a new project.

Raw SQL spans every space the account can read, so filter by `space`. Child records inherit their parent's space. Ordinary root record creates without a space use the same project default; superuser root creates must name a space explicitly. Explicit choices retain their independent membership and write-role checks.
