import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { isMarkdownSource, verifySourceRange } from "./sourceRanges";
import type { Passage, Source } from "./types";

export function SourceContent({
  text,
  source,
  passage,
  passageRequested = false,
  passageLoading = false,
}: {
  text: string;
  source: Pick<Source, "id" | "media_type" | "original_name">;
  passage?: Pick<Passage, "id" | "body" | "locator"> | null;
  passageRequested?: boolean;
  passageLoading?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const manualView = useRef(false);
  const [exact, setExact] = useState(false);
  const verified = useMemo(
    () => (passage ? verifySourceRange(text, passage) : null),
    [text, passage],
  );
  const markdown = isMarkdownSource(source);
  const shownText = verified?.text ?? text;
  useEffect(() => {
    manualView.current = false;
    setExact(false);
  }, [text, passage?.id]);
  useEffect(() => {
    if (!verified) return;
    const target = content.current?.querySelector<HTMLElement>(
      "[data-source-highlight]",
    );
    if (
      !manualView.current &&
      markdown &&
      !exact &&
      (!target ||
        content.current?.querySelector("[data-source-range-fallback]"))
    ) {
      setExact(true);
      return;
    }
    target?.scrollIntoView?.({ block: "center" });
  }, [verified, exact, markdown]);
  const plain = (
    <pre className="source-text">
      {verified ? (
        <>
          {shownText.slice(0, verified.range.start)}
          <mark className="source-highlight" data-source-highlight="true">
            {shownText.slice(verified.range.start, verified.range.end)}
          </mark>
          {shownText.slice(verified.range.end)}
        </>
      ) : (
        shownText
      )}
    </pre>
  );
  return (
    <div className="source-content" ref={content}>
      {passageLoading ? (
        <p role="status">Checking cited passage…</p>
      ) : passageRequested && !verified ? (
        <p className="source-range-note" role="status">
          {passage
            ? "This passage could not be verified against the original. No source range is highlighted."
            : "This passage is unavailable for this original."}
        </p>
      ) : null}
      {verified && (
        <div className="source-range-toolbar">
          <p>
            <strong>Cited passage</strong>
            <span>{passage?.locator}</span>
          </p>
          {markdown && (
            <div role="group" aria-label="Source reading view">
              <button
                aria-pressed={!exact}
                onClick={() => {
                  manualView.current = true;
                  setExact(false);
                }}
              >
                Reading view
              </button>
              <button
                aria-pressed={exact}
                onClick={() => {
                  manualView.current = true;
                  setExact(true);
                }}
              >
                Exact source
              </button>
            </div>
          )}
        </div>
      )}
      {markdown && !exact ? (
        <div className="markdown">
          <Markdown
            body={shownText}
            mode="source"
            highlight={verified?.range}
          />
        </div>
      ) : (
        plain
      )}
      {markdown && exact && verified && (
        <p className="source-range-note">
          Exact source shows the full verified range, including Markdown syntax.
        </p>
      )}
    </div>
  );
}
