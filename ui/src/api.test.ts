import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearReaderCache,
  IncompleteReadError,
  getPage,
  listPages,
  logout,
  pb,
  query,
  refreshSession,
  searchPages,
  SearchUnavailableError,
  watchPublications,
  TruncatedQueryError,
} from "./api";

const publication = "publication0001";
const user = {
  id: "user00000000001",
  collectionId: "_pb_users_auth_",
  collectionName: "users",
};
function response(rows: Record<string, unknown>[], truncated = false) {
  const columns = Object.keys(rows[0] ?? {});
  return {
    columns,
    rows: rows.map((row) => columns.map((column) => row[column])),
    truncated,
  };
}
const validManifest = (published = 1) =>
  response([{ manifest_type: "object", total: Math.max(1, published), unique_keys: Math.max(1, published), invalid: 0, published_count: published }]);
const detailRow = (page: Record<string, unknown>, citations = 0, backlinks = 0, links = 0) =>
  ({ ...page, citation_count: citations, backlink_count: backlinks, link_count: links });

afterEach(() => {
  clearReaderCache();
  vi.restoreAllMocks();
  pb.authStore.clear();
});

describe("published knowledge reads", () => {
  it("shares validation and complete publication data until access invalidation", async () => {
    const page = { id: "revision0000001", page: "page00000000001", slug: "example", title: "Example", body: "Synthetic" };
    const send = vi.spyOn(pb, "send").mockImplementation(async (_path, options) => {
      const sql = options?.body.sql as string;
      if (sql.includes("manifest_type")) return validManifest();
      if (sql.includes("r.body")) return response([detailRow(page)]);
      if (sql.includes("FROM citations") || sql.includes("FROM page_links")) return response([]);
      return response([page]);
    });
    await Promise.all([listPages(publication), getPage(publication, "example")]);
    expect(send).toHaveBeenCalledTimes(6);
    await Promise.all([listPages(publication), getPage(publication, "example")]);
    expect(send).toHaveBeenCalledTimes(6);
    clearReaderCache();
    await Promise.all([listPages(publication), getPage(publication, "example")]);
    expect(send).toHaveBeenCalledTimes(12);
  });

  it("does not retain missing pages or empty directories across temporary visibility loss", async () => {
    const page = { id: "revision0000001", page: "page00000000001", slug: "example", title: "Example", body: "Synthetic" };
    let visible = false;
    vi.spyOn(pb, "send").mockImplementation(async (_path, options) => {
      const sql = options?.body.sql as string;
      if (sql.includes("manifest_type")) return validManifest();
      if (sql.includes("r.body")) return response(visible ? [detailRow(page)] : []);
      if (sql.includes("FROM citations") || sql.includes("FROM page_links")) return response([]);
      return response(visible ? [page] : []);
    });
    await expect(listPages(publication)).rejects.toBeInstanceOf(IncompleteReadError);
    await expect(getPage(publication, "example")).resolves.toBeNull();
    visible = true;
    await expect(listPages(publication)).resolves.toEqual([page]);
    await expect(getPage(publication, "example")).resolves.toMatchObject(page);
  });

  it("rejects and retries a directory whose later batch loses visibility", async () => {
    const pages = Array.from({ length: 201 }, (_, i) => ({ id: String(i).padStart(15, "0"), slug: `page-${i}` }));
    let revoked = true;
    vi.spyOn(pb, "send").mockImplementation(async (_path, options) => {
      const sql = options?.body.sql as string;
      if (sql.includes("manifest_type")) return validManifest(pages.length);
      const [, limit, offset] = /LIMIT (\d+) OFFSET (\d+)/.exec(sql)!;
      return response(revoked && Number(offset) ? [] : pages.slice(Number(offset), Number(offset) + Number(limit)));
    });
    await expect(listPages(publication)).rejects.toBeInstanceOf(IncompleteReadError);
    revoked = false;
    await expect(listPages(publication)).resolves.toEqual(pages);
  });

  it("rejects and retries evidence whose later citation batch loses visibility", async () => {
    const citations = Array.from({ length: 101 }, (_, i) => ({ id: String(i).padStart(15, "0"), marker: String(i + 1) }));
    let revoked = true;
    vi.spyOn(pb, "send").mockImplementation(async (_path, options) => {
      const sql = options?.body.sql as string;
      if (sql.includes("manifest_type")) return validManifest();
      if (sql.includes("r.body")) return response([detailRow({ id: "revision0000001", page: "page00000000001" }, citations.length)]);
      if (!sql.includes("FROM citations c")) return response([]);
      const [, limit, offset] = /LIMIT (\d+) OFFSET (\d+)/.exec(sql)!;
      return response(revoked && Number(offset) ? [] : citations.slice(Number(offset), Number(offset) + Number(limit)));
    });
    await expect(getPage(publication, "example")).rejects.toBeInstanceOf(IncompleteReadError);
    revoked = false;
    await expect(getPage(publication, "example")).resolves.toMatchObject({ citations: expect.arrayContaining([expect.objectContaining({ marker: "101" })]) });
  });

  it.each(["backlinks", "links"])("rejects incomplete %s before retaining page details", async kind => {
    vi.spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest())
      .mockResolvedValueOnce(response([detailRow({ id: "revision0000001", page: "page00000000001" }, 0, kind === "backlinks" ? 1 : 0, kind === "links" ? 1 : 0)]))
      .mockResolvedValue(response([]));
    await expect(getPage(publication, "example")).rejects.toBeInstanceOf(IncompleteReadError);
  });

  it("reconciles a publication committed between the initial read and subscription activation", async () => {
    vi.spyOn(pb.authStore, "isValid", "get").mockReturnValue(true);
    let connected!: () => void;
    vi.spyOn(pb.realtime, "subscribe").mockImplementation(async (_topic, callback) => { connected = () => callback({} as never); return async () => {}; });
    let activate!: (unsubscribe: () => Promise<void>) => void;
    const subscribe = vi.spyOn(pb.collection("publications"), "subscribe").mockImplementation(() => new Promise(resolve => { activate = resolve; }));
    let committedPublication = "initial";
    const observed = [committedPublication];
    const reconcile = vi.fn(() => { observed.push(committedPublication); });
    const pending = watchPublications(reconcile);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    committedPublication = "published-in-subscription-gap";
    connected(); // Initial connection alone must not start a redundant full read.
    expect(reconcile).not.toHaveBeenCalled();
    activate(async () => {});
    const unsubscribe = await pending;
    expect(observed).toEqual(["initial", "published-in-subscription-gap"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    committedPublication = "published-while-disconnected";
    connected();
    expect(observed.at(-1)).toBe("published-while-disconnected");
    expect(reconcile).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
  it("decodes SQL JSON properties and property evidence without changing scalar strings", async () => {
    vi.spyOn(pb, "send").mockResolvedValue(response([{ properties: '{"catalog_type":"resource","accountable_owner":null}', property_evidence: '{"catalog_type":["1"]}', title: '{not JSON}' }]));
    await expect(query("SELECT synthetic")).resolves.toEqual([{ properties: { catalog_type: "resource", accountable_owner: null }, property_evidence: { catalog_type: ["1"] }, title: "{not JSON}" }]);
  });
  it.each([
    { manifest_type: "array", total: 0, unique_keys: 0, invalid: 0 },
    { manifest_type: "object", total: 2, unique_keys: 1, invalid: 0 },
    { manifest_type: "object", total: 1, unique_keys: 1, invalid: 1 },
  ])(
    "rejects malformed or incomplete manifests before reading content: %j",
    async (check) => {
      const send = vi.spyOn(pb, "send").mockResolvedValue(response([check]));
      await expect(listPages(publication)).rejects.toThrow(
        "incomplete or invalid",
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("returns no content for an unavailable publication", async () => {
    const send = vi.spyOn(pb, "send").mockResolvedValue(response([]));
    await expect(listPages(publication)).resolves.toEqual([]);
    await expect(searchPages(publication, "anything")).rejects.toThrow(
      "unavailable",
    );
    await expect(getPage(publication, "missing")).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects truncated results instead of presenting partial evidence", async () => {
    vi.spyOn(pb, "send").mockResolvedValue(response([{ id: "partial" }], true));
    await expect(query("SELECT id FROM pages")).rejects.toBeInstanceOf(
      TruncatedQueryError,
    );
  });

  it("pins index reads to the manifest and excludes archived and staged revisions", async () => {
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest(0))
      .mockResolvedValue(response([]));
    await listPages(publication);
    const sql = send.mock.calls[1][1]?.body.sql as string;
    expect(sql).toContain("pub.id='publication0001'");
    expect(sql).toContain("JOIN json_each(pub.manifest) m");
    expect(sql).toContain("p.id=m.key");
    expect(sql).toContain("r.id=m.value");
    expect(sql).toContain("m.type='text'");
    expect(sql).toContain("r.page=p.id");
    expect(sql).toContain("r.archived=0");
    expect(sql).toContain("origin.run=r.run");
    expect(sql).toContain("origin.space=pub.space");
    expect(sql).toContain("origin.sequence<=pub.sequence");
    expect(sql).toContain("AS publishedAt");
    expect(sql).not.toContain("pub.manifest, pub");
  });

  it("retries truncated index pages at a smaller size without skipping rows", async () => {
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest())
      .mockResolvedValueOnce(response([{ id: "partial" }], true))
      .mockResolvedValueOnce(response([{ id: "complete" }]));
    await expect(listPages(publication)).resolves.toEqual([{ id: "complete" }]);
    expect(send.mock.calls[1][1]?.body.sql).toContain("LIMIT 200 OFFSET 0");
    expect(send.mock.calls[2][1]?.body.sql).toContain("LIMIT 100 OFFSET 0");
  });

  it("reduces pages when the server rejects the response byte budget", async () => {
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest(0))
      .mockRejectedValueOnce({ status: 413 })
      .mockResolvedValueOnce(response([]));
    await expect(listPages(publication)).resolves.toEqual([]);
    expect(send.mock.calls[2][1]?.body.sql).toContain("LIMIT 100 OFFSET 0");
  });

  it("rejects invalid IDs, slugs and pagination before sending requests", async () => {
    const send = vi.spyOn(pb, "send");
    await expect(listPages("' OR 1=1")).rejects.toThrow("identity");
    await expect(getPage(publication, "../draft")).rejects.toThrow("slug");
    await expect(searchPages(publication, "hi", -1)).rejects.toThrow(
      "query page",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sends literal search terms and hydrates only exact scoped revisions in rank order", async () => {
    const first = {
      id: "revision0000001",
      page: "page00000000001",
      title: "First",
    };
    const second = {
      id: "revision0000002",
      page: "page00000000002",
      title: "Second",
    };
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest())
      .mockResolvedValueOnce({
        index: "pages",
        scope: publication,
        generation: "generation1",
        hasMore: false,
        truncated: false,
        hits: [
          { id: second.id, score: -2, excerpt: "<script>untrusted</script>" },
          { id: first.id, score: -1, excerpt: "First" },
        ],
      })
      .mockResolvedValueOnce(response([first, second]));
    const found = await searchPages(
      publication,
      "O'Brien %",
      20,
      20,
      "generation1",
    );
    expect(send.mock.calls[1][0]).toBe("/api/context/search");
    expect(send.mock.calls[1][1]?.body).toEqual({
      index: "pages",
      scope: publication,
      query: "O'Brien %",
      offset: 20,
      limit: 20,
      expectedGeneration: "generation1",
    });
    expect(found.hits.map((hit) => hit.id)).toEqual([second.id, first.id]);
    expect(found.hits[0].excerpt).toBe("<script>untrusted</script>");
    expect(send.mock.calls[2][1]?.body.sql).toContain(
      "pub.id='publication0001'",
    );
    expect(send.mock.calls[2][1]?.body.sql).toContain("r.id=m.value");
  });
  it("rejects hits missing from the selected publication", async () => {
    vi.spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest())
      .mockResolvedValueOnce({
        index: "pages",
        scope: publication,
        generation: "g",
        hasMore: false,
        truncated: false,
        hits: [{ id: "revision0000001", score: -1, excerpt: "draft" }],
      })
      .mockResolvedValueOnce(response([]));
    await expect(searchPages(publication, "draft")).rejects.toThrow(
      "selected publication",
    );
  });
  it("requires generation for later pages and reports a changed generation", async () => {
    const send = vi.spyOn(pb, "send");
    await expect(searchPages(publication, "word", 20)).rejects.toThrow(
      "search page",
    );
    expect(send).not.toHaveBeenCalled();
    send
      .mockResolvedValueOnce(validManifest())
      .mockRejectedValueOnce({ status: 409 });
    await expect(
      searchPages(publication, "word", 20, 20, "old"),
    ).rejects.toThrow("Search changed");
  });

  it.each([[404, "not-found"], [413, "too-large"], [503, "unavailable"]])("describes private search availability failures (%s)", async (status, reason) => {
    vi.spyOn(pb, "send").mockResolvedValueOnce(validManifest()).mockRejectedValueOnce({ status });
    await expect(searchPages(publication, "word")).rejects.toMatchObject({ constructor: SearchUnavailableError, reason });
  });

  it.each([
    { generation: 123 },
    { generation: "" },
    { generation: "a\0b" },
    { truncated: true },
    { hasMore: true },
    { scope: "publication0002" },
  ])("rejects malformed or mismatched search metadata: %j", async (patch) => {
    vi.spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest())
      .mockResolvedValueOnce({
        index: "pages",
        scope: publication,
        generation: "g",
        hits: [],
        hasMore: false,
        truncated: false,
        ...patch,
      });
    await expect(searchPages(publication, "word")).rejects.toThrow();
  });

  it("returns missing pages without querying draft evidence", async () => {
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest())
      .mockResolvedValue(response([]));
    await expect(getPage(publication, "missing")).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("loads citations only for the selected revision and pins both link directions", async () => {
    const page = {
      id: "revision0000001",
      page: "page00000000001",
      slug: "example",
      title: "Example",
      summary: "",
      kind: "concept",
      body: "Text[^1]",
    };
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValueOnce(validManifest())
      .mockResolvedValueOnce(response([detailRow(page)]))
      .mockResolvedValue(response([]));
    await expect(getPage(publication, "example")).resolves.toEqual({
      ...page,
      citations: [],
      backlinks: [],
      links: [],
    });
    const sql = send.mock.calls
      .slice(1)
      .map((call) => call[1]?.body.sql as string);
    expect(sql[1]).toContain("c.page_revision='revision0000001'");
    for (const linkQuery of sql.slice(2)) {
      expect(linkQuery).toContain("pub.id='publication0001'");
      expect(linkQuery).toContain("r.archived=0");
    }
  });

  it("carries each cited passage's rendition kind so agent text is labelled", async () => {
    const citation = {
      id: "citation0000001", marker: "1", note: "", passage_id: "passage00000001", ordinal: 1,
      locator: "# Scan; lines 1-2", passage_body: "Converted words", rendition_kind: "agent-text",
      source_id: "source000000001", source_title: "Scan", original_name: "scan.pdf", original: "scan.pdf",
      media_type: "application/pdf", source_date: "", sha256: "a".repeat(64),
    };
    const send = vi.spyOn(pb, "send").mockImplementation(async (_path, options) => {
      const sql = options?.body.sql as string;
      if (sql.includes("AS manifest_type")) return validManifest();
      if (sql.includes("r.body")) return response([detailRow({ id: "revision0000001", page: "page00000000001" }, 1)]);
      if (sql.includes("AS passage_id")) return response(Number(/OFFSET (\d+)/.exec(sql)![1]) ? [] : [citation]);
      return response([]);
    });
    const page = await getPage(publication, "scan");
    expect(page?.citations[0].passage).toEqual({ id: "passage00000001", ordinal: 1, locator: "# Scan; lines 1-2", body: "Converted words", kind: "agent-text" });
    expect(send.mock.calls.map((call) => call[1]?.body.sql as string).find((sql) => sql.includes("AS passage_id"))).toContain("e.kind AS rendition_kind");
  });

  it.each([false, true])("loads all 738 transcript citations within the request budget (oversized batch: %s)", async (oversized) => {
    const citations = Array.from({ length: 738 }, (_, i) => ({
      id: String(i).padStart(15, "0"), marker: String(i + 1),
      passage_id: String(i).padStart(15, "0"), passage_body: "Synthetic transcript passage.",
    }));
    const send = vi.spyOn(pb, "send").mockImplementation(async (_path, options) => {
      const sql = options?.body.sql as string;
      if (sql.includes("AS manifest_type")) return validManifest();
      if (sql.includes("r.body")) return response([detailRow({ id: "revision0000001", page: "page00000000001" }, 738)]);
      if (!sql.includes("FROM citations c")) return response([]);
      const [, limit, offset] = /LIMIT (\d+) OFFSET (\d+)/.exec(sql)!;
      if (oversized && Number(limit) > 50) throw { status: 413 };
      return response(citations.slice(Number(offset), Number(offset) + Number(limit)));
    });
    const page = await getPage(publication, "transcript");
    expect(page?.citations.map(c => c.marker)).toEqual(citations.map(c => c.marker));
    expect(page?.citations[737].passage.body).toBe("Synthetic transcript passage.");
    // Leave room in the 60/10s budget for the index and initial SSE reload.
    expect(send.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it.each([401, 403])(
    "clears a revoked session after SQL status %i",
    async (status) => {
      pb.authStore.save("expired", {
        id: "user00000000001",
        collectionId: "_pb_users_auth_",
        collectionName: "users",
      });
      vi.spyOn(pb, "send").mockRejectedValue({ status });
      await expect(query("SELECT id FROM pages")).rejects.toEqual({ status });
      expect(pb.authStore.token).toBe("");
      expect(
        window.localStorage.getItem("pocketcontext.reader.auth"),
      ).toBeNull();
    },
  );

  it.each([false, true])(
    "does not restore an old refresh after logout (new login: %s)",
    async (loginAgain) => {
      pb.authStore.save("old-token", user);
      let resolve!: (value: unknown) => void;
      vi.spyOn(pb, "send").mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const refresh = refreshSession();
      logout();
      if (loginAgain) pb.authStore.save("new-login-token", user);
      resolve({ token: "refreshed-old-token", record: user });
      await refresh;
      expect(pb.authStore.token).toBe(loginAgain ? "new-login-token" : "");
    },
  );

  it("does not revoke a new session when an old request returns unauthorized", async () => {
    pb.authStore.save("old-token", user);
    let reject!: (reason: unknown) => void;
    vi.spyOn(pb, "send").mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const pending = query("SELECT id FROM pages");
    pb.authStore.save("new-login-token", user);
    reject({ status: 401 });
    await expect(pending).rejects.toEqual({ status: 401 });
    expect(pb.authStore.token).toBe("new-login-token");
  });
});
