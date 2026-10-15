import { GenerationProvenance, generationMetadata } from "./Generation";
import { useEffect, useRef, useState } from "react";
import { api, pb, query, sessionGeneration } from "./api";
import {
  catalogHref,
  catalogLabels,
  catalogTypes,
  type CatalogState,
} from "./Catalog";
import { pageHref } from "./Markdown";
import { evidenceHref } from "./EvidenceBrowser";
import { propertyLabel, propertyText } from "./Properties";
import type { PageDetail, PageSummary, Passage, Source } from "./types";
import "./audio.css";

const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-z0-9]{15}$/.test(value))
    throw new Error("Invalid recording reference.");
  return value;
};
export function filterAudio(pages: PageSummary[], state: CatalogState) {
  const terms = state.query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return pages
    .filter(
      (p) =>
        p.properties?.catalog_type === "audio_recording" &&
        (!state.language || p.properties.language === state.language) &&
        (!state.bundle ||
          Boolean(p.properties.selected_bundle_rendition_id) ===
            (state.bundle === "selected")) &&
        terms.every((t) =>
          [
            p.title,
            p.summary,
            ...Object.values(p.properties || {}).map(propertyText),
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(t),
        ),
    )
    .sort(
      (a, b) =>
        (a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug)) *
        (state.sort === "-title" ? -1 : 1),
    );
}
export function AudioCatalog({
  pages,
  state,
  publication,
  onNavigate,
}: {
  pages: PageSummary[];
  state: CatalogState;
  publication?: string;
  onNavigate?: (href: string) => void;
}) {
  const update = (patch: Partial<CatalogState>) => {
    const href = catalogHref({ ...state, offset: 0, ...patch }, publication);
    if (onNavigate) onNavigate(href);
    else location.hash = href;
  };
  const matches = filterAudio(pages, state),
    rows = matches.slice(state.offset, state.offset + 50);
  return (
    <section className="catalog-page" aria-label="Audio catalog">
      <div className="page-eyebrow">PUBLISHED CATALOG</div>
      <h1 className="page-title">Audio</h1>
      <p>
        Recordings and their selected extractions. Generated analysis is
        distinct from reviewed wiki summaries.
      </p>
      <nav className="catalog-tabs" aria-label="Catalogs">
        {catalogTypes.map((type) => (
          <a
            key={type}
            href={catalogHref({ type }, publication)}
            aria-current={type === "audio_recording" ? "page" : undefined}
          >
            {catalogLabels[type]}
          </a>
        ))}
      </nav>
      <div className="catalog-filters">
        <label>
          Search recordings
          <input
            type="search"
            value={state.query}
            onChange={(e) => update({ query: e.target.value })}
          />
        </label>
        <label>
          Language
          <select
            value={state.language || ""}
            onChange={(e) => update({ language: e.target.value })}
          >
            <option value="">All</option>
            {[
              ...new Set(
                pages
                  .filter(
                    (p) => p.properties?.catalog_type === "audio_recording",
                  )
                  .map((p) => p.properties?.language)
                  .filter((v): v is string => typeof v === "string"),
              ),
            ]
              .sort()
              .map((v) => (
                <option key={v}>{v}</option>
              ))}
          </select>
        </label>
        <label>
          Bundle availability
          <select
            value={state.bundle || ""}
            onChange={(e) => update({ bundle: e.target.value })}
          >
            <option value="">All</option>
            <option value="selected">Selected bundle</option>
            <option value="none">No selected bundle</option>
          </select>
        </label>
        <label>
          Sort
          <select
            value={state.sort}
            onChange={(e) => update({ sort: e.target.value })}
          >
            <option value="title">Name ↑</option>
            <option value="-title">Name ↓</option>
          </select>
        </label>
        <button onClick={() => update({ query: "", language: "", bundle: "" })}>
          Clear filters
        </button>
      </div>
      <p role="status">{matches.length} recordings</p>
      <div className="repository-document-list">
        {rows.map((p) => (
          <article className="repository-document" key={p.id}>
            <h2>
              <a href={pageHref(p.slug, publication)}>{p.title}</a>
            </h2>
            <p>{p.summary}</p>
            <dl>
              {["recorded_at", "language", "duration_seconds"].map((k) => (
                <div key={k}>
                  <dt>{propertyLabel(k)}</dt>
                  <dd>{propertyText(p.properties?.[k])}</dd>
                </div>
              ))}
            </dl>
            <p>
              {p.properties?.selected_bundle_rendition_id
                ? "Selected bundle available"
                : "No selected bundle"}
            </p>
          </article>
        ))}
      </div>
      {!rows.length && <p>No matching recordings in this publication.</p>}
      <nav aria-label="Catalog pagination">
        {state.offset > 0 && (
          <a
            href={catalogHref(
              { ...state, offset: Math.max(0, state.offset - 50) },
              publication,
            )}
          >
            Previous
          </a>
        )}{" "}
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
interface Bundle {
  id: string;
  source: string;
  version_label: string;
  processor: string;
  notes: string;
}
interface Notes {
  artifact_sources: Record<string, string>;
  transcript_rendition: string;
  bundle_sha256: string;
  source_sha256: string;
}
export function bundleNotes(bundle: Bundle): Notes {
  const parsed = JSON.parse(bundle.notes);
  if (
    !parsed ||
    typeof parsed.artifact_sources !== "object" ||
    Array.isArray(parsed.artifact_sources) ||
    !parsed.artifact_sources
  )
    throw new Error("Invalid bundle provenance.");
  id(parsed.transcript_rendition);
  if (Object.keys(parsed.artifact_sources).length > 16)
    throw new Error("Invalid bundle provenance.");
  for (const value of Object.values(parsed.artifact_sources)) id(value);
  return parsed;
}
export async function recordingSource(source: string, space: string) {
  const rows = await query<Source>(
    `SELECT id,title,original_name,original,media_type,source_date,sha256 FROM sources WHERE id='${id(source)}' AND space='${id(space)}' LIMIT 1`,
  );
  if (!rows[0]) throw new Error("Recording evidence is unavailable.");
  return rows[0];
}
export async function readAudioBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error("Protected file unavailable.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("File exceeds the preview limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
export async function protectedBytes(
  source: Source,
  limit: number,
  signal: AbortSignal,
) {
  const generation = sessionGeneration;
  const response = await fetch(await api.originalURL(source), {
    cache: "no-store",
    signal,
  });
  const bytes = await readAudioBytes(response, limit);
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== source.sha256) throw new Error("File checksum does not match.");
  if (
    generation !== sessionGeneration ||
    !pb.authStore.isValid ||
    signal.aborted
  )
    throw new Error("Session changed.");
  return bytes;
}
interface Artifact {
  role: string;
  path: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
}
interface Manifest {
  extraction?: { model?: string };
  configuration?: { generation?: unknown };
  schema_version: string;
  status: string;
  source: { sha256: string };
  stages: Record<string, string>;
  artifacts: Artifact[];
}
export function validateManifest(
  value: unknown,
  notes: Notes,
  audio: Source,
): Manifest {
  const m = value as Manifest;
  if (
    !m ||
    m.schema_version !== "gemini-transcribe.bundle/v2" ||
    m.status !== "complete" ||
    m.source?.sha256 !== audio.sha256 ||
    notes.source_sha256 !== audio.sha256 ||
    !m.stages ||
    m.stages.transcription !== "complete" ||
    !Array.isArray(m.artifacts) ||
    m.artifacts.length > 8
  )
    throw new Error("Invalid bundle manifest.");
  const formats: Record<string, [string, string]> = {
    transcript: ["transcript.json", "application/json"],
    transcript_txt: ["transcript.txt", "text/plain"],
    transcript_srt: ["transcript.srt", "application/x-subrip"],
    analysis: ["analysis.json", "application/json"],
    analysis_md: ["analysis.md", "text/markdown"],
    translation: ["translation.json", "application/json"],
    translation_txt: ["translation.txt", "text/plain"],
    translation_srt: ["translation.srt", "application/x-subrip"],
  };
  const seen = new Set<string>();
  for (const a of m.artifacts) {
    if (
      !a ||
      !formats[a.role] ||
      a.path !== formats[a.role][0] ||
      a.media_type !== formats[a.role][1] ||
      seen.has(a.role) ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !Number.isSafeInteger(a.size_bytes) ||
      a.size_bytes < 1 ||
      !/^[a-z]+\.(json|txt|srt|md)$/.test(a.path) ||
      typeof a.media_type !== "string" ||
      !notes.artifact_sources[a.role]
    )
      throw new Error("Invalid bundle artifact.");
    seen.add(a.role);
  }
  if (
    !["transcript", "transcript_txt", "transcript_srt"].every((role) =>
      seen.has(role),
    )
  )
    throw new Error("Incomplete transcript artifacts.");
  for (const [stage, roles] of [
    ["analysis", ["analysis", "analysis_md"]],
    ["translation", ["translation", "translation_txt", "translation_srt"]],
  ] as const) {
    if (
      !["complete", "skipped"].includes(m.stages[stage]) ||
      roles.some((role) => seen.has(role) !== (m.stages[stage] === "complete"))
    )
      throw new Error("Artifact stages do not match.");
  }
  if (
    Object.keys(notes.artifact_sources).some(
      (role) => role !== "manifest" && !seen.has(role),
    )
  )
    throw new Error("Unbound bundle artifact.");
  generationMetadata(m.configuration?.generation);
  return m;
}
async function verifiedManifest(
  notes: Notes,
  audio: Source,
  space: string,
  signal: AbortSignal,
) {
  const source = await recordingSource(notes.artifact_sources.manifest, space);
  if (source.sha256 !== notes.bundle_sha256)
    throw new Error("Manifest checksum mismatch.");
  const bytes = await protectedBytes(source, 8 * 1024 * 1024, signal);
  return validateManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    notes,
    audio,
  );
}
function boundArtifact(role: string, source: Source, m: Manifest) {
  if (role === "manifest") return;
  const a = m.artifacts.find((a) => a.role === role);
  if (!a || a.sha256 !== source.sha256)
    throw new Error("Artifact does not match manifest.");
  return a;
}
export async function transcriptPassages(
  notes: Notes,
  audio: Source,
  space: string,
  signal: AbortSignal,
) {
  const renditions = await query<{ notes: string }>(
    `SELECT notes FROM renditions WHERE id='${id(notes.transcript_rendition)}' AND source='${id(audio.id)}' AND space='${id(space)}' AND kind='transcript' LIMIT 1`,
  );
  const provenance = JSON.parse(renditions[0]?.notes || "null");
  if (
    !provenance ||
    provenance.schema_version !== "gemini-transcribe.bundle/v2" ||
    provenance.bundle_sha256 !== notes.bundle_sha256 ||
    provenance.source_sha256 !== audio.sha256
  )
    throw new Error("Transcript provenance mismatch.");
  const result: Passage[] = [];
  while (result.length < 10000) {
    const rows = await query<Passage>(
      `SELECT p.id,p.ordinal,p.locator,p.body FROM passages p JOIN renditions r ON r.id=p.rendition WHERE r.id='${id(notes.transcript_rendition)}' AND r.source='${id(audio.id)}' AND r.space='${id(space)}' AND r.kind='transcript' ORDER BY p.ordinal LIMIT 100 OFFSET ${result.length}`,
    );
    if (signal.aborted) throw new Error("Cancelled.");
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new Error("Transcript exceeds preview limit.");
}
// Inspect immutable native locators rather than trusting optional manifest warnings.
export function timingWarnings(passages: Passage[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  let previous: number | undefined;
  for (const p of passages) {
    const segment = /^segment (seg[0-9]+);/.exec(p.locator)?.[1];
    if (!segment || seen.has(segment)) continue;
    seen.add(segment);
    const range = /; seconds ([0-9.]+)-([0-9.]+)/.exec(p.locator);
    if (!range) {
      if (p.locator.includes("timing unavailable"))
        warnings.push(
          `${segment}: Timing unavailable; the generated interval was reversed.`,
        );
      continue;
    }
    const start = Number(range[1]),
      end = Number(range[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
      warnings.push(
        `${segment}: Timing unavailable; the generated interval is invalid.`,
      );
    if (previous !== undefined && start < previous)
      warnings.push(
        `${segment}: Start precedes the previous segment. Check the recording before relying on conversational order.`,
      );
    previous = start;
  }
  return warnings;
}
export function timingLocator(locator: string): string {
  const range = /; seconds ([0-9.]+)-([0-9.]+)/.exec(locator);
  return range && Number(range[1]) > Number(range[2])
    ? locator.replace(range[0], "; timing unavailable (reversed interval)")
    : locator;
}
export function TimingWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <aside aria-label="Transcript timing warnings" role="note">
      <p>
        Timing warnings: text and segment order are preserved. Review affected
        passages against the recording; unavailable timing cannot be used for
        playback ranges.
      </p>
      <ul>
        {warnings.slice(0, 10).map((warning, i) => (
          <li key={i}>{warning}</li>
        ))}
      </ul>
      {warnings.length > 10 && (
        <p>{warnings.length - 10} additional timing warnings.</p>
      )}
    </aside>
  );
}
export function validateAnalysis(value: unknown, passages: Passage[]) {
  const a = value as Record<string, unknown>;
  const segments = new Set(
    passages.map((p) => /^segment (seg[0-9]+);/.exec(p.locator)?.[1]),
  );
  if (!a || a.schema_version !== "gemini-transcribe.analysis/v1")
    throw new Error("Invalid analysis schema.");
  const allowed = [
    "schema_version",
    "summary",
    "topics",
    "decisions",
    "action_items",
    "questions",
    "speaker_mappings",
  ];
  if (Object.keys(a).some((k) => !allowed.includes(k)))
    throw new Error("Unsupported analysis fields.");
  let nodes = 0;
  for (const field of [
    "summary",
    "topics",
    "decisions",
    "action_items",
    "questions",
    "speaker_mappings",
  ]) {
    const entries = a[field];
    if (!Array.isArray(entries) || entries.length > 1000)
      throw new Error("Invalid analysis fields.");
    for (const item of entries) {
      nodes +=
        1 +
        Object.keys(item || {}).length +
        (Array.isArray(item?.segment_ids) ? item.segment_ids.length : 0);
      if (
        nodes > 10000 ||
        Object.keys(item || {}).length > 12 ||
        Object.entries(item || {}).some(
          ([k, v]) =>
            k !== "segment_ids" &&
            v !== null &&
            (typeof v !== "string" || v.length > 100000),
        )
      )
        throw new Error("Analysis preview bounds exceeded.");
      if (
        !item ||
        typeof item !== "object" ||
        !Array.isArray(item.segment_ids) ||
        !item.segment_ids.length ||
        item.segment_ids.length > 1000 ||
        item.segment_ids.some(
          (s: unknown) => typeof s !== "string" || !segments.has(s),
        )
      )
        throw new Error("Invalid analysis references.");
    }
  }
  const { schema_version: _schema, ...content } = a;
  return content;
}
export function validateTranslation(value: unknown, passages: Passage[]) {
  const tr = value as {
    schema_version: string;
    target_language: string;
    segments: { segment_id: string; text: string }[];
  };
  const originals = new Map<string, Passage>();
  for (const p of passages) {
    const segment = /^segment (seg[0-9]+);/.exec(p.locator)?.[1];
    if (segment && !originals.has(segment)) originals.set(segment, p);
  }
  if (
    !tr ||
    tr.schema_version !== "gemini-transcribe.translation/v1" ||
    typeof tr.target_language !== "string" ||
    tr.target_language.length > 100 ||
    !Array.isArray(tr.segments) ||
    tr.segments.length !== originals.size
  )
    throw new Error("Invalid translation.");
  const seen = new Set<string>();
  const turns = tr.segments.map((item) => {
    if (
      !item ||
      !originals.has(item.segment_id) ||
      seen.has(item.segment_id) ||
      typeof item.text !== "string" ||
      item.text.length > 100000
    )
      throw new Error("Invalid translation segment.");
    seen.add(item.segment_id);
    const p = originals.get(item.segment_id)!;
    return {
      speaker: p.body.split(": ")[0],
      text: item.text,
      original_segment: item.segment_id,
      timestamp: timingLocator(p.locator),
    };
  });
  return { target_language: tr.target_language, segments: turns };
}
function Structured({
  value,
  depth = 0,
  links = {},
  publication,
}: {
  value: unknown;
  depth?: number;
  links?: Record<string, string[]>;
  publication?: string;
}) {
  if (depth > 10) return <p>Nested content omitted; download the original.</p>;
  if (Array.isArray(value))
    return (
      <ul>
        {value.slice(0, 1000).map((v, i) => (
          <li key={i}>
            <Structured
              value={v}
              depth={depth + 1}
              links={links}
              publication={publication}
            />
          </li>
        ))}
        {value.length > 1000 && (
          <li>Additional items available in original.</li>
        )}
      </ul>
    );
  if (value && typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([k, v]) => (
          <div key={k}>
            <dt>{propertyLabel(k)}</dt>
            <dd>
              <Structured
                value={v}
                depth={depth + 1}
                links={links}
                publication={publication}
              />
            </dd>
          </div>
        ))}
      </dl>
    );
  if (typeof value === "string" && links[value])
    return (
      <span>
        {links[value].map((pid, i) => (
          <a key={pid} href={evidenceHref("passages", pid, "", publication)}>
            {value}
            {links[value].length > 1 ? ` (${i + 1})` : ""}{" "}
          </a>
        ))}
      </span>
    );
  return <span>{value == null ? "—" : String(value)}</span>;
}
export default function AudioRecording(props: {
  page: PageDetail;
  pages: PageSummary[];
  space: string;
  publication?: string;
}) {
  const [session, setSession] = useState(sessionGeneration);
  useEffect(
    () => pb.authStore.onChange(() => setSession(sessionGeneration)),
    [],
  );
  if (!pb.authStore.isValid) return null;
  return (
    <Recording key={`${session}:${props.space}:${props.page.id}`} {...props} />
  );
}
function Recording({
  page,
  pages,
  space,
  publication,
}: {
  page: PageDetail;
  pages: PageSummary[];
  space: string;
  publication?: string;
}) {
  const [source, setSource] = useState<Source | null>(null),
    [bundles, setBundles] = useState<Bundle[]>([]),
    [selected, setSelected] = useState(
      String(page.properties?.selected_bundle_rendition_id || ""),
    );
  const [status, setStatus] = useState(""),
    [audio, setAudio] = useState(""),
    [tab, setTab] = useState(""),
    [preview, setPreview] = useState<unknown>(null),
    [passages, setPassages] = useState<Passage[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [segmentLinks, setSegmentLinks] = useState<Record<string, string[]>>(
    {},
  );
  const [revoked, setRevoked] = useState(false);
  const [provenance, setProvenance] = useState<Manifest | null>(null);
  const [files, setFiles] = useState<Record<string, Source>>({});
  const epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    urls = useRef(new Set<string>()),
    player = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const s = await recordingSource(
          String(page.properties?.audio_source_id),
          space,
        );
        if (!s.media_type.startsWith("audio/"))
          throw new Error("Source is not audio.");
        const b = await query<Bundle>(
          `SELECT id,source,version_label,processor,notes FROM renditions WHERE source='${id(s.id)}' AND space='${id(space)}' AND kind='transcript-bundle' ORDER BY version_label,id LIMIT 101`,
        );
        if (b.length > 100)
          throw new Error("Too many extraction versions to preview.");
        if (active) {
          setSource(s);
          setBundles(b);
        }
      } catch {
        if (active) setStatus("Recording evidence unavailable.");
      }
    })();
    return () => {
      active = false;
      epoch.current++;
      for (const c of controllers.current) c.abort();
      for (const url of urls.current) URL.revokeObjectURL(url);
      player.current?.pause();
    };
  }, [page.id, space]);
  useEffect(() => {
    const check = async () => {
      try {
        await recordingSource(String(page.properties?.audio_source_id), space);
      } catch {
        epoch.current++;
        for (const c of controllers.current) c.abort();
        player.current?.pause();
        for (const url of urls.current) URL.revokeObjectURL(url);
        urls.current.clear();
        setAudio("");
        setPreview(null);
        setPassages([]);
        setWarnings([]);
        setFiles({});
        setProvenance(null);
        setSource(null);
        setBundles([]);
        setRevoked(true);
      }
    };
    const timer = window.setInterval(() => void check(), 30000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [page.id, space]);
  const clear = () => {
    epoch.current++;
    for (const c of controllers.current) c.abort();
    controllers.current.clear();
    setPreview(null);
    setSegmentLinks({});
    setPassages([]);
    setWarnings([]);
    setFiles({});
    setProvenance(null);
    setStatus("");
    setTab("");
  };
  const execute = async (fn: (signal: AbortSignal) => Promise<void>) => {
    const c = new AbortController();
    controllers.current.add(c);
    try {
      await fn(c.signal);
    } catch {
      if (!c.signal.aborted)
        setStatus(
          "Unable to load protected recording evidence. Check access or retry.",
        );
    } finally {
      controllers.current.delete(c);
    }
  };
  const loadAudio = () =>
    void execute(async (signal) => {
      if (!source) return;
      setStatus("Loading audio…");
      const bytes = await protectedBytes(source, 100 * 1024 * 1024, signal);
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: source.media_type }),
      );
      urls.current.add(url);
      setAudio(url);
      setStatus("");
    });
  const bundle = bundles.find((b) => b.id === selected);
  const load = (kind: string) => {
    clear();
    setTab(kind);
    const current = epoch.current;
    void execute(async (signal) => {
      if (!bundle) throw new Error("No selected bundle.");
      const notes = bundleNotes(bundle);
      setStatus("Loading evidence…");
      const manifest = await verifiedManifest(notes, source!, space, signal);
      if (kind === "Transcript") {
        const rows = await transcriptPassages(notes, source!, space, signal);
        if (current === epoch.current) {
          setPassages(rows);
          setWarnings(timingWarnings(rows));
        }
      } else if (kind === "Files and provenance") {
        const result: Record<string, Source> = {};
        for (const [role, sourceId] of Object.entries(notes.artifact_sources)) {
          result[role] = await recordingSource(sourceId, space);
          boundArtifact(role, result[role], manifest);
          if (signal.aborted) return;
        }
        if (current === epoch.current) {
          setFiles(result);
          setProvenance(manifest);
        }
      } else {
        const role = kind === "Analysis" ? "analysis" : "translation";
        if (!notes.artifact_sources[role]) {
          if (current === epoch.current)
            setStatus(`${kind} was skipped or is unavailable in this bundle.`);
          return;
        }
        const artifact = await recordingSource(
          notes.artifact_sources[role],
          space,
        );
        const descriptor = boundArtifact(role, artifact, manifest)!;
        const bytes = await protectedBytes(artifact, 8 * 1024 * 1024, signal);
        if (bytes.byteLength !== descriptor.size_bytes)
          throw new Error("Artifact size mismatch.");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const native = await transcriptPassages(notes, source!, space, signal);
        const value =
          kind === "Analysis"
            ? validateAnalysis(JSON.parse(text), native)
            : validateTranslation(JSON.parse(text), native);
        if (current === epoch.current) {
          const links: Record<string, string[]> = {};
          for (const p of native) {
            const segment = /^segment (seg[0-9]+);/.exec(p.locator)?.[1];
            if (segment) (links[segment] ??= []).push(p.id);
          }
          setWarnings(timingWarnings(native));
          setSegmentLinks(links);
          setPreview(value);
        }
      }
      if (current === epoch.current) setStatus("");
    });
  };
  const download = (file: Source) =>
    void execute(async (signal) => {
      setStatus("Preparing download…");
      const bytes = await protectedBytes(file, 8 * 1024 * 1024, signal);
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
      );
      urls.current.add(url);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.original_name;
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }, 1000);
      setStatus("");
    });
  if (revoked)
    return (
      <section aria-label="Audio recording">
        <p role="alert">
          Recording access is no longer available. Reload after checking your
          access.
        </p>
      </section>
    );
  return (
    <section className="audio-recording" aria-label="Audio recording">
      <h2>Recording</h2>
      <p>
        Generated transcripts and analysis are extraction claims, not reviewed
        wiki conclusions. Timestamps are approximate.
      </p>
      {source && (
        <>
          <p>
            <a href={evidenceHref("sources", source.id, "", publication)}>
              Original audio source
            </a>
          </p>
          {!audio ? (
            <button onClick={loadAudio}>Load audio</button>
          ) : (
            <audio
              ref={player}
              controls
              preload="none"
              src={audio}
              aria-label="Recording audio"
              onError={() => {
                setAudio("");
                setStatus("Audio playback unavailable.");
              }}
            />
          )}
        </>
      )}
      {["summary_pages", "transcript_pages"].map((key) => (
        <div key={key}>
          <h3>
            {key === "summary_pages"
              ? "Reviewed wiki summaries"
              : "Reviewed wiki transcripts"}
          </h3>
          {(!Array.isArray(page.properties?.[key]) ||
            !(page.properties![key] as string[]).length) && (
            <p>
              {key === "summary_pages"
                ? "No reviewed summary linked."
                : "No reviewed transcript linked."}
            </p>
          )}
          {Array.isArray(page.properties?.[key]) &&
            (page.properties![key] as string[]).map((pid) => {
              const target = pages.find((p) => p.page === pid);
              return target ? (
                <p key={pid}>
                  <a href={pageHref(target.slug, publication)}>
                    {target.title}
                  </a>
                </p>
              ) : null;
            })}
        </div>
      ))}
      <label>
        Extraction version
        <select
          value={selected}
          onChange={(e) => {
            clear();
            setSelected(e.target.value);
          }}
        >
          <option value="">No bundle selected</option>
          {bundles.map((b) => (
            <option key={b.id} value={b.id}>
              {b.version_label}
              {b.id === page.properties?.selected_bundle_rendition_id
                ? " (published selection)"
                : ""}
            </option>
          ))}
        </select>
      </label>
      {selected && !bundle && <p>Selected bundle unavailable.</p>}
      {bundle && (
        <>
          <p>
            Processor: {bundle.processor}. Browsing another version does not
            change this publication.
          </p>
          {page.properties?.timing_review_bundle_rendition_id === selected &&
            typeof page.properties?.timing_review_note === "string" && (
              <p>Published timing review: {page.properties.timing_review_note}</p>
            )}
          <div className="audio-tabs" role="group" aria-label="Bundle views">
            {[
              "Transcript",
              "Analysis",
              "Translation",
              "Files and provenance",
            ].map((kind) => (
              <button
                key={kind}
                aria-pressed={tab === kind}
                onClick={() => load(kind)}
              >
                {kind}
              </button>
            ))}
          </div>
        </>
      )}
      {status && <p role="status">{status}</p>}
      {tab && <h3>{tab}</h3>}
      <TimingWarnings warnings={warnings} />
      {passages.map((p) => (
        <article key={p.id}>
          <a href={evidenceHref("passages", p.id, "", publication)}>
            {timingLocator(p.locator)}
          </a>
          <p>{p.body}</p>
        </article>
      ))}
      {preview !== null &&
        (tab === "Analysis" ? (
          <div className="audio-analysis">
            <Structured
              value={preview}
              links={segmentLinks}
              publication={publication}
            />
          </div>
        ) : (
          <div className="audio-analysis">
            <Structured
              value={preview}
              links={segmentLinks}
              publication={publication}
            />
          </div>
        ))}
      {provenance && (
        <GenerationProvenance
          value={provenance.configuration?.generation}
          model={provenance.extraction?.model}
        />
      )}
      {Object.entries(files).map(([role, file]) => (
        <p key={role}>
          <a href={evidenceHref("sources", file.id, "", publication)}>
            {propertyLabel(role)}
          </a>{" "}
          <button onClick={() => download(file)}>
            Download {propertyLabel(role)}
          </button>
        </p>
      ))}
      {Object.keys(files).length > 0 && (
        <p>
          Manifest and analysis retain hashes, speaker mappings, reviewed
          overrides and extraction provenance. Artifacts are derived from one
          recording, not independent corroboration.
        </p>
      )}
    </section>
  );
}
