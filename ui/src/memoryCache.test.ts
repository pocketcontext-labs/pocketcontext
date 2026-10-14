import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./memoryCache";

describe("private reader memory cache", () => {
  it("shares concurrent reads and fences pending results on access loss", async () => {
    const cache = new MemoryCache<string>(2, 100);
    let finish!: (value: string) => void;
    const fetch = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const first = cache.read("page", fetch);
    expect(cache.read("page", fetch)).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    cache.clear();
    const rejected = expect(first).rejects.toThrow("access changed");
    finish("private content");
    await rejected;
    await expect(cache.read("page", async () => "new access")).resolves.toBe("new access");
  });

  it("bounds entries by recency and serialized content size", async () => {
    const cache = new MemoryCache<string>(2, 32);
    await cache.read("one", async () => "one");
    await cache.read("two", async () => "two");
    await cache.read("one", async () => "wrong");
    await cache.read("three", async () => "three");
    await expect(cache.read("one", async () => "wrong")).resolves.toBe("one");
    const fetch = vi.fn(async () => "two");
    await cache.read("two", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    const huge = vi.fn(async () => "content too large for retention");
    await cache.read("huge", huge);
    await cache.read("huge", huge);
    expect(huge).toHaveBeenCalledTimes(2);
    const bytes = new MemoryCache<string>(10, 20);
    await bytes.read("one", async () => "one");
    await bytes.read("three", async () => "three");
    await expect(bytes.read("one", async () => "reloaded")).resolves.toBe("reloaded");
  });

  it("retries failures and does not retain negative authorization results", async () => {
    const cache = new MemoryCache<boolean>(2, 100);
    await expect(cache.read("publication", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const fetch = vi.fn(async () => false);
    await cache.read("publication", fetch, valid => valid);
    await cache.read("publication", fetch, valid => valid);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(cache.read("publication", async () => true)).resolves.toBe(true);
  });

  it("accounts for duplicate reads when the pending registry is full", async () => {
    const cache = new MemoryCache<string>(2, 20);
    let release!: (value: string) => void;
    const blocked = new Promise<string>(resolve => { release = resolve; });
    const first = cache.read("blocked-one", () => blocked);
    const second = cache.read("blocked-two", () => blocked);
    await Promise.all([cache.read("one", async () => "one"), cache.read("one", async () => "one")]);
    await cache.read("two", async () => "two");
    await expect(cache.read("one", async () => "wrong")).resolves.toBe("one");
    release("end");
    await Promise.all([first, second]);
  });
});
