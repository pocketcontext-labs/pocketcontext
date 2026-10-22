import { useEffect, useRef } from "react";
import { pageHref } from "./Markdown";
import { spaceLink } from "./spaceLinks";
import {
  filterWelcomePages,
  groupWelcomePages,
  groupWelcomePagesByType,
  isWelcomeView,
  WELCOME_VIEWS,
} from "./welcome";
import { isNavigationDefinition } from "./navigation";
import type { PageSummary } from "./types";
import "./welcome.css";
import "./pagesDirectory.css";

export interface DirectoryState {
  topic?: string;
  view?: string;
  filter?: string;
  sort?: string;
}
export function pagesHref(
  state: DirectoryState = {},
  publication?: string,
): string {
  const params = new URLSearchParams();
  if (publication) params.set("publication", publication);
  for (const key of ["topic", "view", "filter", "sort"] as const)
    if (state[key]) params.set(key, state[key]!);
  return spaceLink(`#/pages${params.size ? `?${params}` : ""}`);
}
export default function PagesDirectory({
  pages,
  publication,
  state,
  onNavigate,
}: {
  pages: PageSummary[];
  publication?: string;
  state: DirectoryState;
  onNavigate: (href: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const groups = groupWelcomePages(pages);
  const selected = groups.find((group) => group.id === state.topic);
  const mode = isWelcomeView(state.view) ? state.view : "alphabetical";
  const filtered = filterWelcomePages(
    state.topic ? selected?.pages || [] : pages,
    state.filter || "",
  );
  const sort = state.sort === "-title" ? "-title" : "title";
  const ordered = sort === "-title" ? [...filtered].reverse() : filtered;
  const results =
    mode === "topics"
      ? groups
          .filter((group) => !state.topic || group.id === state.topic)
          .map((group) => ({
            ...group,
            pages: ordered.filter((page) =>
              group.pages.some((member) => member.page === page.page),
            ),
          }))
      : mode === "types"
        ? groupWelcomePagesByType(ordered).map((group) => ({
            ...group,
            pages: sort === "-title" ? [...group.pages].reverse() : group.pages,
          }))
        : [{ id: "all", title: "Published pages", pages: ordered }];
  const navigate = (patch: DirectoryState) =>
    onNavigate(pagesHref({ ...state, ...patch }, publication));
  const renderPages = (items: PageSummary[]) => (
    <ul className="directory-entries">
      {items.map((page) => (
        <li key={page.page}>
          <a href={pageHref(page.slug, publication)}>
            <strong>{page.title}</strong>
            {page.summary && <span>{page.summary}</span>}
            <small>{page.kind}</small>
          </a>
        </li>
      ))}
    </ul>
  );
  return (
    <section
      className="welcome-page pages-directory"
      aria-labelledby="pages-directory-title"
    >
      <header className="welcome-intro">
        <div>
          <h1 id="pages-directory-title" ref={heading} tabIndex={-1}>
            All pages
          </h1>
          <p>Browse the published knowledge in this space.</p>
        </div>
      </header>
      <div className="directory-controls">
        <label>
          Filter pages
          <input
            type="search"
            maxLength={500}
            value={state.filter || ""}
            placeholder="Title, summary or page type…"
            onChange={(event) => navigate({ filter: event.target.value })}
          />
        </label>
        <label>
          Topic
          <select
            value={state.topic || ""}
            onChange={(event) => navigate({ topic: event.target.value })}
          >
            <option value="">All topics</option>
            {state.topic && !selected && (
              <option value={state.topic}>Topic unavailable</option>
            )}
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.title} ({group.pages.length})
              </option>
            ))}
          </select>
        </label>
        <label>
          Group by
          <select
            value={mode}
            onChange={(event) => navigate({ view: event.target.value })}
          >
            {WELCOME_VIEWS.map((view) => (
              <option key={view.id} value={view.id}>
                {view.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select
            value={sort}
            onChange={(event) => navigate({ sort: event.target.value })}
          >
            <option value="title">Name A–Z</option>
            <option value="-title">Name Z–A</option>
          </select>
        </label>
      </div>
      <p role="status">
        {filtered.length} of {pages.length} pages
        {state.topic && selected ? ` · ${selected.title}` : ""}
      </p>
      {Boolean(state.filter || state.topic) && (
        <button
          className="subtle-button"
          onClick={() => navigate({ filter: "", topic: "" })}
        >
          Clear filters
        </button>
      )}
      {results
        .filter((group) => group.pages.length > 0)
        .map((group) => (
          <section
            className="welcome-index-group"
            key={group.id}
            aria-label={group.title}
          >
            <h2>{group.title}</h2>
            {renderPages(group.pages)}
          </section>
        ))}
      {mode === "topics" &&
        !state.topic &&
        filtered.some(isNavigationDefinition) && (
          <section aria-label="Navigation definitions">
            <h2>Navigation definitions</h2>
            {renderPages(ordered.filter(isNavigationDefinition))}
          </section>
        )}
      {!filtered.length && (
        <p className="welcome-empty">
          {state.topic && !selected
            ? "This topic is unavailable in this publication."
            : pages.length
              ? "No pages match these filters."
              : "No pages have been published in this space yet."}
        </p>
      )}
    </section>
  );
}
