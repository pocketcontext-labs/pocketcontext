import type { PageSummary } from "./types";

import {
  navigationGroups,
  navigationKeys,
  isNavigationDefinition,
  UNASSIGNED_TOPIC,
  type NavigationGroup,
} from "./navigation";
export type WelcomeGroup = NavigationGroup;
function words(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
/** Compatibility helper: first explicit membership; grouping includes every membership. */
export function classifyWelcomePage(page: PageSummary): string {
  return navigationKeys(page, "topic")[0] || UNASSIGNED_TOPIC;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePages(a: PageSummary, b: PageSummary): number {
  return (
    compareText(words(a.title), words(b.title)) ||
    compareText(a.slug, b.slug) ||
    compareText(a.page, b.page)
  );
}

/** Local catalog filtering only; this does not replace full-text evidence search. */
export function filterWelcomePages(
  pages: readonly PageSummary[],
  query: string,
): PageSummary[] {
  const terms = words(query).split(" ").filter(Boolean);
  return pages
    .filter((page) => {
      const value = words(
        `${page.title} ${page.slug} ${page.kind} ${page.summary}`,
      );
      return terms.every((term) => value.includes(term));
    })
    .sort(comparePages);
}

/** Input must be the complete nonarchived manifest selection from the API. */
export function groupWelcomePages(
  pages: readonly PageSummary[],
): WelcomeGroup[] {
  return navigationGroups(pages, "topic");
}

export const WELCOME_VIEWS = [
  { id: "topics", title: "By topic" },
  { id: "types", title: "By page type" },
  { id: "alphabetical", title: "A–Z" },
] as const;
export type WelcomeView = (typeof WELCOME_VIEWS)[number]["id"];

export function isWelcomeView(value: string | undefined): value is WelcomeView {
  return WELCOME_VIEWS.some((view) => view.id === value);
}

const KIND_SECTIONS = [
  { kind: "summary", title: "Source summaries" },
  { kind: "concept", title: "Concepts" },
  { kind: "answer", title: "Answers" },
  { kind: "transcript", title: "Transcripts" },
] as const;

// Entity sections follow the catalog types in docs/data-model.md; entities
// without a recognized catalog_type stay visible in Other entities.
const ENTITY_SECTIONS = [
  { type: "person", title: "People" },
  { type: "group", title: "Groups" },
  { type: "organization", title: "Organizations" },
  { type: "product", title: "Products" },
  { type: "model", title: "Models" },
  { type: "resource", title: "Resources" },
  { type: "credential", title: "Credentials" },
  { type: "deployment", title: "Deployments" },
  { type: "prompt", title: "Prompts" },
  { type: "repository_document", title: "Repository files" },
  { type: "repository_destination", title: "Repository destinations" },
  { type: "repository_sync", title: "Repository syncs" },
] as const;

export interface WelcomeTypeGroup {
  id: string;
  title: string;
  pages: PageSummary[];
}

export function classifyWelcomePageType(page: PageSummary): string {
  if (page.kind === "entity") {
    const type = String(page.properties?.catalog_type ?? "");
    return ENTITY_SECTIONS.some((section) => section.type === type)
      ? `type-entity-${type}`
      : "type-entity-other";
  }
  return KIND_SECTIONS.some((section) => section.kind === page.kind)
    ? `type-${page.kind}`
    : "type-other";
}

/** Groups by page kind, with entities split by catalog_type; every page appears once. */
export function groupWelcomePagesByType(
  pages: readonly PageSummary[],
): WelcomeTypeGroup[] {
  const groups: WelcomeTypeGroup[] = [
    ...KIND_SECTIONS.map((section) => ({
      id: `type-${section.kind}`,
      title: section.title,
      pages: [],
    })),
    ...ENTITY_SECTIONS.map((section) => ({
      id: `type-entity-${section.type}`,
      title: section.title,
      pages: [],
    })),
    { id: "type-entity-other", title: "Other entities", pages: [] },
    { id: "type-other", title: "Other pages", pages: [] },
  ];
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const page of pages)
    byId.get(classifyWelcomePageType(page))!.pages.push(page);
  for (const group of groups) group.pages.sort(comparePages);
  return groups;
}

/** Explicit topics are useful when present; otherwise show the complete page types. */
export function defaultWelcomeView(pages: readonly PageSummary[]): WelcomeView {
  return pages.some(
    (page) =>
      !isNavigationDefinition(page) && navigationKeys(page, "topic").length,
  )
    ? "topics"
    : "types";
}

/** Only explicitly designated guides belong in onboarding. The positive safe
 * integer revision property onboarding_order controls their order. */
export function onboardingPages(pages: readonly PageSummary[]): PageSummary[] {
  return pages
    .filter((page) => {
      const order = page.properties?.onboarding_order;
      return (
        typeof order === "number" && Number.isSafeInteger(order) && order > 0
      );
    })
    .sort(
      (a, b) =>
        Number(a.properties!.onboarding_order) -
          Number(b.properties!.onboarding_order) || comparePages(a, b),
    );
}
