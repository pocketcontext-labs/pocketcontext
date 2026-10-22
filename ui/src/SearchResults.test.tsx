import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, SearchChangedError, type SearchPage } from "./api";
import SearchResults from "./SearchResults";

const hit = (id: string) => ({
  id,
  page: id,
  slug: id,
  title: id,
  kind: "concept",
  summary: "",
  score: -1,
  excerpt: "Readable <img src=x onerror=alert(1)> text.",
});
const batch = (id: string, more = true): SearchPage => ({
  generation: "g1",
  hits: [hit(id)],
  hasMore: more,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("renders safe plain excerpts, appends one generation, and clears mixed results on conflict", async () => {
  const search = vi
    .spyOn(api, "searchPages")
    .mockResolvedValueOnce(batch("first"))
    .mockResolvedValueOnce(batch("second"))
    .mockRejectedValueOnce(new SearchChangedError())
    .mockResolvedValueOnce(batch("new", false));
  render(
    <SearchResults
      publication="publication0001"
      query="term"
      visible
      epoch={0}
    />,
  );
  await screen.findByRole("link", { name: "first" });
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText("Readable text.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
  await screen.findByRole("link", { name: "second" });
  expect(search.mock.calls[1]).toEqual([
    "publication0001",
    "term",
    1,
    20,
    "g1",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
  await screen.findByRole("button", { name: "Restart search" });
  expect(screen.queryByRole("link", { name: "first" })).toBeNull();
  expect(screen.queryByRole("link", { name: "second" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restart search" }));
  await screen.findByRole("link", { name: "new" });
});

it("highlights literal query text in titles and clean snippets without rendering markup", async () => {
  vi.spyOn(api, "searchPages").mockResolvedValue({
    generation: "g1",
    hasMore: false,
    hits: [
      {
        ...hit("safe"),
        title: "Term [x.y] <script>unsafe()</script>",
        excerpt:
          "## Term report\n\nA **term** and [x.y] appear with [safe link](javascript:unsafe()) and [[star-chart]][^1]. <img src=x onerror=unsafe()>",
      },
    ],
  });
  render(
    <SearchResults
      publication="publication0001"
      query="term [x.y]"
      visible
      epoch={0}
    />,
  );
  const link = await screen.findByRole("link", {
    name: "Term [x.y] <script>unsafe()</script>",
  });
  expect(
    Array.from(link.querySelectorAll("mark"), (mark) => mark.textContent),
  ).toEqual(["Term", "[x.y]"]);
  const excerpt = document.querySelector(".search-excerpt")!;
  expect(excerpt.textContent).toBe(
    "Term report A term and [x.y] appear with safe link and star-chart.",
  );
  expect(
    Array.from(excerpt.querySelectorAll("mark"), (mark) => mark.textContent),
  ).toEqual(["Term", "term", "[x.y]"]);
  expect(excerpt.querySelector("a, img, script, h1, h2, strong")).toBeNull();
  expect(document.querySelector("script, img")).toBeNull();
  expect(link).toHaveAttribute(
    "href",
    expect.stringContaining("q=term%20%5Bx.y%5D"),
  );
});

it("restores the selected result and reader scroll after returning from a page", async () => {
  const search = vi
    .spyOn(api, "searchPages")
    .mockResolvedValue(batch("return-here", false));
  const view = (visible: boolean) => (
    <div id="reader">
      <SearchResults
        publication="publication0001"
        query="return"
        visible={visible}
        epoch={0}
      />
    </div>
  );
  const rendered = render(view(true));
  const reader = document.getElementById("reader")!;
  const scroll = vi.fn();
  reader.scrollTo = scroll;
  const link = await screen.findByRole("link", { name: "return-here" });
  reader.scrollTop = 240;
  fireEvent.click(link);
  rendered.rerender(view(false));
  reader.scrollTop = 0;
  rendered.rerender(view(true));
  await waitFor(() => expect(link).toHaveFocus());
  expect(scroll).toHaveBeenLastCalledWith(0, 240);
  expect(search).toHaveBeenCalledTimes(1);
});
it("ignores old pending requests after a query or publication change", async () => {
  let finish!: (page: SearchPage) => void;
  vi.spyOn(api, "searchPages")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(batch("current", false));
  const rendered = render(
    <SearchResults
      publication="publication0001"
      query="old"
      visible
      epoch={0}
    />,
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  rendered.rerender(
    <SearchResults
      publication="publication0002"
      query="new"
      visible
      epoch={0}
    />,
  );
  await screen.findByRole("link", { name: "current" });
  await act(async () => finish(batch("stale")));
  expect(screen.queryByRole("link", { name: "stale" })).toBeNull();
  expect(screen.getByRole("link", { name: "current" })).toBeVisible();
});
