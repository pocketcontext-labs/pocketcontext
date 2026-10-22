import { useMemo, useState } from "react";
import { pageHref } from "./Markdown";
import type { PageSummary, Publication } from "./types";
import { groupWelcomePages, onboardingPages } from "./welcome";
import "./welcome.css";

export default function WelcomePage({
  pages,
  publication,
  recentPages,
  pinned,
  onSearch,
  onTopicChange,
  onBrowsePages,
}: {
  pages: PageSummary[];
  publication: Publication | null;
  recentPages?: Array<PageSummary & { publishedAt: string }>;
  pinned?: string;
  onSearch: (query: string) => void;
  onTopicChange: (topic: string) => void;
  onBrowsePages: () => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupWelcomePages(pages), [pages]);
  const guides = useMemo(() => onboardingPages(pages), [pages]);
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
  const href = (page: PageSummary) => pageHref(page.slug, pinned);
  return (
    <div className="welcome-page">
      <header className="welcome-intro">
        <div>
          <h1>Overview</h1>
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

      {groups.length > 0 && (
        <section aria-labelledby="welcome-topics-heading">
          <div className="welcome-section-heading">
            <div>
              <h2 id="welcome-topics-heading">Explore by topic</h2>
              <p>Find a starting point, then follow the connections.</p>
            </div>
            <button
              onClick={() => {
                onBrowsePages();
              }}
            >
              Browse all pages →
            </button>
          </div>
          <div className="welcome-topics">
            {groups
              .filter(
                (group) =>
                  group.pages.length > 0 ||
                  Boolean("definition" in group && group.definition),
              )
              .map((group, index) => (
                <button
                  className="welcome-topic"

                  key={group.id}
                  onClick={() => {
                    onTopicChange(group.id);
                    setQuery("");
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
