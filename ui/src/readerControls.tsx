import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { pageHref } from "./Markdown";
import type { Publication } from "./types";
export function versionDate(value?: string) {
  const date = new Date((value || "").replace(" ", "T"));
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
export function trapFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const nodes = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
    ),
  ).filter((node) => node.getClientRects().length && !node.closest("[inert]"));
  const first = nodes[0],
    last = nodes.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
export function PageActions({
  slug,
  publication,
}: {
  slug: string;
  publication: Publication;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const alive = useRef(true);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node))
        menu.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const copy = async (fixed: boolean) => {
    try {
      await navigator.clipboard.writeText(
        new URL(
          pageHref(slug, fixed ? publication.id : undefined),
          location.href,
        ).href,
      );
      if (alive.current) setFeedback("Copied");
    } catch {
      if (alive.current)
        setFeedback("Unable to copy link. Copy the address from your browser.");
    }
    if (alive.current && menu.current) {
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    }
  };
  return (
    <div className="page-actions">
      <details
        ref={menu}
        className="copy-links"
        onKeyDown={(event) => {
          if (event.key === "Escape" && menu.current) {
            menu.current.open = false;
            menu.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary>
          Copy link <span aria-hidden="true">⌄</span>
        </summary>
        <div className="copy-link-options">
          <button onClick={() => void copy(false)}>
            Current page<small>Follows future updates</small>
          </button>
          <button onClick={() => void copy(true)}>
            This version
            <small>Fixed at {versionDate(publication.created)}</small>
          </button>
        </div>
      </details>
      <span className="copy-feedback" role="status">
        {feedback}
      </span>
      <details className="version-details">
        <summary>Version details</summary>
        <p>
          Publication {publication.sequence} ·{" "}
          {versionDate(publication.created)}
        </p>
      </details>
    </div>
  );
}
