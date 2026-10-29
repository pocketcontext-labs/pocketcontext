import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, pb } from "./api";
import { useSourceCount } from "./useSourceCount";

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
  cleanup();
  vi.restoreAllMocks();
  pb.authStore.clear();
});

it("refreshes on source notifications and clears across spaces, logout and pending responses", async () => {
  let notify!: () => void;
  const stop = vi.fn();
  vi.spyOn(api, "watchSources").mockImplementation(async (callback) => {
    notify = callback;
    return stop;
  });
  let completePersonal!: (count: number) => void;
  const count = vi
    .spyOn(api, "sourceCount")
    .mockResolvedValueOnce(23)
    .mockResolvedValueOnce(24)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completePersonal = resolve;
        }),
    );
  const { result, rerender } = renderHook(
    ({ space }) => useSourceCount(space),
    { initialProps: { space: "defaultspace001" } },
  );
  await waitFor(() => expect(result.current).toBe(23));
  act(() => notify());
  await waitFor(() => expect(result.current).toBe(24));
  rerender({ space: "personalspace01" });
  expect(result.current).toBeNull();
  await waitFor(() =>
    expect(count).toHaveBeenLastCalledWith("personalspace01"),
  );
  expect(stop).toHaveBeenCalledOnce();
  act(() => pb.authStore.clear());
  await act(async () => completePersonal(7));
  expect(result.current).toBeNull();
});

it("refreshes on focus and online even when realtime could not subscribe", async () => {
  vi.spyOn(api, "watchSources").mockRejectedValue(new Error("offline"));
  const count = vi
    .spyOn(api, "sourceCount")
    .mockResolvedValueOnce(1)
    .mockResolvedValueOnce(2)
    .mockResolvedValueOnce(3);
  const { result } = renderHook(() => useSourceCount("defaultspace001"));
  await waitFor(() => expect(result.current).toBe(1));
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(result.current).toBe(2));
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(result.current).toBe(3));
  expect(count).toHaveBeenCalledTimes(3);
});
