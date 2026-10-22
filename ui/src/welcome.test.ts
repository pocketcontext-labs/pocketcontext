import { expect, test } from "vitest";
import type { PageSummary } from "./types";
import {
  classifyWelcomePage,
  defaultWelcomeView,
  filterWelcomePages,
  groupWelcomePages,
  groupWelcomePagesByType,
  isWelcomeView,
  onboardingPages,
} from "./welcome";

function page(title: string, kind = "concept"): PageSummary {
  const slug = title.toLowerCase().replaceAll(" ", "-");
  return {
    id: `revision-${slug}`,
    page: `page-${slug}`,
    slug,
    title,
    kind,
    summary: "",
  };
}

test("every catalog page is included exactly once, including unknown subjects beyond 100 pages", () => {
  const pages = Array.from({ length: 150 }, (_, index) =>
    page(`Unclassified ${index}`),
  );
  const groups = groupWelcomePages(pages);
  expect(groups.map((group) => group.id)).toEqual(["__unassigned"]);
  const included = groups.flatMap((group) => group.pages);
  expect(included).toHaveLength(150);
  expect(new Set(included.map((item) => item.page)).size).toBe(150);
  expect(
    groups.find((group) => group.id === "__unassigned")!.pages,
  ).toHaveLength(150);
  expect(groupWelcomePages([...pages].reverse())).toEqual(groups);
});

test("topic membership is explicit and never inferred from title, slug, kind or catalog type", () => {
  expect(classifyWelcomePage(page("Company security onboarding"))).toBe(
    "__unassigned",
  );
  expect(
    classifyWelcomePage({
      ...page("Named"),
      properties: { topics: ["biology", "research"] },
    }),
  ).toBe("biology");
});

test("onboarding is explicitly designated by positive safe-integer revision metadata", () => {
  const first = {
    ...page("Workspace reference"),
    properties: { onboarding_order: 1 },
  };
  const second = {
    ...page("A short tour"),
    properties: { onboarding_order: 2 },
  };
  const titleOnly = page("Employee onboarding and setup guide");
  const invalid = [
    0,
    -1,
    1.5,
    "1",
    true,
    null,
    Number.MAX_SAFE_INTEGER + 1,
  ].map((order) => ({
    ...page(`Invalid ${order}`),
    properties: { onboarding_order: order },
  }));
  expect(onboardingPages([second, ...invalid, titleOnly, first])).toEqual([
    first,
    second,
  ]);
  expect(onboardingPages([titleOnly])).toEqual([]);
  expect(onboardingPages([])).toEqual([]);
});

test("catalog filtering matches all terms across metadata and sorts without mutating inputs", () => {
  const pages = [
    page("Zulu workflow"),
    { ...page("Alpha workflow"), summary: "Connect the device" },
    page("Beta handbook"),
  ];
  expect(
    filterWelcomePages(pages, " WORKFLOW ").map((item) => item.title),
  ).toEqual(["Alpha workflow", "Zulu workflow"]);
  expect(filterWelcomePages(pages, "device alpha")).toEqual([pages[1]]);
  expect(filterWelcomePages(pages, "absent")).toEqual([]);
  expect(filterWelcomePages(pages, "").map((item) => item.title)).toEqual([
    "Alpha workflow",
    "Beta handbook",
    "Zulu workflow",
  ]);
  expect(pages[0].title).toBe("Zulu workflow");
});

test("explicit onboarding order is stable for ties and never inferred from title or topic", () => {
  const alpha = {
    ...page("Alpha setup meeting"),
    properties: { onboarding_order: 5 },
  };
  const zulu = { ...page("Zulu guide"), properties: { onboarding_order: 5 } };
  const selected = [zulu, alpha];
  expect(onboardingPages(selected)).toEqual([alpha, zulu]);
  expect(onboardingPages([...selected].reverse())).toEqual([alpha, zulu]);
  expect(selected).toEqual([zulu, alpha]);
});

test("groups contain only pages supplied by the publication selection", () => {
  const selected = page("Current workflow");
  // Archived and draft revisions never enter the API's PageSummary list.
  expect(groupWelcomePages([selected]).flatMap((group) => group.pages)).toEqual(
    [selected],
  );
  expect(groupWelcomePages([]).every((group) => group.pages.length === 0)).toBe(
    true,
  );
});

function entity(title: string, catalogType?: string): PageSummary {
  return {
    ...page(title, "entity"),
    properties: catalogType === undefined ? {} : { catalog_type: catalogType },
  };
}

test("page type groups split entities by catalog type and include every page once in a stable order", () => {
  const pages = [
    page("Zeta source", "summary"),
    page("Alpha source", "summary"),
    page("Agent loops"),
    page("Why retries fail", "answer"),
    page("Weekly call", "transcript"),
    page("Old import", "legacy"),
    page("Odd kind", "unknown"),
    entity("Mario Example", "person"),
    entity("Ada Example", "person"),
    entity("Platform team", "group"),
    entity("Build server", "resource"),
    entity("Stripe Example"),
    entity("Mystery entity", "spaceship"),
    entity("Example Labs", "organization"),
    entity("Example CLI", "product"),
    entity("Example Model 2", "model"),
  ];
  const groups = groupWelcomePagesByType(pages);
  const filled = groups
    .filter((group) => group.pages.length)
    .map((group) => [group.title, group.pages.map((item) => item.title)]);
  expect(filled).toEqual([
    ["Source summaries", ["Alpha source", "Zeta source"]],
    ["Concepts", ["Agent loops"]],
    ["Answers", ["Why retries fail"]],
    ["Transcripts", ["Weekly call"]],
    ["People", ["Ada Example", "Mario Example"]],
    ["Groups", ["Platform team"]],
    ["Organizations", ["Example Labs"]],
    ["Products", ["Example CLI"]],
    ["Models", ["Example Model 2"]],
    ["Resources", ["Build server"]],
    ["Other entities", ["Mystery entity", "Stripe Example"]],
    ["Other pages", ["Odd kind", "Old import"]],
  ]);
  expect(groups.flatMap((group) => group.pages)).toHaveLength(pages.length);
  expect(new Set(groups.map((group) => group.id)).size).toBe(groups.length);
  expect(groupWelcomePagesByType([...pages].reverse())).toEqual(groups);
  // A catalog_type on a non-entity page does not move it out of its kind.
  expect(
    groupWelcomePagesByType([
      { ...page("Typed concept"), properties: { catalog_type: "person" } },
    ]).find((group) => group.title === "Concepts")!.pages,
  ).toHaveLength(1);
});

test("the default view uses topics only with explicit membership", () => {
  expect(defaultWelcomeView([])).toBe("types");
  expect(defaultWelcomeView([page("Platform architecture")])).toBe("types");
  expect(
    defaultWelcomeView([
      { ...page("Any title"), properties: { topics: ["science"] } },
    ]),
  ).toBe("topics");
  expect(isWelcomeView("types")).toBe(true);
  expect(isWelcomeView("grouped")).toBe(false);
  expect(isWelcomeView(undefined)).toBe(false);
});
