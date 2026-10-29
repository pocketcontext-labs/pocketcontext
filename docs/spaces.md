# Spaces

A PocketContext project belongs to one person. Spaces partition that person's knowledge; they are not an access boundary. Every request still needs the project's one account (see [Authentication](../README.md#authentication)), and once signed in every space is readable and every unarchived space is writable.

Every domain record carries a required `space`. References, citations, links, publication manifests, home choices and catalog relationships stay within one space. Source hashes, run keys, page slugs and publication sequence numbers are unique per space, so the same file or slug can exist independently in two spaces.

## Records

`spaces` has `id`, `name` (1–200 characters after trimming), `archived`, `revision`, `created` and `updated`. Names are labels, not identifiers: two spaces may share a name, although `create-space` never creates a second one. Spaces are never deleted.

`settings` has one row, `projectsettings`, whose `default_space` names the project's default space. A new database starts with one space named `Default`, which is also the default.

## Rules the server enforces

- Creating a space takes only `name`. Renaming, archiving and restoring take `expected_revision`; a stale revision returns 409. Changing the default (`PATCH /api/collections/settings/records/projectsettings` with `default_space` and the settings row's `expected_revision`) is revision-checked the same way. Every change writes an `audit_log` entry.
- The default space cannot be archived; make another space the default first. An archived space cannot become the default.
- An archived space stays readable (records, publications, history and protected originals) but refuses every write until it is restored.
- Root records (`sources`, `ingestion_runs`, `pages`) created without a `space` go to the default space. Renditions, passages, page revisions, citations and page links take the space of their parent; a supplied `space` that differs fails.
- A reference to a record in another space fails exactly like a reference to a missing record (HTTP 404).
- `GET /api/spaces/default` returns `{id, name, archived, revision, settings_revision}` of the default space.

## Client

```sh
pocketcontext spaces                       # id, name, archived, default, selected
pocketcontext create-space Research        # or the one space already named Research ("created": false)
pocketcontext rename-space Research "Reading notes"
pocketcontext archive-space "Reading notes"
pocketcontext restore-space "Reading notes"
pocketcontext default-space                # show the default
pocketcontext default-space Research       # make Research the default
pocketcontext whoami                       # URL, sign-in and the selected space
```

`--space SPACE` overrides `POCKETCONTEXT_SPACE`; without either, commands use the default space. `SPACE` is a space ID or the exact name of exactly one space. An unknown name is an error, and a name shared by several spaces is an error that lists their IDs; choose one by ID or rename one. `create-space NAME` is idempotent: it returns the one space already named `NAME` instead of creating another, and refuses when several spaces have that name.

Raw SQL spans every space, so filter by `space` when you mean one. Search of published pages is scoped by a publication (which belongs to one space); source search is scoped by a space.

## Reader

Without a space in the URL, the reader opens the default space; navigation keeps the selected `space` in its links. The space selector lists unarchived spaces (and the selected one, even when archived). Manage spaces beside the selector creates a space by name, opens and renames spaces, archives or restores them, and makes an unarchived space the default; it marks the default space and does not offer to archive it. Show archived spaces lists archived spaces with Restore. A stale revision makes the reader reload the space before another attempt.

## Databases from earlier releases

Releases before 0.11.0 had several accounts, memberships with roles, Personal and Company spaces and a project policy. This release does not open their databases: the server refuses to start, names the file and leaves it unchanged. There is no upgrade path; see the [0.11.0 release notes](releases/0.11.0.md).
