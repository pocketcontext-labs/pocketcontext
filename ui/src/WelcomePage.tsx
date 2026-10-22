import { useEffect, useMemo, useRef, useState } from "react";
import { pageHref } from "./Markdown";
import type { PageSummary, Publication } from "./types";
import {
  defaultWelcomeView,
  filterWelcomePages,
  groupWelcomePages,
  groupWelcomePagesByType,
  isWelcomeView,
  onboardingPages,
  WELCOME_TOPICS,
  WELCOME_VIEWS,
  type WelcomeView,
} from "./welcome";
import "./welcome.css";

export default function WelcomePage({
  pages,
  publication,
  recentPages,
  pinned,
  onSearch,
  onTopicChange,
  onViewChange,
  topic: requestedTopic,
  view: requestedView,
}: {
  pages: PageSummary[];
  publication: Publication | null;
  recentPages?: Array<PageSummary & { publishedAt: string }>;
  pinned?: string;
  onSearch: (query: string) => void;
  onTopicChange: (topic: string) => void;
  onViewChange?: (view: WelcomeView) => void;
  topic?: string;
  view?: string;
}) {
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("all");
  const [chosenMode, setChosenMode] = useState<WelcomeView | undefined>(
    isWelcomeView(requestedView) ? requestedView : undefined,
  );
  const directory = useRef<HTMLHeadingElement>(null);
  const groups = useMemo(() => groupWelcomePages(pages), [pages]);
  const guides = useMemo(() => onboardingPages(pages), [pages]);
  const mode = chosenMode ?? defaultWelcomeView(pages);
  useEffect(() => {
    setChosenMode(isWelcomeView(requestedView) ? requestedView : undefined);
    if (isWelcomeView(requestedView)) {
      directory.current?.scrollIntoView?.({ block: "start" });
      directory.current?.focus({ preventScroll: true });
    }
  }, [requestedView]);
  useEffect(() => {
    if (!requestedTopic) {
      setTopic("all");
      return;
    }
    setTopic(
      WELCOME_TOPICS.some((group) => group.id === requestedTopic)
        ? requestedTopic
        : "all",
    );
    directory.current?.scrollIntoView?.({ block: "start" });
    directory.current?.focus({ preventScroll: true });
  }, [requestedTopic]);
  const recent = useMemo(() => {
    const selectedPages = new Map(pages.map((page) => [page.page, page]));
    const seen = new Set<string>();
    const result: Array<PageSummary & { date: Date }> = [];
    for (const item of recentPages ?? []) {
      const selected = selectedPages.get(item.page);
      if (!selected || selected.id !== item.id || seen.has(item.page)) continue;
      const date = new Date(item.publishedAt.replace(" ", "T"));
      if (!Number.isFinite(date.getTime())) continue;
      seen.add(item.page);
      result.push({ ...selected, date });
      if (result.length === 6) break;
    }
    return result;
  }, [pages, recentPages]);
  const selected = groups.find((group) => group.id === topic);
  const filtered = filterWelcomePages(selected?.pages ?? pages, "");
  const results =
    mode === "topics"
      ? groupWelcomePages(filtered)
      : mode === "types"
        ? groupWelcomePagesByType(filtered)
        : [
            {
              id: "alphabetical",
              title: "Alphabetical index",
              pages: filtered,
            },
          ];
  const href = (page: PageSummary) => pageHref(page.slug, pinned);
  const showDirectory = () => {
    directory.current?.scrollIntoView?.({ block: "start" });
    directory.current?.focus({ preventScroll: true });
  };

  return (
    <div className="welcome-page">
      <header className="welcome-intro">
        <div>
          <h1>Home</h1>
          <p>Find an answer or explore the knowledge in this space.</p>
        </div>
        <span className="welcome-count">
          {pages.length} {pages.length === 1 ? "page" : "pages"}
        </span>
      </header>

      <form
        className="welcome-search"
        role="search"
        aria-label="Published pages"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) onSearch(query.trim());
        }}
      >
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          maxLength={500}
          aria-label="Search published pages"
          aria-describedby="welcome-search-note"
          placeholder="Find an answer, topic or guide…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        <button type="submit" disabled={!query.trim()}>
          Search
        </button>
      </form>
      <p className="welcome-search-note" id="welcome-search-note">
        Search page titles, summaries and contents in this publication.
      </p>

      {recent.length > 0 && (
        <section
          className="welcome-recent"
          aria-labelledby="welcome-recent-heading"
        >
          <div className="welcome-section-heading">
            <div>
              <h2 id="welcome-recent-heading">Recently published</h2>
              <p>
                {pinned
                  ? "New and updated pages in this historical view."
                  : "New and updated pages in this space."}
              </p>
            </div>
          </div>
          <ul className="welcome-recent-list">
            {recent.map((page) => (
              <li key={page.page}>
                <a href={href(page)}>
                  <span className="welcome-recent-title">{page.title}</span>
                  {page.summary && (
                    <span className="welcome-recent-summary">
                      {page.summary}
                    </span>
                  )}
                  <time dateTime={page.date.toISOString()}>
                    {page.date.toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {guides.length > 0 && (
        <details className="welcome-onboarding">
          <summary>
            <span>Getting started</span>
            <small>
              {guides.length} {guides.length === 1 ? "guide" : "guides"}
            </small>
          </summary>
          <ol className="welcome-guide-links">
            {guides.map((page) => (
              <li key={page.page}>
                <a href={href(page)}>
                  <strong>{page.title}</strong>
                  {page.summary && <span>{page.summary}</span>}
                </a>
              </li>
            ))}
          </ol>
        </details>
      )}

      {pages.length > 0 && (
        <section aria-labelledby="welcome-topics-heading">
          <div className="welcome-section-heading">
            <div>
              <h2 id="welcome-topics-heading">Explore by topic</h2>
              <p>Find a starting point, then follow the connections.</p>
            </div>
            <button
              onClick={() => {
                setTopic("all");
                onTopicChange("all");
                setQuery("");
                showDirectory();
              }}
            >
              Browse all pages ↓
            </button>
          </div>
          <div className="welcome-topics">
            {groups
              .filter((group) => group.pages.length > 0)
              .map((group, index) => (
                <button
                  className="welcome-topic"
                  aria-pressed={topic === group.id}
                  key={group.id}
                  onClick={() => {
                    setTopic(group.id);
                    onTopicChange(group.id);
                    setQuery("");
                    showDirectory();
                  }}
                >
                  <span className="welcome-topic-top">
                    <span aria-hidden="true">
                      {["↗", "◇", "▦", "⌘", "◎", "✧", "≡", "◷", "+"][index]}
                    </span>
                    <small>{group.pages.length} pages</small>
                  </span>
                  <strong>{group.title}</strong>
                  <span className="welcome-topic-description">
                    {group.description}
                  </span>
                  <span className="welcome-topic-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              ))}
          </div>
        </section>
      )}

      <section
        className="welcome-directory"
        id="welcome-directory"
        aria-labelledby="welcome-directory-heading"
      >
        <div className="welcome-section-heading">
          <div>
            <h2 id="welcome-directory-heading" ref={directory} tabIndex={-1}>
              The complete page index
            </h2>
            <p>Every published page in this view.</p>
          </div>
        </div>
        <div className="welcome-controls">
          <div className="welcome-filter-info">
            <strong>{selected?.title ?? "All topics"}</strong>
            <span role="status">
              {filtered.length} of {pages.length} pages
            </span>
            {topic !== "all" && (
              <button
                onClick={() => {
                  setQuery("");
                  setTopic("all");
                  onTopicChange("all");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
          <div
            className="welcome-segmented"
            role="group"
            aria-label="Index view"
          >
            {WELCOME_VIEWS.map((view) => (
              <button
                key={view.id}
                aria-pressed={mode === view.id}
                onClick={() => {
                  setChosenMode(view.id);
                  onViewChange?.(view.id);
                }}
              >
                {view.title}
              </button>
            ))}
          </div>
        </div>
        {results
          .filter((group) => group.pages.length > 0)
          .map((group) => (
            <section
              className="welcome-index-group"
              aria-labelledby={`welcome-group-${group.id}`}
              key={group.id}
            >
              <div className="welcome-group-heading">
                <h3 id={`welcome-group-${group.id}`}>{group.title}</h3>
                <span>{group.pages.length}</span>
              </div>
              <ul className="welcome-entries">
                {group.pages.map((page) => (
                  <li key={page.page}>
                    <a href={href(page)} title={page.summary || undefined}>
                      <span>{page.title}</span>
                      <span aria-hidden="true">→</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        {filtered.length === 0 && (
          <p className="welcome-empty">
            {pages.length
              ? "No pages in this topic yet. Browse all pages to keep exploring."
              : "No pages have been published in this view yet."}
          </p>
        )}
      </section>
      <footer className="welcome-footer">
        <span>Published knowledge in this space.</span>
        <span>
          {publication
            ? `${pinned ? "Historical" : "Live"} publication ${publication.sequence}`
            : "No publication yet"}
        </span>
      </footer>
    </div>
  );
}
