import { useEffect, useRef, useState } from "react";
import { api, query, sessionGeneration } from "./api";
import {
  catalogHref,
  catalogLabels,
  catalogTypes,
  type CatalogState,
} from "./Catalog";
import { pageHref } from "./Markdown";
import { propertyLabel, propertyText } from "./Properties";
import type { PageSummary, Source } from "./types";

const fields = [
  "purpose",
  "target_agents",
  "required_skills",
  "inputs",
  "approval_boundaries",
  "last_validated_at",
];
const list = (page: PageSummary, key: string): string[] =>
  Array.isArray(page.properties?.[key])
    ? (page.properties[key] as string[])
    : [];
export function filterPrompts(pages: PageSummary[], state: CatalogState) {
  const terms = state.query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return pages
    .filter(
      (page) =>
        page.properties?.catalog_type === "repository_document" &&
        page.properties.document_type === "prompt" &&
        (!state.targetAgent ||
          list(page, "target_agents").includes(state.targetAgent)) &&
        (!state.requiredSkill ||
          list(page, "required_skills").includes(state.requiredSkill)) &&
        terms.every((term) =>
          [
            page.title,
            page.summary,
            ...Object.values(page.properties || {}).map(propertyText),
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(term),
        ),
    )
    .sort(
      (a, b) =>
        (a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug)) *
        (state.sort === "-title" ? -1 : 1),
    );
}
export async function decodePrompt(
  bytes: ArrayBuffer,
  expectedHash: string,
): Promise<string> {
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== expectedHash)
    throw new Error("Original checksum does not match. Prompt unavailable.");
  // Preserve a leading UTF-8 BOM in copied text as well as downloaded bytes.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}
