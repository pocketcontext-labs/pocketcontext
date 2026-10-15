import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  AudioCatalog,
  TimingWarnings,
  timingWarnings,
  timingLocator,
  bundleNotes,
  filterAudio,
  readAudioBytes,
  validateAnalysis,
  validateManifest,
} from "./Audio";
import { catalogHref, type CatalogState } from "./Catalog";
import type { PageSummary, Source } from "./types";

afterEach(cleanup);
const state: CatalogState = {
  type: "audio_recording",
  query: "",
  provider: "",
  deployment: "",
  lifecycle: "",
  missingOwner: false,
  sort: "title",
  offset: 0,
};
const page: PageSummary = {
  id: "revision",
  page: "recording",
  slug: "recording",
  kind: "entity",
  title: "Team review",
  summary: "Planning",
  properties: {
    catalog_type: "audio_recording",
    language: "English",
    selected_bundle_rendition_id: "bundle000000001",
  },
};
const source = { id: "audio0000000001", sha256: "a".repeat(64) } as Source;
const notes = {
  artifact_sources: {
    manifest: "manifest0000001",
    transcript: "transcript00001",
    transcript_txt: "transcripttxt01",
    transcript_srt: "transcriptsrt01",
  },
  transcript_rendition: "rendition000001",
  bundle_sha256: "b".repeat(64),
  source_sha256: source.sha256,
};
const manifest = {
  schema_version: "gemini-transcribe.bundle/v2",
  status: "complete",
  source: { sha256: source.sha256 },
  stages: {
    transcription: "complete",
    analysis: "skipped",
    translation: "skipped",
  },
  artifacts: [
    {
      role: "transcript",
      path: "transcript.json",
      sha256: "c".repeat(64),
      size_bytes: 100,
      media_type: "application/json",
    },
    {
      role: "transcript_txt",
      path: "transcript.txt",
      sha256: "d".repeat(64),
      size_bytes: 20,
      media_type: "text/plain",
    },
    {
      role: "transcript_srt",
      path: "transcript.srt",
      sha256: "e".repeat(64),
      size_bytes: 20,
      media_type: "application/x-subrip",
    },
  ],
};
it("filters recordings within published pages with shareable language and bundle state", () => {
  const other = {
    ...page,
    id: "other",
    properties: { catalog_type: "resource" },
  };
  expect(
    filterAudio([page, other], {
      ...state,
      query: "english planning",
      language: "English",
      bundle: "selected",
    }),
  ).toEqual([page]);
  expect(filterAudio([page], { ...state, bundle: "none" })).toEqual([]);
  expect(
    catalogHref(
      { ...state, language: "English", bundle: "selected" },
      "history",
    ),
  ).toContain("language=English&bundle=selected");
});
it("renders accessible recording links and filter controls without downloading evidence", () => {
  render(<AudioCatalog pages={[page]} state={state} publication="history" />);
  expect(screen.getByRole("region", { name: "Audio catalog" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Team review" })).toHaveAttribute(
    "href",
    expect.stringContaining("publication=history"),
  );
  expect(
    screen.getByRole("combobox", { name: "Bundle availability" }),
  ).toBeVisible();
  expect(screen.queryByRole("audio")).toBeNull();
});
it("validates bundle notes without filename guessing", () => {
  expect(
    bundleNotes({
      id: "bundle000000001",
      source: source.id,
      version_label: "v2",
      processor: "test",
      notes: JSON.stringify(notes),
    }),
  ).toEqual(notes);
  expect(() =>
    bundleNotes({
      id: "x",
      source: "x",
      version_label: "x",
      processor: "x",
      notes: JSON.stringify({
        ...notes,
        artifact_sources: { analysis: "../secret" },
      }),
    }),
  ).toThrow();
});
it("rejects incomplete, cross-source, duplicate and unbound artifact manifests", () => {
  expect(validateManifest(manifest, notes, source)).toEqual(manifest);
  expect(() =>
    validateManifest({ ...manifest, status: "partial" }, notes, source),
  ).toThrow();
  expect(() =>
    validateManifest(manifest, notes, { ...source, sha256: "wrong" }),
  ).toThrow();
  expect(() =>
    validateManifest(
      {
        ...manifest,
        artifacts: [...manifest.artifacts, ...manifest.artifacts],
      },
      notes,
      source,
    ),
  ).toThrow();
  expect(() =>
    validateManifest(
      manifest,
      {
        ...notes,
        artifact_sources: {
          ...notes.artifact_sources,
          analysis: "analysis0000001",
        },
      },
      source,
    ),
  ).toThrow();
});
it("rejects unknown analysis references and schema versions", () => {
  const analysis = {
    schema_version: "gemini-transcribe.analysis/v1",
    summary: [{ text: "Review", segment_ids: ["seg000001"] }],
    topics: [],
    decisions: [],
    action_items: [],
    questions: [],
    speaker_mappings: [],
  };
  const passages = [
    {
      id: "passage",
      ordinal: 1,
      locator: "segment seg000001; seconds 0.000-1.000",
      body: "Synthetic",
    },
  ];
  expect(validateAnalysis(analysis, passages)).toEqual(
    expect.objectContaining({ summary: analysis.summary }),
  );
  expect(() => validateAnalysis(analysis, [])).toThrow();
  expect(() =>
    validateAnalysis({ ...analysis, schema_version: "other" }, passages),
  ).toThrow();
});
it("bounds streamed protected file reads before buffering oversized content", async () => {
  const response = (size: number) =>
    ({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(size));
          c.close();
        },
      }),
    }) as Response;
  expect((await readAudioBytes(response(4), 4)).length).toBe(4);
  await expect(readAudioBytes(response(5), 4)).rejects.toThrow("preview limit");
  await expect(readAudioBytes({ ok: false } as Response, 4)).rejects.toThrow(
    "unavailable",
  );
});

