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
  kind: "group",
  role: "owner",
  revision: 3,
};
const company: Space = {
  id: "companyspace001",
  name: "Company",
  kind: "group",
  role: "editor",
  revision: 1,
};
const personal: Space = {
  id: "personalspace01",
  name: "Personal",
  kind: "personal",
  role: "owner",
  revision: 1,
};
let rows: Space[];
beforeEach(() => {
  rows = [company, personal, owned];
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
it("creates a named private space and selects it", async () => {
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
it("limits controls to owners and protects Personal and Company archival", async () => {
  await open();
  const companyRow = screen.getByText("Company").closest("li")!;
  expect(
    within(companyRow).queryByRole("button", { name: "Rename" }),
  ).toBeNull();
  const personalRow = screen.getByText("Personal").closest("li")!;
  expect(
    within(personalRow).queryByRole("button", { name: "Archive" }),
  ).toBeNull();
  expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1);
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
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
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
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("changed elsewhere");
  expect(update).toHaveBeenCalledExactlyOnceWith(owned, { name: "New label" });
  await waitFor(() => expect(api.listSpaces).toHaveBeenCalledTimes(2));
});
