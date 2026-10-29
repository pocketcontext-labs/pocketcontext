import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  originalSize,
  pb,
  sourceCount,
  sourceText,
  SOURCE_PREVIEW_BYTES,
  SourcePreviewLimitError,
  watchSources,
} from "./api";
import type { Source } from "./types";

const bytes = (text: string) => new TextEncoder().encode(text);
const original = (content: Uint8Array): Source => ({
  id: "source000000001",
  title: "Synthetic original",
  original_name: "note.md",
  original: "note.md",
  media_type: "text/markdown",
  source_date: "",
  sha256: createHash("sha256").update(content).digest("hex"),
});
const token = () =>
  `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.x`;
beforeEach(() => {
  pb.authStore.save(token(), {
    id: "user00000000001",
    collectionId: "_pb_users_auth_",
    collectionName: "users",
  });
  vi.stubGlobal("crypto", webcrypto);
  vi.spyOn(pb.files, "getToken").mockResolvedValue("synthetic-file-token");
  vi.spyOn(pb.files, "getURL").mockReturnValue(
    `${location.origin}/api/files/sources/source000000001/note.md?token=synthetic-file-token`,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pb.authStore.clear();
});

it("reads byte-exact protected originals with a fresh token and verifies SHA-256", async () => {
  const content = bytes("# Synthetic\r\n\r\nUnicode: café\n");
  const fetcher = vi.fn().mockResolvedValue(new Response(content));
  vi.stubGlobal("fetch", fetcher);
  await expect(sourceText(original(content))).resolves.toBe(
    "# Synthetic\r\n\r\nUnicode: café\n",
  );
  expect(pb.files.getToken).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining("/api/files/sources/"),
    expect.objectContaining({
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  );
});

it("rejects denied originals even when metadata was available", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("denied", { status: 403 })),
  );
  await expect(sourceText(original(bytes("Synthetic")))).rejects.toThrow(
    "access was denied",
  );
  expect(pb.authStore.token).toBe("");
});

it("rejects a false checksum and invalid UTF-8 instead of rendering replacement text", async () => {
  const content = bytes("Synthetic");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(content))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff]))),
  );
  await expect(
    sourceText({ ...original(content), sha256: "0".repeat(64) }),
  ).rejects.toThrow("checksum");
  await expect(sourceText(original(new Uint8Array([0xff])))).rejects.toThrow(
    "not valid UTF-8",
  );
});

it("rejects oversized Content-Length before consuming and cancels oversized streams without a length", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-length": String(SOURCE_PREVIEW_BYTES + 1) },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(SOURCE_PREVIEW_BYTES));
              controller.enqueue(new Uint8Array(1));
            },
            cancel,
          }),
        ),
      ),
  );
  await expect(sourceText(original(bytes("Synthetic")))).rejects.toBeInstanceOf(
    SourcePreviewLimitError,
  );
  await expect(sourceText(original(bytes("Synthetic")))).rejects.toBeInstanceOf(
    SourcePreviewLimitError,
  );
  expect(cancel).toHaveBeenCalledTimes(2);
});

it.each(["logout", "abort"])(
  "rejects a pending original after %s even when fetch resolves late",
  async (action) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const content = bytes("Private synthetic source");
    const reading = sourceText(original(content), controller.signal);
    const rejected = expect(reading).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    if (action === "logout") pb.authStore.clear();
    else controller.abort();
    finish(new Response(content));
    await rejected;
  },
);

it("counts all sources in only the selected space without publication or search scope", async () => {
  const send = vi
    .spyOn(pb, "send")
    .mockResolvedValue({ columns: ["count"], rows: [[23]], truncated: false });
  await expect(sourceCount("defaultspace001")).resolves.toBe(23);
  expect(send).toHaveBeenCalledWith(
    "/api/context/query",
    expect.objectContaining({
      body: {
        sql: "SELECT count(*) AS count FROM sources WHERE space='defaultspace001'",
      },
    }),
  );
  await expect(sourceCount("invalid-id")).rejects.toThrow(
    "Invalid record identity",
  );
});

it("reconciles source events and reconnects, and ignores callbacks from a logged-out identity", async () => {
  let connected!: () => void, changed!: () => void;
  const stopConnected = vi.fn().mockResolvedValue(undefined),
    stopSources = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(pb.realtime, "subscribe").mockImplementation(
    async (_topic, callback) => {
      connected = () => callback({} as never);
      return stopConnected;
    },
  );
  const subscribe = vi
    .spyOn(pb.collection("sources"), "subscribe")
    .mockImplementation(async (_topic, callback) => {
      changed = () => callback({} as never);
      return stopSources;
    });
  const refresh = vi.fn();
  const stop = await watchSources(refresh);
  expect(subscribe).toHaveBeenCalledWith("*", expect.any(Function));
  expect(refresh).toHaveBeenCalledTimes(1);
  changed();
  connected();
  expect(refresh).toHaveBeenCalledTimes(3);
  pb.authStore.clear();
  changed();
  connected();
  expect(refresh).toHaveBeenCalledTimes(3);
  stop();
  expect(stopConnected).toHaveBeenCalledOnce();
  expect(stopSources).toHaveBeenCalledOnce();
});

it("reads an original's size from a one-byte ranged request without downloading it", async () => {
  const content = bytes("%PDF-1.7 synthetic");
  const fetcher = vi.fn().mockResolvedValue(
    new Response(content.slice(0, 1), {
      status: 206,
      headers: { "content-range": `bytes 0-0/${5 * 1024 * 1024}` },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(originalSize(original(content))).resolves.toBe(5 * 1024 * 1024);
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining("/api/files/sources/"),
    expect.objectContaining({
      headers: { Range: "bytes=0-0" },
      redirect: "error",
    }),
  );
  fetcher.mockResolvedValue(
    new Response(content, { headers: { "content-length": "18" } }),
  );
  await expect(originalSize(original(content))).resolves.toBe(18);
  fetcher.mockResolvedValue(new Response(null, { status: 403 }));
  await expect(originalSize(original(content))).rejects.toThrow(
    "access was denied",
  );
});
