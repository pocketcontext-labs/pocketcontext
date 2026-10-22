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
export function sourceDirectoryHref(
  offset = 0,
  order: SourceOrder = "newest",
  publication = "",
  id = "",
) {
  const href = evidenceHref("sources", id, "", publication, offset);
  return `${href}${href.includes("?") ? "&" : "?"}order=${order}`;
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
};
export default function SourceDirectory({
  space,
  count,
  offset,
  order: requestedOrder,
  publication = "",
}: {
  space: string;
  count: number | null;
  offset: number;
  order?: SourceOrder;
  publication?: string;
}) {
  // Runtime state can outlive a route shape during development hot reload.
  // Normalize again at the SQL boundary rather than trusting a typed prop.
  const order = sourceOrder(requestedOrder);
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
  } | null>(null);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const safeOffset = Math.min(
    100000,
    Math.max(0, Math.floor(offset / SOURCE_PAGE_SIZE) * SOURCE_PAGE_SIZE),
  );
  const key = `${space}:${safeOffset}:${order}:${authEpoch}`;
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
    void query<SourceRow>(
      `SELECT id,title,original_name,source_date,created FROM sources WHERE space='${space}' ORDER BY ${orders[order]} LIMIT ${SOURCE_PAGE_SIZE + 1} OFFSET ${safeOffset}`,
    )
      .then((rows) => {
        if (active)
          setLoaded({
            key,
            rows: rows.slice(0, SOURCE_PAGE_SIZE),
            more: rows.length > SOURCE_PAGE_SIZE,
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
  const totalPages =
    count === null ? null : Math.max(1, Math.ceil(count / SOURCE_PAGE_SIZE));
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
              ? `${(safeOffset + 1).toLocaleString()}–${(safeOffset + rows.length).toLocaleString()}${count === null ? "" : ` of ${count.toLocaleString()}`} sources`
              : count === 0
                ? "0 sources"
                : "No sources on this page"}
        </p>
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
            (count !== null && count > SOURCE_PAGE_SIZE)) &&
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
                        )}
                      >
                        {row.title}
                      </a>
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
                  <a href={sourceDirectoryHref(0, order, publication)}>
                    Return to the first page
                  </a>
                  .
                </>
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
