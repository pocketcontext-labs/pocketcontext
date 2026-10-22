import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageActions } from "./readerControls";
import type { Publication } from "./types";

const publication: Publication = {
  id: "publication0001",
  space: "personalspace01",
  sequence: 12,
  run: "ingestionrun001",
  home: "",
  created: "2026-10-22T10:00:00Z",
};

const writeText = vi.fn<(value: string) => Promise<void>>();
beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    "/#/page/example?publication=olderpublication&space=personalspace01&heading=section",
  );
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function openCopyMenu() {
  const summary = screen.getByText("Copy link").closest("summary")!;
  fireEvent.click(summary);
  expect(summary.parentElement).toHaveAttribute("open");
  return summary;
}

it("copies a current page URL that preserves space and drops historical publication and heading", async () => {
  render(<PageActions slug="example" publication={publication} />);
  const summary = openCopyMenu();
  fireEvent.click(screen.getByRole("button", { name: /Current page/ }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Copied"),
  );
  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    `${location.origin}/#/page/example?space=personalspace01`,
  );
  expect(summary.parentElement).not.toHaveAttribute("open");
  expect(summary).toHaveFocus();
});

it("copies a version URL pinned to the displayed publication and selected space", async () => {
  render(<PageActions slug="example" publication={publication} />);
  openCopyMenu();
  fireEvent.click(screen.getByRole("button", { name: /This version/ }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Copied"),
  );
  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    `${location.origin}/#/page/example?publication=publication0001&space=personalspace01`,
  );
});

it("reports clipboard rejection without claiming success and returns focus to the menu", async () => {
  writeText.mockRejectedValue(new Error("Permission denied"));
  render(<PageActions slug="example" publication={publication} />);
  const summary = openCopyMenu();
  fireEvent.click(screen.getByRole("button", { name: /Current page/ }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Unable to copy link. Copy the address from your browser.",
    ),
  );
  expect(screen.getByRole("status")).not.toHaveTextContent("Copied");
  expect(summary.parentElement).not.toHaveAttribute("open");
  expect(summary).toHaveFocus();
});

it("Escape closes the copy disclosure and restores focus without copying", () => {
  render(<PageActions slug="example" publication={publication} />);
  const summary = openCopyMenu();
  const option = screen.getByRole("button", { name: /This version/ });
  option.focus();
  fireEvent.keyDown(option, { key: "Escape" });
  expect(summary.parentElement).not.toHaveAttribute("open");
  expect(summary).toHaveFocus();
  expect(writeText).not.toHaveBeenCalled();
});

it.each(["resolve", "reject"] as const)(
  "ignores a stale clipboard %s after unmount without closing or focusing the new page menu",
  async (outcome) => {
    let finish!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          finish =
            outcome === "resolve"
              ? resolve
              : () => reject(new Error("Permission denied"));
        }),
    );
    const oldPage = render(
      <PageActions slug="old-page" publication={publication} />,
    );
    openCopyMenu();
    fireEvent.click(screen.getByRole("button", { name: /Current page/ }));
    oldPage.unmount();

    render(
      <PageActions
        slug="new-page"
        publication={{ ...publication, id: "publication0002" }}
      />,
    );
    const newSummary = openCopyMenu();
    const newOption = screen.getByRole("button", { name: /This version/ });
    newOption.focus();
    await act(async () => {
      finish();
    });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(newSummary.parentElement).toHaveAttribute("open");
    expect(newOption).toHaveFocus();
    expect(writeText).toHaveBeenCalledTimes(1);
  },
);
