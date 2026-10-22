import { afterEach, describe, expect, it, vi } from "vitest";
import {
  companySpace,
  defaultSpace,
  createPersonalSpace,
  evidenceSpace,
  listPublications,
  pb,
  selectSpace,
  type Space,
} from "./api";
import { pageHref } from "./Markdown";
import { catalogHref } from "./Catalog";
import { evidenceHref } from "./EvidenceBrowser";
import { searchHref } from "./SearchResults";
const company: Space = {
  id: companySpace,
  kind: "group",
  name: "Company",
  role: "editor",
};
const personal: Space = {
  id: "personalspace01",
  kind: "personal",
  name: "Personal",
  role: "owner",
};
afterEach(() => {
  vi.restoreAllMocks();
  pb.authStore.clear();
  history.replaceState(null, "", "/");
});
describe("production space selection", () => {
  it("selects the requested space without assuming an order", () => {
    expect(selectSpace([personal, company], company.id)).toBe(company);
    expect(selectSpace([personal, company], personal.id)).toBe(personal);
  });
  it("does not silently substitute another space for unavailable membership", () => {
    expect(selectSpace([company], personal.id)).toBeNull();
    expect(selectSpace([company], "bad-space")).toBeNull();
    expect(selectSpace([company], "")).toBeNull();
    expect(selectSpace([personal], companySpace)).toBeNull();
  });
  it.each(["personal", "company"])(
    "resolves the server-owned %s default before selection",
    async (policy) => {
      pb.authStore.save(
        `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.x`,
        {
          id: "user00000000001",
          collectionId: "_pb_users_auth_",
          collectionName: "users",
        },
      );
      const expected = {
        ...(policy === "personal" ? personal : company),
        policy,
      };
      const send = vi.spyOn(pb, "send").mockResolvedValue(expected);
      const resolved = await defaultSpace();
      expect(selectSpace([personal, company], resolved.id)?.id).toBe(
        expected.id,
      );
      expect(send).toHaveBeenCalledWith("/api/spaces/default", {
        method: "GET",
      });
    },
  );
  it("requests personal space only through its explicit idempotent endpoint", async () => {
    const send = vi.spyOn(pb, "send").mockResolvedValue({ id: personal.id });
    await expect(createPersonalSpace()).resolves.toEqual({ id: personal.id });
    expect(send).toHaveBeenCalledWith("/api/spaces/personal", {
      method: "POST",
    });
  });
  it("scopes publication history to selected space", async () => {
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValue({ columns: [], rows: [], truncated: false });
    await listPublications(personal.id, 50, 50);
    expect(send).toHaveBeenCalledWith(
      "/api/context/query",
      expect.objectContaining({
        body: {
          sql: expect.stringContaining(
            `WHERE space='${personal.id}' ORDER BY sequence DESC LIMIT 50 OFFSET 50`,
          ),
        },
      }),
    );
  });
  it("infers evidence space by record ID through authenticated filtered SQL", async () => {
    const send = vi
      .spyOn(pb, "send")
      .mockResolvedValue({
        columns: ["space"],
        rows: [[personal.id]],
        truncated: false,
      });
    await expect(evidenceSpace("sources", "source000000001")).resolves.toBe(
      personal.id,
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
    history.replaceState(null, "", `/#/?space=${personal.id}`);
    for (const href of [
      pageHref("notes"),
      searchHref("query"),
      catalogHref({ type: "resource" }),
      evidenceHref("sources", "", "query"),
    ]) {
      expect(new URLSearchParams(href.split("?")[1]).get("space")).toBe(
        personal.id,
      );
    }
  });
  it("keeps existing company links stable without explicit space", () => {
    expect(pageHref("notes")).toBe("#/page/notes");
  });
});
