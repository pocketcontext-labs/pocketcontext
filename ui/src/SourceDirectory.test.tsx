import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "./api";
import SourceDirectory, {
  sourceDirectoryHref,
  sourceFilter,
  sourceOrder,
} from "./SourceDirectory";
const props = {
  space: "defaultspace001",
  count: 5000,
  offset: 0,
  order: "newest" as const,
};
const rows = (start: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `source${String(start + i).padStart(9, "0")}`,
    title: `Original ${start + i}`,
    original_name: `note-${start + i}.md`,
    source_date: "2026-10-01",
    created: "2026-10-22 12:00:00.000Z",
    renditions: 1,
  }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  location.hash = "";
});
it("browses 5,000 sources with one metadata page, a stable sort and no original downloads", async () => {
  const request = vi.spyOn(api, "query").mockResolvedValue(rows(0, 51));
  const preview = vi.spyOn(api.api, "sourceText");
  render(<SourceDirectory {...props} />);
  await screen.findByText("1–50 of 5,000 sources");
  const table = screen.getByRole("table", { name: "Sources in this space" });
  expect(within(table).getAllByRole("row")).toHaveLength(51);
  expect(screen.queryByText("Original 50")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "SELECT s.id,s.title,s.original_name,s.source_date,s.created,(SELECT count(*) FROM renditions r WHERE r.source=s.id) AS renditions FROM sources s WHERE s.space='defaultspace001' ORDER BY created DESC, id DESC LIMIT 51 OFFSET 0",
  );
  expect(preview).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Next →" })).toHaveAttribute(
    "href",
    "#/sources/?offset=50&order=newest",
  );
  fireEvent.change(screen.getByRole("spinbutton"), {
    target: { value: "100" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(location.hash).toContain("offset=4950");
});
it("keeps range, detail and return context on the last page and resets paging when sorting", async () => {
  location.hash = "#/sources/?space=defaultspace001";
  vi.spyOn(api, "query").mockResolvedValue(rows(4950, 50));
  render(
    <SourceDirectory
      {...props}
      offset={4950}
      order="title"
      publication="publication0001"
    />,
  );
  await screen.findByText("4,951–5,000 of 5,000 sources");
  expect(screen.queryByRole("link", { name: "Next →" })).toBeNull();
  expect(screen.getByRole("link", { name: "Original 4950" })).toHaveAttribute(
    "href",
    "#/sources/source000004950?offset=4950&publication=publication0001&space=defaultspace001&order=title",
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Sort sources" }), {
    target: { value: "oldest" },
  });
  expect(location.hash).not.toContain("offset=");
  expect(location.hash).toContain("order=oldest");
  expect(sourceOrder("title; DROP TABLE sources")).toBe("newest");
});
it("searches metadata and text from the main view without paging into the search results", () => {
  vi.spyOn(api, "query").mockResolvedValue([]);
  render(<SourceDirectory {...props} offset={100} />);
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search all sources" }),
    { target: { value: "starlight" } },
  );
  fireEvent.submit(screen.getByRole("search"));
  expect(location.hash).toBe("#/sources/?q=starlight");
});
it("clears old rows on space changes and ignores late responses", async () => {
  let finish!: (rows: unknown[]) => void;
  vi.spyOn(api, "query")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(rows(100, 1));
  const { rerender } = render(<SourceDirectory {...props} />);
  rerender(<SourceDirectory {...props} space="personalspace01" count={1} />);
  await screen.findByText("Original 100");
  await act(async () => finish(rows(0, 50)));
  expect(screen.queryByText("Original 0")).toBeNull();
});
it("handles empty pages and denied reads without displaying a stale table", async () => {
  const request = vi.spyOn(api, "query").mockResolvedValue([]);
  const { rerender } = render(<SourceDirectory {...props} offset={5000} />);
  await screen.findByRole("link", { name: "Return to the first page" });
  request.mockRejectedValue(new Error("This space is unavailable"));
  rerender(<SourceDirectory {...props} offset={100} />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
});

it.each([
  undefined,
  null,
  "",
  "invalid",
  "constructor",
  "title; DROP TABLE sources",
])(
  "defaults an absent or invalid runtime sort (%s) before constructing SQL",
  async (order) => {
    const request = vi.spyOn(api, "query").mockResolvedValue([]);
    render(
      <SourceDirectory
        {...props}
        space="personalspace01"
        count={0}
        order={order as typeof props.order}
      />,
    );
    await screen.findByText(
      "No sources yet. Ingest an original to add evidence to this space.",
    );
    expect(request).toHaveBeenCalledWith(
      "SELECT s.id,s.title,s.original_name,s.source_date,s.created,(SELECT count(*) FROM renditions r WHERE r.source=s.id) AS renditions FROM sources s WHERE s.space='personalspace01' ORDER BY created DESC, id DESC LIMIT 51 OFFSET 0",
    );
    expect(screen.getByRole("combobox", { name: "Sort sources" })).toHaveValue(
      "newest",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it("badges sources without any rendition and filters to those needing extraction", async () => {
  location.hash = "#/sources/?space=defaultspace001";
  const request = vi
    .spyOn(api, "query")
    .mockImplementation(async (sql) =>
      sql.startsWith("SELECT count(*)")
        ? [{ count: 120 }]
        : [
            { ...rows(0, 1)[0], original_name: "scan.pdf", renditions: 0 },
            ...rows(1, 50),
          ],
    );
  const { rerender } = render(<SourceDirectory {...props} />);
  await screen.findByText("1–50 of 5,000 sources");
  const table = screen.getByRole("table", { name: "Sources in this space" });
  expect(within(table).getAllByText("Needs extraction")).toHaveLength(1);
  expect(
    within(within(table).getAllByRole("row")[1]).getByText("Needs extraction"),
  ).toBeVisible();
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("combobox", { name: "Filter sources" }), {
    target: { value: "pending" },
  });
  expect(location.hash).toContain("filter=pending");
  expect(location.hash).not.toContain("offset=");
  request.mockClear();
  rerender(<SourceDirectory {...props} filter="pending" offset={50} />);
  await screen.findByText("51–100 of 120 sources needing extraction");
  const pending =
    "s.space='defaultspace001' AND NOT EXISTS (SELECT 1 FROM renditions r WHERE r.source=s.id)";
  expect(request).toHaveBeenCalledWith(
    `SELECT s.id,s.title,s.original_name,s.source_date,s.created,(SELECT count(*) FROM renditions r WHERE r.source=s.id) AS renditions FROM sources s WHERE ${pending} ORDER BY created DESC, id DESC LIMIT 51 OFFSET 50`,
  );
  expect(request).toHaveBeenCalledWith(
    `SELECT count(*) AS count FROM sources s WHERE ${pending}`,
  );
  expect(screen.getByRole("combobox", { name: "Filter sources" })).toHaveValue(
    "pending",
  );
  expect(screen.getByRole("link", { name: "Next →" })).toHaveAttribute(
    "href",
    "#/sources/?offset=100&space=defaultspace001&order=newest&filter=pending",
  );
  expect(screen.getByRole("link", { name: "Original 1" })).toHaveAttribute(
    "href",
    "#/sources/source000000001?offset=50&space=defaultspace001&order=newest&filter=pending",
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Sort sources" }), {
    target: { value: "title" },
  });
  expect(location.hash).toContain("filter=pending");
  expect(sourceFilter("pending' OR 1=1")).toBe("");
  expect(sourceDirectoryHref(0, "newest", "", "", "")).toBe(
    "#/sources/?space=defaultspace001&order=newest",
  );
});
it("says when every source has extracted text", async () => {
  vi.spyOn(api, "query").mockImplementation(async (sql) =>
    sql.startsWith("SELECT count(*)") ? [{ count: 0 }] : [],
  );
  render(<SourceDirectory {...props} filter="pending" />);
  await screen.findByText("Every source in this space has extracted text.");
  expect(screen.getByRole("status")).toHaveTextContent(
    "0 sources needing extraction",
  );
});
