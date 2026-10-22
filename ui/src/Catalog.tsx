import CustomCatalog from "./CustomCatalog";
import { navigationGroups } from "./navigation";
import { spaceLink } from "./spaceLinks";
import Prompts from "./Prompts";
import RepositoryFiles from "./RepositoryFiles";
import { catalogValue, groupsFor, ids } from "./ownership";
import { pageHref } from "./Markdown";
import {
  PropertyDisplay,
  propertyLabel,
  propertyText,
  relationshipKeys,
} from "./Properties";
import type { PageSummary } from "./types";

export const catalogTypes = [
  "resource",
  "credential",
  "deployment",
  "person",
  "group",
  "organization",
  "product",
  "model",
  "repository_document",
  "prompt",
] as const;
export const catalogLabels = {
  resource: "Resources",
  credential: "Credentials",
  deployment: "Deployments",
  person: "People",
  group: "Groups",
  organization: "Organizations",
  product: "Products",
  model: "Models",
  repository_document: "Repository files",
  prompt: "Prompts",
};
export type CatalogType = (typeof catalogTypes)[number];
export interface CatalogState {
  custom?: string;
  type: CatalogType;
  query: string;
  targetAgent?: string;
  requiredSkill?: string;
  repository?: string;
  documentType?: string;
  syncStatus?: string;
  group?: string;
  member?: string;
  provider: string;
  deployment: string;
  lifecycle: string;
  missingOwner: boolean;
  sort: string;
  offset: number;
}
export function catalogHref(
  state: Partial<CatalogState> = {},
  publication?: string,
): string {
  const params = new URLSearchParams();
  if (publication) params.set("publication", publication);
  for (const [key, value] of Object.entries(state)) {
    if (
      key !== "type" &&
      key !== "custom" &&
      value &&
      !(key === "sort" && value === "title" && state.custom === undefined)
    )
      params.set(key === "query" ? "q" : key, String(value));
  }
  return spaceLink(
    `#/catalog/${state.custom !== undefined ? `custom/${encodeURIComponent(state.custom)}` : state.type || "resource"}${params.size ? `?${params}` : ""}`,
  );
}
const columns: Record<CatalogType, string[]> = {
  prompt: [],
  repository_document: ["document_type", "output_mode", "accountable_owners"],
  person: ["role", "organization", "groups", "crm_url"],
  group: ["purpose", "members", "owned_resources", "owned_deployments"],
  organization: ["organization_type", "website"],
  product: ["product_type", "provider", "website"],
  model: ["provider", "family"],
  resource: [
    "resource_type",
    "provider",
    "deployment_profiles",
    "lifecycle_status",
    "accountable_owners",
    "provider_observed_at",
  ],
  credential: [
    "provider_status",
    "resources",
    "consumers",
    "expires_at",
    "expiry_observation",
    "next_review",
  ],
  deployment: [
    "provider",
    "lifecycle_status",
    "resources",
    "accountable_owners",
  ],
};
// Operational catalogs have deployments, lifecycles and owners to filter by.
const operational = (type: CatalogType) =>
  type === "resource" || type === "credential" || type === "deployment";
