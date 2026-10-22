import { catalogTypes } from "./Catalog";
import type { PageSummary } from "./types";
/** Only populated built-ins appear; custom definitions are handled independently. */
export function availableCatalogTypes(pages: PageSummary[]) {
  return catalogTypes.filter((type) =>
    pages.some((page) =>
      type === "prompt"
        ? page.properties?.catalog_type === "repository_document" &&
          page.properties.document_type === "prompt"
        : page.properties?.catalog_type === type,
    ),
  );
}
