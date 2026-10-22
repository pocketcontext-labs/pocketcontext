import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import WelcomePage from "./WelcomePage";
import type { PageSummary, Publication } from "./types";

const page = (
  slug: string,
  title: string,
  summary = "",
  order?: number,
): PageSummary => ({
  id: `revision-${slug}`,
  page: `page-${slug}`,
  slug,
  title,
  summary,
  kind: "concept",
  properties: order === undefined ? {} : { onboarding_order: order },
});
const pages = [
  page("colleague-onboarding", "Colleague onboarding", "", 1),
  page("application-skills", "Application skills", "", 2),
  page("login-guide", "Sign in guide", "", 3),
  page("release-notes", "Release notes"),
  page("unusual-topic", "A surprising subject", "A needle in the catalog"),
];
const publication: Publication = {
  space: "companyspace001",
  id: "publication0001",
  sequence: 8,
  home: "",
  run: "run000000000001",
  created: "2026-01-01",
};
afterEach(cleanup);

it("indexes every supplied page, preserves historical links and only suggests existing guides", () => {
  render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={pages}
      publication={publication}
      pinned={publication.id}
    />,
  );
  const index = within(
    screen.getByRole("region", { name: "The complete page index" }),
  );
  expect(index.getAllByRole("link")).toHaveLength(pages.length);
  for (const item of pages)
    expect(index.getByRole("link", { name: item.title })).toHaveAttribute(
      "href",
      `#/page/${item.slug}?publication=${publication.id}`,
    );
  const disclosure = screen
    .getByText("Getting started", { selector: "summary > span" })
    .closest("details")!;
  expect(disclosure).not.toHaveAttribute("open");
  fireEvent.click(disclosure.querySelector("summary")!);
  expect(disclosure).toHaveAttribute("open");
  const onboarding = within(disclosure);
  expect(
    onboarding.getAllByRole("link").map((item) => item.textContent),
  ).toEqual(["Colleague onboarding", "Application skills", "Sign in guide"]);
  expect(
    onboarding.getByRole("link", { name: "Colleague onboarding" }),
  ).toHaveAttribute(
    "href",
    "#/page/colleague-onboarding?publication=publication0001",
  );
  expect(onboarding.queryByRole("link", { name: /Release notes/ })).toBeNull();
});

it("submits full-text search without filtering the page directory", () => {
  const onSearch = vi.fn();
  render(
    <WelcomePage
      onTopicChange={() => {}}
      pages={pages}
      publication={publication}
      onSearch={onSearch}
    />,
  );
  const search = screen.getByRole("searchbox", {
    name: "Search published pages",
  });
  const index = within(
    screen.getByRole("region", { name: "The complete page index" }),
  );
  expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  fireEvent.change(search, { target: { value: "  needle  " } });
  expect(index.getAllByRole("link")).toHaveLength(pages.length);
  fireEvent.submit(screen.getByRole("search", { name: "Published pages" }));
  expect(onSearch).toHaveBeenCalledWith("needle");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(search).toHaveValue("");
});

it("filters topics, focuses the directory and supports alphabetical mode", () => {
  render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={pages}
      publication={publication}
    />,
  );
  const index = within(
    screen.getByRole("region", { name: "The complete page index" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Handoffs & history/ }));
  expect(index.getAllByRole("link")).toHaveLength(1);
  expect(index.getByRole("link", { name: "Release notes" })).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "The complete page index" }),
  ).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  fireEvent.click(screen.getByRole("button", { name: "A–Z" }));
  expect(screen.getByRole("button", { name: "A–Z" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(index.getAllByRole("link")[0]).toHaveTextContent(
    "A surprising subject",
  );
});

it("follows topic navigation and keeps all onboarding guides behind a disclosure", () => {
  const catalog = [
    ...pages,
    page("workspace-setup", "Workspace setup", "", 4),
    page("extra-onboarding", "Extra onboarding", "", 5),
  ];
  const rendered = render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={catalog}
      publication={publication}
      topic="handoffs-history"
    />,
  );
  const index = within(
    screen.getByRole("region", { name: "The complete page index" }),
  );
  expect(index.getAllByRole("link")).toHaveLength(1);
  const guides = screen
    .getByText("Getting started", { selector: "summary > span" })
    .closest("details");
  expect(guides).not.toHaveAttribute("open");
  expect(within(guides!).getAllByRole("link", { hidden: true })).toHaveLength(
    5,
  );
  rendered.rerender(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={catalog}
      publication={publication}
      topic="all"
    />,
  );
  expect(index.getAllByRole("link")).toHaveLength(catalog.length);
});

