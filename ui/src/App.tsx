import AudioRecording from "./Audio";
import { spaceLink } from "./spaceLinks";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Catalog, { catalogHref, catalogTypes, catalogLabels, type CatalogState, type CatalogType } from "./Catalog";
import PropertiesPanel from "./Properties";
import "./catalog.css";
import ImagePreview from "./ImagePreview";
import EvidenceBrowser, { evidenceHref } from "./EvidenceBrowser";
import { api, pb, companySpace, selectSpace, sessionGeneration, type Space } from "./api";
import SearchResults, { searchHref } from "./SearchResults";
import { homePageSlug } from "./home";
import WelcomePage from "./WelcomePage";
import { groupWelcomePages } from "./welcome";
import type { Publication, PageSummary, PageDetail, Citation } from "./types";
import { Markdown, pageHref } from "./Markdown";
function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function savedTheme() {
  try {
    return localStorage.getItem("wiki-theme") || "dark";
  } catch {
    return "dark";
  }
}
function route() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  return {
    slug: path.startsWith("catalog/") || path === "welcome" || /^(sources|passages)\//.test(path) ? "" : safeDecode(path.replace(/^page\//, "")),
    welcome: path === "welcome",
    catalog: path.startsWith("catalog/"),
    catalogState: { type: catalogTypes.includes(path.split("/")[1] as CatalogType) ? path.split("/")[1] as CatalogType : "resource", query: params.get("q") || "", language: params.get("language") || "", bundle: params.get("bundle") || "", targetAgent: params.get("targetAgent") || "", requiredSkill: params.get("requiredSkill") || "", repository: params.get("repository") || "", documentType: params.get("documentType") || "", syncStatus: params.get("syncStatus") || "", group: params.get("group") || "", member: params.get("member") || "", provider: params.get("provider") || "", deployment: params.get("deployment") || "", lifecycle: params.get("lifecycle") || "", missingOwner: params.get("missingOwner") === "true", sort: params.get("sort") || "title", offset: Math.min(100000, Math.max(0, parseInt(params.get("offset") || "0", 10) || 0)) } as CatalogState,
    topic: params.get("topic") || "",
    collection: path.startsWith("sources/") ? "sources" as const : path.startsWith("passages/") ? "passages" as const : "pages" as const,
    record: /^(sources|passages)\//.test(path) ? safeDecode(path.split("/")[1] || "") : "",
    publication: params.get("publication") || "",
    space: params.has("space") ? params.get("space")! : undefined,
    offset: Math.min(100000, Math.max(0, parseInt(params.get("offset") || "0", 10) || 0)),
    heading: params.get("heading") || "",
    query: params.get("q") || "",
  };
}
function historySpace(space: string) {
  const [path, query = ""] = location.hash.split("?");
  const params = new URLSearchParams(query); params.set("space", space);
  history.replaceState(null, "", `${path}?${params}`);
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to load the wiki. Please try again.";
}
export default function App() {
  const [session, setSession] = useState(sessionGeneration);
  useEffect(() => pb.authStore.onChange(() => setSession(sessionGeneration)), []);
  // Remount every private view when the identity changes, including child caches.
  return <Reader key={session} />;
}
function Reader() {
  const [authenticated, setAuthenticated] = useState(pb.authStore.isValid);
  const [current, setCurrent] = useState(route);
  const routeSelection = useRef(current);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [membershipsLoaded, setMembershipsLoaded] = useState(false);
  const personalCreation = useRef(0);
  const [space, setSpace] = useState<Space | null>(null);
  const selectedSpace = useRef("");
  const [emptySpace, setEmptySpace] = useState(false);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    publication: Publication;
    pages: PageSummary[];
    page: PageDetail | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(current.query);
  const [searchEpoch, setSearchEpoch] = useState(0);
  const lastPublication = useRef<string | undefined>(undefined);
  const latestSeen = useRef("");
  const [outline, setOutline] = useState<
    { level: number; title: string; id: string }[]
  >([]);
  const [evidence, setEvidence] = useState<Citation | null>(null);
  const [original, setOriginal] = useState("");
  const [evidenceNavigation, setEvidenceNavigation] = useState<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [evidenceTitle, setEvidenceTitle] = useState("");
  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useState(savedTheme);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; personalCreation.current++; }, []);
  const historyOffset = useRef(0);
  const [moreHistory, setMoreHistory] = useState(false);
  const reader = useRef<HTMLElement>(null);
  const citationClose = useRef<HTMLButtonElement>(null);
  const lastCitationFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("wiki-theme", theme);
    } catch {
      /* Storage is optional. */
    }
  }, [theme]);
  useEffect(() => {
    const handler = () => {
      const next = route();
      const previous = routeSelection.current;
      personalCreation.current++; setCreatingSpace(false);
      if (
        next.slug !== previous.slug || next.welcome !== previous.welcome || next.catalog !== previous.catalog ||
        next.publication !== previous.publication || next.space !== previous.space || next.collection !== previous.collection || next.record !== previous.record
      ) {
        generation.current++;
      }
      if (next.space !== previous.space || next.publication !== previous.publication || next.record !== previous.record) {
        setSnapshot(null); setPublications([]); setSpace(null); setEmptySpace(false);
        setOriginal(""); lastPublication.current = undefined; latestSeen.current = "";
      }
      routeSelection.current = next;
      setCurrent(next);
      if (next.collection !== previous.collection || next.record !== previous.record) setEvidenceTitle("");
      setSearch(next.query);
      setEvidence(null);
      setMenu(false);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(
    () =>
      pb.authStore.onChange(() => {
        const valid = pb.authStore.isValid;
        setAuthenticated(valid);
        if (!valid) {
          generation.current++;
          setSnapshot(null);
          setPublications([]);
          setSpaces([]); setMembershipsLoaded(false); setSpace(null); selectedSpace.current = "";
          setEvidence(null);
          setOriginal("");
          lastPublication.current = undefined;
          setSearch("");
        }
      }, true),
    [],
  );
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const editing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable);
      if (
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") ||
        (event.key === "/" &&
          !editing &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey)
      ) {
        event.preventDefault();
        const welcomeSearch = document.querySelector<HTMLInputElement>('.welcome-page input[type="search"], .catalog-page input[type="search"]');
        if (welcomeSearch) { setMenu(false); welcomeSearch.focus(); return; }
        setMenu(true);
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>('.sidebar input[type="search"]')
            ?.focus(),
        );
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const load = useCallback(async () => {
    if (!pb.authStore.isValid) { pb.authStore.clear(); return; }
    const own = ++generation.current;
    setBusy(true);
    setError("");
    try {
      await api.refreshSession();
      const memberships = await api.listSpaces();
      // A pinned publication link opens in its own space when it is a membership.
      let pinned = current.publication ? await api.getPublication(current.publication) : null;
      const recordSpace = current.record && current.collection !== "pages"
        ? await api.evidenceSpace(current.collection, current.record) : null;
      const chosen = selectSpace(memberships, recordSpace || pinned?.space || current.space);
      if (own !== generation.current) return;
      setSpaces(memberships); setMembershipsLoaded(true);
      if (!chosen) throw new Error("This space is unavailable. Choose another space to continue.");
      if ((recordSpace || pinned?.space) && current.space !== chosen.id && (current.space || chosen.id !== companySpace)) {
        historySpace(chosen.id);
      }
      if (own === generation.current) {
        setSpaces(memberships);
        setSpace(chosen);
        if (chosen && chosen.id !== selectedSpace.current) {
          setSnapshot(null);
          setEvidence(null);
          setOriginal("");
          lastPublication.current = undefined;
          latestSeen.current = "";
        }
        if (chosen) selectedSpace.current = chosen.id;
      }
      if (pinned && pinned.space !== chosen.id) pinned = null;
      const history = await api.listPublications(chosen.id);
      if (own === generation.current && history[0]) {
        if (latestSeen.current && latestSeen.current !== history[0].id)
          setSearchEpoch((n) => n + 1);
        latestSeen.current = history[0].id;
      }
      if (own === generation.current) {
        historyOffset.current = history.length;
        setMoreHistory(history.length === 50);
      }
      let publication = current.publication
        ? history.find((p) => p.id === current.publication)
        : history[0];
      if (current.publication && !publication && pinned) {
        publication = pinned;
        history.push(publication);
      }
      if (!publication) {
        if (current.publication)
          throw new Error(
            "This publication is unavailable. Choose Live to return to the latest pages.",
          );
        if (own === generation.current) {
          setPublications(history);
          setSnapshot(null);
          setEmptySpace(true);
        }
        return;
      }
      const pages = await api.listPages(publication.id);
      const slug = current.welcome || current.catalog ? undefined : current.slug || homePageSlug(publication, pages);
      const page = slug ? await api.getPage(publication.id, slug) : null;
      if (own === generation.current) {
        setPublications(history);
        setEmptySpace(false);
        lastPublication.current = publication.id;
        setSnapshot({ publication, pages, page });
        setEvidence((previous) =>
          previous && page?.citations.some((c) => c.id === previous.id)
            ? previous
            : null,
        );
      }
    } catch (e) {
      if (own === generation.current) { setError(message(e)); setSnapshot(null); setEvidence(null); setOriginal(""); setSpace(null); lastPublication.current = undefined; }
    } finally {
      if (own === generation.current) setBusy(false);
    }
  }, [current.slug, current.welcome, current.catalog, current.publication, current.space, current.collection, current.record]);
  useEffect(() => {
    if (!authenticated) return;
    void load();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    api
      .watchPublications(() => {
        if (disposed) return;
        setConnected(navigator.onLine);
        void load();
      })
      .then((fn) => {
        if (disposed) fn();
        else {
          unsubscribe = fn;
          setConnected(navigator.onLine);
        }
      })
      .catch(() => { if (!disposed) setConnected(false); });
    const focus = () => void load();
    const offline = () => setConnected(false);
    const online = () => {
      setConnected(false);
      void load();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    window.addEventListener("focus", focus);
    const interval = window.setInterval(focus, 60000);
    return () => {
      disposed = true;
      unsubscribe?.();
      setConnected(false);
      window.removeEventListener("focus", focus);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      clearInterval(interval);
    };
  }, [authenticated, load]);
  useEffect(() => {
    if (!(current.welcome && current.topic)) reader.current?.scrollTo?.(0, 0);
  }, [current.slug, current.welcome, current.publication, current.collection, current.record, current.topic, current.catalog, current.catalogState.type, current.offset]);
  useEffect(() => {
    if (current.heading && snapshot)
      document
        .getElementById(current.heading)
        ?.scrollIntoView?.({ behavior: "smooth" });
  }, [current.heading, snapshot]);
  useEffect(() => {
    if (!evidence) return;
    setOriginal("");
    let disposed = false;
    citationClose.current?.focus();
    api
      .originalURL(evidence.source)
      .then((url) => {
        if (!disposed) setOriginal(url);
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      });
    return () => {
      disposed = true;
    };
  }, [evidence]);
  const closeEvidence = () => {
    setEvidence(null);
    setOriginal("");
    const previous = lastCitationFocus.current;
    const label = previous?.getAttribute("aria-label");
    requestAnimationFrame(() => {
      if (previous?.isConnected) previous.focus();
      else if (label)
        Array.from(document.querySelectorAll<HTMLElement>("button[aria-label]"))
          .find((node) => node.getAttribute("aria-label") === label)
          ?.focus();
    });
  };
  const navigatePublication = (id: string) => {
    location.hash = (
      current.catalog
        ? catalogHref(current.catalogState, id === "live" ? undefined : id)
        : current.collection !== "pages"
        ? evidenceHref(current.collection, current.record, current.query, id === "live" ? "" : id, current.offset)
        : current.welcome && !current.query
        ? spaceLink(`#/welcome${id === "live" ? "" : `?publication=${encodeURIComponent(id)}`}`)
        : current.query
        ? searchHref(
            current.query,
            id === "live" ? undefined : id,
            current.slug,
          )
        : pageHref(
            current.slug || "",
            id === "live" ? undefined : id,
          )
    ).slice(1);
  };
  useEffect(() => {
    setOutline(
      Array.from(
        reader.current?.querySelectorAll<HTMLElement>(
          ".markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6",
        ) || [],
      ).map((node) => ({
        level: Number(node.tagName.slice(1)),
        title: node.textContent || "",
        id: node.id,
      })),
    );
  }, [snapshot?.page?.id]);
  const resolveSlug = useCallback(
    (target: string) =>
      snapshot?.pages.find(
        (p) =>
          p.slug === target || p.title.toLowerCase() === target.toLowerCase(),
      )?.slug || target,
    [snapshot?.pages],
  );
  const openCitation = useCallback(
    (marker: number) => {
      const citation = snapshot?.page?.citations.find(
        (c) => Number(c.marker) === marker,
      );
      if (citation) {
        lastCitationFocus.current = document.activeElement as HTMLElement;
        setEvidence(citation);
      }
    },
    [snapshot?.page],
  );
  const pinned = current.publication || undefined;
  if (!authenticated) return <Login theme={theme} setTheme={setTheme} />;
  const page =
    (!current.publication ||
      snapshot?.publication.id === current.publication) &&
    (!current.slug || snapshot?.page?.slug === current.slug)
      ? snapshot?.page
      : null;
  const matchingPublication = !pinned || snapshot?.publication.id === pinned;
  const pages = matchingPublication ? snapshot?.pages || [] : [];
  const searching = !current.catalog && current.collection === "pages" && Boolean(current.query.trim() && !current.slug);
  const topicGroups = groupWelcomePages(pages).filter(group => group.pages.length);
  const welcomeHref = (topic: string) => {
    const params = new URLSearchParams({ topic });
    if (pinned) params.set("publication", pinned);
    return spaceLink(`#/welcome?${params}`);
  };
  const welcoming = !emptySpace && !current.catalog && current.collection === "pages" && !searching && !current.slug &&
    (current.welcome || (matchingPublication && !snapshot?.publication.home));
  const showEmptySpace = emptySpace && !current.publication && current.collection === "pages";
  return (
    <div className="workspace">
      <a
        className="skip-link"
        href="#reader"
        onClick={(e) => {
          e.preventDefault();
          reader.current?.focus();
        }}
      >
        Skip to page
      </a>
      <aside
        className={`sidebar ${menu ? "is-open" : ""}`}
        aria-label="Wiki navigation"
      >
        <a className="brand" href={pageHref("")}>
          <span className="brand-mark">W</span>
          <span>
            WikiContext<small>YOUR CONNECTED KNOWLEDGE</small>
          </span>
        </a>
        {spaces.length > 0 && (spaces.length > 1 || !space) ? <label className="publication-control">Space<select aria-label="Space" value={space?.id || ""} onChange={e => { location.hash = `#/?space=${encodeURIComponent(e.target.value)}`; }}>
          {!space && <option value="" disabled>Choose a space</option>}
          {spaces.map(item => <option key={item.id} value={item.id}>{item.kind === "personal" ? "Personal space" : item.name}{item.role === "reader" ? " (read only)" : ""}</option>)}
        </select></label> : <div className="workspace-label"><span className="workspace-dot" /> {space?.name || "Company"}</div>}
        {membershipsLoaded && !spaces.some(item => item.kind === "personal") && <button className="secondary-button" disabled={creatingSpace} onClick={() => {
          const own = ++personalCreation.current, identity = sessionGeneration, destination = location.hash;
          const active = () => own === personalCreation.current && identity === sessionGeneration && pb.authStore.isValid && destination === location.hash;
          setCreatingSpace(true); setError("");
          void api.createPersonalSpace().then(result => { if (active()) location.hash = `#/?space=${encodeURIComponent(result.id)}`; }).catch(e => { if (active()) setError(message(e)); }).finally(() => { if (active()) setCreatingSpace(false); });
        }}>{creatingSpace ? "Creating personal space…" : "Create personal space"}</button>}
        <a className={`welcome-nav ${welcoming ? "selected" : ""}`} href={spaceLink(`#/welcome${pinned ? `?publication=${encodeURIComponent(pinned)}` : ""}`)} aria-current={welcoming ? "page" : undefined}>⌂ <span>Welcome</span></a>
        <label className="publication-control">Collection<select aria-label="Collection" value={current.collection} onChange={e => { location.hash = e.target.value === "pages" ? pageHref("", pinned) : evidenceHref(e.target.value as "sources" | "passages", "", "", current.publication); }}><option value="pages">Pages</option><option value="sources">Sources</option><option value="passages">Passages</option></select></label>
        <label className="search" hidden={welcoming}>
          <span aria-hidden="true">⌕</span>
          <input
            aria-label={current.collection === "pages" ? "Search pages" : `Search ${current.collection}`}
            type="search"
            placeholder={current.collection === "pages" ? "Search published pages…" : `Search ${current.collection}…`}
            value={search}
            maxLength={500}
            onChange={(e) => {
              const value = e.target.value;
              setSearch(value);
              const href = current.collection !== "pages" ? evidenceHref(current.collection, current.record, value, current.publication) : value.trim()
                ? searchHref(value, current.publication || undefined)
                : pageHref("", current.publication || undefined);
              history.replaceState(null, "", href);
              const next = route();
              routeSelection.current = next;
              setCurrent(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setMenu(false);
                reader.current?.focus();
              }
            }}
          />
          <kbd>/</kbd>
        </label>
        <div className="nav-label">
          {current.collection.toUpperCase()}
          {current.collection === "pages" && <span>{pages.length}</span>}
        </div>
        <div ref={setEvidenceNavigation} className="evidence-navigation" hidden={current.collection === "pages"} />
        <div className="page-navigation" hidden={current.collection !== "pages"}>
          <nav className="catalog-navigation" aria-label="Catalog navigation">{catalogTypes.map(type => <a key={type} href={catalogHref({ type }, pinned)} aria-current={current.catalog && current.catalogState.type === type ? "page" : undefined}>{catalogLabels[type]}</a>)}</nav>
          <nav className="topic-navigation" aria-label="Topics">
            {topicGroups.map(group => <a key={group.id} href={welcomeHref(group.id)} aria-current={welcoming && current.topic === group.id ? "page" : undefined}>
              <span>{group.title}</span><span className="topic-count">{group.pages.length}</span>
            </a>)}
          </nav>
          <details className="all-pages-navigation" key={welcoming ? "welcome" : "reading"} open={!welcoming}>
            <summary>All pages <span>{pages.length}</span></summary>
        <nav className="page-list" aria-label="Pages">
          {(current.collection === "pages" ? pages : []).map((p) => (
            <a
              key={p.id}
              href={pageHref(p.slug, pinned)}
              className={!welcoming && p.slug === page?.slug ? "selected" : ""}
              aria-current={!welcoming && p.slug === page?.slug ? "page" : undefined}
            >
              <span className="page-icon" aria-hidden="true">
                ▤
              </span>
              <span>{p.title}</span>
              {p.page === snapshot?.publication.home && <span className="home-badge">Home</span>}
            </a>
          ))}
        </nav>
          </details>
        </div>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={connected ? "live-dot" : "offline-dot"} />
            {pinned
              ? "Historical publication"
              : connected
                ? "Live · updates automatically"
                : "Checking for updates"}
          </div>
          <button className="subtle-button" onClick={() => api.logout()}>
            Sign out <span aria-hidden="true">↗</span>
          </button>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Toggle navigation"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            ☰
          </button>
          <div className="breadcrumb">
            {current.collection === "pages" ? "Wiki" : current.collection === "sources" ? "Sources" : "Passages"} <span>/</span>{" "}
            <strong>
              {current.collection !== "pages" ? evidenceTitle || (current.record ? "Record details" : "Browse evidence") : current.catalog ? "Catalog" : searching ? "Search" : welcoming ? "Welcome" : page?.title || "Your knowledge"}
            </strong>
          </div>
          <div className="topbar-actions">
            <label className="publication-control">
              <span className="sr-only">Publication</span>
              <select
                aria-label="Publication"
                value={pinned || "live"}
                onChange={(e) => {
                  if (e.target.value === "more") {
                    const own = generation.current;
                    void api
                      .listPublications(space?.id || "", historyOffset.current, 50)
                      .then((rows) => {
                        if (own !== generation.current) return;
                        historyOffset.current += rows.length;
                        setMoreHistory(rows.length === 50);
                        setPublications((previous) =>
                          [
                            ...new Map(
                              [...previous, ...rows].map((p) => [p.id, p]),
                            ).values(),
                          ].sort((a, b) => b.sequence - a.sequence),
                        );
                      })
                      .catch((e) => { if (own === generation.current) setError(message(e)); });
                  } else navigatePublication(e.target.value);
                }}
              >
                <option value="live">Live publication</option>
                {publications.map((p) => (
                  <option key={p.id} value={p.id}>
                    Publication {p.sequence}
                  </option>
                ))}
                {moreHistory && (
                  <option value="more">Load older publications…</option>
                )}
              </select>
            </label>
            <button
              className="icon-button"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? "☼" : "☾"}
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => void load()}>Retry</button>
          </div>
        )}
        {pinned && (
          <div className="history-banner">
            Viewing publication {snapshot?.publication.sequence}.{" "}
            <button onClick={() => navigatePublication("live")}>
              Return to live
            </button>
          </div>
        )}
        <div className={`reading-layout ${welcoming ? "welcome-layout" : current.catalog ? "catalog-layout" : ""}`}>
          <main
            id="reader"
            ref={reader}
            className={`reader ${welcoming ? "welcome-reader" : current.catalog ? "catalog-reader" : ""}`}
            tabIndex={-1}
            aria-busy={busy}
          >
            {showEmptySpace && <section className="empty-state"><h1>This space has no published pages</h1><p>Pages appear here when your agent publishes knowledge in this space.</p></section>}
            {current.collection !== "pages" && space && <EvidenceBrowser key={`evidence-${space.id}`} space={space.id} collection={current.collection} id={current.record} term={current.query} publication={current.publication} offset={current.offset} navigation={evidenceNavigation} onTitleChange={setEvidenceTitle} />}
            <SearchResults key={`search-${space?.id || "none"}`}
              publication={snapshot?.publication.id || lastPublication.current}
              query={current.query}
              visible={
                searching && (!pinned || snapshot?.publication.id === pinned)
              }
              epoch={searchEpoch}
            />
            {current.catalog && !showEmptySpace && matchingPublication && (!busy || snapshot) && <Catalog key={`${space?.id}:${snapshot?.publication.id}`} space={space?.id} snapshotId={snapshot?.publication.id} pages={pages} state={current.catalogState} publication={pinned} onNavigate={href => { history.replaceState(null, "", href); const next = route(); routeSelection.current = next; setCurrent(next); setSearch(next.query); }} />}
            {welcoming && matchingPublication && (!busy || snapshot) && <WelcomePage key={pinned || "live"} pages={pages} publication={snapshot?.publication || null} pinned={pinned} topic={current.topic} onTopicChange={topic => { location.hash = welcomeHref(topic); }} onSearch={query => { location.hash = searchHref(query, pinned); }} />}
            {current.collection === "pages" && !current.catalog && !searching && !welcoming && !showEmptySpace &&
              (page ? (
                <article>
                  {current.query && current.slug && (
                    <a
                      className="back-to-search"
                      href={searchHref(current.query, pinned)}
                    >
                      ← Back to search results
                    </a>
                  )}

                  <div className="page-eyebrow">
                    <span>{page.kind || "WIKI PAGE"}</span>
                    <span className="quiet">
                      Publication {snapshot?.publication.sequence}
                    </span>
                  </div>
                  <h1 className="page-title">{page.title}</h1>
                  <button onClick={() => void navigator.clipboard.writeText(new URL(pageHref(page.slug), location.href).href).catch(() => setError("Unable to copy link"))}>Copy live link</button>{" "}
                  <button onClick={() => void navigator.clipboard.writeText(new URL(pageHref(page.slug, snapshot?.publication.id), location.href).href).catch(() => setError("Unable to copy link"))}>Copy historical link</button>
                  {page.summary && (
                    <p className="page-summary">{page.summary}</p>
                  )}
                  {page.properties?.catalog_type === "audio_recording" && space && <AudioRecording page={page} pages={pages} space={space.id} publication={pinned} />}
                  <PropertiesPanel key={page.id} page={page} pages={pages} publication={pinned} onCitation={openCitation} />
                  <div className="page-rule" />
                  <div className="markdown">
                    <Markdown
                      body={page.body}
                      publication={pinned}
                      resolveSlug={resolveSlug}
                      onCitation={openCitation}
                    />
                  </div>
                  {page.citations.length > 0 && (
                    <section className="sources-section">
                      <h2>Sources</h2>
                      {page.citations.map((c) => (
                        <button
                          key={c.id}
                          className="source-row"
                          onClick={(event) => {
                            lastCitationFocus.current = event.currentTarget;
                            setEvidence(c);
                          }}
                          aria-label={`Citation ${c.marker}: ${c.source.title}`}
                        >
                          <span className="source-number">{c.marker}</span>
                          <span>
                            <strong>{c.source.title}</strong>
                            <small>
                              {c.passage.locator ||
                                `Passage ${c.passage.ordinal}`}
                            </small>
                          </span>
                          <span aria-hidden="true">↗</span>
                        </button>
                      ))}
                    </section>
                  )}
                  <footer className="page-footer">
                    Published knowledge, connected to its evidence.
                  </footer>
                </article>
              ) : (
                <div className="empty-state">
                  <span className="empty-icon">▤</span>
                  <h1>
                    {busy
                      ? "Opening your wiki…"
                      : current.slug
                        ? "Page unavailable"
                        : "A home for your knowledge"}
                  </h1>
                  <p>
                    {current.slug
                      ? "This page is not available in the selected publication. Choose a page from the sidebar."
                      : "Published pages will appear here as your workspace grows."}
                  </p>
                </div>
              ))}
          </main>
          <aside
            className="context-panel"
            aria-label="Page context"
            hidden={current.catalog || welcoming || searching || current.collection !== "pages"}
          >
            <div className="context-title">ON THIS PAGE</div>
            {outline.length ? (
              outline.map((item, i) => (
                <button
                  className={`outline-item indent-${item.level}`}
                  key={i}
                  onClick={() =>
                    document
                      .getElementById(item.id)
                      ?.scrollIntoView({ behavior: "smooth" })
                  }
                >
                  {item.title.replace(/[*_`]/g, "")}
                </button>
              ))
            ) : (
              <p className="context-empty">No section headings</p>
            )}
            <div className="context-title backlinks-title">
              BACKLINKS <span>{page?.backlinks.length || 0}</span>
            </div>
            {page?.backlinks.map((p) => (
              <a
                className="backlink"
                key={p.id}
                href={pageHref(p.slug, pinned)}
              >
                ↗ <span>{p.title}</span>
              </a>
            ))}
            {!page?.backlinks.length && (
              <p className="context-empty">
                Connections to this page will appear here.
              </p>
            )}
            {Boolean(page?.links.length) && (
              <>
                <div className="context-title backlinks-title">
                  RELATED PAGES
                </div>
                {page?.links.map((p) => (
                  <a
                    className="backlink"
                    key={p.id}
                    href={pageHref(p.slug, pinned)}
                  >
                    ↗ <span>{p.title}</span>
                  </a>
                ))}
              </>
            )}
            <div className="context-note">
              <span>◈</span>
              <p>
                Every page is part of a bigger picture.
                <br />
                Follow the links. Explore the evidence.
              </p>
            </div>
          </aside>
        </div>
      </div>
      {evidence && (
        <div className="evidence-backdrop" onClick={closeEvidence}>
          <section
            className="evidence-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="evidence-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeEvidence();
              if (e.key === "Tab") {
                const focusable =
                  Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
                    "button,a[href]",
                  )).filter(node => node.getClientRects().length > 0);
                const first = focusable[0],
                  last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <header>
              <span className="page-eyebrow">
                SOURCE EVIDENCE · {evidence.marker}
              </span>
              <button
                ref={citationClose}
                className="icon-button"
                aria-label="Close evidence"
                onClick={closeEvidence}
              >
                ×
              </button>
            </header>
            <h2 id="evidence-title">{evidence.source.title}</h2>
            <p className="evidence-locator">
              {evidence.passage.locator ||
                `Passage ${evidence.passage.ordinal}`}
            </p>
            <blockquote className="passage">{evidence.passage.body}</blockquote>
            <p><a href={evidenceHref("passages", evidence.passage.id)}>Open passage</a> · <a href={evidenceHref("sources", evidence.source.id)}>Open source</a></p>
            {evidence.note && <p>{evidence.note}</p>}
            <dl>
              <dt>Original</dt>
              <dd>{evidence.source.original_name}</dd>
              {evidence.source.source_date && (
                <>
                  <dt>Source date</dt>
                  <dd>{evidence.source.source_date}</dd>
                </>
              )}
            </dl>
            <ImagePreview source={evidence.source} />
            {original && (
              <a
                className="primary-button"
                href={original}
                onClick={(event) => {
                  event.preventDefault();
                  const initiatingToken = pb.authStore.token;
                  const initiatingRoute = location.hash;
                  const popup = window.open("about:blank", "_blank");
                  if (popup) popup.opener = null;
                  void api
                    .originalURL(evidence.source)
                    .then((url) => {
                      if (!pb.authStore.isValid || pb.authStore.token !== initiatingToken || location.hash !== initiatingRoute) { popup?.close(); return; }
                      if (popup) popup.location.replace(url);
                      else window.location.assign(url);
                    })
                    .catch((error) => {
                      popup?.close();
                      setError(message(error));
                    });
                }}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open original ↗
              </a>
            )}
            <p className="evidence-footnote">
              This passage is preserved from an immutable source.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
function Login({
  theme,
  setTheme,
}: {
  theme: string;
  setTheme: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [googlePending, setGooglePending] = useState(false);
  useEffect(() => () => api.cancelGoogleLogin(), []);
  const [error, setError] = useState("");
  const login = async (action: () => Promise<unknown>, google = false) => {
    setGooglePending(google);
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      setGooglePending(false);
    }
  };
  const password = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void login(() =>
      api.loginPassword(
        String(form.get("email")),
        String(form.get("password")),
      ),
    );
  };
  return (
    <main className="login-shell">
      <button
        className="icon-button login-theme"
        aria-label="Switch theme"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? "☼" : "☾"}
      </button>
      <section className="login-card">
        <div className="brand-mark large">W</div>
        <div className="page-eyebrow">WIKICONTEXT</div>
        <h1>
          Your knowledge.
          <br />
          Connected.
        </h1>
        <p>
          A quiet place to explore your workspace’s knowledge, follow
          connections and get back to the source.
        </p>
        <button
          className="primary-button google-button"
          disabled={busy}
          onClick={() => void login(() => api.loginGoogle(), true)}
        >
          Continue with Google <span>↗</span>
        </button>
        {googlePending && <button type="button" className="secondary-button" onClick={() => api.cancelGoogleLogin()}>Cancel Google sign-in</button>}
        <p className="login-hint">Sign in with your Workspace account.</p>
        <details>
          <summary>Sign in with a password</summary>
          <form onSubmit={password}>
            <label>
              Email
              <input
                required
                name="email"
                type="email"
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                required
                name="password"
                type="password"
                autoComplete="current-password"
              />
            </label>
            <button className="secondary-button" disabled={busy}>
              Sign in
            </button>
          </form>
        </details>
        {error && (
          <p role="alert" className="login-error">
            {error}
          </p>
        )}
        <div className="login-footer">
          <span className="live-dot" /> Living pages. Traceable sources.
        </div>
      </section>
    </main>
  );
}
