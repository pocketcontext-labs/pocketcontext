import { useEffect, useRef, useState } from "react";
import { pb, SearchChangedError } from "./api";
import { SourceSearchForm } from "./SourceDirectory";
import {
  searchSources,
  sourceSearchHitHref,
  SourceSearchUnavailableError,
  type SourceSearchPage,
} from "./sourceSearchApi";
import { highlightSearchText, searchExcerpt } from "./searchText";
import { AgentTextLabel } from "./EvidenceExcerpt";
import { isAgentText } from "./sourceRanges";

function Highlight({ text, query }: { text: string; query: string }) {
  return highlightSearchText(text, query).map((part, n) =>
    part.match ? (
      <mark className="search-highlight" key={n}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}
export default function SourceSearch({
  space,
  query,
  visible,
  epoch,
}: {
  space: string;
  query: string;
  visible: boolean;
  epoch: number;
}) {
  const [result, setResult] = useState<SourceSearchPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const resultScope = useRef({ space, query, epoch });
  const matchesScope =
    resultScope.current.space === space &&
    resultScope.current.query === query &&
    resultScope.current.epoch === epoch;
  useEffect(
    () =>
      pb.authStore.onChange(() => {
        request.current++;
        setResult(null);
        setBusy(false);
        setError("");
        if (pb.authStore.isValid) setRetry((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    const own = ++request.current;
    resultScope.current = { space, query, epoch };
    setResult(null);
    setError("");
    setChanged(false);
    if (!space || !query.trim() || !visible) {
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      searchSources(space, query)
        .then((value) => {
          if (request.current === own) setResult(value);
        })
        .catch((reason) => {
          if (request.current !== own) return;
          setError(
            reason instanceof Error
              ? reason.message
              : "Source search unavailable. Please retry.",
          );
          setChanged(reason instanceof SearchChangedError);
        })
        .finally(() => {
          if (request.current === own) setBusy(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [space, query, epoch, retry, visible]);
  const more = async () => {
    if (!result || busy) return;
    const own = ++request.current;
    setBusy(true);
    setError("");
    try {
      const next = await searchSources(
        space,
        query,
        result.hits.length,
        20,
        result.generation,
      );
      if (request.current !== own) return;
      if (
        next.generation !== result.generation ||
        next.hits.some((hit) => result.hits.some((old) => old.id === hit.id))
      )
        throw new SearchChangedError();
      setResult({ ...next, hits: [...result.hits, ...next.hits] });
    } catch (reason) {
      if (request.current !== own) return;
      // Never leave previously loaded private results visible after denied access.
      if (
        reason instanceof SearchChangedError ||
        (reason instanceof SourceSearchUnavailableError &&
          reason.reason === "not-found")
      )
        setResult(null);
      setChanged(reason instanceof SearchChangedError);
      setError(
        reason instanceof Error
          ? reason.message
          : "Source search unavailable. Please retry.",
      );
    } finally {
      if (request.current === own) setBusy(false);
    }
  };
  const shown = matchesScope ? result : null;
  return (
    <section
      className="search-view source-search"
      hidden={!visible}
      aria-label="Source search results"
      aria-busy={busy}
    >
      <div className="page-eyebrow">SOURCE EVIDENCE</div>
      <h1 className="page-title">Source search results</h1>
      <p className="page-summary">
        Matches for “{query}” in source metadata and extracted text, including
        uncited sources.
      </p>
      {visible && <SourceSearchForm term={query} />}
      <p className="search-status" role="status">
        {busy
          ? "Searching…"
          : shown
            ? `${shown.hits.length}${shown.hasMore ? "+" : ""} sources`
            : ""}
      </p>
      {error && (
        <div role="alert" className="search-error">
          {error}{" "}
          <button
            onClick={() => {
              if (shown && !changed) void more();
              else setRetry((n) => n + 1);
            }}
          >
            {changed ? "Restart search" : "Retry search"}
          </button>
        </div>
      )}
      {shown && !shown.hits.length && (
        <p>No sources match. Try fewer or different words.</p>
      )}
      <ol className="search-results">
        {shown?.hits.map((hit) => (
          <li key={hit.id}>
            <span className="page-eyebrow">
              {hit.passage ? "EXTRACTED PASSAGE" : "SOURCE METADATA"}
            </span>
            {hit.passage && isAgentText(hit) && <AgentTextLabel />}
            <h2>
              <a href={sourceSearchHitHref(space, hit)} aria-label={hit.title}>
                <Highlight text={hit.title} query={query} />
              </a>
            </h2>
            <p className="search-excerpt">
              <Highlight
                text={searchExcerpt(
                  hit.excerpt ||
                    [hit.original_name, hit.source_date]
                      .filter(Boolean)
                      .join(" · "),
                )}
                query={query}
              />
            </p>
            {hit.locator && <small>{hit.locator}</small>}
          </li>
        ))}
      </ol>
      {shown?.hasMore && !error && (
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void more()}
        >
          Load more results
        </button>
      )}
    </section>
  );
}
