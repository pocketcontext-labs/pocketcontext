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
import * as readerAPI from "./api";
import EvidenceBrowser, { sourcePassageHref } from "./EvidenceBrowser";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("reads a deep-linked source directly without fetching a sibling list", async () => {
  vi.spyOn(readerAPI.api, "sourceText").mockResolvedValue(
    "Synthetic original content",
  );
  const selected = { id: "source000000001", title: "Synthetic source" };
  vi.spyOn(readerAPI, "query")
    .mockResolvedValueOnce([selected])
    .mockResolvedValueOnce([
      {
        ...selected,
        original_name: "notes.txt",
        original: "notes.txt",
        media_type: "text/plain",
        source_date: "",
        sha256: "synthetic",
        text_renditions: 1,
      },
    ]);
  const onTitleChange = vi.fn();
  render(
    <EvidenceBrowser
      space="companyspace001"
      collection="sources"
      id={selected.id}
      term=""
      publication=""
      offset={20}
      navigation={null}
      onTitleChange={onTitleChange}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: selected.title }),
  ).toBeVisible();
  expect(
    screen.queryByRole("navigation", { name: "Evidence records" }),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "← All sources" })).toHaveAttribute(
    "href",
    "#/sources/?offset=20&order=newest",
  );
  expect(readerAPI.query).toHaveBeenCalledTimes(2);
  expect(readerAPI.query).not.toHaveBeenCalledWith(
    expect.stringContaining("LIMIT 21"),
  );
  expect(
    screen.getByRole("link", { name: "View source passages" }),
  ).toHaveAttribute("href", `#/passages/?q=${selected.id}`);
  expect(
    screen.getByRole("group", { name: "Record actions" }),
  ).toContainElement(screen.getByRole("button", { name: "Download original" }));
  expect(onTitleChange).toHaveBeenLastCalledWith(selected.title);
  expect(readerAPI.query).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining("WHERE s.space='companyspace001' AND"),
  );
  expect(readerAPI.query).toHaveBeenNthCalledWith(
    2,
    expect.stringContaining("WHERE space='companyspace001' AND"),
  );
});

const sourceFixture = (
  id: string,
  title: string,
  original_name = "note.md",
) => ({
  id,
  title,
  original_name,
  original: original_name,
  media_type: original_name.endsWith(".md") ? "text/markdown" : "text/plain",
  source_date: "2026-10-22",
  sha256: "a".repeat(64),
  text_renditions: 1,
});

it("provides a paginated source reading list in the main content even with separate sidebar navigation", async () => {
  const records = Array.from({ length: 21 }, (_, index) =>
    sourceFixture(
      `source${String(index).padStart(9, "0")}`,
      `Original ${index}`,
    ),
  );
  vi.spyOn(readerAPI, "query").mockResolvedValue(records);
  const preview = vi.spyOn(readerAPI.api, "sourceText");
  const sidebar = document.createElement("div");
  document.body.append(sidebar);
  try {
    render(
      <EvidenceBrowser
        space="companyspace001"
        collection="sources"
        id=""
        term=""
        publication="publication0001"
        offset={0}
        navigation={sidebar}
      />,
    );
    const list = await screen.findByRole("navigation", {
      name: "Sources in this space",
    });
    await waitFor(() =>
      expect(within(list).getAllByRole("link")).toHaveLength(20),
    );
    expect(
      within(list).getByRole("link", { name: /Original 0 / }),
    ).toHaveAttribute(
      "href",
      "#/sources/source000000000?publication=publication0001",
    );
    expect(screen.getByRole("link", { name: "Next sources" })).toHaveAttribute(
      "href",
      "#/sources/?offset=20&publication=publication0001",
    );
    expect(
      screen.getByText(/not limited to the historical publication/),
    ).toBeVisible();
    expect(preview).not.toHaveBeenCalled();
  } finally {
    sidebar.remove();
  }
});

it("renders original Markdown with page typography and keeps metadata tucked away", async () => {
  const source = sourceFixture("source000000001", "Original research");
  vi.spyOn(readerAPI, "query").mockResolvedValue([source]);
  vi.spyOn(readerAPI.api, "sourceText").mockResolvedValue(
    "## Original heading\n\n**Original words** and [[literal-link]].",
  );
  const { container } = render(
    <EvidenceBrowser
      space="companyspace001"
      collection="sources"
      id={source.id}
      term=""
      publication=""
      offset={0}
      navigation={null}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Original heading" }),
  ).toBeVisible();
  expect(
    container.querySelector(".source-content .markdown strong"),
  ).toHaveTextContent("Original words");
  expect(
    screen.getByRole("heading", { name: "Original research", level: 1 }),
  ).toBeVisible();
  expect(container.querySelector(".evidence-details")).not.toHaveAttribute(
    "open",
  );
  expect(container.querySelector(".source-content .citation")).toBeNull();
});

