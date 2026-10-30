import { MemoryCache } from "./memoryCache";
import PocketBase, {
  BaseAuthStore,
  LocalAuthStore,
  type SendOptions,
  type RecordAuthResponse,
} from "pocketbase";
import type {
  Citation,
  PageDetail,
  PageSummary,
  Publication,
  Source,
} from "./types";

// Private publication content never leaves memory. Session changes and a space
// that disappears (for example after a recovered database) discard every entry,
// including pending reads.
const validatedPublications = new MemoryCache<number | null>(128, 4096);
const publicationCache = new MemoryCache<Publication | null>(128, 256 * 1024);
const pageLists = new MemoryCache<PageSummary[]>(8, 8 * 1024 * 1024);
const pageDetails = new MemoryCache<PageDetail | null>(48, 16 * 1024 * 1024);
export function clearReaderCache(): void {
  validatedPublications.clear();
  publicationCache.clear();
  pageLists.clear();
  pageDetails.clear();
}

// The SDK synchronizes this application's credentials across same-origin tabs.
const sessionKey = "pocketcontext.reader.auth";
function browserAuthStore(): BaseAuthStore {
  try {
    const probe = `${sessionKey}.probe.${Math.random()}`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return new LocalAuthStore(sessionKey);
  } catch {
    return new BaseAuthStore();
  }
}
const authStore = browserAuthStore();
// The SDK handles named keys, but localStorage.clear() emits a null key.
if (typeof window !== "undefined" && authStore instanceof LocalAuthStore) {
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== window.localStorage) return;
    // Even an empty-to-empty logout must fence a sign-in that is still pending.
    if (event.key === null || event.key === sessionKey) cancelLogin();
    if (event.key === null) authStore.clear();
  });
}
// Discard legacy per-tab credentials; never resurrect them after shared logout.
try {
  window.sessionStorage.removeItem(sessionKey);
} catch {
  /* Optional storage. */
}
if (authStore.record?.collectionName !== "users" || !authStore.isValid)
  authStore.clear();
export let sessionGeneration = 0;
function identityKey() {
  return authStore.token
    ? `${authStore.record?.collectionName}:${authStore.record?.id}`
    : "";
}
let activeIdentity = identityKey();
let realtimeCleanup: Promise<void> = Promise.resolve();
authStore.onChange(() => {
  const next = identityKey();
  if (next === activeIdentity) {
    // A sibling tab already renewed this identity; do not renew it again on focus.
    if (next) {
      refreshedAt = Date.now();
      refreshedToken = authStore.token;
    }
    return;
  }
  activeIdentity = next;
  sessionGeneration++;
  clearReaderCache();
  realtimeCleanup = realtimeCleanup
    .then(() => pb.realtime.unsubscribe())
    .catch(() => {});
});
export const pb = new PocketBase(
  typeof window === "undefined" ? "http://localhost" : window.location.origin,
  authStore,
);
// Concurrent page/evidence queries share an endpoint but must not cancel each other.
pb.autoCancellation(false);
// Reject fully parsed responses from a previous identity before callers see them.
const send = pb.send.bind(pb);
pb.send = async <T = unknown>(
  path: string,
  options: SendOptions = {},
): Promise<T> => {
  const generation = sessionGeneration;
  const token = authStore.token;
  const identity = identityKey();
  try {
    const result = await send<T>(path, options);
    if (generation !== sessionGeneration || identity !== identityKey())
      throw new Error("Session changed");
    return result;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (
      generation === sessionGeneration &&
      token &&
      token === authStore.token &&
      (status === 401 || status === 403)
    )
      authStore.clear();
    throw error;
  }
};

interface SQLResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}
export class TruncatedQueryError extends Error {
  constructor() {
    super(
      "This content exceeds the query response limit. Narrow the selection and retry.",
    );
  }
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function identity(value: string): string {
  if (!/^[a-z0-9]{15}$/.test(value)) throw new Error("Invalid record identity");
  return literal(value);
}
function windowSize(offset: number, limit: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new Error("Invalid query page");
}

export async function query<T>(sql: string): Promise<T[]> {
  const initiatingToken = pb.authStore.token;
  const generation = sessionGeneration;
  try {
    const result = await pb.send<SQLResult>("/api/context/query", {
      method: "POST",
      body: { sql },
    });
    if (generation !== sessionGeneration) throw new Error("Session changed");
    if (result.truncated) throw new TruncatedQueryError();
    return result.rows.map(
      (row) =>
        Object.fromEntries(
          result.columns.map((column, index) => [
            column,
            ["properties", "property_evidence"].includes(column) &&
            typeof row[index] === "string"
              ? JSON.parse(row[index] as string)
              : row[index],
          ]),
        ) as T,
    );
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) {
      if (
        (error.status === 401 || error.status === 403) &&
        pb.authStore.token === initiatingToken
      )
        pb.authStore.clear();
      if (error.status === 413) throw new TruncatedQueryError();
    }
    throw error;
  }
}

