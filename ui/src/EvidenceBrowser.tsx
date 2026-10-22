import { spaceLink } from "./spaceLinks";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, pb, query } from "./api";
import { EvidenceExcerpt } from "./EvidenceExcerpt";
import { SourceContent } from "./SourceContent";
import type { Passage, Source } from "./types";
import "./evidence.css";

export type EvidenceCollection = "sources" | "passages";
export function evidenceHref(
  collection: EvidenceCollection,
  id = "",
  term = "",
  publication = "",
  offset = 0,
  passage = "",
) {
  const params = new URLSearchParams();
  if (term) params.set("q", term);
  if (offset) params.set("offset", String(offset));
  if (publication) params.set("publication", publication);
  if (passage) params.set("passage", passage);
  return spaceLink(
    `#/${collection}/${encodeURIComponent(id)}${params.size ? `?${params}` : ""}`,
  );
}
/** Immutable source link retaining the exact cited passage identity. */
export function sourcePassageHref(
  sourceId: string,
  passageId: string,
  publication = "",
) {
  return evidenceHref("sources", sourceId, "", publication, 0, passageId);
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Row = {
  id: string;
  title: string;
  body?: string;
  locator?: string;
  source_id?: string;
  original_name?: string;
  source_date?: string;
};
export default function EvidenceBrowser({
  space,
  collection,
  id,
  term,
  publication,
  offset,
  navigation,
  onTitleChange,
  passage = "",
  sourceOrder = "newest",
}: {
  space: string;
  collection: EvidenceCollection;
  id: string;
  term: string;
  publication: string;
  offset: number;
  navigation: HTMLElement | null;
  onTitleChange?: (title: string) => void;
  passage?: string;
  sourceOrder?: string;
}) {
  const [cited, setCited] = useState<{
    key: string;
    value: Passage | null;
  } | null>(null);
  const actionEpoch = useRef(0);
  const sourceToken = useRef("");
  useEffect(() => {
    actionEpoch.current++;
    return () => {
      actionEpoch.current++;
    };
  }, [space, collection, id]);
  const [authEpoch, setAuthEpoch] = useState(0);
  useEffect(
    () => pb.authStore.onChange(() => setAuthEpoch((value) => value + 1)),
    [],
  );
  const [preview, setPreview] = useState<{
    source: string;
    token: string;
    text?: string;
    error?: string;
  } | null>(null);
  const viewKey = `${space}:${authEpoch}`;
  const [loadedKey, setLoadedKey] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    onTitleChange?.("");
    sourceToken.current = "";
    setBusy(true);
    setError("");
    setRows([]);
    setSelected(null);
    setSource(null);
    setPreview(null);
    const timer = setTimeout(
      () =>
        void (async () => {
          try {
            const base =
              collection === "sources"
                ? "SELECT s.id, s.title, s.original_name, s.source_date FROM sources s"
                : "SELECT p.id, s.title, p.locator, p.body, s.id AS source_id FROM passages p JOIN renditions r ON r.id=p.rendition JOIN sources s ON s.id=r.source";
            const key = collection === "sources" ? "s.id" : "p.id";
            // Evidence is listed per selected space; SQL snapshots already hide foreign spaces.
            const inSpace = `${collection === "sources" ? "s" : "p"}.space=${literal(space)}`;
            const fields =
              collection === "sources"
                ? "s.title || ' ' || s.original_name || ' ' || s.id"
                : "s.title || ' ' || p.locator || ' ' || p.body || ' ' || p.id || ' ' || s.id";
            const found =
              collection === "sources" && id
                ? []
                : await query<Row>(
                    `${base.replace("p.locator, p.body,", "p.locator,")} WHERE ${inSpace} AND instr(lower(${fields}), lower(${literal(term)}))>0 ORDER BY ${key} LIMIT 21 OFFSET ${offset}`,
                  );
            const record = id
              ? (
                  await query<Row>(
                    `${base} WHERE ${inSpace} AND ${key}=${literal(id)} LIMIT 1`,
                  )
                )[0]
              : null;
            const original = record
              ? (
                  await query<Source>(
                    `SELECT id,title,original_name,original,media_type,source_date,sha256 FROM sources WHERE space=${literal(space)} AND id=${literal(record.source_id || record.id)} LIMIT 1`,
                  )
                )[0]
              : null;
            if (active) {
              setLoadedKey(viewKey);
              sourceToken.current = pb.authStore.token;
              setRows(found.slice(0, 20));
              setMore(found.length > 20);
              setSelected(record || null);
              onTitleChange?.(record?.title || "");
              setSource(original || null);
            }
          } catch (e) {
            if (active)
              setError(
                e instanceof Error ? e.message : "Unable to load evidence",
              );
          } finally {
            if (active) setBusy(false);
          }
        })(),
      200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [space, collection, id, term, offset, onTitleChange, authEpoch]);
  useEffect(() => {
    setPreview(null);
    if (
      collection !== "sources" ||
      !source ||
      source.id !== id ||
      sourceToken.current !== pb.authStore.token
    )
      return;
    const controller = new AbortController();
    const token = pb.authStore.token;
    let active = true;
    void api
      .sourceText(source, controller.signal)
      .then((text) => {
        if (active && token === pb.authStore.token)
          setPreview({ source: source.id, token, text });
      })
      .catch((error) => {
        if (
          active &&
          !controller.signal.aborted &&
          token === pb.authStore.token
        )
          setPreview({
            source: source.id,
            token,
            error:
              error instanceof Error
                ? error.message
                : "Unable to read the original.",
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [source, space, collection, id, authEpoch]);
  const citedKey = `${space}:${id}:${passage}:${authEpoch}`;
  useEffect(() => {
    setCited(null);
    if (!passage || collection !== "sources") return;
    if (!/^[a-z0-9]{15}$/.test(passage)) {
      setCited({ key: citedKey, value: null });
      return;
    }
    let active = true;
    void query<Passage>(
      `SELECT p.id,p.ordinal,p.locator,p.body FROM passages p JOIN renditions r ON r.id=p.rendition WHERE p.id=${literal(passage)} AND p.space=${literal(space)} AND r.space=${literal(space)} AND r.source=${literal(id)} LIMIT 1`,
    )
      .then((rows) => {
        if (active) setCited({ key: citedKey, value: rows[0] ?? null });
      })
      .catch(() => {
        if (active) setCited({ key: citedKey, value: null });
      });
    return () => {
      active = false;
    };
  }, [space, id, collection, passage, authEpoch]);
  const visibleRows = loadedKey === viewKey ? rows : [];
  const recordLink = (row: Row) => (
    <a
      key={row.id}
      className={row.id === id ? "selected" : undefined}
      aria-current={row.id === id ? "page" : undefined}
      href={evidenceHref(collection, row.id, term, publication, offset)}
    >
      <span>
        {row.title}
        {row.locator && <small>{row.locator}</small>}
      </span>
    </a>
  );
  const results = (
    <>
      <button
        className="evidence-search-copy"
        onClick={() =>
          void navigator.clipboard
            .writeText(
              new URL(
                evidenceHref(collection, "", term, publication, offset),
                location.href,
              ).href,
            )
            .catch(() => setError("Unable to copy link"))
        }
      >
        Copy search link
      </button>
      {selected &&
        loadedKey === viewKey &&
        !visibleRows.some((row) => row.id === id) && (
          <nav
            className="page-list evidence-current"
            aria-label="Current evidence record"
          >
            {recordLink(selected)}
          </nav>
        )}
      <nav className="page-list evidence-list" aria-label="Evidence records">
        {visibleRows.map(recordLink)}
      </nav>
      {!busy && !visibleRows.length && <p>No matches.</p>}
      {(offset > 0 || more) && (
        <nav className="evidence-pagination" aria-label="Evidence result pages">
          {offset > 0 && (
            <a
              href={evidenceHref(
                collection,
                id,
                term,
                publication,
                Math.max(0, offset - 20),
              )}
            >
              Previous
            </a>
          )}
          {more && (
            <a
              href={evidenceHref(
                collection,
                id,
                term,
                publication,
                offset + 20,
              )}
            >
              Next
            </a>
          )}
        </nav>
      )}
    </>
  );
  return (
    <section className="evidence-browser" aria-busy={busy}>
      {collection === "sources" && id && (
        <a
          className="source-directory-back"
          href={`${evidenceHref("sources", "", term, publication, offset)}${evidenceHref("sources", "", term, publication, offset).includes("?") ? "&" : "?"}order=${encodeURIComponent(sourceOrder)}`}
        >
          ← {term ? "Back to search results" : "All sources"}
        </a>
      )}
      {!id && (
        <header className="evidence-heading">
          <h1>{collection === "sources" ? "Sources" : "Passages"}</h1>
          <p>
            Original evidence, including sources not yet cited in a published
            page.
          </p>
        </header>
      )}
      {error && <p role="alert">{error}</p>}
      {id ? (
        selected?.id === id && loadedKey === viewKey ? (
          <article className="evidence-record">
            <div className="page-eyebrow">
              {collection === "sources" ? "Original source" : "Source passage"}
            </div>
            <h1 className="page-title">{selected.title}</h1>
            {selected.locator && (
              <p className="evidence-locator">{selected.locator}</p>
            )}
            <div
              className="evidence-actions"
              role="group"
              aria-label="Record actions"
            >
              <button
                onClick={() =>
                  void navigator.clipboard
                    .writeText(
                      new URL(
                        evidenceHref(collection, id, "", "", 0, passage),
                        location.href,
                      ).href,
                    )
                    .catch(() => setError("Unable to copy link"))
                }
              >
                Copy record link
              </button>
              {source && (
                <button
                  onClick={() => {
                    const token = pb.authStore.token,
                      epoch = actionEpoch.current;
                    void api
                      .originalURL(source)
                      .then((url) => {
                        if (
                          epoch === actionEpoch.current &&
                          pb.authStore.isValid &&
                          token === pb.authStore.token
                        )
                          window.location.assign(url);
                      })
                      .catch((e) => setError(String(e)));
                  }}
                >
                  Download original
                </button>
              )}
              {collection === "sources" && (
                <a
                  href={evidenceHref("passages", "", selected.id, publication)}
                >
                  View source passages
                </a>
              )}
            </div>
            {collection === "sources" && source && (
              <div className="source-reading">
                {preview?.source !== source.id ||
                preview.token !== pb.authStore.token ? (
                  <p role="status">Reading original…</p>
                ) : preview.error ? (
                  <p className="source-preview-error" role="status">
                    {preview.error}
                  </p>
                ) : (
                  <SourceContent
                    key={`${source.id}:${passage}`}
                    text={preview.text || ""}
                    source={source}
                    passage={cited?.key === citedKey ? cited.value : null}
                    passageRequested={Boolean(passage)}
                    passageLoading={Boolean(passage) && cited?.key !== citedKey}
                  />
                )}
              </div>
            )}
            {selected.body && (
              <EvidenceExcerpt
                body={selected.body}
                source={source || undefined}
              />
            )}
            {selected.source_id && (
              <p>
                <a
                  href={sourcePassageHref(
                    selected.source_id,
                    selected.id,
                    publication,
                  )}
                >
                  Source: {selected.title}
                </a>
              </p>
            )}
            <details className="evidence-details">
              <summary>Record details</summary>
              <dl>
                <dt>Record ID</dt>
                <dd>{selected.id}</dd>
                {source && (
                  <>
                    <dt>Original file</dt>
                    <dd>{source.original_name}</dd>
                    <dt>Format</dt>
                    <dd>{source.media_type}</dd>
                    {source.source_date && (
                      <>
                        <dt>Source date</dt>
                        <dd>{source.source_date}</dd>
                      </>
                    )}
                    <dt>SHA-256</dt>
                    <dd>{source.sha256}</dd>
                  </>
                )}
              </dl>
            </details>
          </article>
        ) : (
          !busy && <p>Record unavailable.</p>
        )
      ) : (
        <div className="evidence-overview">
          <p>
            {publication
              ? "All original evidence in this space; this list is not limited to the historical publication."
              : "Select an original to read it here."}
          </p>
          <nav
            className="source-cards"
            aria-label={
              collection === "sources"
                ? "Sources in this space"
                : "Passages in this space"
            }
          >
            {visibleRows.map((row) => (
              <a
                key={row.id}
                href={evidenceHref(
                  collection,
                  row.id,
                  term,
                  publication,
                  offset,
                )}
              >
                <strong>{row.title}</strong>
                {row.original_name && <span>{row.original_name}</span>}
                {row.locator && <span>{row.locator}</span>}
                {row.source_date && <small>{row.source_date}</small>}
              </a>
            ))}
          </nav>
          {!busy && !visibleRows.length && (
            <p>
              No {term ? "matching " : ""}
              {collection} in this space.
            </p>
          )}
          {(offset > 0 || more) && (
            <nav className="evidence-pagination" aria-label="Source list pages">
              {offset > 0 && (
                <a
                  href={evidenceHref(
                    collection,
                    "",
                    term,
                    publication,
                    Math.max(0, offset - 20),
                  )}
                >
                  Previous {collection}
                </a>
              )}
              {more && (
                <a
                  href={evidenceHref(
                    collection,
                    "",
                    term,
                    publication,
                    offset + 20,
                  )}
                >
                  Next {collection}
                </a>
              )}
            </nav>
          )}
        </div>
      )}
      {collection === "passages" &&
        (navigation ? createPortal(results, navigation) : id ? results : null)}
    </section>
  );
}
