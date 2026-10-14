import { MemoryCache } from "./memoryCache";
import PocketBase, { BaseAuthStore, LocalAuthStore, type SendOptions, type RecordAuthResponse } from "pocketbase";
import type {
  Citation,
  PageDetail,
  PageSummary,
  Publication,
  Source,
} from "./types";

// Private publication content never leaves memory. Session changes and confirmed
// membership loss discard every entry, including pending reads.
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
const sessionKey = "wikicontext.reader.auth";
function browserAuthStore(): BaseAuthStore {
  try {
    const probe = `${sessionKey}.probe.${Math.random()}`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return new LocalAuthStore(sessionKey);
  } catch { return new BaseAuthStore(); }
}
const authStore = browserAuthStore();
// The SDK handles named keys, but localStorage.clear() emits a null key.
if (typeof window !== "undefined" && authStore instanceof LocalAuthStore) {
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== window.localStorage) return;
    // Even an empty-to-empty logout must fence a popup that is still signing in.
    if (event.key === null || event.key === sessionKey) cancelGoogleLogin();
    if (event.key === null) authStore.clear();
  });
}
// Discard legacy per-tab credentials; never resurrect them after shared logout.
try { window.sessionStorage.removeItem(sessionKey); } catch { /* Optional storage. */ }
if (authStore.record?.collectionName !== "users" || !authStore.isValid) authStore.clear();
export let sessionGeneration = 0;
function identityKey() {
  return authStore.token ? `${authStore.record?.collectionName}:${authStore.record?.id}` : "";
}
let activeIdentity = identityKey();
let realtimeCleanup: Promise<void> = Promise.resolve();
authStore.onChange(() => {
  const next = identityKey();
  if (next === activeIdentity) {
    // A sibling tab already renewed this identity; do not renew it again on focus.
    if (next) { refreshedAt = Date.now(); refreshedToken = authStore.token; }
    return;
  }
  activeIdentity = next;
  sessionGeneration++;
  clearReaderCache();
  realtimeCleanup = realtimeCleanup.then(() => pb.realtime.unsubscribe()).catch(() => {});
});
export const pb = new PocketBase(
  typeof window === "undefined" ? "http://localhost" : window.location.origin,
  authStore,
);
// Concurrent page/evidence queries share an endpoint but must not cancel each other.
pb.autoCancellation(false);
// Reject fully parsed responses from a previous identity before callers see them.
const send = pb.send.bind(pb);
pb.send = async <T = unknown>(path: string, options: SendOptions = {}): Promise<T> => {
  const generation = sessionGeneration;
  const token = authStore.token;
  const identity = identityKey();
  try {
    const result = await send<T>(path, options);
    if (generation !== sessionGeneration || identity !== identityKey()) throw new Error("Session changed");
    return result;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (generation === sessionGeneration && token && token === authStore.token && (status === 401 || status === 403))
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
          result.columns.map((column, index) => [column,
            ["properties", "property_evidence"].includes(column) && typeof row[index] === "string"
              ? JSON.parse(row[index] as string) : row[index]]),
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

const summary = "r.id, r.page, p.slug, p.kind, r.title, r.summary, r.properties";
function published(publicationId: string): string {
  // Expand only the selected immutable manifest, rather than testing every page
  // identity against it. Never download the manifest or select a revision by age.
  return `FROM publications pub JOIN json_each(pub.manifest) m JOIN pages p ON p.id=m.key JOIN page_revisions r ON r.page=p.id AND r.id=m.value WHERE pub.id=${identity(publicationId)} AND m.type='text' AND r.archived=0`;
}

async function validatePublication(publicationId: string): Promise<number | null> {
  identity(publicationId);
  return validatedPublications.read(publicationId, () => readPublicationValidation(publicationId), count => count !== null);
}
async function readPublicationValidation(publicationId: string): Promise<number | null> {
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
    !Number.isSafeInteger(check.published_count) || check.published_count < 0 || check.published_count > check.total
  )
    throw new Error("This publication is incomplete or invalid");
  return check.published_count;
}

export class IncompleteReadError extends Error {
  constructor() { super("This publication could not be read completely. Please retry."); }
}

export interface Space {
  id: string;
  kind: "personal" | "group";
  name: string;
  role: "owner" | "editor" | "reader";
}
export const companySpace = "companyspace001";
/** Active memberships of the signed-in account. */
export async function listSpaces(): Promise<Space[]> {
  const account = pb.authStore.record?.id;
  if (!account) throw new Error("Please sign in to continue");
  const rows = await query<Space>(
    `SELECT s.id, s.kind, s.name, m.role FROM spaces s JOIN space_members m ON m.space=s.id WHERE m.account=${identity(account)} AND m.active=1 ORDER BY CASE s.id WHEN 'companyspace001' THEN 0 ELSE 1 END, s.name, s.id LIMIT 200`,
  );
  return rows.filter((row) => /^[a-z0-9]{15}$/.test(row.id) && (row.kind === "personal" || row.kind === "group"));
}
/** Explicit requests must be memberships; legacy links default to the company. */
export function selectSpace(spaces: Space[], requested?: string): Space | null {
  return spaces.find((space) => space.id === (requested ?? companySpace)) ?? null;
}
export async function createPersonalSpace(): Promise<{ id: string }> {
  return pb.send("/api/wiki/spaces/personal", { method: "POST" });
}
export async function evidenceSpace(collection: "sources" | "passages", id: string): Promise<string | null> {
  return (await query<{ space: string }>(`SELECT space FROM ${collection} WHERE id=${identity(id)} LIMIT 1`))[0]?.space ?? null;
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
export async function latestPublication(space = companySpace): Promise<Publication | null> {
  return (await listPublications(space, 0, 1))[0] ?? null;
}
export async function getPublication(id: string): Promise<Publication | null> {
  identity(id);
  return publicationCache.read(id, async () => (
    (
      await query<Publication>(
        `SELECT id, space, sequence, run, home, created FROM publications WHERE id=${identity(id)} LIMIT 1`,
      )
    )[0] ?? null
  ), publication => publication !== null);
}
export async function listPages(publicationId: string): Promise<PageSummary[]> {
  const expected = await validatePublication(publicationId);
  if (expected === null) return [];
  return pageLists.read(publicationId, async () => {
    const pages = await allRows<PageSummary>(`SELECT ${summary} ${published(publicationId)} ORDER BY p.slug`, 200);
    if (pages.length !== expected) throw new IncompleteReadError();
    return pages;
  }, pages => pages.length > 0);
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
  "too-large": "This space is too large to search right now. Browse the page list instead.",
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
  return pageDetails.read(`${publicationId}:${slug}`, () => readPage(publicationId, slug), page => page !== null);
}
async function readPage(publicationId: string, slug: string): Promise<PageDetail | null> {
  const page = (
    await query<PageSummary & { body: string; citation_count: number; backlink_count: number; link_count: number }>(
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
      `SELECT c.id, c.marker, c.note, t.id AS passage_id, t.ordinal, t.locator, t.body AS passage_body, s.id AS source_id, s.title AS source_title, s.original_name, s.original, s.media_type, s.source_date, s.sha256 FROM citations c JOIN passages t ON t.id=c.passage JOIN renditions e ON e.id=t.rendition JOIN sources s ON s.id=e.source WHERE c.page_revision=${identity(page.id)} ORDER BY c.id`,
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
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0) ||
      citation_count !== rows.length || backlink_count !== backlinks.length || link_count !== links.length)
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

const googleRequestKey = "wikicontext-google-signin";
let pendingSignIn: { cancel: (message?: string) => void } | null = null;
async function signIn(email?: string, password?: string): Promise<void> {
  pendingSignIn?.cancel();
  const generation = sessionGeneration, token = authStore.token;
  const client = new PocketBase(pb.baseURL, new BaseAuthStore());
  const google = email === undefined;
  // Open synchronously in the click handler, before provider discovery awaits.
  const popup = google ? window.open("about:blank", "_blank", "popup,width=520,height=720") : null;
  if (google && !popup) throw new Error("Allow the sign-in popup, then try again.");
  let ended = false;
  let rejectAttempt: (error: Error) => void = () => {};
  const attempt = {
    cancel(message = `${google ? "Google sign-in" : "Sign-in"} cancelled. You can try again.`) {
      if (ended) return;
      ended = true;
      // This isolated client owns only this attempt, including discovery and exchange.
      client.cancelAllRequests();
      popup?.close();
      rejectAttempt(Object.assign(new Error(message), { isAbort: true }));
    },
  };
  pendingSignIn = attempt;
  const timeout = google ? window.setTimeout(() => attempt.cancel("Google sign-in timed out. Please try again."), 180000) : undefined;
  try {
    const result = await new Promise<RecordAuthResponse>((resolve, reject) => {
      rejectAttempt = reject;
      const auth = client.collection("users");
      const response = google
        ? auth.authWithOAuth2({
          provider: "google", requestKey: googleRequestKey,
          urlCallback(url) {
            if (ended) throw new Error("Sign-in ended");
            const destination = new URL(url);
            if (destination.origin !== "https://accounts.google.com" || destination.username || destination.password)
              throw new Error("Unexpected Google authorization configuration.");
            popup!.location.href = destination.href;
          },
        })
        : auth.authWithPassword(email!, password!);
      response.then(resolve, reject);
    });
    if (ended || pendingSignIn !== attempt || generation !== sessionGeneration || token !== authStore.token) throw new Error("Session changed");
    if (result.record.collectionName !== "users") throw new Error("Invalid workspace identity");
    authStore.save(result.token, result.record);
  } finally {
    ended = true;
    clearTimeout(timeout);
    popup?.close();
    if (pendingSignIn === attempt) pendingSignIn = null;
    await client.realtime.unsubscribe();
  }
}
export async function loginGoogle(): Promise<void> { await signIn(); }
/** Cancel discovery, the realtime wait or exchange and fence late responses. */
export function cancelGoogleLogin(): void { pendingSignIn?.cancel(); }
export async function loginPassword(email: string, password: string): Promise<void> { await signIn(email, password); }
let refreshedAt = 0;
let refreshedToken = "";
export async function refreshSession(): Promise<void> {
  const initiatingToken = pb.authStore.token;
  if (!initiatingToken) throw new Error("Please sign in to continue");
  const generation = sessionGeneration;
  if (initiatingToken === refreshedToken && Date.now() - refreshedAt < 300000) return;
  try {
    // Save explicitly: the SDK authRefresh helper saves even after a user signs out.
    const result = await pb.send<RecordAuthResponse>(
      "/api/collections/users/auth-refresh",
      {
        method: "POST",
        headers: { Authorization: initiatingToken },
      },
    );
    if (pb.authStore.token !== initiatingToken || generation !== sessionGeneration) return;
    if (result.record.collectionName !== "users")
      throw new Error("Invalid workspace identity");
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
  cancelGoogleLogin();
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
/** Only decoded raster formats supported by reviewed-image ingestion are previewed. */
export function canPreviewImage(source: Source): boolean {
  return ["image/png", "image/jpeg", "image/webp"].includes(source.media_type.trim().toLowerCase());
}
export async function previewURL(source: Source): Promise<string> {
  identity(source.id);
  if (!canPreviewImage(source) || !source.original) throw new Error("Image preview unavailable");
  const generation = sessionGeneration;
  const token = await pb.files.getToken();
  if (generation !== sessionGeneration || !pb.authStore.isValid) throw new Error("Session changed");
  const url = pb.files.getURL({ id: source.id, collectionName: "sources" }, source.original, { token });
  if (new URL(url).origin !== new URL(pb.baseURL).origin) throw new Error("Invalid image origin");
  return url;
}
export async function watchPublications(
  callback: () => void,
): Promise<() => void> {
  const generation = sessionGeneration;
  await realtimeCleanup;
  if (generation !== sessionGeneration || !pb.authStore.isValid) return () => {};
  const notify = () => { if (generation === sessionGeneration) callback(); };
  let subscribed = false;
  const unsubscribeConnected = await pb.realtime.subscribe(
    "PB_CONNECT",
    // Initial connection is reconciled after subscription below; avoid a third
    // full page read before the collection subscription is active.
    () => { if (subscribed) notify(); },
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
  createPersonalSpace,
  evidenceSpace,
  loginGoogle,
  cancelGoogleLogin,
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
  previewURL,
  watchPublications,
};