export function filterCatalog(
  pages: PageSummary[],
  state: CatalogState,
): PageSummary[] {
  const names = new Map(pages.map((page) => [page.page, page.title]));
  const terms = state.query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const scalar = (page: PageSummary, key: string) => {
    const value = catalogValue(page, key, pages);
    return (relationshipKeys.has(key) || key === "groups") &&
      Array.isArray(value)
      ? value
          .map((id) => names.get(id) || "Unavailable in this publication")
          .join(", ")
      : propertyText(value);
  };
  return pages
    .filter((page) => {
      const p = page.properties || {};
      const searchable = [
        page.title,
        page.slug,
        page.summary,
        ...groupsFor(page, pages).map((group) => group.title),
        ...Object.entries(p).map(([key, value]) =>
          (relationshipKeys.has(key) || key === "groups") &&
          Array.isArray(value)
            ? value.map((id) => names.get(id) || "").join(" ")
            : propertyText(value),
        ),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return (
        p.catalog_type === state.type &&
        terms.every((term) => searchable.includes(term)) &&
        (!state.group ||
          groupsFor(page, pages).some((group) => group.page === state.group)) &&
        (!state.member || ids(page, "members").includes(state.member)) &&
        (!state.provider || p.provider === state.provider) &&
        (!state.lifecycle || p.lifecycle_status === state.lifecycle) &&
        (!state.deployment ||
          (Array.isArray(p.deployment_profiles) &&
            p.deployment_profiles.includes(state.deployment))) &&
        (!state.missingOwner ||
          (!ids(page, "accountable_owners").length &&
            (p.accountable_owner == null ||
              p.accountable_owner === "" ||
              (Array.isArray(p.accountable_owner) &&
                !p.accountable_owner.length))))
      );
    })
    .sort((a, b) => {
      const descending = state.sort.startsWith("-");
      const key = state.sort.replace(/^-/, "");
      const av = key === "title" ? a.title : scalar(a, key),
        bv = key === "title" ? b.title : scalar(b, key);
      return (
        ((key.startsWith("owned_")
          ? Number(av) - Number(bv)
          : av.localeCompare(bv)) || a.slug.localeCompare(b.slug)) *
        (descending ? -1 : 1)
      );
    });
}
export default function Catalog({
  pages,
  state,
  publication,
  onNavigate,
  snapshotId,
  space,
}: {
  snapshotId?: string;
  space?: string;
  pages: PageSummary[];
  state: CatalogState;
  publication?: string;
  onNavigate?: (href: string) => void;
}) {
  if (state.custom !== undefined)
    return (
      <CustomCatalog
        pages={pages}
        state={state}
        publication={publication}
        onNavigate={onNavigate}
      />
    );
  if (!catalogTypes.includes(state.type))
    return (
      <section className="catalog-page">
        <h1>Catalog unavailable</h1>
        <p>This catalog is not available in this publication.</p>
      </section>
    );
  if (state.type === "prompt")
    return (
      <Prompts
        pages={pages}
        state={state}
        publication={publication}
        snapshotId={snapshotId}
        space={space}
        onNavigate={onNavigate}
      />
    );
  if (state.type === "repository_document")
    return (
      <RepositoryFiles
        pages={pages}
        state={state}
        publication={publication}
        onNavigate={onNavigate}
      />
    );
  const update = (patch: Partial<CatalogState>) => {
    const href = catalogHref({ ...state, offset: 0, ...patch }, publication);
    if (onNavigate) onNavigate(href);
    else location.hash = href;
  };
  const selected = pages.filter(
    (page) => page.properties?.catalog_type === state.type,
  );
  const options = (key: string) =>
    [
      ...new Set(
        [
          key === "provider"
            ? state.provider
            : key === "lifecycle_status"
              ? state.lifecycle
              : "",
          ...selected.map((page) => page.properties?.[key]),
        ].filter(
          (value): value is string =>
            typeof value === "string" && Boolean(value),
        ),
      ),
    ].sort();
  const deploymentIds = new Set(
    selected.flatMap((page) =>
      Array.isArray(page.properties?.deployment_profiles)
        ? page.properties.deployment_profiles
        : [],
    ),
  );
  const matches = filterCatalog(pages, state);
  const rows = matches.slice(state.offset, state.offset + 50);
  const fields = columns[state.type];
  return (
    <section
      className="catalog-page"
      aria-label={`${catalogLabels[state.type]} catalog`}
    >
      <div className="page-eyebrow">PUBLISHED CATALOG</div>
      <h1 className="page-title">{catalogLabels[state.type]}</h1>
      <p className="page-summary">
        Browse recorded properties and follow each page to its evidence. Dates
        describe observations and reviews, not publication time.
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
        {navigationGroups(pages, "catalog").map((group) => (
          <a
            key={`custom-${group.id}`}
            href={catalogHref({ custom: group.id }, publication)}
          >
            {group.title}
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
        {(state.type === "person" || state.type === "group") && (
          <label>
            {state.type === "person" ? "Group" : "Member"}
            <select
              aria-label={state.type === "person" ? "Group" : "Member"}
              value={
                (state.type === "person" ? state.group : state.member) || ""
              }
              onChange={(event) =>
                update(
                  state.type === "person"
                    ? { group: event.target.value }
                    : { member: event.target.value },
                )
              }
            >
              <option value="">
                {state.type === "person" ? "All groups" : "All members"}
              </option>
              {(state.type === "person" ? state.group : state.member) &&
                !pages.some(
                  (page) =>
                    page.page ===
                    (state.type === "person" ? state.group : state.member),
                ) && (
                  <option
                    value={state.type === "person" ? state.group : state.member}
                  >
                    Unavailable in this publication
                  </option>
                )}
              {pages
                .filter(
                  (page) =>
                    page.properties?.catalog_type ===
                    (state.type === "person" ? "group" : "person"),
                )
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((page) => (
                  <option key={page.page} value={page.page}>
                    {page.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        {(operational(state.type) ||
          state.type === "product" ||
          state.type === "model") && (
          <label>
            Provider
            <select
              aria-label="Provider"
              value={state.provider}
              onChange={(event) => update({ provider: event.target.value })}
            >
              <option value="">All providers</option>
              {options("provider").map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        )}
        {operational(state.type) && (
          <>
            <label>
              Deployment
              <select
                aria-label="Deployment"
                value={state.deployment}
                onChange={(event) => update({ deployment: event.target.value })}
              >
                <option value="">All deployments</option>
                {state.deployment &&
                  !pages.some(
                    (page) =>
                      page.page === state.deployment &&
                      deploymentIds.has(page.page),
                  ) && (
                    <option value={state.deployment}>
                      Unavailable deployment
                    </option>
                  )}
                {pages
                  .filter((page) => deploymentIds.has(page.page))
                  .map((page) => (
                    <option key={page.page} value={page.page}>
                      {page.title}
                    </option>
                  ))}
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
                {options("lifecycle_status").map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          Sort
          <select
            aria-label="Sort"
            value={state.sort}
            onChange={(event) => update({ sort: event.target.value })}
          >
            {["title", ...fields].flatMap((key) => [
              <option key={key} value={key}>
                {key === "title" ? "Name" : propertyLabel(key)} ↑
              </option>,
              <option key={`-${key}`} value={`-${key}`}>
                {key === "title" ? "Name" : propertyLabel(key)} ↓
              </option>,
            ])}
          </select>
        </label>
        {operational(state.type) && (
          <label className="catalog-checkbox">
            <input
              type="checkbox"
              checked={state.missingOwner}
              onChange={(event) =>
                update({ missingOwner: event.target.checked })
              }
            />
            Missing owner
          </label>
        )}
        <button
          onClick={() =>
            update({
              group: "",
              member: "",
              query: "",
              provider: "",
              deployment: "",
              lifecycle: "",
              missingOwner: false,
            })
          }
        >
          Clear filters
        </button>
      </div>
      <p role="status">
        {matches.length} {matches.length === 1 ? "page" : "pages"}
        {rows.length > 0 &&
          ` · ${Math.min(state.offset + 1, matches.length)}–${Math.min(state.offset + 50, matches.length)}`}
      </p>
      {matches.length > 0 && !rows.length && (
        <p>
          No pages at this offset.{" "}
          <a href={catalogHref({ ...state, offset: 0 }, publication)}>
            Return to first page
          </a>
        </p>
      )}
      {!matches.length && (
        <p>
          No matching pages. Catalog pages appear when published with a catalog
          type and properties.
        </p>
      )}
      {rows.length > 0 && (
        <>
          <div className="catalog-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  {fields.map((key) => (
                    <th scope="col" key={key}>
                      {propertyLabel(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((page) => (
                  <tr key={page.page}>
                    <th scope="row">
                      <a href={pageHref(page.slug, publication)}>
                        {page.title}
                      </a>
                    </th>
                    {fields.map((key) => (
                      <td key={key}>
                        <PropertyDisplay
                          name={key === "groups" ? "members" : key}
                          value={catalogValue(page, key, pages)}
                          pages={pages}
                          publication={publication}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="catalog-cards">
            {rows.map((page) => (
              <article key={page.page}>
                <h2>
                  <a href={pageHref(page.slug, publication)}>{page.title}</a>
                </h2>
                <p>
                  {!operational(state.type) ? (
                    page.summary
                  ) : (
                    <>
                      {propertyText(page.properties?.provider)} ·{" "}
                      {propertyText(page.properties?.lifecycle_status)}
                    </>
                  )}
                </p>
                <details>
                  <summary>Record properties</summary>
                  <dl>
                    {fields.map((key) => (
                      <div key={key}>
                        <dt>{propertyLabel(key)}</dt>
                        <dd>
                          <PropertyDisplay
                            name={key === "groups" ? "members" : key}
                            value={catalogValue(page, key, pages)}
                            pages={pages}
                            publication={publication}
                          />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </article>
            ))}
          </div>
        </>
      )}
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
