import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import Catalog, { catalogHref, type CatalogState } from "./Catalog";
import { customCatalogRows } from "./CustomCatalog";
import { navigationGroups } from "./navigation";
import type { PageSummary } from "./types";
afterEach(cleanup);
const page = (
  slug: string,
  properties: PageSummary["properties"] = {},
): PageSummary => ({
  id: `rev-${slug}`,
  page: `page-${slug}`,
  slug,
  title: slug,
  summary: "",
  kind: "entity",
  properties,
});
const def = page("developer-tools", {
  navigation_kind: "catalog",
  catalog_columns: ["title", "provider", "license", "accountable_owners"],
  catalog_sort: "-provider",
});
def.title = "Development tools";
const tool = page("example-tool", {
  catalogs: ["developer-tools"],
  provider: "Example",
  license: "<img src=x onerror=unsafe()>",
  accountable_owners: ["page-team"],
});
const team = page("team", { catalog_type: "group" });
team.title = "Named team";
const state: CatalogState = {
  type: "resource",
  custom: "developer-tools",
  query: "",
  provider: "",
  deployment: "",
  lifecycle: "",
  missingOwner: false,
  sort: "",
  offset: 0,
};
test("custom catalog uses explicit columns, safe values, known relationships and historical links", () => {
  const navigate = vi.fn();
  render(
    <Catalog
      pages={[def, tool, team]}
      state={state}
      publication="publication0001"
      onNavigate={navigate}
    />,
  );
  expect(
    screen.getAllByRole("columnheader").map((node) => node.textContent),
  ).toEqual(["Name", "Provider", "License", "Accountable owners"]);
  expect(screen.getByRole("link", { name: "Named team" })).toHaveAttribute(
    "href",
    "#/page/team?publication=publication0001",
  );
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText("<img src=x onerror=unsafe()>")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue(
    "-provider",
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
    target: { value: "title" },
  });
  expect(navigate).toHaveBeenLastCalledWith(
    expect.stringContaining("sort=title"),
  );
  expect(catalogHref({ custom: "" })).toBe("#/catalog/custom/");
  expect(catalogHref({ custom: "resource" }, "publication0001")).toBe(
    "#/catalog/custom/resource?publication=publication0001",
  );
});
test("unknown custom and built-in catalogs do not fall back to Resources", () => {
  const r = render(
    <Catalog pages={[tool]} state={{ ...state, custom: "missing" }} />,
  );
  expect(
    screen.getByRole("heading", { name: "Catalog unavailable" }),
  ).toBeVisible();
  r.rerender(
    <Catalog
      pages={[tool]}
      state={{
        ...state,
        custom: undefined,
        type: "missing" as CatalogState["type"],
      }}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Catalog unavailable" }),
  ).toBeVisible();
});
test("catalog pagination and property filters retain stable links and selected members", () => {
  const items = Array.from({ length: 51 }, (_, i) =>
    page(`tool-${String(i).padStart(2, "0")}`, {
      catalogs: ["developer-tools"],
      provider: "Example",
    }),
  );
  render(
    <Catalog
      pages={[def, ...items]}
      state={{ ...state, sort: "title" }}
      publication="publication0001"
    />,
  );
  expect(screen.getAllByRole("row")).toHaveLength(51);
  expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
    "href",
    expect.stringContaining("offset=50"),
  );
  const group = navigationGroups([def, ...items], "catalog")[0];
  expect(customCatalogRows(group, items, "tool-01 example", "title")).toEqual([
    items[1],
  ]);
});
