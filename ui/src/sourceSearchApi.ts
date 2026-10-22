import { pb, query, SearchChangedError, sessionGeneration } from "./api";

export interface SourceSearchHit {
  id: string;
  title: string;
  original_name: string;
  source_date: string;
  score: number;
  excerpt: string;
  passage?: string;
  locator?: string;
}
export interface SourceSearchPage {
  generation: string;
  hits: SourceSearchHit[];
  hasMore: boolean;
}
export class SourceSearchUnavailableError extends Error {
  constructor(readonly reason: "not-found" | "too-large" | "unavailable") {
    super(
      {
        "not-found":
          "This space is unavailable. Choose another space to search.",
        "too-large":
          "This space is too large to search right now. Browse Sources instead.",
        unavailable: "Source search is temporarily unavailable. Please retry.",
      }[reason],
    );
  }
}
const validID = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9]{15}$/.test(value);
function identity(value: string) {
  if (!validID(value)) throw new Error("Invalid source search identity");
  return `'${value}'`;
}
export function sourceSearchHref(space: string, term: string): string {
  identity(space);
  return `#/sources/?${new URLSearchParams({ space, q: term })}`;
}
export function sourceSearchHitHref(
  space: string,
  hit: Pick<SourceSearchHit, "id" | "passage">,
): string {
  identity(space);
  identity(hit.id);
  if (hit.passage) identity(hit.passage);
  return `#/sources/${hit.id}?${new URLSearchParams({ space, ...(hit.passage ? { passage: hit.passage } : {}) })}`;
}
export async function searchSources(
  space: string,
  term: string,
  offset = 0,
  limit = 20,
  expectedGeneration?: string,
): Promise<SourceSearchPage> {
  const scope = identity(space);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 10000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (offset > 0 && !expectedGeneration)
  )
    throw new Error("Invalid source search page");
  if (
    !term.trim() ||
    term.length > 500 ||
    term.includes("\0") ||
    term.trim().split(/\s+/).length > 16
  )
    throw new Error(
      "Search must contain 1 to 500 characters and at most 16 words",
    );
  const session = sessionGeneration;
  const token = pb.authStore.token;
  const active = () => {
    if (session !== sessionGeneration || !pb.authStore.isValid)
      throw new Error("Session changed");
  };
  active();
  let result: {
    index: string;
    scope: string;
    generation: string;
    hits: Array<{
      id: string;
      score: number;
      excerpt: string;
      passage?: string;
    }>;
    hasMore: boolean;
    truncated: boolean;
  };
  try {
    result = await pb.send("/api/context/search", {
      method: "POST",
      body: {
        index: "sources",
        query: term.trim(),
        scope: space,
        offset,
        limit,
        ...(expectedGeneration ? { expectedGeneration } : {}),
      },
    });
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if ((status === 401 || status === 403) && token === pb.authStore.token)
      pb.authStore.clear();
    if (status === 409) throw new SearchChangedError();
    if (status === 404) throw new SourceSearchUnavailableError("not-found");
    if (status === 413) throw new SourceSearchUnavailableError("too-large");
    if (status === 503) throw new SourceSearchUnavailableError("unavailable");
    throw error;
  }
  active();
  if (
    result.index !== "sources" ||
    result.scope !== space ||
    typeof result.generation !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.generation) ||
    (expectedGeneration && result.generation !== expectedGeneration)
  )
    throw new SearchChangedError();
  if (
    !Array.isArray(result.hits) ||
    result.hits.length > limit ||
    typeof result.hasMore !== "boolean" ||
    result.hasMore !== result.truncated ||
    (result.hasMore && !result.hits.length)
  )
    throw new Error("Invalid source search response");
  const seen = new Set<string>();
  result.hits.forEach((hit, n) => {
    if (
      !validID(hit.id) ||
      seen.has(hit.id) ||
      !Number.isFinite(hit.score) ||
      typeof hit.excerpt !== "string" ||
      (hit.passage !== undefined && !validID(hit.passage))
    )
      throw new Error("Invalid source search hit");
    seen.add(hit.id);
    const previous = result.hits[n - 1];
    if (
      previous &&
      (previous.score > hit.score ||
        (previous.score === hit.score && previous.id >= hit.id))
    )
      throw new Error("Invalid source search ranking");
  });
  if (!result.hits.length)
    return { generation: result.generation, hits: [], hasMore: result.hasMore };
  // Hydrate only fixed metadata and independently verify each passage relationship.
  // IDs are validated before interpolation; search content never becomes SQL.
  const sourceIDs = result.hits.map((hit) => identity(hit.id)).join(",");
  const sources = await query<{
    id: string;
    title: string;
    original_name: string;
    source_date: string;
  }>(
    `SELECT id,title,original_name,source_date FROM sources WHERE space=${scope} AND id IN (${sourceIDs}) ORDER BY id LIMIT 100`,
  );
  active();
  const bySource = new Map(sources.map((row) => [row.id, row]));
  if (sources.length !== result.hits.length || bySource.size !== sources.length)
    throw new SourceSearchUnavailableError("not-found");
  const passageIDs = result.hits.flatMap((hit) =>
    hit.passage ? [identity(hit.passage)] : [],
  );
  const passages = passageIDs.length
    ? await query<{ id: string; source: string; locator: string }>(
        `SELECT p.id,r.source,p.locator FROM passages p JOIN renditions r ON r.id=p.rendition JOIN sources s ON s.id=r.source WHERE s.space=${scope} AND r.space=s.space AND p.space=s.space AND s.id IN (${sourceIDs}) AND p.id IN (${passageIDs.join(",")}) ORDER BY p.id LIMIT 100`,
      )
    : [];
  active();
  const byPassage = new Map(passages.map((row) => [row.id, row]));
  return {
    generation: result.generation,
    hasMore: result.hasMore,
    hits: result.hits.map((hit) => {
      const source = bySource.get(hit.id)!;
      const passage = hit.passage ? byPassage.get(hit.passage) : undefined;
      if (
        (hit.passage && passage?.source !== hit.id) ||
        typeof source.title !== "string" ||
        typeof source.original_name !== "string" ||
        typeof source.source_date !== "string"
      )
        throw new SourceSearchUnavailableError("not-found");
      return {
        ...source,
        ...hit,
        ...(passage ? { locator: passage.locator } : {}),
      };
    }),
  };
}
