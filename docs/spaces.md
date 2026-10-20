# Spaces

Spaces are the access boundary. Knowledge belongs to the company space `companyspace001` unless a request names another space. Every domain record carries a required `space`; references, citations, links, publication manifests, home choices and catalog relationships stay within one space. Source hashes, run keys, page slugs and publication sequence numbers are unique per space.

## Membership

Active `owner` and `editor` memberships permit writes; active `reader` memberships permit reads. SQL snapshots, REST, realtime and protected originals check membership independently. A record in another space and a missing record produce the same not-found response.

Every account created on the server (`init`, `account`) receives company editor membership in the same transaction. An inactive membership is a revocation and is never reactivated by sign-in. Ordinary users cannot create group spaces or change memberships; the collection rules are superuser-only and the hooks validate those trusted writes with revision checks and audit entries.

## Personal spaces

Personal spaces are explicit. The reader's Create personal space button and `pocketcontext create-personal-space` call the authenticated `POST /api/spaces/personal`, which returns `{"id": "SPACE_ID"}` and is idempotent. A personal space has one fixed owner and is visible only to that owner. Creating one does not change the CLI default or move existing knowledge.

## Reader and client

The reader starts in the company space and shows a selector when more than one space is available; a requested space that is not available is an error, never a silent switch. Links to a personal space keep `space` in the URL.

`--space ID` overrides `POCKETCONTEXT_SPACE`; otherwise the client uses the company space. `pocketcontext spaces` lists visible memberships. Raw SQL spans every space the account can read, so filter by `space`. Child records inherit their parent's space; root records without a space use the company space.
