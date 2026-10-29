import { useEffect, useRef, useState } from "react";
import { pb, query } from "./api";
import { evidenceHref } from "./EvidenceBrowser";
import "./sourceDirectory.css";

export const SOURCE_PAGE_SIZE = 50;
const orders = {
  newest: "created DESC, id DESC",
  oldest: "created ASC, id ASC",
  title: "title COLLATE NOCASE ASC, id ASC",
} as const;
export type SourceOrder = keyof typeof orders;
export function sourceOrder(value: unknown): SourceOrder {
  return typeof value === "string" && Object.hasOwn(orders, value)
    ? (value as SourceOrder)
    : "newest";
}
/** Sources whose original has no rendition of any kind: the agent still has to convert it. */
export type SourceFilter = "" | "pending";
export function sourceFilter(value: unknown): SourceFilter {
  return value === "pending" ? "pending" : "";
}
const pendingCondition =
  "NOT EXISTS (SELECT 1 FROM renditions r WHERE r.source=s.id)";
export function sourceDirectoryHref(
  offset = 0,
  order: SourceOrder = "newest",
  publication = "",
  id = "",
  filter: SourceFilter = "",
) {
  const href = evidenceHref("sources", id, "", publication, offset);
  return `${href}${href.includes("?") ? "&" : "?"}order=${order}${sourceFilter(filter) ? `&filter=${sourceFilter(filter)}` : ""}`;
}
export function SourceSearchForm({
  term = "",
  publication = "",
}: {
  term?: string;
  publication?: string;
}) {
  const [draft, setDraft] = useState(term);
  useEffect(() => setDraft(term), [term]);
  return (
    <form
      className="source-directory-search"
      role="search"
      aria-label="Search source content"
      onSubmit={(event) => {
        event.preventDefault();
        location.hash = evidenceHref("sources", "", draft.trim(), publication);
      }}
    >
      <label className="sr-only" htmlFor="source-directory-search">
        Search all sources
      </label>
      <input
        id="source-directory-search"
        type="search"
        maxLength={500}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Search titles, filenames and source text…"
      />
      <button type="submit">Search</button>
      {term && (
        <a href={sourceDirectoryHref(0, "newest", publication)}>Clear search</a>
      )}
    </form>
  );
}
type SourceRow = {
  id: string;
  title: string;
  original_name: string;
  source_date: string;
  created: string;
  renditions: number;
};
export default function SourceDirectory({
  space,
  count,
  offset,
  order: requestedOrder,
  publication = "",
  filter: requestedFilter = "",
}: {
  space: string;
  count: number | null;
  offset: number;
  order?: SourceOrder;
  publication?: string;
  filter?: SourceFilter;
}) {
  // Runtime state can outlive a route shape during development hot reload.
  // Normalize again at the SQL boundary rather than trusting a typed prop.
  const order = sourceOrder(requestedOrder);
  const filter = sourceFilter(requestedFilter);
  const [authEpoch, setAuthEpoch] = useState(0);
  useEffect(
    () => pb.authStore.onChange(() => setAuthEpoch((value) => value + 1)),
    [],
  );
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    rows: SourceRow[];
    more: boolean;
    pending: number | null;
  } | null>(null);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const safeOffset = Math.min(
    100000,
    Math.max(0, Math.floor(offset / SOURCE_PAGE_SIZE) * SOURCE_PAGE_SIZE),
  );
  const key = `${space}:${safeOffset}:${order}:${filter}:${authEpoch}`;
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    setError("");
    setPending(true);
    if (!/^[a-z0-9]{15}$/.test(space)) {
      setError("This space is unavailable.");
      setPending(false);
      return;
    }
    const scope = `s.space='${space}'${filter ? ` AND ${pendingCondition}` : ""}`;
    void Promise.all([
      query<SourceRow>(
        `SELECT s.id,s.title,s.original_name,s.source_date,s.created,(SELECT count(*) FROM renditions r WHERE r.source=s.id) AS renditions FROM sources s WHERE ${scope} ORDER BY ${orders[order]} LIMIT ${SOURCE_PAGE_SIZE + 1} OFFSET ${safeOffset}`,
      ),
      // The space total counts every source; the filtered view needs its own.
      filter
        ? query<{ count: number }>(
            `SELECT count(*) AS count FROM sources s WHERE ${scope}`,
          )
        : null,
    ])
      .then(([rows, pending]) => {
        if (active)
          setLoaded({
            key,
            rows: rows.slice(0, SOURCE_PAGE_SIZE),
            more: rows.length > SOURCE_PAGE_SIZE,
            pending:
              pending?.length === 1 &&
              Number.isSafeInteger(pending[0].count) &&
              pending[0].count >= 0
                ? pending[0].count
                : null,
          });
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Sources are unavailable. Please retry.",
          );
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [key, count, retry]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    document.getElementById("reader")?.scrollTo(0, 0);
  }, [safeOffset, order]);
  const rows = loaded?.key === key ? loaded.rows : [];
  const more = loaded?.key === key && loaded.more;
  const total = filter ? (loaded?.key === key ? loaded.pending : null) : count;
  const totalPages =
    total === null ? null : Math.max(1, Math.ceil(total / SOURCE_PAGE_SIZE));
  const page = Math.floor(safeOffset / SOURCE_PAGE_SIZE) + 1;
  const [jump, setJump] = useState(String(page));
  useEffect(() => setJump(String(page)), [page]);
  const pager = (
    <nav className="source-directory-pagination" aria-label="Source pages">
      {safeOffset > 0 ? (
        <a
          href={sourceDirectoryHref(
            Math.max(0, safeOffset - SOURCE_PAGE_SIZE),
            order,
            publication,
            "",
            filter,
          )}
        >
          ← Previous
        </a>
      ) : (
        <span aria-disabled="true">← Previous</span>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = Number(jump);
          if (
            Number.isSafeInteger(next) &&
            next >= 1 &&
            next <= (totalPages || 2001)
          )
            location.hash = sourceDirectoryHref(
              (next - 1) * SOURCE_PAGE_SIZE,
              order,
              publication,
              "",
              filter,
            );
        }}
      >
        <label>
          Page{" "}
          <input
            aria-label="Source page number"
            type="number"
            min="1"
            max={totalPages || 2001}
            value={jump}
            onChange={(event) => setJump(event.target.value)}
            required
          />
        </label>
        {totalPages !== null && <span>of {totalPages.toLocaleString()}</span>}
        <button type="submit">Go</button>
      </form>
      {more ? (
        <a
          href={sourceDirectoryHref(
            safeOffset + SOURCE_PAGE_SIZE,
            order,
            publication,
            "",
            filter,
          )}
        >
          Next →
        </a>
      ) : (
        <span aria-disabled="true">Next →</span>
      )}
    </nav>
  );
  return (
    <section className="source-directory" aria-busy={pending}>
      <header className="evidence-heading">
        <h1 ref={heading} tabIndex={-1}>
          Sources
        </h1>
        <p>
          Original evidence in this space, including sources not yet cited in a
          page.
        </p>
      </header>
      <SourceSearchForm publication={publication} />
      <div className="source-directory-toolbar">
        <p role="status">
          {pending
            ? "Loading sources…"
            : rows.length
              ? `${(safeOffset + 1).toLocaleString()}–${(safeOffset + rows.length).toLocaleString()}${total === null ? "" : ` of ${total.toLocaleString()}`} ${filter ? "sources needing extraction" : "sources"}`
              : total === 0
                ? filter
                  ? "0 sources needing extraction"
                  : "0 sources"
                : "No sources on this page"}
        </p>
        <label>
          Show{" "}
          <select
            aria-label="Filter sources"
            value={filter}
            onChange={(event) => {
              location.hash = sourceDirectoryHref(
                0,
                order,
                publication,
                "",
                sourceFilter(event.target.value),
              );
            }}
          >
            <option value="">All sources</option>
            <option value="pending">Needs extraction</option>
          </select>
        </label>
        <label>
          Sort{" "}
          <select
            aria-label="Sort sources"
            value={order}
            onChange={(event) => {
              location.hash = sourceDirectoryHref(
                0,
                sourceOrder(event.target.value),
                publication,
                "",
                filter,
              );
            }}
          >
            <option value="newest">Recently added</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Name A–Z</option>
          </select>
        </label>
      </div>
      {error ? (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </p>
      ) : (
        <>
          {(safeOffset > 0 ||
            more ||
            (total !== null && total > SOURCE_PAGE_SIZE)) &&
            pager}
          <div className="source-directory-table">
            <table>
              <caption className="sr-only">Sources in this space</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Source date</th>
                  <th scope="col">Added</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <a
                        href={sourceDirectoryHref(
                          safeOffset,
                          order,
                          publication,
                          row.id,
                          filter,
                        )}
                      >
                        {row.title}
                      </a>
                      {row.renditions === 0 && (
                        <strong
                          className="source-badge"
                          title="No extracted text yet: the agent converts this original and runs pocketcontext extract"
                        >
                          Needs extraction
                        </strong>
                      )}
                      <span title={row.original_name}>{row.original_name}</span>
                    </td>
                    <td>{row.source_date || "—"}</td>
                    <td>{row.created.slice(0, 10) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!pending && !rows.length && (
            <p className="source-directory-empty">
              {safeOffset ? (
                <>
                  This page is empty.{" "}
                  <a
                    href={sourceDirectoryHref(
                      0,
                      order,
                      publication,
                      "",
                      filter,
                    )}
                  >
                    Return to the first page
                  </a>
                  .
                </>
              ) : filter ? (
                "Every source in this space has extracted text."
              ) : (
                "No sources yet. Ingest an original to add evidence to this space."
              )}
            </p>
          )}
          {rows.length > 15 && (
            <a
              className="source-directory-top"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                heading.current?.focus();
                document.getElementById("reader")?.scrollTo(0, 0);
              }}
            >
              Back to page controls ↑
            </a>
          )}
        </>
      )}
    </section>
  );
}
