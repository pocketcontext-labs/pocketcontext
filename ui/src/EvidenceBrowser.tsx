import { spaceLink } from "./spaceLinks";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, pb, query } from "./api";
import ImagePreview from "./ImagePreview";
import type { Source } from "./types";
import "./evidence.css";

export type EvidenceCollection = "sources" | "passages";
export function evidenceHref(collection: EvidenceCollection, id = "", term = "", publication = "", offset = 0) {
  const params = new URLSearchParams();
  if (term) params.set("q", term);
  if (offset) params.set("offset", String(offset));
  if (publication) params.set("publication", publication);
  return spaceLink(`#/${collection}/${encodeURIComponent(id)}${params.size ? `?${params}` : ""}`);
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Row = { id: string; title: string; body?: string; locator?: string; source_id?: string };
export default function EvidenceBrowser({ space, collection, id, term, publication, offset, navigation, onTitleChange }: { space: string; collection: EvidenceCollection; id: string; term: string; publication: string; offset: number; navigation: HTMLElement | null; onTitleChange?: (title: string) => void }) {
  const actionEpoch = useRef(0);
  useEffect(() => { actionEpoch.current++; return () => { actionEpoch.current++; }; }, [space, collection, id]);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    onTitleChange?.("");
    setBusy(true); setError(""); setRows([]); setSelected(null); setSource(null);
    const timer = setTimeout(() => void (async () => {
      try {
        const base = collection === "sources"
          ? "SELECT s.id, s.title FROM sources s"
          : "SELECT p.id, s.title, p.locator, p.body, s.id AS source_id FROM passages p JOIN renditions r ON r.id=p.rendition JOIN sources s ON s.id=r.source";
        const key = collection === "sources" ? "s.id" : "p.id";
        // Evidence is listed per selected space; SQL snapshots already hide foreign spaces.
        const inSpace = `${collection === "sources" ? "s" : "p"}.space=${literal(space)}`;
        const fields = collection === "sources" ? "s.title || ' ' || s.original_name || ' ' || s.id" : "s.title || ' ' || p.locator || ' ' || p.body || ' ' || p.id || ' ' || s.id";
        const found = await query<Row>(`${base.replace("p.locator, p.body,", "p.locator,")} WHERE ${inSpace} AND instr(lower(${fields}), lower(${literal(term)}))>0 ORDER BY ${key} LIMIT 21 OFFSET ${offset}`);
        const record = id ? (await query<Row>(`${base} WHERE ${inSpace} AND ${key}=${literal(id)} LIMIT 1`))[0] : null;
        const original = record ? (await query<Source>(`SELECT id,title,original_name,original,media_type,source_date,sha256 FROM sources WHERE id=${literal(record.source_id || record.id)} LIMIT 1`))[0] : null;
        if (active) { setRows(found.slice(0,20)); setMore(found.length>20); setSelected(record || null); onTitleChange?.(record?.title || ""); setSource(original || null); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Unable to load evidence"); }
      finally { if (active) setBusy(false); }
    })(), 200);
    return () => { active = false; clearTimeout(timer); };
  }, [space, collection, id, term, offset, onTitleChange]);
  const recordLink = (row: Row) => <a key={row.id} className={row.id === id ? "selected" : undefined} aria-current={row.id === id ? "page" : undefined} href={evidenceHref(collection, row.id, term, publication, offset)}>
    <span>{row.title}{row.locator && <small>{row.locator}</small>}</span>
  </a>;
  const results = <>
    <button className="evidence-search-copy" onClick={() => void navigator.clipboard.writeText(new URL(evidenceHref(collection,"",term,publication,offset),location.href).href).catch(() => setError("Unable to copy link"))}>Copy search link</button>
    {selected && !rows.some(row => row.id === id) && <nav className="page-list evidence-current" aria-label="Current evidence record">{recordLink(selected)}</nav>}
    <nav className="page-list evidence-list" aria-label="Evidence records">{rows.map(recordLink)}</nav>
    {!busy && !rows.length && <p>No matches.</p>}
    {(offset > 0 || more) && <nav className="evidence-pagination" aria-label="Evidence result pages">
      {offset > 0 && <a href={evidenceHref(collection,id,term,publication,Math.max(0,offset-20))}>Previous</a>}
      {more && <a href={evidenceHref(collection,id,term,publication,offset+20)}>Next</a>}
    </nav>}
  </>;
  return <section className="evidence-browser" aria-busy={busy}>
    <header className="evidence-heading">
      <h1>{collection === "sources" ? "Sources" : "Passages"}</h1>
      <p>Original evidence, including sources not yet cited in a published page.</p>
    </header>
    {error && <p role="alert">{error}</p>}
    {id ? selected ? <article className="evidence-record">
      <h2>{selected.title}</h2>
      {selected.locator && <p className="evidence-locator">{selected.locator}</p>}
      {source && <p className="evidence-file-info">{source.original_name} · {source.media_type}{source.source_date && ` · ${source.source_date}`}</p>}
      <div className="evidence-actions" role="group" aria-label="Record actions">
        <button onClick={() => void navigator.clipboard.writeText(new URL(evidenceHref(collection,id),location.href).href).catch(() => setError("Unable to copy link"))}>Copy record link</button>
        {source && <button onClick={() => { const token = pb.authStore.token, epoch = actionEpoch.current; void api.originalURL(source).then(url => { if (epoch === actionEpoch.current && pb.authStore.isValid && token === pb.authStore.token) window.location.assign(url); }).catch(e => setError(String(e))); }}>Download original</button>}
        {collection === "sources" && <a href={evidenceHref("passages", "", selected.id, publication)}>View source passages</a>}
      </div>
      {selected.body && <blockquote className="passage">{selected.body}</blockquote>}
      {selected.source_id && <p><a href={evidenceHref("sources", selected.source_id, "", publication)}>Source: {selected.title}</a></p>}
      {source && <ImagePreview source={source} />}
      <details className="evidence-details"><summary>Record details</summary><dl><dt>Record ID</dt><dd>{selected.id}</dd></dl></details>
    </article> : !busy && <p>Record unavailable.</p> : <p>Select a {collection === "sources" ? "source" : "passage"} to read its evidence.</p>}
    {navigation ? createPortal(results, navigation) : results}
  </section>;
}
