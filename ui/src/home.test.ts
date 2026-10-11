import { expect, test } from "vitest";
import { homePageSlug } from "./home";
import type { PageSummary, Publication } from "./types";

const pages: PageSummary[] = [
  { id: "revision-a", page: "page-a", slug: "alpha", kind: "concept", title: "Zulu", summary: "" },
  { id: "revision-b", page: "page-b", slug: "beta", kind: "concept", title: "Alpha", summary: "" },
];
const publication: Publication = { id: "publication", space: "companyspace001", sequence: 1, run: "run", home: "page-b", created: "" };

test("home uses the stable page identity and selected publication", () => {
  expect(homePageSlug(publication, pages)).toBe("beta");
  expect(homePageSlug({ ...publication, home: "page-a" }, pages)).toBe("alpha");
});

test("unset or unavailable home does not select an arbitrary page", () => {
  expect(homePageSlug({ ...publication, home: "" }, pages)).toBeUndefined();
  expect(homePageSlug({ ...publication, home: "missing" }, pages)).toBeUndefined();
  expect(homePageSlug(publication, [])).toBeUndefined();
});
