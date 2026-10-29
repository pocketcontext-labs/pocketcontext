import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSpace,
  defaultSpace,
  evidenceSpace,
  listSpaces,
  listPublications,
  pb,
  selectSpace,
  type Space,
} from "./api";
import { pageHref } from "./Markdown";
import { catalogHref } from "./Catalog";
import { evidenceHref } from "./EvidenceBrowser";
import { searchHref } from "./SearchResults";
const main: Space = {
  id: "defaultspace001",
  name: "Default",
  is_default: true,
};
const research: Space = {
  id: "researchspace01",
  name: "Research",
};
function signIn() {
  pb.authStore.save(
    `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.x`,
    {
      id: "user00000000001",
      collectionId: "_pb_users_auth_",
      collectionName: "users",
    },
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  pb.authStore.clear();
  history.replaceState(null, "", "/");
});
describe("production space selection", () => {
  it("selects the requested space without assuming an order", () => {
    expect(selectSpace([research, main], main.id)).toBe(main);
    expect(selectSpace([research, main], research.id)).toBe(research);
  });
  it("does not silently substitute another space for an unknown one", () => {
    expect(selectSpace([main], research.id)).toBeNull();
    expect(selectSpace([main], "bad-space")).toBeNull();
    expect(selectSpace([main], "")).toBeNull();
    expect(selectSpace([research], main.id)).toBeNull();
  });
  it.each([main, research])(
    "resolves the project's default space before selection",
    async (expected) => {
      signIn();
      const send = vi
        .spyOn(pb, "send")
        .mockResolvedValue({ ...expected, archived: false });
      const resolved = await defaultSpace();
      expect(selectSpace([research, main], resolved.id)?.id).toBe(
        expected.id,
      );
      expect(send).toHaveBeenCalledWith("/api/spaces/default", {
        method: "GET",
      });
    },
  );
  it("lists every space with archived and default flags", async () => {
    signIn();
    const send = vi.spyOn(pb, "send").mockResolvedValue({
      columns: ["id", "name", "revision", "archived", "is_default"],
      rows: [
        [main.id, "Default", 1, 0, 1],
        [research.id, "Research", 2, 1, 0],
      ],
      truncated: false,
    });
    await expect(listSpaces()).resolves.toEqual([
      {
        id: main.id,
        name: "Default",
        revision: 1,
        archived: false,
        is_default: true,
      },
      {
        id: research.id,
        name: "Research",
        revision: 2,
        archived: true,
        is_default: false,
      },
    ]);
    const sql = (send.mock.calls[0][1] as { body: { sql: string } }).body.sql;
    expect(sql).not.toMatch(/space_members|kind|role/);
  });
  it("creates a space from its name only", async () => {
    const create = vi.fn().mockResolvedValue({ id: research.id });
    vi.spyOn(pb, "collection").mockReturnValue({ create } as never);
    await expect(createSpace("Research")).resolves.toEqual({ id: research.id });
    expect(create).toHaveBeenCalledWith({ name: "Research" });
  });
  it("scopes publication history to selected space", async () => {
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValue({ columns: [], rows: [], truncated: false });
    await listPublications(research.id, 50, 50);
    expect(send).toHaveBeenCalledWith(
      "/api/context/query",
      expect.objectContaining({
        body: {
          sql: expect.stringContaining(
            `WHERE space='${research.id}' ORDER BY sequence DESC LIMIT 50 OFFSET 50`,
          ),
        },
      }),
    );
  });
  it("infers evidence space by record ID through authenticated filtered SQL", async () => {
    const send = vi.spyOn(pb, "send").mockResolvedValue({
      columns: ["space"],
      rows: [[research.id]],
      truncated: false,
    });
    await expect(evidenceSpace("sources", "source000000001")).resolves.toBe(
      research.id,
    );
    expect(send).toHaveBeenCalledWith(
      "/api/context/query",
      expect.objectContaining({
        body: {
          sql: "SELECT space FROM sources WHERE id='source000000001' LIMIT 1",
        },
      }),
    );
  });
});
describe("shareable space navigation", () => {
  it("retains selected space in page, search, catalog, and evidence links", () => {
    history.replaceState(null, "", `/#/?space=${research.id}`);
    for (const href of [
      pageHref("notes"),
      searchHref("query"),
      catalogHref({ type: "resource" }),
      evidenceHref("sources", "", "query"),
    ]) {
      expect(new URLSearchParams(href.split("?")[1]).get("space")).toBe(
        research.id,
      );
    }
  });
  it("keeps links to the default space stable without explicit space", () => {
    expect(pageHref("notes")).toBe("#/page/notes");
  });
});
