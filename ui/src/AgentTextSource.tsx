import { useEffect, useState } from "react";
import { api, pb, query } from "./api";
import { evidenceHref } from "./EvidenceBrowser";
import { AgentTextLabel, EvidenceExcerpt } from "./EvidenceExcerpt";
import { AGENT_TEXT } from "./sourceRanges";
import type { Passage, Source } from "./types";

export const AGENT_PASSAGE_PAGE = 20;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function formatBytes(size: number | null | undefined): string {
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
    return "Unknown";
  if (size < 1024) return `${size.toLocaleString()} bytes`;
  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]} (${size.toLocaleString()} bytes)`;
}

export interface AgentRendition {
  id: string;
  version_label: string;
  notes?: unknown;
  created: string;
}
/** Read the recorded conversion provenance; notes are agent-supplied data, never markup. */
export function renditionNotes(notes: unknown): {
  tool: string;
  conversion: string;
  original_sha256: string;
} {
  let value = notes;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const field = (key: string) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? String((value as Record<string, unknown>)[key] ?? "")
      : "";
  return {
    tool: field("tool"),
    conversion: field("conversion"),
    original_sha256: field("original_sha256"),
  };
}

/** Source page for an original without a text rendition (PDF, image, audio, …).
 * Nothing is decoded from the original; its extracted text is the agent's. */
export function AgentTextSource({
  space,
  source,
  publication = "",
  cited,
  citedLoading = false,
  citedRequested = false,
}: {
  space: string;
  source: Source;
  publication?: string;
  cited?: Passage | null;
  citedLoading?: boolean;
  citedRequested?: boolean;
}) {
  const [size, setSize] = useState<number | null | undefined>(undefined);
  const [renditions, setRenditions] = useState<AgentRendition[] | null>(null);
  const [version, setVersion] = useState("");
  const [passages, setPassages] = useState<{
    rendition: string;
    rows: Passage[];
    more: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const token = pb.authStore.token;
    let active = true;
    void api
      .originalSize(source, controller.signal)
      .then((value) => {
        if (active && token === pb.authStore.token) setSize(value);
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setSize(null);
      });
    void query<AgentRendition>(
      `SELECT id,version_label,notes,created FROM renditions WHERE space=${literal(space)} AND source=${literal(source.id)} AND kind='${AGENT_TEXT}' ORDER BY created DESC, id DESC LIMIT 50`,
    )
      .then((rows) => {
        if (!active) return;
        setRenditions(rows);
        setVersion(rows[0]?.id || "");
      })
      .catch((reason) => {
        if (!active) return;
        setRenditions([]);
        setError(
          reason instanceof Error
            ? reason.message
            : "Extracted text is unavailable.",
        );
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [space, source]);
  const load = (rendition: string, offset: number) => {
    let active = true;
    setBusy(true);
    setError("");
    void query<Passage>(
      `SELECT p.id,p.ordinal,p.locator,p.body FROM passages p JOIN renditions r ON r.id=p.rendition WHERE p.space=${literal(space)} AND r.space=${literal(space)} AND r.source=${literal(source.id)} AND r.kind='${AGENT_TEXT}' AND r.id=${literal(rendition)} ORDER BY p.ordinal LIMIT ${AGENT_PASSAGE_PAGE + 1} OFFSET ${offset}`,
    )
      .then((rows) => {
        if (!active) return;
        const page = rows
          .slice(0, AGENT_PASSAGE_PAGE)
          .map((row) => ({ ...row, kind: AGENT_TEXT }));
        setPassages((previous) => ({
          rendition,
          rows:
            offset && previous?.rendition === rendition
              ? [...previous.rows, ...page]
              : page,
          more: rows.length > AGENT_PASSAGE_PAGE,
        }));
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Extracted text is unavailable.",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  };
  useEffect(() => {
    setPassages(null);
    if (version) return load(version, 0);
  }, [version]);
  const selected = renditions?.find((item) => item.id === version);
  const provenance = renditionNotes(selected?.notes);
  const shown = passages?.rendition === version ? passages.rows : [];
  return (
    <div className="agent-text-source">
      <section className="source-original" aria-label="Original file">
        <p className="source-range-note">
          This original is not a text file, so it is not previewed here.
          Download it to open it in its own application.
        </p>
        <dl>
          <dt>Format</dt>
          <dd>{source.media_type || "Unknown"}</dd>
          <dt>Size</dt>
          <dd>{size === undefined ? "Checking…" : formatBytes(size)}</dd>
          <dt>Original file</dt>
          <dd>{source.original_name}</dd>
        </dl>
      </section>
      {citedRequested &&
        (citedLoading ? (
          <p role="status">Checking cited passage…</p>
        ) : cited ? (
          <section className="agent-text-cited" aria-label="Cited passage">
            <p>
              <strong>Cited passage</strong>
              <span>{cited.locator}</span>
            </p>
            <EvidenceExcerpt
              body={cited.body}
              source={source}
              kind={cited.kind}
            />
          </section>
        ) : (
          <p className="source-range-note" role="status">
            This passage is unavailable for this original.
          </p>
        ))}
      {renditions === null ? (
        <p role="status">Checking extracted text…</p>
      ) : !renditions.length ? (
        !error && (
          <p className="source-range-note" role="status">
            <strong className="source-badge">Needs extraction</strong> No text
            has been extracted from this original yet. Your agent converts it
            and runs <code>pocketcontext extract</code>.
          </p>
        )
      ) : (
        <section
          className="agent-text-passages"
          aria-label="Agent-derived passages"
        >
          <h2>Extracted text</h2>
          <AgentTextLabel />
          <p className="source-range-note">
            Passages come from text your agent produced from this original.
            Their locators refer to that text, not to the original file.
          </p>
          <dl>
            <dt>Version</dt>
            <dd>
              {renditions.length > 1 ? (
                <select
                  aria-label="Extracted text version"
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                >
                  {renditions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.version_label}
                    </option>
                  ))}
                </select>
              ) : (
                selected?.version_label
              )}
            </dd>
            {provenance.tool && (
              <>
                <dt>Converted by</dt>
                <dd>{provenance.tool}</dd>
              </>
            )}
            {provenance.conversion && (
              <>
                <dt>Conversion</dt>
                <dd>{provenance.conversion}</dd>
              </>
            )}
            {provenance.original_sha256 && (
              <>
                <dt>Converted from SHA-256</dt>
                <dd>{provenance.original_sha256}</dd>
              </>
            )}
          </dl>
          <ol className="agent-text-list">
            {shown.map((row) => (
              <li
                key={row.id}
                className={row.id === cited?.id ? "cited" : undefined}
              >
                <a
                  className="evidence-locator"
                  href={evidenceHref("passages", row.id, "", publication)}
                >
                  {row.locator || `Passage ${row.ordinal}`}
                </a>
                <pre className="evidence-excerpt source-text">{row.body}</pre>
              </li>
            ))}
          </ol>
          {passages?.rendition === version && passages.more && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => load(version, shown.length)}
            >
              Load more passages
            </button>
          )}
          {busy && <p role="status">Loading passages…</p>}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