// Small adaptive pages respect both the row and byte limits, including long summaries/passages.
async function allRows<T>(sql: string, initialSize = 100): Promise<T[]> {
  const result: T[] = [];
  let size = initialSize;
  for (;;) {
    let rows: T[];
    try {
      rows = await query<T>(`${sql} LIMIT ${size} OFFSET ${result.length}`);
    } catch (error) {
      if (error instanceof TruncatedQueryError && size > 1) {
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      throw error;
    }
    result.push(...rows);
    if (rows.length < size) return result;
  }
}

const summary =
  "r.id, r.page, p.slug, p.kind, r.title, r.summary, r.properties";
function published(publicationId: string): string {
  // Expand only the selected immutable manifest, rather than testing every page
  // identity against it. Never download the manifest or select a revision by age.
  return `FROM publications pub JOIN json_each(pub.manifest) m JOIN pages p ON p.id=m.key JOIN page_revisions r ON r.page=p.id AND r.id=m.value WHERE pub.id=${identity(publicationId)} AND m.type='text' AND r.archived=0`;
}

async function validatePublication(
  publicationId: string,
): Promise<number | null> {
  identity(publicationId);
  return validatedPublications.read(
    publicationId,
    () => readPublicationValidation(publicationId),
    (count) => count !== null,
  );
}
async function readPublicationValidation(
  publicationId: string,
): Promise<number | null> {
  // Validate before inner joins can discard broken entries. Publications and
  // their revisions are immutable, so subsequent paged reads share this check.
  const rows = await query<{
    manifest_type: string;
    total: number;
    unique_keys: number;
    invalid: number;
    published_count: number;
  }>(
    `SELECT json_type(pub.manifest) AS manifest_type, count(m.key) AS total,
      count(DISTINCT m.key) AS unique_keys,
      coalesce(sum(CASE WHEN r.archived=0 THEN 1 ELSE 0 END),0) AS published_count,
      coalesce(sum(CASE WHEN m.key IS NULL THEN 0
        WHEN length(m.key)!=15 OR m.key GLOB '*[^a-z0-9]*'
        OR m.type!='text' OR length(m.value)!=15 OR m.value GLOB '*[^a-z0-9]*'
        OR p.id IS NULL OR r.id IS NULL THEN 1 ELSE 0 END),0) AS invalid
     FROM publications pub LEFT JOIN json_each(pub.manifest) m ON 1=1
     LEFT JOIN pages p ON p.id=m.key
     LEFT JOIN page_revisions r ON r.id=m.value AND r.page=p.id
     WHERE pub.id=${identity(publicationId)} GROUP BY pub.id LIMIT 1`,
  );
  if (!rows.length) return null;
  const check = rows[0];
  if (
    check.manifest_type !== "object" ||
    check.invalid !== 0 ||
    check.total !== check.unique_keys ||
    !Number.isSafeInteger(check.published_count) ||
    check.published_count < 0 ||
    check.published_count > check.total
  )
    throw new Error("This publication is incomplete or invalid");
  return check.published_count;
}

export class IncompleteReadError extends Error {
  constructor() {
    super("This publication could not be read completely. Please retry.");
  }
}

export interface Space {
  id: string;
  name: string;
  revision?: number;
  archived?: boolean;
  /** The project's default space, which cannot be archived. */
  is_default?: boolean;
  /** Revision of the settings row that names the default space. */
  settings_revision?: number;
}
/** Every space of the project, with the default first. */
export async function listSpaces(): Promise<Space[]> {
  if (!pb.authStore.record?.id) throw new Error("Please sign in to continue");
  const rows = await query<Space>(
    `SELECT s.id, s.name, s.revision, s.archived, s.id = t.default_space AS is_default, t.revision AS settings_revision FROM spaces s, settings t ORDER BY s.id = t.default_space DESC, s.name, s.id LIMIT 200`,
  );
  return rows
    .filter((row) => /^[a-z0-9]{15}$/.test(row.id))
    .map((row) => ({
      ...row,
      archived: Boolean(row.archived),
      is_default: Boolean(row.is_default),
    }));
}
/** Explicit requests must name an existing space. Call defaultSpace for an implicit selection. */
export function selectSpace(spaces: Space[], requested: string): Space | null {
  return spaces.find((space) => space.id === requested) ?? null;
}
export interface DefaultSpace {
  id: string;
  name: string;
  archived: boolean;
  revision: number;
  settings_revision: number;
}
export async function defaultSpace(): Promise<DefaultSpace> {
  const generation = sessionGeneration;
  const result = await pb.send<DefaultSpace>("/api/spaces/default", {
    method: "GET",
  });
  if (generation !== sessionGeneration || !pb.authStore.isValid)
    throw new Error("Session changed");
  identity(result.id);
  if (typeof result.name !== "string")
    throw new Error("Default space is unavailable");
  return result;
}
export async function createSpace(name: string): Promise<{ id: string }> {
  return pb.collection("spaces").create({ name });
}
export async function updateSpace(
  space: Space,
  changes: { name?: string; archived?: boolean },
): Promise<{ id: string }> {
  return pb
    .collection("spaces")
    .update(space.id, { ...changes, expected_revision: space.revision });
}
/** Make an active space the default. The settings revision guards against a
 * default changed elsewhere since the spaces were listed. */
export async function setDefaultSpace(space: Space): Promise<{ id: string }> {
  if (!Number.isInteger(space.settings_revision))
    throw new Error("Reload the spaces and try again");
  await pb.collection("settings").update("projectsettings", {
    default_space: space.id,
    expected_revision: space.settings_revision,
  });
  return { id: space.id };
}
export async function evidenceSpace(
  collection: "sources" | "passages",
  id: string,
): Promise<string | null> {
  return (
    (
      await query<{ space: string }>(
        `SELECT space FROM ${collection} WHERE id=${identity(id)} LIMIT 1`,
      )
    )[0]?.space ?? null
  );
}
export async function listPublications(
  space: string,
  offset = 0,
  limit = 50,
): Promise<Publication[]> {
  windowSize(offset, limit);
  return query(
    `SELECT id, space, sequence, run, home, created FROM publications WHERE space=${identity(space)} ORDER BY sequence DESC LIMIT ${limit} OFFSET ${offset}`,
  );
}
export async function latestPublication(
  space: string,
): Promise<Publication | null> {
  return (await listPublications(space, 0, 1))[0] ?? null;
}
export async function getPublication(id: string): Promise<Publication | null> {
  identity(id);
  return publicationCache.read(
    id,
    async () =>
      (
        await query<Publication>(
          `SELECT id, space, sequence, run, home, created FROM publications WHERE id=${identity(id)} LIMIT 1`,
        )
      )[0] ?? null,
    (publication) => publication !== null,
  );
}
export async function listPages(publicationId: string): Promise<PageSummary[]> {
  const expected = await validatePublication(publicationId);
  if (expected === null) return [];
  return pageLists.read(
    publicationId,
    async () => {
      const pages = await allRows<PageSummary>(
        `SELECT ${summary}, (SELECT origin.created FROM publications origin WHERE origin.run=r.run AND origin.space=pub.space AND origin.sequence<=pub.sequence ORDER BY origin.sequence LIMIT 1) AS publishedAt ${published(publicationId)} ORDER BY p.slug`,
        200,
      );
      if (pages.length !== expected) throw new IncompleteReadError();
      return pages;
    },
    (pages) => pages.length > 0,
  );
}
export interface SearchPage {
  generation: string;
  hits: (PageSummary & { score: number; excerpt: string })[];
  hasMore: boolean;
}
export class SearchChangedError extends Error {
  constructor() {
    super("Search changed. Restart to see consistent results.");
  }
}
export type SearchFailure = "not-found" | "too-large" | "unavailable";
const searchFailureMessages: Record<SearchFailure, string> = {
  "not-found": "This publication is not available in your spaces.",
  "too-large":
    "This space is too large to search right now. Browse the page list instead.",
  unavailable: "Search is temporarily unavailable. Please retry shortly.",
};
export class SearchUnavailableError extends Error {
  constructor(readonly reason: SearchFailure) {
    super(searchFailureMessages[reason]);
  }
}
export async function searchPages(
  publicationId: string,
  term: string,
  offset = 0,
  limit = 20,
  expectedGeneration?: string,
): Promise<SearchPage> {
  windowSize(offset, limit);
  identity(publicationId);
  if (limit > 100 || offset > 10000 || (offset > 0 && !expectedGeneration))
    throw new Error("Invalid search page");
  if (!term.trim() || term.length > 500 || term.trim().split(/\s+/).length > 16)
    throw new Error(
      "Search must contain 1 to 500 characters and at most 16 words",
    );
  if ((await validatePublication(publicationId)) === null)
    throw new Error("This publication is unavailable");
  const token = pb.authStore.token;
  let result: {
    index: string;
    scope: string;
    generation: string;
    hits: { id: string; score: number; excerpt: string }[];
    hasMore: boolean;
    truncated: boolean;
  };
  try {
    result = await pb.send("/api/context/search", {
      method: "POST",
      body: {
        index: "pages",
        query: term.trim(),
        scope: publicationId,
        limit,
        offset,
        ...(expectedGeneration ? { expectedGeneration } : {}),
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) {
      if (
        (error.status === 401 || error.status === 403) &&
        pb.authStore.token === token
      )
        pb.authStore.clear();
      if (error.status === 409) throw new SearchChangedError();
      if (error.status === 404) throw new SearchUnavailableError("not-found");
      if (error.status === 413) throw new SearchUnavailableError("too-large");
      if (error.status === 503) throw new SearchUnavailableError("unavailable");
    }
    throw error;
  }
  if (
    result.index !== "pages" ||
    result.scope !== publicationId ||
    typeof result.generation !== "string" ||
    !result.generation ||
    result.generation.length > 128 ||
    result.generation.includes("\0") ||
    (expectedGeneration && result.generation !== expectedGeneration)
  )
    throw new SearchChangedError();
  if (
    !Array.isArray(result.hits) ||
    result.hits.length > limit ||
    typeof result.hasMore !== "boolean" ||
    result.truncated !== result.hasMore ||
    (result.hasMore && !result.hits.length) ||
    new Set(result.hits.map((h) => h.id)).size !== result.hits.length
  )
    throw new Error("Invalid search response");
  if (!result.hits.length)
    return { generation: result.generation, hits: [], hasMore: result.hasMore };
  for (let i = 1; i < result.hits.length; i++) {
    const previous = result.hits[i - 1],
      current = result.hits[i];
    if (
      previous.score > current.score ||
      (previous.score === current.score && previous.id >= current.id)
    )
      throw new Error("Invalid search ranking");
  }
  const ids = result.hits.map((h) => {
    if (!Number.isFinite(h.score) || typeof h.excerpt !== "string")
      throw new Error("Invalid search hit");
    return identity(h.id);
  });
  const rows = await allRows<PageSummary>(
    `SELECT ${summary} ${published(publicationId)} AND r.id IN (${ids.join(",")}) ORDER BY r.id`,
    20,
  );
  const byID = new Map(rows.map((row) => [row.id, row]));
  if (byID.size !== result.hits.length || rows.length !== byID.size)
    throw new Error("Search results do not match the selected publication");
  return {
    generation: result.generation,
    hasMore: result.hasMore,
    hits: result.hits.map((hit) => {
      const page = byID.get(hit.id);
      if (!page)
        throw new Error("Search result is unavailable in this publication");
      return { ...page, score: hit.score, excerpt: hit.excerpt };
    }),
  };
}

interface CitationRow {
  id: string;
  marker: string;
  note: string;
  passage_id: string;
  ordinal: number;
  locator: string;
  passage_body: string;
  rendition_kind: string;
  source_id: string;
  source_title: string;
  original_name: string;
  original: string;
  media_type: string;
  source_date: string;
  sha256: string;
}

export async function getPage(
  publicationId: string,
  slug: string,
): Promise<PageDetail | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error("Invalid page slug");
  if ((await validatePublication(publicationId)) === null) return null;
  return pageDetails.read(
    `${publicationId}:${slug}`,
    () => readPage(publicationId, slug),
    (page) => page !== null,
  );
}
async function readPage(
  publicationId: string,
  slug: string,
): Promise<PageDetail | null> {
  const page = (
    await query<
      PageSummary & {
        body: string;
        citation_count: number;
        backlink_count: number;
        link_count: number;
      }
    >(
      // The selected revision and all expected relationship counts come from
      // one authorized SQL snapshot. Separate paged reads must match it before
      // a complete detail can enter the immutable cache.
      `SELECT selected.*,
        (SELECT count(*) FROM citations c WHERE c.page_revision=selected.id) AS citation_count,
        (SELECT count(*) ${published(publicationId)} AND r.id IN (SELECT l.page_revision FROM page_links l WHERE l.target=selected.page)) AS backlink_count,
        (SELECT count(*) ${published(publicationId)} AND p.id IN (SELECT l.target FROM page_links l WHERE l.page_revision=selected.id)) AS link_count
       FROM (SELECT ${summary}, r.body, r.property_evidence ${published(publicationId)} AND p.slug=${literal(slug)} LIMIT 1) selected`,
    )
  )[0];
  if (!page) return null;
  const [rows, backlinks, links] = await Promise.all([
    allRows<CitationRow>(
      `SELECT c.id, c.marker, c.note, t.id AS passage_id, t.ordinal, t.locator, t.body AS passage_body, e.kind AS rendition_kind, s.id AS source_id, s.title AS source_title, s.original_name, s.original, s.media_type, s.source_date, s.sha256 FROM citations c JOIN passages t ON t.id=c.passage JOIN renditions e ON e.id=t.rendition JOIN sources s ON s.id=e.source WHERE c.page_revision=${identity(page.id)} ORDER BY c.id`,
      // Transcript pages can cite hundreds of short passages. Use the normal
      // batch size; allRows shrinks it if long passages exceed the byte budget.
      100,
    ),
    allRows<PageSummary>(
      `SELECT ${summary} ${published(publicationId)} AND r.id IN (SELECT l.page_revision FROM page_links l WHERE l.target=${identity(page.page)}) ORDER BY p.slug`,
    ),
    allRows<PageSummary>(
      `SELECT ${summary} ${published(publicationId)} AND p.id IN (SELECT l.target FROM page_links l WHERE l.page_revision=${identity(page.id)}) ORDER BY p.slug`,
    ),
  ]);
  const { citation_count, backlink_count, link_count, ...detail } = page;
  const counts = [citation_count, backlink_count, link_count];
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    citation_count !== rows.length ||
    backlink_count !== backlinks.length ||
    link_count !== links.length
  )
    throw new IncompleteReadError();
  const citations: Citation[] = rows
    .map((row) => ({
      id: row.id,
      marker: row.marker,
      note: row.note,
      passage: {
        id: row.passage_id,
        ordinal: row.ordinal,
        locator: row.locator,
        body: row.passage_body,
        kind: row.rendition_kind,
      },
      source: {
        id: row.source_id,
        title: row.source_title,
        original_name: row.original_name,
        original: row.original,
        media_type: row.media_type,
        source_date: row.source_date,
        sha256: row.sha256,
      },
    }))
    .sort((a, b) => Number(a.marker) - Number(b.marker));
  return { ...detail, citations, backlinks, links };
}

let pendingSignIn: { cancel: (message?: string) => void } | null = null;
/** The sign-in name of the project's one account; the password is the secret. */
export const localIdentity = "me@pocketcontext.localhost";
async function signIn(email: string, password: string): Promise<void> {
  pendingSignIn?.cancel();
  const generation = sessionGeneration,
    token = authStore.token;
  const client = new PocketBase(pb.baseURL, new BaseAuthStore());
  let ended = false;
  let rejectAttempt: (error: Error) => void = () => {};
  const attempt = {
    cancel(message = "Sign-in cancelled. You can try again.") {
      if (ended) return;
      ended = true;
      // This isolated client owns only this attempt.
      client.cancelAllRequests();
      rejectAttempt(Object.assign(new Error(message), { isAbort: true }));
    },
  };
  pendingSignIn = attempt;
  try {
    const result = await new Promise<RecordAuthResponse>((resolve, reject) => {
      rejectAttempt = reject;
      client
        .collection("users")
        .authWithPassword(email, password)
        .then(resolve, reject);
    });
    if (
      ended ||
      pendingSignIn !== attempt ||
      generation !== sessionGeneration ||
      token !== authStore.token
    )
      throw new Error("Session changed");
    if (result.record.collectionName !== "users")
      throw new Error("Unexpected sign-in response");
    authStore.save(result.token, result.record);
  } finally {
    ended = true;
    if (pendingSignIn === attempt) pendingSignIn = null;
  }
}
/** Cancel a pending sign-in and fence late responses. */
export function cancelLogin(): void {
  pendingSignIn?.cancel();
}
export async function loginPassword(password: string): Promise<void> {
  await signIn(localIdentity, password);
}
let refreshedAt = 0;
let refreshedToken = "";
export async function refreshSession(): Promise<void> {
  const initiatingToken = pb.authStore.token;
  if (!initiatingToken) throw new Error("Please sign in to continue");
  const generation = sessionGeneration;
  if (initiatingToken === refreshedToken && Date.now() - refreshedAt < 300000)
    return;
  try {
    // Save explicitly: the SDK authRefresh helper saves even after a user signs out.
    const result = await pb.send<RecordAuthResponse>(
      "/api/collections/users/auth-refresh",
      {
        method: "POST",
        headers: { Authorization: initiatingToken },
      },
    );
    if (
      pb.authStore.token !== initiatingToken ||
      generation !== sessionGeneration
    )
      return;
    if (result.record.collectionName !== "users")
      throw new Error("Unexpected sign-in response");
    refreshedAt = Date.now();
    refreshedToken = result.token;
    pb.authStore.save(result.token, result.record);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error.status === 401 || error.status === 403) &&
      pb.authStore.token === initiatingToken
    )
      pb.authStore.clear();
    throw error;
  }
}
export function logout(): void {
  cancelLogin();
  pb.authStore.clear();
}
export async function originalURL(source: Source): Promise<string> {
  identity(source.id);
  const token = await pb.files.getToken();
  return pb.files.getURL(
    { id: source.id, collectionName: "sources" },
    source.original,
    { token, download: true },
  );
}
/** Size of the protected original from a one-byte ranged read; null when unknown. */
export async function originalSize(
  source: Source,
  signal?: AbortSignal,
): Promise<number | null> {
  const token = pb.authStore.token;
  const url = await originalURL(source);
  if (new URL(url).origin !== new URL(pb.baseURL).origin)
    throw new Error("Invalid original location");
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: { Range: "bytes=0-0" },
  });
  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    if (
      (response.status === 401 || response.status === 403) &&
      token === pb.authStore.token
    )
      pb.authStore.clear();
    throw new Error("This original is unavailable or access was denied.");
  }
  const range = /^bytes \d+-\d+\/(\d+)$/.exec(
    response.headers.get("content-range") || "",
  );
  const size = Number(
    range
      ? range[1]
      : response.status === 200
        ? (response.headers.get("content-length") ?? "")
        : "",
  );
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}
export const SOURCE_PREVIEW_BYTES = 2 * 1024 * 1024;
export class SourcePreviewLimitError extends Error {
  constructor(limit = SOURCE_PREVIEW_BYTES) {
    super(
      `This original is larger than the ${limit / (1024 * 1024)} MiB reading limit. Download it or read its passages.`,
    );
  }
}
/** Read the independently authorized original, never an approximation assembled from passages. */
async function sourceBytes(
  source: Source,
  signal?: AbortSignal,
  limit = SOURCE_PREVIEW_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  identity(source.id);
  const generation = sessionGeneration;
  const token = pb.authStore.token;
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const current = () => {
    combined.throwIfAborted();
    if (
      generation !== sessionGeneration ||
      token !== pb.authStore.token ||
      !pb.authStore.isValid
    )
      throw new Error("Session changed");
  };
  const unsubscribe = pb.authStore.onChange(() => {
    if (
      generation !== sessionGeneration ||
      token !== pb.authStore.token ||
      !pb.authStore.isValid
    )
      controller.abort();
  });
  try {
    current();
    const url = await originalURL(source);
    current();
    if (new URL(url).origin !== new URL(pb.baseURL).origin)
      throw new Error("Invalid original location");
    const response = await fetch(url, {
      signal: combined,
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    current();
    if (!response.ok) {
      if (
        (response.status === 401 || response.status === 403) &&
        token === pb.authStore.token
      )
        pb.authStore.clear();
      throw new Error("This original is unavailable or access was denied.");
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new SourcePreviewLimitError(limit);
    }
    if (!response.body)
      throw new Error("This original has no readable content.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0,
      complete = false;
    try {
      for (;;) {
        const chunk = await reader.read();
        current();
        if (chunk.done) {
          complete = true;
          break;
        }
        size += chunk.value.byteLength;
        if (size > limit) throw new SourcePreviewLimitError(limit);
        chunks.push(chunk.value);
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (!crypto.subtle || !/^[a-f0-9]{64}$/.test(source.sha256))
      throw new Error("The original cannot be verified. Download it instead.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    current();
    const hash = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== source.sha256)
      throw new Error("The original does not match its recorded checksum.");
    return bytes;
  } finally {
    unsubscribe();
  }
}

export async function sourceText(source: Source, signal?: AbortSignal): Promise<string> {
  const bytes = await sourceBytes(source, signal);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This original is not valid UTF-8 text. Download it instead.");
  }
}

/** Only locally stored, checksum-verified raster images can be embedded. */
export async function sourceImage(source: Source, signal?: AbortSignal): Promise<Blob> {
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(source.media_type))
    throw new Error("This file cannot be displayed as an inline image.");
  return new Blob([await sourceBytes(source, signal, 50 * 1024 * 1024)], { type: source.media_type });
}

export async function imageSource(id: string, space: string): Promise<Source> {
  const rows = await query<Source>(`SELECT id,title,original_name,original,media_type,source_date,sha256 FROM sources WHERE id=${identity(id)} AND space=${identity(space)} LIMIT 1`);
  if (!rows[0]) throw new Error("This image is unavailable in this space.");
  return rows[0];
}

export async function sourceCount(space: string): Promise<number> {
  const rows = await query<{ count: number }>(
    `SELECT count(*) AS count FROM sources WHERE space=${identity(space)}`,
  );
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(rows[0].count) ||
    rows[0].count < 0
  )
    throw new Error("Source count is unavailable");
  return rows[0].count;
}

export async function watchSources(callback: () => void): Promise<() => void> {
  const generation = sessionGeneration;
  await realtimeCleanup;
  if (generation !== sessionGeneration || !pb.authStore.isValid)
    return () => {};
  const notify = () => {
    if (generation === sessionGeneration && pb.authStore.isValid) callback();
  };
  let subscribed = false;
  const disconnected = await pb.realtime.subscribe("PB_CONNECT", () => {
    if (subscribed) notify();
  });
  try {
    const stopped = await pb.collection("sources").subscribe("*", notify);
    subscribed = true;
    notify();
    return () => {
      void stopped().catch(() => {});
      void disconnected().catch(() => {});
    };
  } catch (error) {
    void disconnected().catch(() => {});
    throw error;
  }
}

export async function watchPublications(
  callback: () => void,
): Promise<() => void> {
  const generation = sessionGeneration;
  await realtimeCleanup;
  if (generation !== sessionGeneration || !pb.authStore.isValid)
    return () => {};
  const notify = () => {
    if (generation === sessionGeneration) callback();
  };
  let subscribed = false;
  const unsubscribeConnected = await pb.realtime.subscribe(
    "PB_CONNECT",
    // Initial connection is reconciled after subscription below; avoid a third
    // full page read before the collection subscription is active.
    () => {
      if (subscribed) notify();
    },
  );
  try {
    const unsubscribePublications = await pb
      .collection("publications")
      .subscribe("*", notify);
    subscribed = true;
    // Reconcile publications committed after the initial read but before this
    // subscription became active; no realtime event is guaranteed for that gap.
    notify();
    return () => {
      void unsubscribePublications().catch(() => {});
      void unsubscribeConnected().catch(() => {});
    };
  } catch (error) {
    void unsubscribeConnected().catch(() => {});
    throw error;
  }
}

export const api = {
  clearReaderCache,
  listSpaces,
  defaultSpace,
  createSpace,
  updateSpace,
  setDefaultSpace,
  evidenceSpace,
  cancelLogin,
  loginPassword,
  refreshSession,
  logout,
  listPublications,
  latestPublication,
  getPublication,
  listPages,
  getPage,
  searchPages,
  originalURL,
  originalSize,
  sourceText,
  sourceCount,
  watchSources,
  watchPublications,
};
