import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Space } from "./api";
import SpaceManager from "./SpaceManager";
const owned: Space = {
  id: "ownedspace00001",
  name: "Research",
  revision: 3,
  settings_revision: 2,
};
const main: Space = {
  id: "defaultspace001",
  name: "Notes",
  revision: 1,
  is_default: true,
  settings_revision: 2,
};
const row = (name: string) => screen.getByText(name).closest("li")!;
let rows: Space[];
beforeEach(() => {
  rows = [main, owned];
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  vi.spyOn(api, "listSpaces").mockImplementation(async () => rows);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function open() {
  const changed = vi.fn().mockResolvedValue(undefined);
  render(<SpaceManager selected={owned.id} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage spaces" }));
  await screen.findByText("Research");
  return changed;
}
it("creates a named space and selects it", async () => {
  const create = vi
    .spyOn(api, "createSpace")
    .mockResolvedValue({ id: "newspace0000001" });
  const changed = await open();
  fireEvent.change(screen.getByLabelText("New space name"), {
    target: { value: "  Work notes  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create space" }));
  await screen.findByText("Space created.");
  expect(create).toHaveBeenCalledWith("Work notes");
  expect(changed).toHaveBeenCalledWith("newspace0000001");
});
it("shows the default and current space and guards archiving the default", async () => {
  await open();
  const defaultRow = row("Notes");
  expect(within(defaultRow).getByText("Default")).toBeTruthy();
  expect(
    within(defaultRow).queryByRole("button", { name: "Make default" }),
  ).toBeNull();
  const archive = within(defaultRow).getByRole("button", { name: "Archive" });
  expect(archive).toBeDisabled();
  expect(archive).toHaveAccessibleDescription(
    /default space cannot be archived/,
  );
  expect(
    within(defaultRow).getByRole("button", { name: "Rename" }),
  ).toBeEnabled();
  const currentRow = row("Research");
  expect(within(currentRow).getByText("Open now")).toBeTruthy();
  expect(within(currentRow).queryByRole("button", { name: "Open" })).toBeNull();
  expect(
    within(currentRow).getByRole("button", { name: "Archive" }),
  ).toBeEnabled();
  expect(screen.queryByText(/member|role|personal|company/i)).toBeNull();
});
it("makes another space the default and refreshes the list", async () => {
  const setDefault = vi
    .spyOn(api, "setDefaultSpace")
    .mockImplementation(async (space) => {
      rows = rows.map((item) => ({
        ...item,
        is_default: item.id === space.id,
        settings_revision: 3,
      }));
      return { id: space.id };
    });
  const changed = await open();
  fireEvent.click(
    within(row("Research")).getByRole("button", { name: "Make default" }),
  );
  await screen.findByText("“Research” is now the default space.");
  expect(setDefault).toHaveBeenCalledExactlyOnceWith(owned);
  expect(changed).toHaveBeenCalledWith(undefined);
  expect(within(row("Research")).getByText("Default")).toBeTruthy();
  expect(
    within(row("Research")).getByRole("button", { name: "Archive" }),
  ).toBeDisabled();
  expect(
    within(row("Notes")).getByRole("button", { name: "Archive" }),
  ).toBeEnabled();
  expect(
    within(row("Notes")).getByRole("button", { name: "Make default" }),
  ).toBeTruthy();
});
it("reloads after a default changed elsewhere without retrying", async () => {
  const setDefault = vi
    .spyOn(api, "setDefaultSpace")
    .mockRejectedValue({ status: 409 });
  await open();
  fireEvent.click(
    within(row("Research")).getByRole("button", { name: "Make default" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "changed elsewhere",
  );
  expect(setDefault).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.listSpaces).toHaveBeenCalledTimes(2));
});
it("shows the server's reason when it refuses a change", async () => {
  vi.spyOn(api, "updateSpace").mockRejectedValue({
    status: 400,
    response: {
      message:
        "The default space cannot be archived; make another space the default first.",
    },
  });
  await open();
  fireEvent.click(
    within(row("Research")).getByRole("button", { name: "Archive" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "make another space the default first",
  );
});
it("never offers to make an archived space the default", async () => {
  rows = [main, { ...owned, archived: true }];
  const changed = vi.fn().mockResolvedValue(undefined);
  render(<SpaceManager selected={main.id} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage spaces" }));
  await screen.findByText("Notes");
  expect(screen.queryByText("Research")).toBeNull();
  fireEvent.click(screen.getByLabelText("Show archived spaces"));
  const archived = row("Research");
  expect(within(archived).getByText("Archived")).toBeTruthy();
  expect(
    within(archived).queryByRole("button", { name: "Make default" }),
  ).toBeNull();
  expect(
    within(archived).getByRole("button", { name: "Restore" }),
  ).toBeEnabled();
});
it("confirms archival, retains history, and supports restore", async () => {
  const update = vi
    .spyOn(api, "updateSpace")
    .mockImplementation(async (_space, changes) => {
      rows = rows.map((row) =>
        row.id === owned.id ? { ...row, ...changes, revision: 4 } : row,
      );
      return { id: owned.id };
    });
  await open();
  fireEvent.click(
    within(row("Research")).getByRole("button", { name: "Archive" }),
  );
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
  await screen.findByText(/Space archived. You can restore/);
  expect(screen.queryByText("Research")).toBeNull();
  fireEvent.click(screen.getByLabelText("Show archived spaces"));
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByText("Space restored.");
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ revision: 4 }),
    { archived: false },
  );
});
it("handles a stale rename by reloading without retrying the write", async () => {
  const update = vi
    .spyOn(api, "updateSpace")
    .mockRejectedValue({ status: 409 });
  await open();
  fireEvent.click(
    within(screen.getByText("Research").closest("li")!).getByRole("button", {
      name: "Rename",
    }),
  );
  fireEvent.change(screen.getByLabelText("Space name"), {
    target: { value: "New label" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "changed elsewhere",
  );
  expect(update).toHaveBeenCalledExactlyOnceWith(owned, { name: "New label" });
  await waitFor(() => expect(api.listSpaces).toHaveBeenCalledTimes(2));
});
