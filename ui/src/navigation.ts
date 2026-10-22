import type { PageSummary } from "./types";

export type NavigationKind = "topic" | "catalog";
export const UNASSIGNED_TOPIC = "__unassigned";
export const validNavigationKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export const isNavigationDefinition = (page: PageSummary) =>
  page.properties?.navigation_kind === "topic" ||
  page.properties?.navigation_kind === "catalog";
export function navigationKeys(
  page: PageSummary,
  kind: NavigationKind,
): string[] {
  if (isNavigationDefinition(page)) return [];
  const value = page.properties?.[kind === "topic" ? "topics" : "catalogs"];
  return Array.isArray(value)
    ? [...new Set(value.filter(validNavigationKey))]
    : [];
}
// Keep the display-field exceptions aligned with pb_hooks/properties.js.
const reservedColumns = new Set([
  "pocketcontext_page",
  "pocketcontext_revision",
  "id",
  "page",
  "page_id",
  "revision",
  "revision_id",
  "publication",
  "publication_id",
  "kind",
  "title",
  "summary",
  "body",
  "archived",
  "run",
  "base_revision",
  "created",
  "updated",
  "created_by",
  "updated_by",
  "properties",
  "property_evidence",
  "constructor",
  "prototype",
  "__proto__",
]);
const displayColumns = new Set(["title", "summary", "slug", "kind"]);
export const validCatalogColumn = (key: unknown): key is string =>
  typeof key === "string" &&
  /^[a-z][a-z0-9_]{0,63}$/.test(key) &&
  (!reservedColumns.has(key) || displayColumns.has(key));
export interface NavigationGroup {
  id: string;
  title: string;
  description: string;
  pages: PageSummary[];
  definition?: PageSummary;
  order: number;
  columns: string[];
  sort: string;
}
const readable = (key: string) =>
  key.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
const comparePages = (a: PageSummary, b: PageSummary) =>
  a.title.localeCompare(b.title) ||
  a.slug.localeCompare(b.slug) ||
  a.page.localeCompare(b.page);
/** Derive navigation only from the selected, authorized immutable manifest. */
export function navigationGroups(
  pages: readonly PageSummary[],
  kind: NavigationKind,
): NavigationGroup[] {
  const groups = new Map<string, NavigationGroup>();
  const ensure = (id: string) => {
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        title: readable(id),
        description: "",
        pages: [],
        order: Number.MAX_SAFE_INTEGER,
        columns: [],
        sort: "title",
      };
      groups.set(id, group);
    }
    return group;
  };
  const unique = [...new Map(pages.map((page) => [page.page, page])).values()];
  for (const page of unique) {
    if (
      page.properties?.navigation_kind !== kind ||
      !validNavigationKey(page.slug)
    )
      continue;
    const group = ensure(page.slug),
      p = page.properties;
    group.definition = page;
    group.title = page.title;
    group.description = page.summary;
    if (
      typeof p.navigation_order === "number" &&
      Number.isSafeInteger(p.navigation_order) &&
      p.navigation_order >= 0
    )
      group.order = p.navigation_order;
    if (kind === "catalog") {
      if (Array.isArray(p.catalog_columns))
        group.columns = [
          ...new Set(p.catalog_columns.filter(validCatalogColumn)),
        ].slice(0, 12);
      const sort = p.catalog_sort;
      if (
        typeof sort === "string" &&
        ["title", ...group.columns].includes(sort.replace(/^-/, ""))
      )
        group.sort = sort;
    }
  }
  for (const page of unique) {
    if (isNavigationDefinition(page)) continue;
    const keys = navigationKeys(page, kind);
    if (kind === "topic" && !keys.length) {
      const group = ensure(UNASSIGNED_TOPIC);
      group.title = "Other knowledge";
      group.description = "Pages without an assigned topic.";
      group.pages.push(page);
    } else for (const key of keys) ensure(key).pages.push(page);
  }
  for (const group of groups.values()) group.pages.sort(comparePages);
  return [...groups.values()].sort((a, b) =>
    a.id === UNASSIGNED_TOPIC
      ? 1
      : b.id === UNASSIGNED_TOPIC
        ? -1
        : a.order - b.order ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id),
  );
}