it("replaces the complete catalog on publication changes without retaining old links", () => {
  const rendered = render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={pages}
      publication={publication}
    />,
  );
  rendered.rerender(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={[page("new", "New page")]}
      publication={{ ...publication, sequence: 9 }}
    />,
  );
  expect(
    screen.queryByRole("link", { name: "Colleague onboarding" }),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "New page" })).toBeVisible();
  expect(document.querySelector("details.welcome-onboarding")).toBeNull();
  expect(screen.getByText("Live publication 9")).toBeVisible();
});

it("renders empty and untrusted catalog text safely", () => {
  const rendered = render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={[]}
      publication={null}
    />,
  );
  expect(
    screen.getByText("No pages have been published in this view yet."),
  ).toBeVisible();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  rendered.rerender(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={[page("safe", "<img src=x onerror=alert(1)>")]}
      publication={publication}
    />,
  );
  expect(document.querySelector("img")).toBeNull();
  expect(
    screen.getByRole("link", { name: "<img src=x onerror=alert(1)>" }),
  ).toHaveAttribute("href", "#/page/safe");
});

it("synchronizes topic choices with navigation and resets when Welcome opens", () => {
  const onTopicChange = vi.fn();
  const rendered = render(
    <WelcomePage
      pages={pages}
      publication={publication}
      onSearch={() => {}}
      onTopicChange={onTopicChange}
      topic="handoffs-history"
    />,
  );
  const index = within(
    screen.getByRole("region", { name: "The complete page index" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(onTopicChange).toHaveBeenLastCalledWith("all");
  fireEvent.click(screen.getByRole("button", { name: /Getting started/ }));
  expect(onTopicChange).toHaveBeenLastCalledWith("getting-started");
  expect(index.getAllByRole("link").length).toBeLessThan(pages.length);
  rendered.rerender(
    <WelcomePage
      pages={pages}
      publication={publication}
      onSearch={() => {}}
      onTopicChange={onTopicChange}
      topic=""
    />,
  );
  expect(index.getAllByRole("link")).toHaveLength(pages.length);
  fireEvent.click(screen.getByRole("button", { name: "Browse all pages ↓" }));
  expect(onTopicChange).toHaveBeenLastCalledWith("all");
});

it("defaults to page types for uncategorized knowledge, switches views and reports the choice", () => {
  const onViewChange = vi.fn();
  const knowledge = [
    {
      ...page("ada-example", "Ada Example"),
      kind: "entity",
      properties: { catalog_type: "person" },
    },
    { ...page("widget-co", "Widget Co"), kind: "entity" },
    { ...page("agent-loops", "Agent loops"), kind: "concept" },
    { ...page("2026-talk", "A talk about agents"), kind: "summary" },
  ];
  const rendered = render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      onViewChange={onViewChange}
      pages={knowledge}
      publication={publication}
    />,
  );
  const index = within(
    screen.getByRole("region", { name: "The complete page index" }),
  );
  const views = within(screen.getByRole("group", { name: "Index view" }));
  expect(views.getByRole("button", { name: "By page type" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    index.getAllByRole("heading", { level: 3 }).map((item) => item.textContent),
  ).toEqual(["Source summaries", "Concepts", "People", "Other entities"]);
  expect(
    within(index.getByRole("region", { name: "People" })).getByRole("link", {
      name: "Ada Example",
    }),
  ).toBeVisible();
  fireEvent.click(views.getByRole("button", { name: "By topic" }));
  expect(onViewChange).toHaveBeenLastCalledWith("topics");
  expect(views.getByRole("button", { name: "By topic" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    index.getByRole("heading", { name: "People & relationships" }),
  ).toBeVisible();
  fireEvent.click(views.getByRole("button", { name: "A–Z" }));
  expect(onViewChange).toHaveBeenLastCalledWith("alphabetical");
  expect(index.getAllByRole("link")[0]).toHaveTextContent(
    "A talk about agents",
  );
  rendered.rerender(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      onViewChange={onViewChange}
      pages={knowledge}
      publication={publication}
      view="types"
    />,
  );
  expect(views.getByRole("button", { name: "By page type" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  rendered.rerender(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      onViewChange={onViewChange}
      pages={knowledge}
      publication={publication}
      view="bogus"
    />,
  );
  expect(views.getByRole("button", { name: "By page type" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("keeps topic grouping by default for categorized pages and honors a view from the URL", () => {
  render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={pages}
      publication={publication}
      view="types"
    />,
  );
  const index = within(
    screen.getByRole("region", { name: "The complete page index" }),
  );
  expect(screen.getByRole("button", { name: "By page type" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    index.getAllByRole("heading", { level: 3 }).map((item) => item.textContent),
  ).toEqual(["Concepts"]);
  cleanup();
  render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={pages}
      publication={publication}
    />,
  );
  expect(screen.getByRole("button", { name: "By topic" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("shows recent selected revisions with dates and preserves historical links", () => {
  render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={pages}
      publication={publication}
      pinned={publication.id}
      recentPages={[
        {
          ...pages[3],
          title: "stale recent title",
          publishedAt: "2026-01-01 12:00:00.000Z",
        },
        { ...pages[0], publishedAt: "2025-12-30T12:00:00Z" },
      ]}
    />,
  );
  const recent = within(
    screen.getByRole("region", { name: "Recently published" }),
  );
  expect(
    recent.getAllByRole("link").map((item) => item.getAttribute("href")),
  ).toEqual([
    "#/page/release-notes?publication=publication0001",
    "#/page/colleague-onboarding?publication=publication0001",
  ]);
  expect(recent.getByRole("link", { name: /Release notes/ })).toBeVisible();
  expect(screen.queryByText("stale recent title")).toBeNull();
  expect(screen.getByRole("region", { name: "Recently published" }).querySelector("time")).toHaveAttribute(
    "datetime",
    "2026-01-01T12:00:00.000Z",
  );
  expect(
    recent.getByText("New and updated pages in this historical view."),
  ).toBeVisible();
});

it("omits stale, missing and duplicate recent revisions and clears them when the publication changes", () => {
  const selected = pages[3];
  const recentPages = [
    { ...page("unavailable", "Unavailable page"), publishedAt: "2026-01-01" },
    { ...selected, id: "older-revision", publishedAt: "2026-01-01" },
    { ...selected, publishedAt: "bad-date" },
    { ...selected, publishedAt: "2026-01-01" },
    { ...selected, publishedAt: "2026-01-01" },
  ];
  const rendered = render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={pages}
      publication={publication}
      recentPages={recentPages}
    />,
  );
  expect(
    within(
      screen.getByRole("region", { name: "Recently published" }),
    ).getAllByRole("link"),
  ).toHaveLength(1);
  rendered.rerender(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={[page("new-page", "New page")]}
      publication={{ ...publication, sequence: 9 }}
      recentPages={recentPages}
    />,
  );
  expect(
    screen.queryByRole("region", { name: "Recently published" }),
  ).toBeNull();
  expect(screen.queryByText("Unavailable page")).toBeNull();
});

it("limits recent pages to six while retaining the complete directory", () => {
  const catalog = Array.from({ length: 10 }, (_, index) => page(`page-${index}`, `Page ${index}`));
  render(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={catalog} publication={publication} recentPages={catalog.map(item => ({ ...item, publishedAt: "2026-01-01" }))} />);
  expect(within(screen.getByRole("region", { name: "Recently published" })).getAllByRole("link")).toHaveLength(6);
  expect(within(screen.getByRole("region", { name: "The complete page index" })).getAllByRole("link")).toHaveLength(10);
});

it("keeps an empty Home compact without empty topic cards or inferred onboarding", () => {
  const rendered = render(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={[]}
      publication={null}
    />,
  );
  expect(screen.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  expect(
    screen.getByRole("searchbox", { name: "Search published pages" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Explore by topic" }),
  ).toBeNull();
  expect(document.querySelector("details")).toBeNull();
  rendered.rerender(
    <WelcomePage
      onTopicChange={() => {}}
      onSearch={() => {}}
      pages={[page("onboarding-guide", "Onboarding guide")]}
      publication={publication}
    />,
  );
  expect(document.querySelector("details")).toBeNull();
});

it("focuses the page directory when a view opens directly or changes through navigation", () => {
  const rendered = render(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={pages} publication={publication} view="alphabetical" />);
  const heading = screen.getByRole("heading", { name: "The complete page index" });
  expect(heading).toHaveFocus();
  const scrollIntoView = vi.fn();
  heading.scrollIntoView = scrollIntoView;
  screen.getByRole("searchbox", { name: "Search published pages" }).focus();
  rendered.rerender(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={pages} publication={publication} view="types" />);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(heading).toHaveFocus();
  scrollIntoView.mockClear();
  rendered.rerender(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={pages} publication={publication} />);
  expect(scrollIntoView).not.toHaveBeenCalled();
});
