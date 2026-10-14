import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { GenerationProvenance, generationMetadata } from "./Generation";
afterEach(cleanup);
const g = {
  schema_version: "gemini-transcribe.generation/v1",
  pipeline: "long-decode",
  api: "generate_content",
  sdk_version: "2.30.1",
  stages: {
    transcription: [
      {
        status: "complete",
        continuation_count: 1,
        hops: [
          {
            finish_reason: "CONTINUATION",
            usage: { prompt_token_count: 100, candidates_token_count: 50 },
          },
          { usage: { prompt_token_count: 100, candidates_token_count: 20 } },
        ],
      },
    ],
  },
};
it("shows actual continuation and per-hop totals without assuming missing thinking is zero", () => {
  render(<GenerationProvenance value={g} model="synthetic-model" />);
  expect(screen.getByText(/Long decode \(continuation enabled\)/)).toBeTruthy();
  expect(screen.getByText(/Continuation responses: 1/)).toBeTruthy();
  expect(screen.getByText("200")).toBeTruthy();
  expect(screen.getByText("70")).toBeTruthy();
  expect(screen.getAllByText("Unavailable").length).toBe(3);
});
it("does not infer a pipeline for historical metadata", () => {
  expect(generationMetadata({ prototype: "old" })).toBeNull();
  render(<GenerationProvenance value={undefined} />);
  expect(screen.getByText(/Pipeline and usage: Unavailable/)).toBeTruthy();
});
it("rejects invalid usage and unknown versioned metadata", () => {
  expect(() =>
    generationMetadata({ ...g, schema_version: "unknown" }),
  ).toThrow();
  expect(() =>
    generationMetadata({
      ...g,
      stages: {
        transcription: [
          {
            status: "complete",
            continuation_count: 0,
            hops: [{ usage: { thoughts_token_count: -1 } }],
          },
        ],
      },
    }),
  ).toThrow();
});

it("does not sum incomplete attempt usage as a complete total", () => {
  render(
    <GenerationProvenance
      value={{
        ...g,
        stages: {
          transcription: [
            { status: "failed", continuation_count: 0, hops: [] },
            ...g.stages.transcription,
          ],
        },
      }}
    />,
  );
  expect(screen.queryByText("200")).toBeNull();
  expect(screen.getAllByText("Unavailable").length).toBe(5);
});
