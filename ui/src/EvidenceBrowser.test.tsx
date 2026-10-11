import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as readerAPI from "./api";
import EvidenceBrowser from "./EvidenceBrowser";

vi.mock("./ImagePreview", () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps a deep-linked source visible when it is outside the result page, without listing raw IDs", async () => {
  const selected = { id: "source000000001", title: "Synthetic source" };
  vi.spyOn(readerAPI, "query")
    .mockResolvedValueOnce([{ id: "source000000002", title: "Other source" }])
    .mockResolvedValueOnce([selected])
    .mockResolvedValueOnce([{ ...selected, original_name: "slide.png", original: "slide.png", media_type: "image/png", source_date: "", sha256: "synthetic" }]);
  const onTitleChange = vi.fn();
  render(<EvidenceBrowser space="companyspace001" collection="sources" id={selected.id} term="" publication="" offset={20} navigation={null} onTitleChange={onTitleChange} />);
  const current = await screen.findByRole("navigation", { name: "Current evidence record" });
  expect(within(current).getByRole("link", { name: selected.title })).toHaveAttribute("aria-current", "page");
  expect(current).not.toHaveTextContent(selected.id);
  expect(screen.getByRole("link", { name: "View source passages" })).toHaveAttribute("href", `#/passages/?q=${selected.id}`);
  expect(screen.getByRole("group", { name: "Record actions" })).toContainElement(screen.getByRole("button", { name: "Download original" }));
  expect(onTitleChange).toHaveBeenLastCalledWith(selected.title);
  expect(readerAPI.query).toHaveBeenNthCalledWith(1, expect.stringContaining("WHERE s.space='companyspace001' AND"));
  expect(readerAPI.query).toHaveBeenNthCalledWith(2, expect.stringContaining("WHERE s.space='companyspace001' AND"));
});
