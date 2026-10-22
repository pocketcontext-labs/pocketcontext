import { Markdown } from "./Markdown";
import { isMarkdownSource } from "./sourceRanges";
import type { Source } from "./types";

export function EvidenceExcerpt({
  body,
  source,
}: {
  body: string;
  source?: Pick<Source, "media_type" | "original_name">;
}) {
  return isMarkdownSource(source) ? (
    <div className="evidence-excerpt markdown">
      <Markdown body={body} mode="source" />
    </div>
  ) : (
    <pre className="evidence-excerpt source-text">{body}</pre>
  );
}
