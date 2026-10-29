import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { pb, SearchChangedError } from "./api";
import * as sources from "./sourceSearchApi";
import SourceSearch from "./SourceSearch";
const space = "space0000000001";
const hit = (n: number) => ({
  id: `source${String(n).padStart(9, "0")}`,
  title: `Rocket ${n}`,
  original_name: "note.md",
  source_date: "",
  score: -1,
  excerpt: "## Rocket **notes**. <img src=x onerror=unsafe()>",
  passage: `passage${String(n).padStart(8, "0")}`,
  locator: "lines 1-4",
});
const batch = (n: number, hasMore = true): sources.SourceSearchPage => ({
  generation: "a".repeat(64),
  hits: [hit(n)],
  hasMore,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("renders one safe source link with its matching passage, appends one generation, restarts on conflict", async () => {
  const search = vi
    .spyOn(sources, "searchSources")
    .mockResolvedValueOnce(batch(1))
    .mockResolvedValueOnce(batch(2))
    .mockRejectedValueOnce(new SearchChangedError())
    .mockResolvedValueOnce(batch(3, false));
  render(<SourceSearch space={space} query="rocket" visible epoch={0} />);
  const first = await screen.findByRole("link", { name: "Rocket 1" });
  expect(first.getAttribute("href")).toBe(
    "#/sources/source000000001?space=space0000000001&passage=passage00000001",
  );
  expect(first.querySelector("mark")?.textContent).toBe("Rocket");
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector(".search-excerpt")).toHaveTextContent(
    /Rocket notes\s*\./,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
  await screen.findByRole("link", { name: "Rocket 2" });
  expect(search.mock.calls[1]).toEqual([
    space,
    "rocket",
    1,
    20,
    "a".repeat(64),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
  await screen.findByRole("button", { name: "Restart search" });
  expect(within(screen.getByRole("list")).queryAllByRole("link")).toHaveLength(
    0,
  );
  fireEvent.click(screen.getByRole("button", { name: "Restart search" }));
  await screen.findByRole("link", { name: "Rocket 3" });
});
it("fences stale search promises on query, space and epoch changes", async () => {
  const pending: Array<(v: sources.SourceSearchPage) => void> = [];
  vi.spyOn(sources, "searchSources").mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const view = render(
    <SourceSearch space={space} query="rocket" visible epoch={0} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 220));
  view.rerender(
    <SourceSearch space="space0000000002" query="orbit" visible epoch={1} />,
  );
  await act(async () => pending[0](batch(1)));
  expect(screen.queryByRole("link", { name: "Rocket 1" })).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 220));
  await act(async () => pending[1](batch(2, false)));
  expect(await screen.findByRole("link", { name: "Rocket 2" })).toHaveAttribute(
    "href",
    expect.stringContaining("space=space0000000002"),
  );
});
it("clears loaded results when pagination reports lost space access", async () => {
  vi.spyOn(sources, "searchSources")
    .mockResolvedValueOnce(batch(1))
    .mockRejectedValueOnce(
      new sources.SourceSearchUnavailableError("not-found"),
    );
  render(<SourceSearch space={space} query="rocket" visible epoch={0} />);
  await screen.findByRole("link", { name: "Rocket 1" });
  fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
  await screen.findByRole("alert");
  expect(within(screen.getByRole("list")).queryAllByRole("link")).toHaveLength(
    0,
  );
});
it("clears private results immediately on authentication change", async () => {
  vi.spyOn(sources, "searchSources").mockResolvedValue(batch(1));
  render(<SourceSearch space={space} query="rocket" visible epoch={0} />);
  await screen.findByRole("link", { name: "Rocket 1" });
  act(() => pb.authStore.clear());
  expect(within(screen.getByRole("list")).queryAllByRole("link")).toHaveLength(
    0,
  );
});
it("metadata-only results omit passage and publication parameters", async () => {
  vi.spyOn(sources, "searchSources").mockResolvedValue({
    generation: "a".repeat(64),
    hasMore: false,
    hits: [{ ...hit(1), passage: undefined, excerpt: "" }],
  });
  location.hash = "#/sources/?publication=old";
  render(<SourceSearch space={space} query="rocket" visible epoch={0} />);
  const link = await screen.findByRole("link", { name: "Rocket 1" });
  expect(link.getAttribute("href")).toBe(
    "#/sources/source000000001?space=space0000000001",
  );
  expect(screen.getByText("note.md")).toBeVisible();
});

it("labels matching passages from agent-derived text", async () => {
  vi.spyOn(sources, "searchSources").mockResolvedValue({
    generation: "a".repeat(64),
    hits: [hit(1), { ...hit(2), kind: "agent-text" }],
    hasMore: false,
  });
  render(<SourceSearch space={space} query="rocket" visible epoch={0} />);
  await screen.findByRole("link", { name: "Rocket 2" });
  const items = screen.getAllByRole("listitem");
  expect(
    within(items[0]).queryByText("Agent-derived text — not an exact copy"),
  ).toBeNull();
  expect(
    within(items[1]).getByText("Agent-derived text — not an exact copy"),
  ).toBeVisible();
});
