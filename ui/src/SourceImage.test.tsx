import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceImage } from "./SourceImage";
import { imageSource, pb, sourceImage } from "./api";
const { listeners } = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock("./api", () => ({
  imageSource: vi.fn(), sourceImage: vi.fn(), sessionGeneration: 0,
  pb: { authStore: { token: "test", isValid: true, onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } },
}));
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(pb.authStore, { token: "test", isValid: true });
});
afterEach(() => { cleanup(); listeners.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); location.hash = ""; });
it("renders a protected image, offers enlargement and releases its blob on unmount", async () => {
  location.hash = "#/?space=space0000000001";
  vi.mocked(imageSource).mockResolvedValue({ id: "source000000001", original_name: "diagram.png" } as any);
  vi.mocked(sourceImage).mockResolvedValue(new Blob(["synthetic"], { type: "image/png" }));
  const create = vi.fn().mockReturnValue("blob:synthetic");
  const revoke = vi.fn();
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  const show = vi.fn();
  HTMLDialogElement.prototype.showModal = show;
  HTMLDialogElement.prototype.close = vi.fn();
  const { unmount } = render(<SourceImage id="source000000001" alt="Diagram" title="size=320x200" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Enlarge Diagram" })).toBeVisible());
  expect(imageSource).toHaveBeenCalledWith("source000000001", "space0000000001");
  const inline = screen.getByRole("img", { name: "Diagram" });
  expect(inline).toHaveAttribute("src", "blob:synthetic");
  expect(inline).toHaveAttribute("width", "320");
  fireEvent.click(screen.getByRole("button", { name: "Enlarge Diagram" }));
  expect(show).toHaveBeenCalledOnce();
  unmount();
  expect(revoke).toHaveBeenCalledWith("blob:synthetic");
});


it("reloads on same-account token renewal and clears on logout", async () => {
  location.hash = "#/?space=space0000000001";
  vi.mocked(imageSource).mockResolvedValue({ id: "source000000001", original_name: "diagram.png" } as any);
  vi.mocked(sourceImage).mockResolvedValue(new Blob(["synthetic"], { type: "image/png" }));
  URL.createObjectURL = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:renewed");
  URL.revokeObjectURL = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  render(<SourceImage id="source000000001" alt="Diagram" />);
  await waitFor(() => expect(screen.getByRole("img", { name: "Diagram" })).toHaveAttribute("src", "blob:first"));
  act(() => {
    Object.assign(pb.authStore, { token: "renewed" });
    for (const listener of listeners) listener();
  });
  await waitFor(() => expect(screen.getByRole("img", { name: "Diagram" })).toHaveAttribute("src", "blob:renewed"));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:first");
  expect(sourceImage).toHaveBeenCalledTimes(2);
  act(() => {
    Object.assign(pb.authStore, { token: "", isValid: false });
    for (const listener of listeners) listener();
  });
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Sign in to view this image.");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:renewed");
  expect(sourceImage).toHaveBeenCalledTimes(2);
});

it("retries an in-flight image after renewal and discards the stale response", async () => {
  location.hash = "#/?space=space0000000001";
  vi.mocked(imageSource).mockResolvedValue({ id: "source000000001", original_name: "diagram.png" } as any);
  let finish!: (blob: Blob) => void;
  vi.mocked(sourceImage)
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(new Blob(["renewed"], { type: "image/png" }));
  URL.createObjectURL = vi.fn().mockReturnValue("blob:renewed");
  URL.revokeObjectURL = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  render(<SourceImage id="source000000001" alt="Diagram" />);
  await waitFor(() => expect(sourceImage).toHaveBeenCalledTimes(1));
  act(() => {
    Object.assign(pb.authStore, { token: "renewed" });
    for (const listener of listeners) listener();
  });
  await waitFor(() => expect(screen.getByRole("img", { name: "Diagram" })).toHaveAttribute("src", "blob:renewed"));
  await act(async () => { finish(new Blob(["stale"], { type: "image/png" })); });
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(sourceImage).toHaveBeenCalledTimes(2);
});
