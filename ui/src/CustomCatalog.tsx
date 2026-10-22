import { catalogHref, type CatalogState } from "./Catalog";
import { pageHref } from "./Markdown";
import {
  PropertyDisplay,
  propertyLabel,
  propertyText,
  relationshipKeys,
} from "./Properties";
import { navigationGroups, type NavigationGroup } from "./navigation";
import type { PageSummary, PropertyValue } from "./types";
import "./customCatalog.css";

export function catalogColumnValue(
  page: PageSummary,
  key: string,
): PropertyValue | undefined {
  return ["title", "summary", "slug", "kind"].includes(key)
    ? page[key as "title" | "summary" | "slug" | "kind"]
    : page.properties?.[key];
}
export function customCatalogRows(
  group: NavigationGroup,
  pages: PageSummary[],
  query: string,
  requestedSort: string,
) {
  const names = new Map(pages.map((page) => [page.page, page.title]));
  const text = (page: PageSummary, key: string) => {
    const value = catalogColumnValue(page, key);
    return relationshipKeys.has(key) && Array.isArray(value)
      ? value
          .map((id) => names.get(id) || "Unavailable in this publication")
          .join(" ")
      : propertyText(value);
  };
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const sort = ["title", ...group.columns].includes(
    requestedSort.replace(/^-/, ""),
  )
    ? requestedSort
    : group.sort;
  const key = sort.replace(/^-/, ""),
    direction = sort.startsWith("-") ? -1 : 1;
  return group.pages
    .filter((page) => {
      const haystack = [
        page.title,
        page.summary,
        page.slug,
        ...group.columns.map((key) => text(page, key)),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => {
      const av = catalogColumnValue(a, key),
        bv = catalogColumnValue(b, key);
      const compared =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : text(a, key).localeCompare(text(b, key));
      return (
        direction * compared ||
        a.title.localeCompare(b.title) ||
        a.page.localeCompare(b.page)
      );
    });
}
export default function CustomCatalog({
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
  const groups = navigationGroups(pages, "catalog");
  const group = groups.find((item) => item.id === state.custom);
  if (!group)
    return (
      <section className="catalog-page" aria-label="Catalog unavailable">
        <h1 className="page-title">Catalog unavailable</h1>
        <p>This catalog is not available in this publication.</p>
      </section>
    );
  const fields = group.columns.filter((key) => key !== "title");
  const sort =
    state.sort && ["title", ...fields].includes(state.sort.replace(/^-/, ""))
      ? state.sort
      : group.sort;
  const matches = customCatalogRows(group, pages, state.query, sort);
  const rows = matches.slice(state.offset, state.offset + 50);
  const update = (patch: Partial<CatalogState>) => {
    const href = catalogHref({ ...state, offset: 0, ...patch }, publication);
    if (onNavigate) onNavigate(href);
    else location.hash = href;
  };
  return (
    <section
      className="catalog-page custom-catalog"
      aria-label={`${group.title} catalog`}
    >
      <div className="page-eyebrow">PUBLISHED CATALOG</div>
      <h1 className="page-title">{group.title}</h1>
      {group.description && <p className="page-summary">{group.description}</p>}
      {group.definition && (
        <p>
          <a href={pageHref(group.definition.slug, publication)}>
            About this catalog
          </a>
        </p>
      )}
      <nav className="catalog-tabs" aria-label="Custom catalogs">
        {groups.map((item) => (
          <a
            key={item.id}
            href={catalogHref({ custom: item.id }, publication)}
            aria-current={item.id === group.id ? "page" : undefined}
          >
            {item.title}
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
          Sort
          <select
            aria-label="Sort"
            value={sort}
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
      </div>
      <p role="status">
        {matches.length} {matches.length === 1 ? "page" : "pages"}
        {rows.length > 0
          ? ` · ${state.offset + 1}–${state.offset + rows.length}`
          : ""}
      </p>
      {!matches.length && (
        <p>No pages match this catalog in this publication.</p>
      )}
      {matches.length > 0 && !rows.length && (
        <p>
          No pages at this offset.{" "}
          <a href={catalogHref({ ...state, offset: 0 }, publication)}>
            Return to first page
          </a>
        </p>
      )}
      {rows.length > 0 && (
        <div className="custom-catalog-table">
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
                    <a href={pageHref(page.slug, publication)}>{page.title}</a>
                    {!fields.length && page.summary && <p>{page.summary}</p>}
                  </th>
                  {fields.map((key) => (
                    <td key={key}>
                      <PropertyDisplay
                        name={key}
                        value={catalogColumnValue(page, key)}
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