it("preserves segment order and text while warning on backwards and reversed timing", () => {
  const passages = [
    {
      id: "a",
      ordinal: 1,
      locator: "segment seg000001; seconds 10.000-15.000",
      body: "First",
    },
    {
      id: "b",
      ordinal: 2,
      locator: "segment seg000002; seconds 9.000-12.000",
      body: "Second",
    },
    {
      id: "c",
      ordinal: 3,
      locator: "segment seg000003; seconds 15.000-10.000",
      body: "Third",
    },
    {
      id: "d",
      ordinal: 4,
      locator: "segment seg000004; timing unavailable (reversed interval)",
      body: "Fourth",
    },
  ];
  const original = JSON.stringify(passages);
  const warnings = timingWarnings(passages);
  expect(warnings).toHaveLength(3);
  expect(warnings[0]).toContain("seg000002: Start precedes");
  expect(timingLocator(passages[2].locator)).toBe(
    "segment seg000003; timing unavailable (reversed interval)",
  );
  expect(JSON.stringify(passages)).toBe(original);
  render(<TimingWarnings warnings={warnings} />);
  expect(
    screen.getByRole("note", { name: "Transcript timing warnings" }),
  ).toHaveTextContent("Review affected passages");
  expect(screen.queryByRole("link")).toBeNull();
});
it("accepts overlap and ignores repeated chunks of a single segment", () => {
  const passages = [
    {
      id: "a",
      ordinal: 1,
      locator: "segment seg000001; seconds 10.000-15.000",
      body: "One",
    },
    {
      id: "b",
      ordinal: 2,
      locator: "segment seg000002; seconds 12.000-16.000",
      body: "Two",
    },
    {
      id: "c",
      ordinal: 3,
      locator: "segment seg000002; seconds 12.000-16.000",
      body: "continued",
    },
  ];
  expect(timingWarnings(passages)).toEqual([]);
  expect(timingLocator(passages[0].locator)).toBe(passages[0].locator);
});
