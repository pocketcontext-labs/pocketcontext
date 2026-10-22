import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Catalog, {
  catalogHref,
  filterCatalog,
  type CatalogState,
} from "./Catalog";
import PropertiesPanel, { propertyText } from "./Properties";
import { classifyWelcomePage } from "./welcome";
import type { PageDetail, PageSummary } from "./types";
afterEach(cleanup);
const deployment: PageSummary = {
  id: "dep-revision",
  page: "dep-id",
  title: "North cluster",
  slug: "north",
  kind: "entity",
  summary: "",
  properties: { catalog_type: "deployment" },
};
const resource: PageDetail = {
  id: "resource-rev",
  page: "resource-id",
  title: "Evidence bucket",
  slug: "bucket",
  kind: "entity",
  summary: "",
  body: "",
  citations: [],
  backlinks: [],
  links: [],
  properties: {
    catalog_type: "resource",
    provider: "Example",
    provider_id: "not-a-secret",
    accountable_owner: null,
    deployment_profiles: [deployment.page],
    provider_observed_at: "2026-10-08",
    lifecycle_status: "active",
    expires_at: null,
    expiry_observation: "Not returned",
  },
  property_evidence: { provider_observed_at: ["2"] },
};
const state: CatalogState = {
  type: "resource",
  query: "",
  provider: "",
  deployment: "",
  lifecycle: "",
  missingOwner: false,
  sort: "title",
  offset: 0,
};
describe("published property catalogs", () => {
  it("filters properties and relationship names without interpreting bodies or conflating unknown values", () => {
    const pages = [resource, deployment];
    expect(
      filterCatalog(pages, {
        ...state,
        query: "North cluster",
        provider: "Example",
        deployment: deployment.page,
        lifecycle: "active",
        missingOwner: true,
      }),
    ).toEqual([resource]);
    expect(filterCatalog(pages, { ...state, provider: "Other" })).toEqual([]);
    expect(filterCatalog(pages, { ...state, query: "not-a-secret" })).toEqual([
      resource,
    ]);
    expect(propertyText(null)).toBe("Needs verification");
    expect(propertyText(false)).toBe("No");
    expect(propertyText(0)).toBe("0");
    expect(propertyText("Not returned")).toBe("Not returned");
  });
  it("sorts relationships by publication-selected titles, not identifiers", () => {
    const first = { ...deployment, page: "z", title: "Alpha" };
    const last = { ...deployment, page: "a", title: "Zulu" };
    const a = {
      ...resource,
      page: "one",
      properties: { ...resource.properties, deployment_profiles: ["a"] },
    };
    const z = {
      ...resource,
      page: "two",
      properties: { ...resource.properties, deployment_profiles: ["z"] },
    };
    expect(
      filterCatalog([a, z, first, last], {
        ...state,
        sort: "deployment_profiles",
      }),
    ).toEqual([z, a]);
  });
  it("keeps complete catalog filters and publication in shareable pagination links", () => {
    const href = catalogHref(
      {
        ...state,
        query: "R&D",
        provider: "Example",
        deployment: "dep-id",
        lifecycle: "active",
        missingOwner: true,
        sort: "-title",
        offset: 50,
      },
      "publication-id",
    );
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("q")).toBe("R&D");
    expect(params.get("publication")).toBe("publication-id");
    expect(params.get("missingOwner")).toBe("true");
    expect(params.get("offset")).toBe("50");
    expect(params.get("deployment")).toBe("dep-id");
  });
  it("opens property-only evidence and links relationships within the selected publication", () => {
    const citation = vi.fn();
    render(
      <PropertiesPanel
        page={resource}
        pages={[resource, deployment]}
        publication="old-publication"
        onCitation={citation}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Evidence for Provider observed at: citation 2",
      }),
    );
    expect(citation).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByText(/All properties/));
    expect(screen.getByRole("link", { name: "North cluster" })).toHaveAttribute(
      "href",
      "#/page/north?publication=old-publication",
    );
    expect(screen.getByText("Not returned")).toBeInTheDocument();
  });
  it("does not add a panel to legacy pages and classifies catalog pages by metadata", () => {
    const { container } = render(
      <PropertiesPanel
        page={{ ...resource, properties: {} }}
        pages={[]}
        onCitation={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(
      classifyWelcomePage({
        ...resource,
        title: "A mysterious item",
        slug: "item",
      }),
    ).toBe("__unassigned");
  });
  it("paginates matching records and preserves publication in page links", () => {
    const pages = Array.from({ length: 51 }, (_, i) => ({
      ...resource,
      id: `rev-${i}`,
      page: `id-${i}`,
      slug: `bucket-${i}`,
      title: `Bucket ${String(i).padStart(2, "0")}`,
    }));
    render(<Catalog pages={pages} state={state} publication="history" />);
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "#/catalog/resource?publication=history&offset=50",
    );
    expect(screen.getByRole("row", { name: /Bucket 00/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("row", { name: /Bucket 50/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Bucket 00" })[0],
    ).toHaveAttribute("href", "#/page/bucket-0?publication=history");
  });
});

const ada: PageSummary = {
  ...deployment,
  id: "ada-rev",
  page: "ada",
  slug: "ada",
  title: "Ada",
  properties: {
    catalog_type: "person",
    role: "Engineer",
    organization: "Example",
    crm_url: "https://crm.example/ada",
  },
};
const ben: PageSummary = {
  ...ada,
  id: "ben-rev",
  page: "ben",
  slug: "ben",
  title: "Ben",
};
const core: PageSummary = {
  ...deployment,
  page: "core",
  slug: "core",
  title: "Core",
  properties: {
    catalog_type: "group",
    purpose: "Operations",
    members: [ada.page, ben.page],
  },
};
const owned: PageSummary = {
  ...deployment,
  properties: {
    catalog_type: "deployment",
    accountable_owners: [core.page],
    backup_owners: [core.page],
  },
};
const directory = [ada, ben, core, owned];

describe("people and groups", () => {
  it("does not infer topic membership from built-in catalog types", () => {
    expect(classifyWelcomePage(ada)).toBe("__unassigned");
    expect(classifyWelcomePage(core)).toBe("__unassigned");
  });
  it("derives membership from only the supplied publication and searches group names", () => {
    expect(
      filterCatalog(directory, {
        ...state,
        type: "person",
        group: core.page,
        query: "core",
      }),
    ).toEqual([ada, ben]);
    const later = directory.map((page) =>
      page.page === core.page
        ? { ...core, properties: { ...core.properties, members: [ada.page] } }
        : page,
    );
    expect(
      filterCatalog(later, { ...state, type: "person", group: core.page }),
    ).toEqual([ada]);
    expect(
      filterCatalog(directory, { ...state, type: "group", member: ben.page }),
    ).toEqual([core]);
    expect(
      filterCatalog(later, { ...state, type: "group", member: ben.page }),
    ).toEqual([]);
    expect(
      catalogHref({ type: "person", group: "core", offset: 50 }, "old"),
    ).toBe("#/catalog/person?publication=old&group=core&offset=50");
  });
  it("recognizes group ownership while retaining legacy ownership", () => {
    expect(
      filterCatalog(directory, {
        ...state,
        type: "deployment",
        missingOwner: true,
      }),
    ).toEqual([]);
    expect(
      filterCatalog(
        [
          {
            ...owned,
            properties: {
              catalog_type: "deployment",
              accountable_owner: "Legacy owner",
            },
          },
        ],
        { ...state, type: "deployment", missingOwner: true },
      ),
    ).toEqual([]);
  });
  it("shows distinct group-owned counts and pinned membership links", () => {
    render(
      <Catalog
        pages={directory}
        state={{ ...state, type: "group" }}
        publication="old"
      />,
    );
    const row = screen.getByRole("row", {
      name: /Core Operations Ada Ben 0 1/,
    });
    expect(row).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Ada" })[0]).toHaveAttribute(
      "href",
      "#/page/ada?publication=old",
    );
    expect(screen.getByLabelText("Member")).toBeInTheDocument();
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
  });
  it("shows inherited responsibilities and safe CRM links without granting permissions", () => {
    render(
      <PropertiesPanel
        page={{ ...ada, body: "", citations: [], links: [], backlinks: [] }}
        pages={directory}
        publication="old"
        onCitation={() => {}}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Responsibilities through groups" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "North cluster" })).toHaveLength(
      2,
    );
    expect(screen.getByRole("link", { name: "Core" })).toHaveAttribute(
      "href",
      "#/page/core?publication=old",
    );
    expect(screen.getByRole("link", { name: "CRM record" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });
});
describe("organizations, products and models", () => {
  const labs: PageSummary = {
    ...deployment,
    id: "labs-rev",
    page: "labs",
    slug: "example-labs",
    title: "Example Labs",
    properties: {
      catalog_type: "organization",
      organization_type: "lab",
      website: "https://labs.example",
    },
  };
  const cli: PageSummary = {
    ...deployment,
    id: "cli-rev",
    page: "cli",
    slug: "example-cli",
    title: "Example CLI",
    properties: {
      catalog_type: "product",
      product_type: "cli",
      provider: "Example Labs",
    },
  };
  const model: PageSummary = {
    ...deployment,
    id: "model-rev",
    page: "model",
    slug: "example-model-2",
    title: "Example Model 2",
    properties: {
      catalog_type: "model",
      provider: "Example Labs",
      family: "Example Model",
    },
  };
  const named = [labs, cli, model, deployment];
  it("lists each type in its own catalog with its own columns and filters", () => {
    expect(
      filterCatalog(named, { ...state, type: "product" }).map((p) => p.page),
    ).toEqual(["cli"]);
    expect(
      filterCatalog(named, {
        ...state,
        type: "model",
        provider: "Example Labs",
      }),
    ).toEqual([model]);
    render(
      <Catalog pages={named} state={{ ...state, type: "organization" }} />,
    );
    expect(
      screen.getByRole("heading", { name: "Organizations" }),
    ).toBeInTheDocument();
    for (const label of ["Organizations", "Products", "Models"])
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Example Labs" }),
    ).not.toHaveLength(0);
    expect(screen.getAllByText("lab")).toHaveLength(2);
    expect(screen.queryByText(/Needs verification ·/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Deployment")).not.toBeInTheDocument();
    cleanup();
    render(<Catalog pages={named} state={{ ...state, type: "model" }} />);
    expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByLabelText("Provider")).toBeInTheDocument();
    expect(screen.queryByLabelText("Lifecycle")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing owner")).not.toBeInTheDocument();
  });
});
