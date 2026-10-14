import { describe, expect, it, vi } from "vitest";
import { ReconciledRead } from "./reconciledRead";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("membership reconciliation", () => {
  it("shares a burst of forced checks and rechecks events during its trailing read", async () => {
    const reads = new ReconciledRead<string>();
    const first = deferred<string>(), second = deferred<string>(), third = deferred<string>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const initial = reads.read(fetch);
    expect(reads.read(fetch)).toBe(initial);
    const burst = Array.from({ length: 20 }, () => reads.read(fetch, true));
    expect(new Set(burst).size).toBe(1);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    first.resolve("before revocation");
    await initial;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const during = Array.from({ length: 20 }, () => reads.read(fetch, true));
    expect(new Set(during).size).toBe(1);
    second.resolve("another change is in flight");
    await Promise.all(burst);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    third.resolve("revoked");
    expect(await Promise.all(during)).toEqual(Array(20).fill("revoked"));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(reads.active).toBe(false);
  });

  it("runs the requested trailing check even when the current read fails", async () => {
    const reads = new ReconciledRead<string>();
    const initial = deferred<string>();
    const fetch = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValueOnce("current membership");
    const first = reads.read(fetch);
    const reconciled = reads.read(fetch, true);
    const rejected = expect(first).rejects.toThrow("offline");
    initial.reject(new Error("offline"));
    await rejected;
    await expect(reconciled).resolves.toBe("current membership");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(reads.active).toBe(false);
  });
});
