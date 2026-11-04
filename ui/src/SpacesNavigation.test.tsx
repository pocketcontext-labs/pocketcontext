import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SpacesNavigation from "./SpacesNavigation";

afterEach(cleanup);

const spaces = [
  { id: "default", name: "Default" },
  { id: "research", name: "Research" },
  { id: "old", name: "Archived", archived: true },
];
function setup(onCreateSpace = vi.fn().mockResolvedValue("created")) {
  const onSpaceChange = vi.fn();
  const setSpaceList = vi.fn();
  render(
    <SpacesNavigation
      space="default"
      spaces={spaces}
      onSpaceChange={onSpaceChange}
      onCreateSpace={onCreateSpace}
      spaceManagement={<button>Manage spaces</button>}
      spaceList={true}
      setSpaceList={setSpaceList}
    />,
  );
  return { onSpaceChange, onCreateSpace, setSpaceList };
}
describe("Spaces navigation", () => {
  it("selects active spaces and retains access to space management", () => {
    const { onSpaceChange, setSpaceList } = setup();
    expect(screen.getByRole("button", { name: "Manage spaces" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archived" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    expect(onSpaceChange).toHaveBeenCalledWith("research");
    expect(setSpaceList).toHaveBeenCalledWith(false);
  });
  it("creates a space and opens it", async () => {
    const { onCreateSpace, onSpaceChange, setSpaceList } = setup();
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    fireEvent.change(screen.getByLabelText("Space name"), {
      target: { value: "  New notes  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() => expect(onSpaceChange).toHaveBeenCalledWith("created"));
    expect(onCreateSpace).toHaveBeenCalledWith("New notes");
    expect(setSpaceList).toHaveBeenCalledWith(false);
  });
  it("keeps the draft available after a refused creation", async () => {
    const { onSpaceChange } = setup(
      vi.fn().mockRejectedValue(new Error("refused")),
    );
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    fireEvent.change(screen.getByLabelText("Space name"), {
      target: { value: "Notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create",
    );
    expect(screen.getByLabelText("Space name")).toHaveValue("Notes");
    expect(onSpaceChange).not.toHaveBeenCalled();
  });
});
