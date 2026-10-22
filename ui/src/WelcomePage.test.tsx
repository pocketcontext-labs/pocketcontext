import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import WelcomePage from "./WelcomePage";
import PagesDirectory, { pagesHref } from "./PagesDirectory";
import { availableCatalogTypes } from "./catalogNavigation";
import type { PageSummary, Publication } from "./types";
const page = (
  slug: string,
  properties: PageSummary["properties"] = {},
): PageSummary => ({
  id: `rev-${slug}`,
  page: `page-${slug}`,
  slug,
  title: slug,
  summary: `About ${slug}`,
  kind: "concept",
  properties,
});
const publication: Publication = {
  space: "companyspace001",
  id: "publication0001",
  sequence: 8,
  home: "",
  run: "run000000000001",
  created: "2026-01-01",
};
const a = page("Alpha", { topics: ["research", "tools"], onboarding_order: 1 }),
  b = page("Beta", { topics: ["research"] }),
  def = {
    ...page("research", { navigation_kind: "topic" }),
    title: "Research notes",
  };
const props = {
  pages: [a, b, def],
  publication,
  onSearch: vi.fn(),
  onTopicChange: vi.fn(),
  onBrowsePages: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("Overview has topic shortcuts and explicit guides but no directory", () => {
  render(<WelcomePage {...props} />);
  expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "All pages" })).toBeNull();
  expect(screen.queryByLabelText("Filter pages")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Research notes/ }));
  expect(props.onTopicChange).toHaveBeenCalledWith("research");
  fireEvent.click(screen.getByRole("button", { name: /Browse all pages/ }));
  expect(props.onBrowsePages).toHaveBeenCalledOnce();
  expect(
    screen.getByText("Getting started").closest("details"),
  ).not.toHaveAttribute("open");
});
it("Overview submits ranked page search and limits recents to selected unique revisions", () => {
  const pages = Array.from({ length: 8 }, (_, i) => page(`Page ${i}`));
  render(
    <WelcomePage
      {...props}
      pages={pages}
      pinned={publication.id}
      recentPages={[
        { ...pages[0], id: "stale", publishedAt: "2026-01-01" },
        ...pages.map((item) => ({ ...item, publishedAt: "2026-01-01" })),
        { ...pages[0], publishedAt: "2026-01-01" },
      ]}
    />,
  );
  const recent = within(
    screen.getByRole("region", { name: "Recently published" }),
  );
  expect(recent.getAllByRole("link")).toHaveLength(6);
  expect(recent.getAllByRole("link")[0].getAttribute("href")).toContain(
    `publication=${publication.id}`,
  );
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "source content" },
  });
  fireEvent.submit(screen.getByRole("search"));
  expect(props.onSearch).toHaveBeenCalledWith("source content");
});
it("Overview omits empty groups and onboarding inferred from titles", () => {
  render(<WelcomePage {...props} pages={[]} />);
  expect(
    screen.queryByRole("heading", { name: "Explore by topic" }),
  ).toBeNull();
  expect(screen.queryByText("Getting started")).toBeNull();
  expect(screen.getByText("0 pages")).toBeTruthy();
});
it("All pages is a standalone directory with snapshot links and unique total", () => {
  render(
    <PagesDirectory
      pages={props.pages}
      publication={publication.id}
      state={{}}
      onNavigate={() => {}}
    />,
  );
  expect(screen.getByRole("heading", { name: "All pages" })).toHaveFocus();
  expect(
    screen.queryByRole("heading", { name: "Recently published" }),
  ).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("3 of 3 pages");
  expect(screen.getAllByRole("link")).toHaveLength(3);
  expect(
    screen.getByRole("link", { name: /Alpha/ }).getAttribute("href"),
  ).toContain(`publication=${publication.id}`);
});
it("filters exact topic membership, text and descending order without counting duplicate membership", () => {
  const nav = vi.fn();
  const { rerender } = render(
    <PagesDirectory
      pages={props.pages}
      state={{ topic: "research", filter: "a", sort: "-title" }}
      onNavigate={nav}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("2 of 3 pages");
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "BetaAbout Betaconcept",
    "AlphaAbout Alphaconcept",
  ]);
  fireEvent.change(screen.getByLabelText("Filter pages"), {
    target: { value: "Beta" },
  });
  expect(nav).toHaveBeenLastCalledWith(
    pagesHref({ topic: "research", filter: "Beta", sort: "-title" }),
  );
  rerender(
    <PagesDirectory
      pages={props.pages}
      state={{ topic: "missing" }}
      onNavigate={nav}
    />,
  );
  expect(
    screen.getByText("This topic is unavailable in this publication."),
  ).toBeTruthy();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});
it("topic grouping keeps definitions discoverable and type grouping includes every page", () => {
  const { rerender } = render(
    <PagesDirectory
      pages={props.pages}
      state={{ view: "topics" }}
      onNavigate={() => {}}
    />,
  );
  expect(
    within(
      screen.getByRole("region", { name: "Navigation definitions" }),
    ).getByRole("link", { name: /Research notes/ }),
  ).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("3 of 3 pages");
  rerender(
    <PagesDirectory
      pages={props.pages}
      state={{ view: "types" }}
      onNavigate={() => {}}
    />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(3);
});
it("empty spaces and malicious text render safely", () => {
  const { rerender } = render(
    <PagesDirectory pages={[]} state={{}} onNavigate={() => {}} />,
  );
  expect(
    screen.getByText("No pages have been published in this space yet."),
  ).toBeTruthy();
  rerender(
    <PagesDirectory
      pages={[page("<script>alert(1)</script>")]}
      state={{}}
      onNavigate={() => {}}
    />,
  );
  expect(document.querySelector("script")).toBeNull();
});
it("only populated built-in catalogs appear, with prompts derived from repository documents", () => {
  expect(availableCatalogTypes([])).toEqual([]);
  expect(
    availableCatalogTypes([
      page("person", { catalog_type: "person" }),
      page("prompt", {
        catalog_type: "repository_document",
        document_type: "prompt",
      }),
      page("custom", { catalogs: ["tools"] }),
    ]),
  ).toEqual(["person", "repository_document", "prompt"]);
});

it("topic filtering preserves published definition labels and isolates the selected membership", () => {
  const { rerender } = render(
    <PagesDirectory
      pages={props.pages}
      state={{ view: "topics", topic: "research", filter: "Alpha" }}
      onNavigate={() => {}}
    />,
  );
  expect(screen.getByRole("region", { name: "Research notes" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Tools" })).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  rerender(
    <PagesDirectory
      pages={props.pages}
      state={{ view: "topics", filter: "Alpha" }}
      onNavigate={() => {}}
    />,
  );
  expect(screen.getByRole("region", { name: "Research notes" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Tools" })).toBeTruthy();
});
