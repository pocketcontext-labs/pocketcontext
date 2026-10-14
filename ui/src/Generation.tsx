/** Display only versioned, bounded receipts from the hash-verified selected manifest. */
export interface Generation {
  schema_version: "gemini-transcribe.generation/v1";
  pipeline: "standard" | "long-decode";
  api: string;
  sdk_version: string;
  stages: Record<
    string,
    {
      status: string;
      continuation_count: number;
      hops: { usage?: Record<string, number>; finish_reason?: string }[];
    }[]
  >;
}
const usageKeys = [
  "prompt_token_count",
  "cached_content_token_count",
  "candidates_token_count",
  "thoughts_token_count",
  "total_token_count",
  "initial_prompt_token_count",
];
export function generationMetadata(value: unknown): Generation | null {
  if (!value || typeof value !== "object" || !("schema_version" in value))
    return null;
  const g = value as Generation;
  if (
    g.schema_version !== "gemini-transcribe.generation/v1" ||
    !["standard", "long-decode"].includes(g.pipeline) ||
    g.api !==
      (g.pipeline === "standard" ? "interactions" : "generate_content") ||
    typeof g.sdk_version !== "string" ||
    g.sdk_version.length > 100 ||
    !g.stages ||
    typeof g.stages !== "object" ||
    Array.isArray(g.stages)
  )
    throw new Error("Invalid generation provenance.");
  for (const [stage, attempts] of Object.entries(g.stages)) {
    if (
      !["transcription", "analysis", "translation"].includes(stage) ||
      !Array.isArray(attempts) ||
      attempts.length > 100
    )
      throw new Error("Invalid generation stage.");
    for (const a of attempts) {
      if (
        !a ||
        !["complete", "failed"].includes(a.status) ||
        !Number.isSafeInteger(a.continuation_count) ||
        a.continuation_count < 0 ||
        !Array.isArray(a.hops) ||
        a.hops.length > 100
      )
        throw new Error("Invalid generation attempt.");
      if (
        a.continuation_count !==
        a.hops.filter((h) => h?.finish_reason === "CONTINUATION").length
      )
        throw new Error("Incorrect continuation count.");
      for (const h of a.hops) {
        if (
          !h ||
          (h.usage !== undefined &&
            (typeof h.usage !== "object" ||
              h.usage === null ||
              Array.isArray(h.usage) ||
              Object.entries(h.usage).some(
                ([key, v]) =>
                  !usageKeys.includes(key) || !Number.isSafeInteger(v) || v < 0,
              )))
        )
          throw new Error("Invalid generation usage.");
      }
    }
  }
  return g;
}
function reported(attempts: Generation["stages"][string], key: string) {
  const hops = attempts.flatMap((a) => a.hops);
  if (
    attempts.some((a) => !a.hops.length) ||
    !hops.length ||
    hops.some((h) => h.usage?.[key] === undefined)
  )
    return "Unavailable";
  const sum = hops.reduce((total, h) => total + h.usage![key], 0);
  return Number.isSafeInteger(sum)
    ? sum.toLocaleString("en-US")
    : "Unavailable";
}
export function GenerationProvenance({
  value,
  model,
}: {
  value: unknown;
  model?: string;
}) {
  const g = generationMetadata(value);
  return (
    <section aria-label="Generation provenance">
      <h3>Generation provenance</h3>
      <p>Model: {typeof model === "string" ? model : "Unavailable"}</p>
      {!g ? (
        <p>Pipeline and usage: Unavailable for this historical bundle.</p>
      ) : (
        <>
          <p>
            Pipeline:{" "}
            {g.pipeline === "long-decode"
              ? "Long decode (continuation enabled)"
              : "Standard"}
            . API: {g.api}. SDK: {g.sdk_version}.
          </p>
          {Object.entries(g.stages).map(([stage, attempts]) => (
            <div key={stage}>
              <h4>{stage[0].toUpperCase() + stage.slice(1)}</h4>
              <p>
                Recorded attempts: {attempts.length}. Continuation responses:{" "}
                {attempts.reduce((n, a) => n + a.continuation_count, 0)}.
              </p>
              <dl>
                {[
                  ["Input tokens", "prompt_token_count"],
                  ["Cached input tokens", "cached_content_token_count"],
                  ["Output tokens", "candidates_token_count"],
                  ["Thinking tokens", "thoughts_token_count"],
                  ["Total tokens", "total_token_count"],
                ].map(([label, key]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{reported(attempts, key)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <p>
            Counts include recorded failed attempts. Missing provider counts are
            unavailable, not zero. Token usage is not a billing invoice.
          </p>
        </>
      )}
    </section>
  );
}