it("retains original download and passages when a preview is refused", async () => {
  const source = sourceFixture("source000000001", "Large original");
  vi.spyOn(readerAPI, "query").mockResolvedValue([source]);
  vi.spyOn(readerAPI.api, "sourceText").mockRejectedValue(
    new readerAPI.SourcePreviewLimitError(),
  );
  render(
    <EvidenceBrowser
      space="companyspace001"
      collection="sources"
      id={source.id}
      term=""
      publication=""
      offset={0}
      navigation={null}
    />,
  );
  expect(await screen.findByText(/2 MiB reading limit/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Download original" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "View source passages" }),
  ).toBeVisible();
});

it("aborts an old source preview and never displays its late content after navigation", async () => {
  const first = sourceFixture("source000000001", "First original");
  const second = sourceFixture(
    "source000000002",
    "Second original",
    "note.txt",
  );
  vi.spyOn(readerAPI, "query").mockImplementation(async (sql) =>
    sql.includes("LIMIT 21")
      ? [first, second]
      : [sql.includes(second.id) ? second : first],
  );
  let finish!: (value: string) => void;
  let oldSignal: AbortSignal | undefined;
  vi.spyOn(readerAPI.api, "sourceText").mockImplementation((source, signal) => {
    if (source.id === first.id) {
      oldSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return Promise.resolve("# Literal plain text");
  });
  const rendered = render(
    <EvidenceBrowser
      space="companyspace001"
      collection="sources"
      id={first.id}
      term=""
      publication=""
      offset={0}
      navigation={null}
    />,
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  rendered.rerender(
    <EvidenceBrowser
      space="companyspace001"
      collection="sources"
      id={second.id}
      term=""
      publication=""
      offset={0}
      navigation={null}
    />,
  );
  expect(oldSignal?.aborted).toBe(true);
  expect(await screen.findByText("# Literal plain text")).toHaveProperty(
    "tagName",
    "PRE",
  );
  await act(async () => finish("Stale original content"));
  expect(screen.queryByText("Stale original content")).toBeNull();
});

it("verifies a deep-linked passage from the selected source and space before highlighting", async () => {
  const source = sourceFixture("source000000001", "Cited original");
  const passage = {
    id: "passage00000001",
    ordinal: 1,
    locator: "document; line 3",
    body: "Repeated words",
  };
  const queries = vi
    .spyOn(readerAPI, "query")
    .mockImplementation(async (sql) =>
      sql.includes("p.ordinal") ? [passage] : [source],
    );
  vi.spyOn(readerAPI.api, "sourceText").mockResolvedValue(
    "Repeated words\nDifferent words\nRepeated words",
  );
  const { container } = render(
    <EvidenceBrowser
      space="companyspace001"
      collection="sources"
      id={source.id}
      term=""
      publication=""
      offset={0}
      navigation={null}
      passage={passage.id}
    />,
  );
  await waitFor(() =>
    expect(container.querySelector("mark")).toHaveTextContent("Repeated words"),
  );
  const query = queries.mock.calls.find(([sql]) =>
    sql.includes("p.ordinal"),
  )?.[0];
  expect(query).toContain("p.id='passage00000001'");
  expect(query).toContain("p.space='companyspace001'");
  expect(query).toContain("r.space='companyspace001'");
  expect(query).toContain("r.source='source000000001'");
  expect(readerAPI.api.sourceText).toHaveBeenCalledWith(
    expect.objectContaining({ id: source.id }),
    expect.any(AbortSignal),
  );
});

it("does not apply a stale cited passage after changing source or expose unavailable passage text", async () => {
  const first = sourceFixture("source000000001", "First");
  const second = sourceFixture("source000000002", "Second");
  let finish!: (rows: unknown[]) => void;
  const query = vi.spyOn(readerAPI, "query");
  query.mockImplementation(async (sql) => {
    if (sql.includes("p.ordinal")) {
      if (sql.includes(first.id))
        return new Promise((resolve) => {
          finish = resolve;
        });
      throw new Error("Forbidden");
    }
    return [sql.includes(second.id) ? second : first];
  });
  vi.spyOn(readerAPI.api, "sourceText").mockResolvedValue("Available original");
  const props = {
    space: "companyspace001",
    collection: "sources" as const,
    term: "",
    publication: "",
    offset: 0,
    navigation: null,
    passage: "passage00000001",
  };
  const { container, rerender } = render(
    <EvidenceBrowser {...props} id={first.id} />,
  );
  await screen.findByText("Available original");
  rerender(<EvidenceBrowser {...props} id={second.id} />);
  await screen.findByText("This passage is unavailable for this original.");
  await act(async () =>
    finish([
      {
        id: "passage00000001",
        ordinal: 1,
        locator: "document; line 1",
        body: "Private stale passage",
      },
    ]),
  );
  expect(container.querySelector("mark")).toBeNull();
  expect(screen.queryByText("Private stale passage")).toBeNull();
  expect(screen.getByText("Available original")).toBeVisible();
});

it("keeps passage identity, publication context and explicit space in source links", () => {
  const old = location.hash;
  location.hash = "#/sources?space=personalspace01";
  try {
    expect(
      sourcePassageHref(
        "source000000001",
        "passage00000001",
        "publication0001",
      ),
    ).toBe(
      "#/sources/source000000001?publication=publication0001&passage=passage00000001&space=personalspace01",
    );
  } finally {
    location.hash = old;
  }
});

const binaryFixture = () => ({
  ...sourceFixture("source000000009", "Scanned contract", "contract.pdf"),
  media_type: "application/pdf",
  text_renditions: 0,
});
const agentPassage = (n: number) => ({
  id: `passage${String(n).padStart(8, "0")}`,
  ordinal: n,
  locator: `# Contract; lines ${n}-${n}`,
  body: `Converted clause ${n}`,
});
const agentRendition = (id: string, version_label: string, tool: string) => ({
  id,
  version_label,
  created: "2026-10-29 10:00:00.000Z",
  notes: JSON.stringify({
    derived: true,
    passages: 21,
    tool,
    conversion: "Rendered pages to Markdown",
  }),
});
const binaryProps = {
  space: "companyspace001",
  collection: "sources" as const,
  id: "source000000009",
  term: "",
  publication: "",
  offset: 0,
  navigation: null,
};

it("shows a non-text original's facts and its labelled agent-derived passages without decoding it", async () => {
  const source = binaryFixture();
  const passages = Array.from({ length: 25 }, (_, n) => agentPassage(n + 1));
  const queries = vi
    .spyOn(readerAPI, "query")
    .mockImplementation(async (sql) => {
      if (sql.includes("FROM renditions WHERE"))
        return [
          agentRendition("rendition000002", "agent-2", "second reader"),
          agentRendition(
            "rendition000001",
            "agent-1",
            "claude-opus-5-5 read the PDF",
          ),
        ];
      if (sql.includes("FROM passages p")) {
        const [, limit, offset] = /LIMIT (\d+) OFFSET (\d+)/.exec(sql)!;
        return passages
          .slice(Number(offset), Number(offset) + Number(limit))
          .map((p) => ({
            ...p,
            body: `${p.body} ${sql.includes("rendition000001") ? "v1" : "v2"}`,
          }));
      }
      return [source];
    });
  const preview = vi.spyOn(readerAPI.api, "sourceText");
  vi.spyOn(readerAPI.api, "originalSize").mockResolvedValue(3 * 1024 * 1024);
  render(<EvidenceBrowser {...binaryProps} />);
  expect(await screen.findByText("3 MiB (3,145,728 bytes)")).toBeVisible();
  const facts = screen.getByRole("region", { name: "Original file" });
  expect(within(facts).getByText("application/pdf")).toBeVisible();
  expect(within(facts).getByText("contract.pdf")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Download original" }),
  ).toBeVisible();
  const derived = await screen.findByRole("region", {
    name: "Agent-derived passages",
  });
  expect(
    within(derived).getByText("Agent-derived text — not an exact copy"),
  ).toBeVisible();
  expect(
    await within(derived).findByText("Converted clause 1 v2"),
  ).toBeVisible();
  expect(within(derived).getByText("second reader")).toBeVisible();
  expect(within(derived).getAllByRole("listitem")).toHaveLength(20);
  expect(
    within(derived).getByRole("link", { name: "# Contract; lines 1-1" }),
  ).toHaveAttribute("href", "#/passages/passage00000001");
  fireEvent.click(screen.getByRole("button", { name: "Load more passages" }));
  await waitFor(() =>
    expect(within(derived).getAllByRole("listitem")).toHaveLength(25),
  );
  expect(
    screen.queryByRole("button", { name: "Load more passages" }),
  ).toBeNull();
  const version = within(derived).getByRole("combobox", {
    name: "Extracted text version",
  });
  fireEvent.change(version, { target: { value: "rendition000001" } });
  expect(
    await within(derived).findByText("Converted clause 1 v1"),
  ).toBeVisible();
  expect(
    within(derived).getByText("claude-opus-5-5 read the PDF"),
  ).toBeVisible();
  expect(preview).not.toHaveBeenCalled();
  expect(document.querySelector(".source-content, mark")).toBeNull();
  const sql = queries.mock.calls.map(([value]) => value);
  expect(sql.find((value) => value.includes("FROM sources WHERE"))).toContain(
    "r.kind='text') AS text_renditions",
  );
  for (const value of sql.filter((item) => item.includes("FROM passages p")))
    expect(value).toContain(
      "p.space='companyspace001' AND r.space='companyspace001' AND r.source='source000000009' AND r.kind='agent-text'",
    );
});

it("marks a non-text original without any rendition as needing extraction", async () => {
  const source = binaryFixture();
  vi.spyOn(readerAPI, "query").mockImplementation(async (sql) =>
    sql.includes("FROM renditions WHERE") ? [] : [source],
  );
  vi.spyOn(readerAPI.api, "sourceText");
  vi.spyOn(readerAPI.api, "originalSize").mockResolvedValue(null);
  render(<EvidenceBrowser {...binaryProps} />);
  expect(
    await screen.findByText(
      /No text has been extracted from this original yet/,
    ),
  ).toBeVisible();
  expect(screen.getByText("Needs extraction")).toBeVisible();
  expect(await screen.findByText("Unknown")).toBeVisible();
  expect(readerAPI.api.sourceText).not.toHaveBeenCalled();
});

it("shows a cited agent-text passage labelled and unhighlighted on its non-text source", async () => {
  const source = binaryFixture();
  const cited = { ...agentPassage(3), kind: "agent-text" };
  vi.spyOn(readerAPI, "query").mockImplementation(async (sql) => {
    if (sql.includes("FROM renditions WHERE"))
      return [agentRendition("rendition000001", "agent-1", "reader")];
    if (sql.includes("p.id='passage00000003'")) return [cited];
    if (sql.includes("FROM passages p"))
      return [agentPassage(1), agentPassage(2), agentPassage(3)];
    return [source];
  });
  vi.spyOn(readerAPI.api, "originalSize").mockResolvedValue(10);
  const { container } = render(
    <EvidenceBrowser {...binaryProps} passage={cited.id} />,
  );
  const box = await screen.findByRole("region", { name: "Cited passage" });
  expect(
    within(box).getByText("Agent-derived text — not an exact copy"),
  ).toBeVisible();
  expect(within(box).getByText("Converted clause 3")).toBeVisible();
  await waitFor(() =>
    expect(
      container.querySelector(".agent-text-list li.cited"),
    ).toHaveTextContent("Converted clause 3"),
  );
  expect(container.querySelector("mark")).toBeNull();
});

it("labels an agent-text passage record and keeps the needs-extraction filter on return", async () => {
  vi.spyOn(readerAPI, "query").mockImplementation(async (sql) =>
    sql.includes("FROM sources WHERE")
      ? [binaryFixture()]
      : [
          {
            id: "passage00000001",
            title: "Scanned contract",
            locator: "# Contract; lines 1-1",
            body: "Converted clause 1",
            kind: "agent-text",
            source_id: "source000000009",
          },
        ],
  );
  render(
    <EvidenceBrowser
      {...binaryProps}
      collection="passages"
      id="passage00000001"
    />,
  );
  expect(
    await screen.findByText("Agent-derived text — not an exact copy"),
  ).toBeVisible();
  cleanup();
  vi.spyOn(readerAPI.api, "originalSize").mockResolvedValue(10);
  render(<EvidenceBrowser {...binaryProps} sourceFilter="pending" />);
  expect(
    await screen.findByRole("link", { name: "← All sources" }),
  ).toHaveAttribute("href", "#/sources/?order=newest&filter=pending");
});