const maxPromptBytes = 8 * 1024 * 1024;
export function portableMarkdown(body: string) {
  if (
    ["[[", "[^", "[needs verification]"].some((marker) =>
      body.includes(marker),
    ) ||
    /^\s*>\s*\[!/m.test(body)
  )
    throw new Error(
      "Markdown contains wiki-only markup. Publish portable Markdown or use exact_copy.",
    );
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > maxPromptBytes)
    throw new Error("Prompt exceeds the 8 MiB preview limit.");
  return bytes;
}
export async function readPromptBytes(
  response: Response,
): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("Prompt original unavailable.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPromptBytes) {
        await reader.cancel();
        throw new Error("Prompt exceeds the 8 MiB preview limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
export async function loadPrompt(
  page: PageSummary,
  publication: string,
  space: string,
) {
  const generation = sessionGeneration;
  const detail = await api.getPage(publication, page.slug);
  if (
    !detail ||
    detail.id !== page.id ||
    detail.properties?.catalog_type !== "repository_document" ||
    detail.properties.document_type !== "prompt" ||
    generation !== sessionGeneration
  )
    throw new Error("Selected prompt is no longer available.");
  if (detail.properties?.output_mode === "markdown") {
    const bytes = portableMarkdown(detail.body);
    return { text: detail.body, bytes };
  }
  const sourceId = detail.properties?.source_id;
  if (
    detail.properties?.output_mode !== "exact_copy" ||
    typeof sourceId !== "string" ||
    !/^[a-z0-9]{15}$/.test(sourceId) ||
    !/^[a-z0-9]{15}$/.test(space)
  )
    throw new Error("Invalid prompt source.");
  const source = (
    await query<Source>(
      `SELECT id,title,original_name,original,media_type,source_date,sha256 FROM sources WHERE id='${sourceId}' AND space='${space}' LIMIT 1`,
    )
  )[0];
  if (!source || generation !== sessionGeneration)
    throw new Error("Prompt source unavailable.");
  const response = await fetch(await api.originalURL(source), {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Unable to download prompt original.");
  const bytes = await readPromptBytes(response);
  const text = await decodePrompt(bytes, source.sha256);
  if (generation !== sessionGeneration) throw new Error("Session changed.");
  return { text, bytes: new Uint8Array(bytes) };
}
function PromptPreview({
  page,
  publication,
  space,
}: {
  page: PageSummary;
  publication: string;
  space: string;
}) {
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof loadPrompt>
  > | null>(null);
  const [status, setStatus] = useState("");
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setResult(null);
    setStatus("");
    return () => {
      epoch.current++;
    };
  }, [page.id, publication, space]);
  const preview = async () => {
    const active = ++epoch.current;
    setResult(null);
    setStatus("Loading prompt…");
    try {
      const value = await loadPrompt(page, publication, space);
      if (active === epoch.current) {
        setResult(value);
        setStatus("");
      }
    } catch (error) {
      if (active === epoch.current)
        setStatus(
          error instanceof Error ? error.message : "Unable to load prompt.",
        );
    }
  };
  const copy = async () => {
    const active = epoch.current;
    try {
      await navigator.clipboard.writeText(result!.text);
      if (active === epoch.current) setStatus("Prompt copied.");
    } catch {
      if (active === epoch.current)
        setStatus("Clipboard unavailable. Download the prompt instead.");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(result!.bytes)], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${page.slug}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="prompt-preview">
      <button onClick={() => void preview()}>Preview prompt</button>
      {result && (
        <>
          <pre tabIndex={0} aria-label={`Prompt text: ${page.title}`}>
            {result.text}
          </pre>
          <button onClick={() => void copy()}>Copy prompt</button>{" "}
          <button onClick={download}>Download prompt</button>{" "}
          <button
            onClick={() => {
              epoch.current++;
              setResult(null);
              setStatus("");
            }}
          >
            Close preview
          </button>
        </>
      )}
      {status && <p role="status">{status}</p>}
    </div>
  );
}
export default function Prompts({
  pages,
  state,
  publication,
  snapshotId,
  space,
  onNavigate,
}: {
  pages: PageSummary[];
  state: CatalogState;
  publication?: string;
  snapshotId?: string;
  space?: string;
  onNavigate?: (href: string) => void;
}) {
  const update = (patch: Partial<CatalogState>) => {
    const href = catalogHref({ ...state, offset: 0, ...patch }, publication);
    if (onNavigate) onNavigate(href);
    else location.hash = href;
  };
  const all = pages.filter(
    (page) =>
      page.properties?.catalog_type === "repository_document" &&
      page.properties.document_type === "prompt",
  );
  const matches = filterPrompts(pages, state),
    rows = matches.slice(state.offset, state.offset + 50);
  return (
    <section className="catalog-page" aria-label="Prompts catalog">
      <div className="page-eyebrow">PUBLISHED CATALOG</div>
      <h1 className="page-title">Prompts</h1>
      <p className="page-summary">
        Reusable prompts with their requirements and approval boundaries.
        Preview, copy or download the exact text; review it before use.
      </p>
      <nav className="catalog-tabs" aria-label="Catalogs">
        {catalogTypes.map((type) => (
          <a
            key={type}
            href={catalogHref({ type }, publication)}
            aria-current={type === "prompt" ? "page" : undefined}
          >
            {catalogLabels[type]}
          </a>
        ))}
      </nav>
      <div className="catalog-filters">
        <label>
          Search prompts
          <input
            type="search"
            value={state.query}
            onChange={(e) => update({ query: e.target.value })}
          />
        </label>
        {(
          [
            ["targetAgent", "target_agents", "Target agent"],
            ["requiredSkill", "required_skills", "Required skill"],
          ] as const
        ).map(([key, prop, label]) => (
          <label key={key}>
            {label}
            <select
              aria-label={label}
              value={state[key] || ""}
              onChange={(e) => update({ [key]: e.target.value })}
            >
              <option value="">All</option>
              {[
                ...new Set([
                  state[key] || "",
                  ...all.flatMap((page) => list(page, prop)),
                ]),
              ]
                .filter(Boolean)
                .sort()
                .map((value) => (
                  <option key={value}>{value}</option>
                ))}
            </select>
          </label>
        ))}
        <label>
          Sort
          <select
            aria-label="Sort"
            value={state.sort}
            onChange={(e) => update({ sort: e.target.value })}
          >
            <option value="title">Name ↑</option>
            <option value="-title">Name ↓</option>
          </select>
        </label>
        <button
          onClick={() =>
            update({ query: "", targetAgent: "", requiredSkill: "" })
          }
        >
          Clear filters
        </button>
      </div>
      <p role="status">
        {matches.length} {matches.length === 1 ? "prompt" : "prompts"}
        {rows.length
          ? ` · ${state.offset + 1}–${Math.min(state.offset + 50, matches.length)}`
          : ""}
      </p>
      {!matches.length && <p>No matching prompts in this publication.</p>}
      {!!matches.length && !rows.length && (
        <a href={catalogHref({ ...state, offset: 0 }, publication)}>
          Return to first page
        </a>
      )}
      <div className="repository-document-list">
        {rows.map((page) => (
          <article className="repository-document" key={page.id}>
            <h2>
              <a href={pageHref(page.slug, publication)}>{page.title}</a>
            </h2>
            <p>{page.summary}</p>
            <dl>
              {fields.map((field) => (
                <div key={field}>
                  <dt>{propertyLabel(field)}</dt>
                  <dd>{propertyText(page.properties?.[field])}</dd>
                </div>
              ))}
            </dl>
            {snapshotId && space && (
              <PromptPreview
                page={page}
                publication={snapshotId}
                space={space}
              />
            )}
          </article>
        ))}
      </div>
      <nav className="catalog-pagination" aria-label="Catalog pagination">
        {state.offset > 0 && (
          <a
            href={catalogHref(
              { ...state, offset: Math.max(0, state.offset - 50) },
              publication,
            )}
          >
            Previous
          </a>
        )}
        {state.offset + 50 < matches.length && (
          <a
            href={catalogHref(
              { ...state, offset: state.offset + 50 },
              publication,
            )}
          >
            Next
          </a>
        )}
      </nav>
    </section>
  );
}
