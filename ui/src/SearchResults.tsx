import { useEffect, useRef, useState } from "react";
import { api, SearchChangedError, type SearchPage } from "./api";
import { pageHref } from "./Markdown";
import { highlightSearchText, searchExcerpt } from "./searchText";

function HighlightedText({ text, query }: { text: string; query: string }) {
  return highlightSearchText(text, query).map((part, index) =>
    part.match ? (
      <mark className="search-highlight" key={index}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}
export function searchHref(query: string, publication?: string, slug = "") {
  const url = pageHref(slug, publication);
  return `${url}${url.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;
}
export default function SearchResults({
  publication,
  query,
  visible,
  epoch,
}: {
  publication?: string;
  query: string;
  visible: boolean;
  epoch: number;
}) {
  const [result, setResult] = useState<SearchPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const savedScroll = useRef(0);
  const savedFocus = useRef("");
  useEffect(() => {
    const own = ++request.current;
    savedScroll.current = 0;
    savedFocus.current = "";
    setResult(null);
    setError("");
    setChanged(false);
    if (!publication || !query.trim()) {
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      api
        .searchPages(publication, query)
        .then((value) => {
          if (request.current === own) setResult(value);
        })
        .catch((e) => {
          if (request.current === own) {
            setError(
              e instanceof Error
                ? e.message
                : "Search unavailable. Please retry.",
            );
            setChanged(e instanceof SearchChangedError);
          }
        })
        .finally(() => {
          if (request.current === own) setBusy(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [publication, query, retry, epoch]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById("reader")?.scrollTo(0, savedScroll.current);
      if (savedFocus.current)
        document
          .querySelector<HTMLElement>(
            `[data-search-hit="${savedFocus.current}"]`,
          )
          ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, query, publication]);
  const more = async () => {
    if (!publication || !result || busy) return;
    const own = ++request.current;
    setBusy(true);
    setError("");
    try {
      const next = await api.searchPages(
        publication,
        query,
        result.hits.length,
        20,
        result.generation,
      );
      if (own === request.current) {
        if (
          next.hits.some((hit) => result.hits.some((old) => old.id === hit.id))
        )
          throw new SearchChangedError();
        setResult({ ...next, hits: [...result.hits, ...next.hits] });
      }
    } catch (e) {
      if (own === request.current) {
        if (e instanceof SearchChangedError) {
          setResult(null);
          setChanged(true);
        }
        setError(
          e instanceof Error ? e.message : "Search unavailable. Please retry.",
        );
      }
    } finally {
      if (own === request.current) setBusy(false);
    }
  };
  return (
    <section
      className="search-view"
      hidden={!visible}
      aria-label="Search results"
      aria-busy={busy}
    >
      <div className="page-eyebrow">PUBLISHED KNOWLEDGE</div>
      <h1 className="page-title">Search results</h1>
      <p className="page-summary">Matches for “{query}”</p>
      <p className="search-status" role="status">
        {busy
          ? "Searching…"
          : result
            ? `${result.hits.length}${result.hasMore ? "+" : ""} results`
            : ""}
      </p>
      {error && (
        <div role="alert" className="search-error">
          {error}{" "}
          <button
            onClick={() => {
              if (result && !changed) void more();
              else setRetry((n) => n + 1);
            }}
          >
            {changed ? "Restart search" : "Retry search"}
          </button>
        </div>
      )}
      {result && !result.hits.length && (
        <p>No published pages match. Try fewer or different words.</p>
      )}
      <ol className="search-results">
        {result?.hits.map((hit) => (
          <li key={hit.id}>
            <span className="page-eyebrow">{hit.kind}</span>
            <h2>
              <a
                data-search-hit={hit.id}
                aria-label={hit.title}
                href={searchHref(query, publication, hit.slug)}
                onClick={() => {
                  savedFocus.current = hit.id;
                  savedScroll.current =
                    document.getElementById("reader")?.scrollTop || 0;
                }}
              >
                <HighlightedText text={hit.title} query={query} />
              </a>
            </h2>
            <p className="search-excerpt">
              <HighlightedText
                text={searchExcerpt(hit.excerpt)}
                query={query}
              />
            </p>
          </li>
        ))}
      </ol>
      {result?.hasMore && !error && (
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
