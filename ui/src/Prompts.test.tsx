import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, pb } from "./api";
import Catalog, { type CatalogState } from "./Catalog";
import {
  decodePrompt,
  loadPrompt,
  filterPrompts,
  portableMarkdown,
  readPromptBytes,
} from "./Prompts";
import type { PageDetail, PageSummary } from "./types";
const prompt: PageSummary = {
  id: "revision1",
  page: "page1",
  slug: "setup",
  kind: "entity",
  title: "Setup",
  summary: "",
  properties: {
    catalog_type: "repository_document",
    document_type: "prompt",
    output_mode: "markdown",
    purpose: "Install tools",
    target_agents: ["codex"],
    required_skills: ["pocketcontext"],
  },
};
const state: CatalogState = {
  type: "prompt",
  query: "",
  provider: "",
  deployment: "",
  lifecycle: "",
  missingOwner: false,
  sort: "title",
  offset: 0,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("filters prompt subtype and searches metadata without treating other repository documents as prompts", () => {
  const other = {
    ...prompt,
    id: "other",
    properties: { ...prompt.properties, document_type: "readme" },
  };
  expect(
    filterPrompts([prompt, other], {
      ...state,
      query: "install pocketcontext",
      targetAgent: "codex",
    }),
  ).toEqual([prompt]);
  expect(
    filterPrompts([prompt], { ...state, requiredSkill: "vaultcontext" }),
  ).toEqual([]);
});
it("preserves publication and filter state and clears stale previews on revision changes", async () => {
  let resolve!: (value: PageDetail) => void;
  vi.spyOn(api, "getPage").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const navigate = vi.fn();
  const view = render(
    <Catalog
      pages={[prompt]}
      state={state}
      publication="historic"
      snapshotId="historic"
      space="defaultspace001"
      onNavigate={navigate}
    />,
  );
  fireEvent.change(screen.getByLabelText("Target agent", {exact: true}), {
    target: { value: "codex" },
  });
  expect(navigate).toHaveBeenCalledWith(
    "#/catalog/prompt?publication=historic&targetAgent=codex",
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
  view.rerender(
    <Catalog
      pages={[{ ...prompt, id: "revision2" }]}
      state={state}
      publication="new"
      snapshotId="new"
      space="defaultspace001"
    />,
  );
  await act(async () => {
    resolve({
      ...prompt,
      body: "OLD PRIVATE TEXT",
      citations: [],
      backlinks: [],
      links: [],
    } as PageDetail);
  });
  await waitFor(() =>
    expect(screen.queryByText("OLD PRIVATE TEXT")).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("button", { name: "Copy prompt" }),
  ).not.toBeInTheDocument();
});
it("previews literal markdown and copies exactly without rendering instructions", async () => {
  const text = "<script>doNothing()</script>\n## Task\r\n";
  vi.spyOn(api, "getPage").mockResolvedValue({
    ...prompt,
    body: text,
    citations: [],
    backlinks: [],
    links: [],
  } as PageDetail);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <Catalog
      pages={[prompt]}
      state={state}
      snapshotId="pub"
      space="defaultspace001"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
  await screen.findByRole("button", { name: "Copy prompt" });
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
});
it("checks SHA-256, rejects invalid UTF-8 and preserves BOM and CRLF", async () => {
  const bytes = new TextEncoder().encode("\ufeffPrompt\r\n");
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  expect(await decodePrompt(bytes.buffer, hash)).toBe("\ufeffPrompt\r\n");
  await expect(decodePrompt(bytes.buffer, "0".repeat(64))).rejects.toThrow(
    "checksum",
  );
  const invalid = new Uint8Array([255]);
  const badHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", invalid)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await expect(decodePrompt(invalid.buffer, badHash)).rejects.toThrow();
});

it("refuses page-link markup and oversized markdown or streaming originals", async () => {
  for (const text of [
    "[[internal]]",
    "citation[^1]",
    "[needs verification]",
    "> [!note] private",
  ])
    expect(() => portableMarkdown(text)).toThrow("page-link markup");
  expect(() => portableMarkdown("a".repeat(8 * 1024 * 1024 + 1))).toThrow(
    "8 MiB",
  );
  const cancel = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
    },
    cancel,
  });
  await expect(readPromptBytes({ body: stream } as Response)).rejects.toThrow(
    "8 MiB",
  );
  expect(cancel).toHaveBeenCalled();
});

it("refuses changed revisions or a non-prompt subtype before loading originals", async () => {
  const getPage = vi.spyOn(api, "getPage");
  const original = vi.spyOn(api, "originalURL");
  for (const detail of [
    { ...prompt, id: "different" },
    {
      ...prompt,
      properties: { ...prompt.properties, document_type: "readme" },
    },
    {
      ...prompt,
      properties: { ...prompt.properties, catalog_type: "resource" },
    },
  ]) {
    getPage.mockResolvedValue({
      ...detail,
      body: "Private",
      citations: [],
      backlinks: [],
      links: [],
    } as PageDetail);
    await expect(
      loadPrompt(prompt, "publication0001", "defaultspace001"),
    ).rejects.toThrow("no longer available");
  }
  expect(original).not.toHaveBeenCalled();
});
it("uses same-space SQL and refuses a denied protected original download", async () => {
  const exact = {
    ...prompt,
    properties: {
      ...prompt.properties,
      output_mode: "exact_copy",
      source_id: "source000000001",
    },
  };
  vi.spyOn(api, "getPage").mockResolvedValue({
    ...exact,
    body: "Description",
    citations: [],
    backlinks: [],
    links: [],
  } as PageDetail);
  const send = vi
    .spyOn(pb, "send")
    .mockResolvedValue({
      columns: ["id", "original", "sha256"],
      rows: [["source000000001", "prompt.md", "0".repeat(64)]],
      truncated: false,
    });
  vi.spyOn(api, "originalURL").mockResolvedValue(
    "https://example.invalid/protected",
  );
  const fetchOriginal = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue({ ok: false, status: 403 } as Response);
  await expect(
    loadPrompt(exact, "publication0001", "defaultspace001"),
  ).rejects.toThrow("Unable to download");
  expect(send).toHaveBeenCalledWith(
    "/api/context/query",
    expect.objectContaining({
      body: { sql: expect.stringContaining("AND space='defaultspace001'") },
    }),
  );
  expect(fetchOriginal).toHaveBeenCalledWith(
    "https://example.invalid/protected",
    { cache: "no-store" },
  );
});
