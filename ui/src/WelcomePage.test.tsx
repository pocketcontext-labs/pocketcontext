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

const page = (slug: string, title: string, summary = ""): PageSummary => ({
  id: `revision-${slug}`,
  page: `page-${slug}`,
  slug,
  title,
  summary,
  kind: "concept",
});
const pages = [
  page("colleague-onboarding", "Colleague onboarding"),
  page("application-skills", "Application skills"),
  page("login-guide", "Sign in guide"),
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
    <WelcomePage onTopicChange={() => {}} onSearch={() => {}}
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
  const onboarding = within(
    screen.getByRole("region", { name: "New to the workspace?" }),
  );
  expect(
    onboarding.getByRole("link", { name: "Open onboarding" }),
  ).toHaveAttribute(
    "href",
    "#/page/colleague-onboarding?publication=publication0001",
  );
  expect(
    onboarding.getByRole("link", { name: /Application skills/ }),
  ).toBeVisible();
  expect(onboarding.getByRole("link", { name: /Sign in guide/ })).toBeVisible();
  expect(onboarding.queryByRole("link", { name: /Release notes/ })).toBeNull();
});

it("submits full-text search without filtering the page directory", () => {
  const onSearch = vi.fn();
  render(<WelcomePage onTopicChange={() => {}} pages={pages} publication={publication} onSearch={onSearch} />);
  const search = screen.getByRole("searchbox", { name: "Search published pages" });
  const index = within(screen.getByRole("region", { name: "The complete page index" }));
  expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  fireEvent.change(search, { target: { value: "  needle  " } });
  expect(index.getAllByRole("link")).toHaveLength(pages.length);
  fireEvent.submit(screen.getByRole("search", { name: "Published pages" }));
  expect(onSearch).toHaveBeenCalledWith("needle");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(search).toHaveValue("");
});

