import {
  catalogHref,
  catalogLabels,
  catalogTypes,
  type CatalogState,
} from "./Catalog";
import { pageHref } from "./Markdown";
import { ids } from "./ownership";
import { PropertyDisplay, propertyText } from "./Properties";
import type { PageSummary } from "./types";
const value = (page: PageSummary, key: string) =>
  typeof page.properties?.[key] === "string"
    ? (page.properties[key] as string)
    : "";
export function githubFileHref(destination: PageSummary): string | undefined {
  const repo = value(destination, "github_repository"),
    branch = value(destination, "github_branch"),
    path = value(destination, "github_path");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !branch ||
    !path ||
    [repo, branch, path].some(
      (part) =>
        /[\\\x00-\x1f\x7f]/.test(part) ||
        part
          .split("/")
          .some((segment) => !segment || segment === "." || segment === ".."),
    )
  )
    return undefined;
  return `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
export function documentDestinations(
  document: PageSummary,
  pages: PageSummary[],
) {
  return pages
    .filter(
      (page) =>
        page.properties?.catalog_type === "repository_destination" &&
        ids(page, "documents").includes(document.page),
    )
    .map((destination) => {
      const observation = pages
        .filter(
          (page) =>
            page.properties?.catalog_type === "repository_sync" &&
            ids(page, "destinations").includes(destination.page),
        )
        .sort(
          (a, b) =>
            Date.parse(value(b, "checked_at")) -
              Date.parse(value(a, "checked_at")) || b.id.localeCompare(a.id),
        )[0];
      const sourceChanged = Boolean(
        observation &&
        value(observation, "synced_document_revision") !== document.id,
      );
      const destinationChanged = Boolean(
        observation &&
        value(observation, "synced_destination_revision") !== destination.id,
      );
      const recorded = observation
        ? value(observation, "sync_status")
        : "unknown";
      return {
        destination,
        observation,
        sourceChanged,
        destinationChanged,
        status: destinationChanged
          ? "unknown"
          : sourceChanged && recorded === "current"
            ? "behind"
            : recorded || "unknown",
      };
    })
    .sort(
      (a, b) =>
        value(a.destination, "github_repository").localeCompare(
          value(b.destination, "github_repository"),
        ) ||
        value(a.destination, "github_path").localeCompare(
          value(b.destination, "github_path"),
        ),
    );
}
export default function RepositoryFiles({
  pages,
  state,
  publication,
  onNavigate,
}: {
  pages: PageSummary[];
  state: CatalogState;
  publication?: string;
  onNavigate?: (href: string) => void;
}) {
  const update = (patch: Partial<CatalogState>) => {
    const href = catalogHref({ ...state, offset: 0, ...patch }, publication);
    if (onNavigate) onNavigate(href);
    else location.hash = href;
  };
  const terms = state.query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const matchesDestination = (
    item: ReturnType<typeof documentDestinations>[number],
  ) =>
    (!state.repository ||
      value(item.destination, "github_repository") === state.repository) &&
    (!state.syncStatus || item.status === state.syncStatus);
  const matches = pages
    .filter((page) => page.properties?.catalog_type === "repository_document")
    .map((document) => ({
      document,
      destinations: documentDestinations(document, pages),
    }))
    .filter(({ document, destinations }) => {
      const searchable = [
        document.title,
        document.summary,
        ...Object.values(document.properties || {}).map(propertyText),
        ...destinations.flatMap(({ destination }) => [
          destination.title,
          ...Object.values(destination.properties || {}).map(propertyText),
        ]),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return (
        terms.every((term) => searchable.includes(term)) &&
        (!state.documentType ||
          value(document, "document_type") === state.documentType) &&
        (!state.lifecycle ||
          value(document, "lifecycle_status") === state.lifecycle) &&
        (!state.missingOwner || !ids(document, "accountable_owners").length) &&
        ((!state.repository && !state.syncStatus) ||
          destinations.some(matchesDestination) ||
          (!destinations.length &&
            !state.repository &&
            state.syncStatus === "unknown"))
      );
    })
    .sort(
      (a, b) =>
        (a.document.title.localeCompare(b.document.title) ||
          a.document.slug.localeCompare(b.document.slug)) *
        (state.sort === "-title" ? -1 : 1),
    );
  const rows = matches.slice(state.offset, state.offset + 50);
  const choices = (key: string, type: string, selected?: string) =>
    [
      ...new Set(
        [
          selected || "",
          ...pages
            .filter((page) => page.properties?.catalog_type === type)
            .map((page) => value(page, key)),
        ].filter(Boolean),
      ),
    ].sort();
  return (
    <section
      className="catalog-page repository-files"
      aria-label="Repository files catalog"
    >
      <div className="page-eyebrow">PUBLISHED CATALOG</div>
      <h1 className="page-title">Repository files</h1>
      <p className="page-summary">
        Authoritative documents and their GitHub copies. Status reflects
        the last recorded check in this publication; GitHub is not checked live.
      </p>
      <nav className="catalog-tabs" aria-label="Catalogs">
        {catalogTypes.map((type) => (
          <a
            key={type}
            href={catalogHref({ type }, publication)}
            aria-current={type === state.type ? "page" : undefined}
          >
            {catalogLabels[type]}
          </a>
        ))}
      </nav>
      <div className="catalog-filters">
        <label>
          Search catalog
          <input
            type="search"
            value={state.query}
            onChange={(event) => update({ query: event.target.value })}
          />
        </label>
        <label>
          Repository
          <select
            aria-label="Repository"
            value={state.repository || ""}
            onChange={(event) => update({ repository: event.target.value })}
          >
            <option value="">All repositories</option>
            {choices(
              "github_repository",
              "repository_destination",
              state.repository,
            ).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Document type
          <select
            aria-label="Document type"
            value={state.documentType || ""}
            onChange={(event) => update({ documentType: event.target.value })}
          >
            <option value="">All document types</option>
            {choices(
              "document_type",
              "repository_document",
              state.documentType,
            ).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Sync status
          <select
            aria-label="Sync status"
            value={state.syncStatus || ""}
            onChange={(event) => update({ syncStatus: event.target.value })}
          >
            <option value="">All statuses</option>
            {["current", "behind", "diverged", "pending", "unknown"].map(
              (item) => (
                <option key={item}>{item}</option>
              ),
            )}
          </select>
        </label>
        <label>
          Lifecycle
          <select
            aria-label="Lifecycle"
            value={state.lifecycle}
            onChange={(event) => update({ lifecycle: event.target.value })}
          >
            <option value="">All lifecycles</option>
            {choices(
              "lifecycle_status",
              "repository_document",
              state.lifecycle,
            ).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select
            aria-label="Sort"
            value={state.sort}
            onChange={(event) => update({ sort: event.target.value })}
          >
            <option value="title">Name ↑</option>
            <option value="-title">Name ↓</option>
          </select>
        </label>
        <label className="catalog-checkbox">
          <input
            type="checkbox"
            checked={state.missingOwner}
            onChange={(event) => update({ missingOwner: event.target.checked })}
          />
          Missing owner
        </label>
        <button
          onClick={() =>
            update({
              query: "",
              repository: "",
              documentType: "",
              syncStatus: "",
              lifecycle: "",
              missingOwner: false,
            })
          }
        >
          Clear filters
        </button>
      </div>
      <p role="status">
        {matches.length} {matches.length === 1 ? "document" : "documents"}
        {rows.length
          ? ` · ${state.offset + 1}–${Math.min(state.offset + 50, matches.length)}`
          : ""}
      </p>
      {!matches.length && (
        <p>
          No matching repository files. Publish a repository document and its
          destinations to add them here.
        </p>
      )}
      {matches.length > 0 && !rows.length && (
        <p>
          No documents at this offset.{" "}
          <a href={catalogHref({ ...state, offset: 0 }, publication)}>
            Return to first page
          </a>
        </p>
      )}
      <div className="repository-document-list">
        {rows.map(({ document, destinations }) => (
          <article className="repository-document" key={document.page}>
            <h2>
              <a href={pageHref(document.slug, publication)}>
                {document.title}
              </a>
            </h2>
            <p>
              {propertyText(document.properties?.document_type)} ·{" "}
              {propertyText(document.properties?.output_mode)} ·{" "}
              {propertyText(document.properties?.lifecycle_status)}
            </p>
            <div className="repository-owner">
              Owner:{" "}
              <PropertyDisplay
                name="accountable_owners"
                value={document.properties?.accountable_owners}
                pages={pages}
                publication={publication}
              />
            </div>
            {!destinations.length && <p>No GitHub destinations recorded.</p>}
            <ul className="repository-destinations">
              {destinations
                .filter(matchesDestination)
                .map(
                  ({
                    destination,
                    observation,
                    status,
                    sourceChanged,
                    destinationChanged,
                  }) => (
                    <li key={destination.page}>
                      <div>
                        <a href={pageHref(destination.slug, publication)}>
                          {destination.title}
                        </a>
                        <p>
                          {value(destination, "github_repository")} /{" "}
                          <code>{value(destination, "github_path")}</code> ·
                          branch{" "}
                          <code>{value(destination, "github_branch")}</code> ·{" "}
                          {propertyText(
                            destination.properties?.lifecycle_status,
                          )}
                          {githubFileHref(destination) && (
                            <>
                              {" "}
                              ·{" "}
                              <a
                                href={githubFileHref(destination)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Open GitHub file
                              </a>
                            </>
                          )}
                        </p>
                      </div>
                      <div>
                        <strong>{status}</strong>
                        {observation ? (
                          <>
                            <p>
                              Checked{" "}
                              <time dateTime={value(observation, "checked_at")}>
                                {value(observation, "checked_at")}
                              </time>
                            </p>
                            <a href={pageHref(observation.slug, publication)}>
                              Sync evidence
                            </a>
                            {destinationChanged && (
                              <p>
                                Destination changed since the last check; needs
                                recheck.
                              </p>
                            )}
                            {sourceChanged && (
                              <p>
                                Source revision differs from the last
                                synchronized revision.
                              </p>
                            )}
                          </>
                        ) : (
                          <p>No check recorded.</p>
                        )}
                      </div>
                    </li>
                  ),
                )}
            </ul>
          </article>
        ))}
      </div>
      <nav className="catalog-pagination" aria-label="Catalog pagination">
        {state.offset > 0 && (
          <a
            href={catalogHref(
              { ...state, offset: Math.max(0, state.offset - 50) },
              publication,
            )}
          >
            Previous
          </a>
        )}
        {state.offset + 50 < matches.length && (
          <a
            href={catalogHref(
              { ...state, offset: state.offset + 50 },
              publication,
            )}
          >
            Next
          </a>
        )}
      </nav>
    </section>
  );
}
