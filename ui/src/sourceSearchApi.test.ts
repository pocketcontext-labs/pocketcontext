import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pb, SearchChangedError } from "./api";
import {
  searchSources,
  sourceSearchHref,
  SourceSearchUnavailableError,
} from "./sourceSearchApi";
const space = "space0000000001",
  source = "source000000001",
  passage = "passage00000001",
  generation = "a".repeat(64);
const response = () => ({
  index: "sources",
  scope: space,
  generation,
  hasMore: false,
  truncated: false,
  hits: [{ id: source, score: -2, excerpt: "café rocket", passage }],
});
const metadata = () => ({
  columns: ["id", "title", "original_name", "source_date"],
  rows: [[source, "Note", "note.md", ""]],
  truncated: false,
});
const relationship = (kind = "text") => ({
  columns: ["id", "source", "locator", "kind"],
  rows: [[passage, source, "lines 1-3", kind]],
  truncated: false,
});
beforeEach(() =>
  pb.authStore.save(
    `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.x`,
    {
      id: "user00000000001",
      collectionId: "_pb_users_auth_",
      collectionName: "users",
    },
  ),
);
afterEach(() => {
  vi.restoreAllMocks();
  pb.authStore.clear();
});
it("scopes metadata/body search to space and hydrates independently authorized passage relations", async () => {
  const send = vi
    .spyOn(pb, "send")
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(metadata())
    .mockResolvedValueOnce(relationship());
  const found = await searchSources(space, "café rocket");
  expect(found.hits[0]).toMatchObject({
    id: source,
    passage,
    locator: "lines 1-3",
    title: "Note",
  });
  expect(send.mock.calls[0]).toEqual([
    "/api/context/search",
    {
      method: "POST",
      body: {
        index: "sources",
        query: "café rocket",
        scope: space,
        offset: 0,
        limit: 20,
      },
    },
  ]);
  for (const [, options] of send.mock.calls.slice(1))
    expect((options?.body as { sql: string }).sql).toContain(
      `space='${space}'`,
    );
  expect(sourceSearchHref(space, "a&b")).toBe(
    "#/sources/?space=space0000000001&q=a%26b",
  );
});
it("refuses pagination without generation and inconsistent server generations", async () => {
  const send = vi.spyOn(pb, "send");
  await expect(searchSources(space, "rocket", 20)).rejects.toThrow(
    "Invalid source search page",
  );
  expect(send).not.toHaveBeenCalled();
  send.mockResolvedValue(response());
  await expect(
    searchSources(space, "rocket", 20, 20, "b".repeat(64)),
  ).rejects.toBeInstanceOf(SearchChangedError);
});
it("rejects duplicates and forged passage relationships", async () => {
  const value = response();
  value.hits.push({ ...value.hits[0] });
  const send = vi.spyOn(pb, "send").mockResolvedValueOnce(value);
  await expect(searchSources(space, "rocket")).rejects.toThrow(
    "Invalid source search hit",
  );
  const relation = relationship();
  relation.rows[0][1] = "source000000002";
  send
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(metadata())
    .mockResolvedValueOnce(relation);
  await expect(searchSources(space, "rocket")).rejects.toBeInstanceOf(
    SourceSearchUnavailableError,
  );
});
it("rejects disappeared metadata after authorization changes and fences late identity responses", async () => {
  const send = vi
    .spyOn(pb, "send")
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce({ ...metadata(), rows: [] });
  await expect(searchSources(space, "rocket")).rejects.toBeInstanceOf(
    SourceSearchUnavailableError,
  );
  let finish!: (value: unknown) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = searchSources(space, "rocket");
  pb.authStore.clear();
  finish(response());
  await expect(pending).rejects.toThrow("Session changed");
});
it("maps bounded-index failures and does not place query content into hydration SQL", async () => {
  const send = vi.spyOn(pb, "send").mockRejectedValueOnce({ status: 413 });
  await expect(searchSources(space, "rocket")).rejects.toThrow("too large");
  send
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(metadata())
    .mockResolvedValueOnce(relationship());
  await searchSources(space, "' OR 1=1");
  expect((send.mock.calls[2][1]?.body as { sql: string }).sql).not.toContain(
    "OR 1=1",
  );
});

it("hydrates the rendition kind of a matching passage", async () => {
  const send = vi
    .spyOn(pb, "send")
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(metadata())
    .mockResolvedValueOnce(relationship("agent-text"));
  const found = await searchSources(space, "rocket");
  expect(found.hits[0]).toMatchObject({ passage, kind: "agent-text" });
  expect((send.mock.calls[2][1]?.body as { sql: string }).sql).toContain(
    "r.kind",
  );
});