it("filters topics, focuses the directory and supports alphabetical mode", () => {
  render(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={pages} publication={publication} />);
  const index = within(screen.getByRole("region", { name: "The complete page index" }));
  fireEvent.click(screen.getByRole("button", { name: /Handoffs & history/ }));
  expect(index.getAllByRole("link")).toHaveLength(1);
  expect(index.getByRole("link", { name: "Release notes" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "The complete page index" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  fireEvent.click(screen.getByRole("button", { name: "A–Z" }));
  expect(screen.getByRole("button", { name: "A–Z" })).toHaveAttribute("aria-pressed", "true");
  expect(index.getAllByRole("link")[0]).toHaveTextContent("A surprising subject");
});

it("follows topic navigation and keeps all onboarding guides behind a disclosure", () => {
  const catalog = [...pages, page("workspace-setup", "Workspace setup"), page("extra-onboarding", "Extra onboarding")];
  const rendered = render(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={catalog} publication={publication} topic="handoffs-history" />);
  const index = within(screen.getByRole("region", { name: "The complete page index" }));
  expect(index.getAllByRole("link")).toHaveLength(1);
  const guides = screen.getByText("All onboarding guides (5)").closest("details");
  expect(guides).not.toHaveAttribute("open");
  expect(within(guides!).getAllByRole("link", { hidden: true })).toHaveLength(5);
  rendered.rerender(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={catalog} publication={publication} topic="all" />);
  expect(index.getAllByRole("link")).toHaveLength(catalog.length);
});

it("replaces the complete catalog on publication changes without retaining old links", () => {
  const rendered = render(
    <WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={pages} publication={publication} />,
  );
  rendered.rerender(
    <WelcomePage onTopicChange={() => {}} onSearch={() => {}}
      pages={[page("new", "New page")]}
      publication={{ ...publication, sequence: 9 }}
    />,
  );
  expect(
    screen.queryByRole("link", { name: "Colleague onboarding" }),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "New page" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open onboarding" })).toBeNull();
  expect(screen.getByText("Live publication 9")).toBeVisible();
});

it("renders empty and untrusted catalog text safely", () => {
  const rendered = render(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={[]} publication={null} />);
  expect(
    screen.getByText("No pages have been published in this view yet."),
  ).toBeVisible();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  rendered.rerender(
    <WelcomePage onTopicChange={() => {}} onSearch={() => {}}
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
  const rendered = render(<WelcomePage pages={pages} publication={publication} onSearch={() => {}} onTopicChange={onTopicChange} topic="handoffs-history" />);
  const index = within(screen.getByRole("region", { name: "The complete page index" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(onTopicChange).toHaveBeenLastCalledWith("all");
  fireEvent.click(screen.getByRole("button", { name: /Getting started/ }));
  expect(onTopicChange).toHaveBeenLastCalledWith("getting-started");
  expect(index.getAllByRole("link").length).toBeLessThan(pages.length);
  rendered.rerender(<WelcomePage pages={pages} publication={publication} onSearch={() => {}} onTopicChange={onTopicChange} topic="" />);
  expect(index.getAllByRole("link")).toHaveLength(pages.length);
  fireEvent.click(screen.getByRole("button", { name: "Browse all pages ↓" }));
  expect(onTopicChange).toHaveBeenLastCalledWith("all");
});

it("defaults to page types for uncategorized knowledge, switches views and reports the choice", () => {
  const onViewChange = vi.fn();
  const knowledge = [
    { ...page("ada-example", "Ada Example"), kind: "entity", properties: { catalog_type: "person" } },
    { ...page("widget-co", "Widget Co"), kind: "entity" },
    { ...page("agent-loops", "Agent loops"), kind: "concept" },
    { ...page("2026-talk", "A talk about agents"), kind: "summary" },
  ];
  const rendered = render(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} onViewChange={onViewChange} pages={knowledge} publication={publication} />);
  const index = within(screen.getByRole("region", { name: "The complete page index" }));
  const views = within(screen.getByRole("group", { name: "Index view" }));
  expect(views.getByRole("button", { name: "By page type" })).toHaveAttribute("aria-pressed", "true");
  expect(index.getAllByRole("heading", { level: 3 }).map(item => item.textContent)).toEqual(["Source summaries", "Concepts", "People", "Other entities"]);
  expect(within(index.getByRole("region", { name: "People" })).getByRole("link", { name: "Ada Example" })).toBeVisible();
  fireEvent.click(views.getByRole("button", { name: "By topic" }));
  expect(onViewChange).toHaveBeenLastCalledWith("topics");
  expect(views.getByRole("button", { name: "By topic" })).toHaveAttribute("aria-pressed", "true");
  expect(index.getByRole("heading", { name: "People & relationships" })).toBeVisible();
  fireEvent.click(views.getByRole("button", { name: "A–Z" }));
  expect(onViewChange).toHaveBeenLastCalledWith("alphabetical");
  expect(index.getAllByRole("link")[0]).toHaveTextContent("A talk about agents");
  rendered.rerender(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} onViewChange={onViewChange} pages={knowledge} publication={publication} view="types" />);
  expect(views.getByRole("button", { name: "By page type" })).toHaveAttribute("aria-pressed", "true");
  rendered.rerender(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} onViewChange={onViewChange} pages={knowledge} publication={publication} view="bogus" />);
  expect(views.getByRole("button", { name: "By page type" })).toHaveAttribute("aria-pressed", "true");
});

it("keeps topic grouping by default for categorized pages and honors a view from the URL", () => {
  render(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={pages} publication={publication} view="types" />);
  const index = within(screen.getByRole("region", { name: "The complete page index" }));
  expect(screen.getByRole("button", { name: "By page type" })).toHaveAttribute("aria-pressed", "true");
  expect(index.getAllByRole("heading", { level: 3 }).map(item => item.textContent)).toEqual(["Concepts"]);
  cleanup();
  render(<WelcomePage onTopicChange={() => {}} onSearch={() => {}} pages={pages} publication={publication} />);
  expect(screen.getByRole("button", { name: "By topic" })).toHaveAttribute("aria-pressed", "true");
});
