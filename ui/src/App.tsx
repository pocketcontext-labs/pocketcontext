import Brand from "./Brand";
import SpaceManager from "./SpaceManager";
import SourceSearch from "./SourceSearch";
import SourceDirectory, { sourceOrder } from "./SourceDirectory";
import { EvidenceExcerpt } from "./EvidenceExcerpt";
import PagesDirectory, { pagesHref } from "./PagesDirectory";
import { availableCatalogTypes } from "./catalogNavigation";
import { useSourceCount } from "./useSourceCount";
import { navigationGroups } from "./navigation";
import {
  PageActions,
  versionDate,
  useMediaQuery,
  trapFocus,
} from "./readerControls";
import { ReconciledRead } from "./reconciledRead";
import { spaceLink } from "./spaceLinks";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Catalog, {
  catalogHref,
  catalogLabels,
  type CatalogState,
  type CatalogType,
} from "./Catalog";
import PropertiesPanel from "./Properties";
import "./catalog.css";
import EvidenceBrowser, {
  evidenceHref,
  sourcePassageHref,
} from "./EvidenceBrowser";
import {
  api,
  pb,
  companySpace,
  selectSpace,
  sessionGeneration,
  type Space,
} from "./api";
import SearchResults, { searchHref } from "./SearchResults";
import { highlightSearchText } from "./searchText";
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
function route() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  return {
    slug:
      path.startsWith("catalog/") ||
      path === "welcome" ||
      path === "pages" ||
      /^(sources|passages)\//.test(path)
        ? ""
        : safeDecode(path.replace(/^page\//, "")),
    welcome: path === "welcome",
    directory:
      path === "pages" ||
      (path === "welcome" && (params.has("view") || params.has("topic"))),
    filter: params.get("filter") || "",
    sort: params.get("sort") || "title",
    passage: params.get("passage") || "",
    catalog: path.startsWith("catalog/"),
    catalogState: {
      type: (path.split("/")[1] === "custom"
        ? "resource"
        : (path.split("/").length === 2 ? path.split("/")[1] : "") ||
          "unavailable") as CatalogType,
      custom:
        path.split("/")[1] === "custom"
          ? safeDecode(path.split("/").slice(2).join("/"))
          : undefined,
      query: params.get("q") || "",
      targetAgent: params.get("targetAgent") || "",
      requiredSkill: params.get("requiredSkill") || "",
      repository: params.get("repository") || "",
      documentType: params.get("documentType") || "",
      syncStatus: params.get("syncStatus") || "",
      group: params.get("group") || "",
      member: params.get("member") || "",
      provider: params.get("provider") || "",
      deployment: params.get("deployment") || "",
      lifecycle: params.get("lifecycle") || "",
      missingOwner: params.get("missingOwner") === "true",
      sort:
        params.get("sort") ||
        (path.startsWith("catalog/custom/") ? "" : "title"),
      offset: Math.min(
        100000,
        Math.max(0, parseInt(params.get("offset") || "0", 10) || 0),
      ),
    } as CatalogState,
    topic: params.get("topic") || "",
    view: params.get("view") || "",
    collection: path.startsWith("sources/")
      ? ("sources" as const)
      : path.startsWith("passages/")
        ? ("passages" as const)
        : ("pages" as const),
    record: /^(sources|passages)\//.test(path)
      ? safeDecode(path.split("/")[1] || "")
      : "",
    publication: params.get("publication") || "",
    space: params.has("space") ? params.get("space")! : undefined,
    offset: Math.min(
      100000,
      Math.max(0, parseInt(params.get("offset") || "0", 10) || 0),
    ),
    sourceOrder: sourceOrder(params.get("order") || ""),
    heading: params.get("heading") || "",
    query: params.get("q") || "",
  };
}
function historySpace(space: string) {
  const [path, query = ""] = location.hash.split("?");
  const params = new URLSearchParams(query);
  params.set("space", space);
  history.replaceState(null, "", `${path}?${params}`);
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to load PocketContext. Please try again.";
}
export default function App() {
  const [session, setSession] = useState(sessionGeneration);
  useEffect(
    () => pb.authStore.onChange(() => setSession(sessionGeneration)),
    [],
  );
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
  const sourceCount = useSourceCount(space?.id);
  const [emptySpace, setEmptySpace] = useState(false);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    publication: Publication;
    pages: PageSummary[];
    page: PageDetail | null;
    selection: ReturnType<typeof route>;
  } | null>(null);
  const [error, setError] = useState("");
  const membershipsCache = useRef<Space[] | null>(null);
  const membershipsCheckedAt = useRef(0);
  const membershipReads = useRef(new ReconciledRead<Space[]>());
  const histories = useRef(new Map<string, Publication[]>());
  const historyRequests = useRef(new Map<string, Promise<Publication[]>>());
  const authority = useRef(0);
  const [accessEpoch, setAccessEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(current.query);
  const lastPublication = useRef<string | undefined>(undefined);
  const [outline, setOutline] = useState<
    { level: number; title: string; id: string }[]
  >([]);
  const [evidence, setEvidence] = useState<Citation | null>(null);
  const [original, setOriginal] = useState("");
  const [evidenceNavigation, setEvidenceNavigation] =
    useState<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const compactNavigation = useMediaQuery("(max-width: 1100px)");
  const dockEvidence = useMediaQuery("(min-width: 1280px)");
  const sidebar = useRef<HTMLElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const navigationOpen = compactNavigation ? menu : !navCollapsed;
  const drawerDestination = useRef(false);
  useEffect(() => {
    if (!compactNavigation) setMenu(false);
  }, [compactNavigation]);
  useEffect(() => {
    if (!menu || !compactNavigation) return;
    const previous = document.activeElement as HTMLElement | null;
    drawerDestination.current = false;
    sidebar.current
      ?.querySelector<HTMLButtonElement>(".navigation-close")
      ?.focus();
    return () => {
      requestAnimationFrame(() => {
        if (drawerDestination.current) {
          if (!reader.current?.contains(document.activeElement))
            reader.current?.focus({ preventScroll: true });
        } else if (previous?.isConnected && !previous.closest("[inert]"))
          previous.focus();
        else navigationToggle.current?.focus();
      });
    };
  }, [menu, compactNavigation]);
  const [evidenceTitle, setEvidenceTitle] = useState("");
  const [connected, setConnected] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      generation.current++;
      personalCreation.current++;
    },
    [],
  );
  const historyOffset = useRef(0);
  const [moreHistory, setMoreHistory] = useState(false);
  const reader = useRef<HTMLElement>(null);
  const citationClose = useRef<HTMLButtonElement>(null);
  const lastCitationFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const handler = () => {
      const next = route();
      const previous = routeSelection.current;
      personalCreation.current++;
      setCreatingSpace(false);
      if (
        next.slug !== previous.slug ||
        next.welcome !== previous.welcome ||
        next.directory !== previous.directory ||
        next.catalog !== previous.catalog ||
        next.publication !== previous.publication ||
        next.space !== previous.space ||
        next.collection !== previous.collection ||
        next.record !== previous.record
      ) {
        generation.current++;
      }
      if ((next.space || companySpace) !== (previous.space || companySpace)) {
        setSnapshot(null);
        setPublications([]);
        setSpace(null);
        setEmptySpace(false);
        setOriginal("");
        lastPublication.current = undefined;
      }
      routeSelection.current = next;
      setCurrent(next);
      if (
        next.collection !== previous.collection ||
        next.record !== previous.record
      )
        setEvidenceTitle("");
      setSearch(next.query);
      setEvidence(null);
      drawerDestination.current = true;
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
          setSpaces([]);
          setMembershipsLoaded(false);
          setSpace(null);
          selectedSpace.current = "";
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
        if (document.querySelector('[aria-modal="true"]')) return;
        event.preventDefault();
        const welcomeSearch = document.querySelector<HTMLInputElement>(
          '.welcome-page input[type="search"], .catalog-page input[type="search"], .source-directory-search input[type="search"]',
        );
        if (welcomeSearch) {
          setMenu(false);
          welcomeSearch.focus();
          return;
        }
        setMenu(window.matchMedia("(max-width: 1100px)").matches);
        setNavCollapsed(false);
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
  const readMemberships = async (refresh: boolean): Promise<Space[]> => {
    const identity = sessionGeneration;
    if (!mounted.current) throw new Error("Reader closed");
    // Navigation shares a recent authorization check; focus, reconnect, realtime
    // and the interval always recheck, including same-identity revocations.
    if (
      !refresh &&
      !membershipReads.current.active &&
      membershipsCache.current &&
      Date.now() - membershipsCheckedAt.current < 60000
    )
      return membershipsCache.current;
    return membershipReads.current.read(async () => {
      if (!mounted.current || identity !== sessionGeneration)
        throw new Error("Session changed");
      await api.refreshSession();
      if (!mounted.current || identity !== sessionGeneration)
        throw new Error("Session changed");
      const memberships = await api.listSpaces();
      if (!mounted.current || identity !== sessionGeneration)
        throw new Error("Session changed");
      const removed =
        membershipsCache.current?.filter(
          (old) => !memberships.some((item) => item.id === old.id),
        ) || [];
      if (removed.length) {
        authority.current++;
        api.clearReaderCache();
        histories.current.clear();
        historyRequests.current.clear();
        // Remount search/evidence children as well: their loaded data is private.
        setAccessEpoch(authority.current);
        if (removed.some((item) => item.id === selectedSpace.current)) {
          setSnapshot(null);
          setPublications([]);
          setSpace(null);
          setEmptySpace(false);
          setEvidence(null);
          setOriginal("");
          lastPublication.current = undefined;
          setBusy(false);
          setError(
            "This space is unavailable. Choose another space to continue.",
          );
        }
      }
      membershipsCache.current = memberships;
      membershipsCheckedAt.current = Date.now();
      setSpaces(memberships);
      setMembershipsLoaded(true);
      return memberships;
    }, refresh);
  };
  const readHistory = (
    spaceId: string,
    refresh: boolean,
  ): Promise<Publication[]> => {
    const pending = historyRequests.current.get(spaceId);
    if (pending)
      return refresh ? pending.then(() => readHistory(spaceId, true)) : pending;
    const previous = histories.current.get(spaceId);
    if (previous && !refresh) return Promise.resolve(previous);
    const access = authority.current;
    const request = (async () => {
      const latest = previous
        ? await api.latestPublication(spaceId)
        : undefined;
      const rows =
        previous && latest?.id === previous[0]?.id
          ? previous
          : await api.listPublications(spaceId);
      if (access !== authority.current)
        throw new Error("Reader access changed");
      histories.current.delete(spaceId);
      histories.current.set(spaceId, rows);
      if (histories.current.size > 8)
        histories.current.delete(histories.current.keys().next().value!);
      return rows;
    })().finally(() => {
      if (historyRequests.current.get(spaceId) === request)
        historyRequests.current.delete(spaceId);
    });
    historyRequests.current.set(spaceId, request);
    return request;
  };
  const load = useCallback(async (refresh = false) => {
    if (!pb.authStore.isValid) {
      pb.authStore.clear();
      return;
    }
    const own = ++generation.current;
    const identity = sessionGeneration;
    const current = routeSelection.current;
    let access = authority.current;
    const active = () =>
      mounted.current &&
      identity === sessionGeneration &&
      own === generation.current &&
      access === authority.current;
    setBusy(true);
    setError("");
    try {
      const unknownSpace =
        current.space !== undefined &&
        !membershipsCache.current?.some((item) => item.id === current.space);
      const memberships = await readMemberships(refresh || unknownSpace);
      access = authority.current;
      if (!active()) return;
      // A pinned publication or evidence link resolves its authorized space.
      const [resolvedPublication, recordSpace] = await Promise.all([
        current.publication
          ? api.getPublication(current.publication)
          : Promise.resolve(null),
        current.record && current.collection !== "pages"
          ? api.evidenceSpace(current.collection, current.record)
          : Promise.resolve(null),
      ]);
      let pinned = resolvedPublication;
      const requestedSpace =
        recordSpace ||
        pinned?.space ||
        (current.space !== undefined
          ? current.space
          : (await api.defaultSpace()).id);
      const chosen = selectSpace(memberships, requestedSpace);
      if (!active()) return;
      if (!chosen || (current.publication && !pinned)) {
        setSnapshot(null);
        setEvidence(null);
        setOriginal("");
        setSpace(null);
        lastPublication.current = undefined;
        throw new Error(
          !chosen
            ? "This space is unavailable. Choose another space to continue."
            : "This publication is unavailable. Choose Live to return to the latest pages.",
        );
      }
      if (current.space !== chosen.id) {
        historySpace(chosen.id);
      }
      const changedSpace = chosen.id !== selectedSpace.current;
      if (active()) {
        setSpaces(memberships);
        setSpace(chosen);
        if (changedSpace) {
          setSnapshot(null);
          setEvidence(null);
          setOriginal("");
          lastPublication.current = undefined;
        }
        selectedSpace.current = chosen.id;
      }
      if (pinned && pinned.space !== chosen.id) pinned = null;
      const history = [
        ...(await readHistory(chosen.id, refresh || changedSpace)),
      ];
      if (active()) {
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
        if (active()) {
          setPublications(history);
          setSnapshot(null);
          setEmptySpace(true);
        }
        return;
      }
      if (!active()) return;
      // Explicit page requests do not depend on the directory. The API shares
      // their validation and serves immutable cache hits without network work.
      const [pages, explicitPage] = await Promise.all([
        api.listPages(publication.id),
        current.slug
          ? api.getPage(publication.id, current.slug)
          : Promise.resolve(null),
      ]);
      if (!active()) return;
      const slug =
        current.welcome ||
        current.directory ||
        current.catalog ||
        current.collection !== "pages" ||
        current.query
          ? undefined
          : current.slug || homePageSlug(publication, pages);
      const page = current.slug
        ? explicitPage
        : slug
          ? await api.getPage(publication.id, slug)
          : null;
      if (active()) {
        setPublications(history);
        setEmptySpace(false);
        lastPublication.current = publication.id;
        setSnapshot({ publication, pages, page, selection: current });
        setEvidence((previous) =>
          previous && page?.citations.some((c) => c.id === previous.id)
            ? previous
            : null,
        );
      }
    } catch (e) {
      // A transient failure leaves the last complete authorized view available.
      // Confirmed membership loss and unavailable selections are cleared above.
      if (active()) setError(message(e));
    } finally {
      if (own === generation.current) setBusy(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      // Authorization checks must never wait behind a slow page download.
      // A confirmed loss immediately clears private views and fences that load.
      try {
        await readMemberships(true);
      } catch (error) {
        if (mounted.current) setError(message(error));
      }
      return;
    }
    refreshInFlight.current = true;
    try {
      do {
        refreshQueued.current = false;
        await load(true);
      } while (
        refreshQueued.current &&
        mounted.current &&
        pb.authStore.isValid
      );
    } finally {
      refreshInFlight.current = false;
    }
  }, [load]);
  useEffect(() => {
    if (authenticated) void load();
  }, [
    authenticated,
    load,
    current.slug,
    current.welcome,
    current.directory,
    current.catalog,
    current.publication,
    current.space,
    current.collection,
    current.record,
  ]);
  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    api
      .watchPublications(() => {
        if (disposed) return;
        setConnected(navigator.onLine);
        void refresh();
      })
      .then((fn) => {
        if (disposed) fn();
        else {
          unsubscribe = fn;
          setConnected(navigator.onLine);
        }
      })
      .catch(() => {
        if (!disposed) setConnected(false);
      });
    const focus = () => void refresh();
    const offline = () => setConnected(false);
    const online = () => {
      setConnected(false);
      void refresh();
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
  }, [authenticated, refresh]);
  useEffect(() => {
    if (!(current.welcome && (current.topic || current.view)))
      reader.current?.scrollTo?.(0, 0);
  }, [
    current.slug,
    current.welcome,
    current.directory,
    current.publication,
    current.collection,
    current.record,
    current.topic,
    current.view,
    current.catalog,
    current.catalogState.type,
    current.catalogState.custom,
    current.offset,
  ]);
  useEffect(() => {
    if (current.heading && snapshot)
      document
        .getElementById(current.heading)
        ?.scrollIntoView?.({ behavior: "smooth" });
  }, [current.heading, snapshot]);
  useEffect(() => {
    if (
      !current.slug ||
      !current.query.trim() ||
      current.heading ||
      snapshot?.selection.slug !== current.slug ||
      snapshot.selection.publication !== current.publication
    )
      return;
    // Read rendered text so aliases and Markdown formatting match what the
    // reader sees. Query text is literal; it never becomes markup or a selector.
    const matchCount = (element: HTMLElement) =>
      new Set(
        highlightSearchText(element.textContent || "", current.query)
          .filter((part) => part.match)
          .map((part) => part.text.toLocaleLowerCase()),
      ).size;
    const blocks = Array.from(
      reader.current?.querySelectorAll<HTMLElement>(
        "article .markdown p, article .markdown li, article .markdown td, article .markdown th, article .markdown pre",
      ) || [],
    ).filter(matchCount);
    // Prefer the paragraph covering the most query terms, not an earlier
    // partial match or a list item containing several unrelated paragraphs.
    const target =
      blocks
        .filter(
          (block) =>
            !blocks.some((other) => other !== block && block.contains(other)),
        )
        .sort((a, b) => matchCount(b) - matchCount(a))[0] ||
      Array.from(
        reader.current?.querySelectorAll<HTMLElement>(
          "article .page-title, article .page-summary, article .markdown :is(h1,h2,h3,h4,h5,h6)",
        ) || [],
      ).find(matchCount);
    if (!target) return;
    const previousTabIndex = target.getAttribute("tabindex");
    target.classList.add("page-search-match");
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
    return () => {
      target.classList.remove("page-search-match");
      if (previousTabIndex === null) target.removeAttribute("tabindex");
      else target.setAttribute("tabindex", previousTabIndex);
    };
  }, [
    current.slug,
    current.query,
    current.heading,
    current.publication,
    current.space,
    snapshot?.selection.slug,
    snapshot?.selection.publication,
    snapshot?.page?.id,
  ]);
  useEffect(() => {
    if (!evidence) return;
    setOriginal("");
    let disposed = false;
    const access = authority.current;
    citationClose.current?.focus();
    const marker = Number(evidence.marker);
    const clickedClaim =
      lastCitationFocus.current?.isConnected &&
      reader.current?.contains(lastCitationFocus.current) &&
      lastCitationFocus.current?.getAttribute("data-citation") ===
        String(marker)
        ? lastCitationFocus.current.closest("p, li, td, blockquote")
        : null;
    const claim =
      clickedClaim ||
      reader.current
        ?.querySelector(`[data-citation="${marker}"]`)
        ?.closest("p, li, td, blockquote");
    claim?.classList.add("citation-claim-active");
    if (dockEvidence) claim?.scrollIntoView?.({ block: "nearest" });
    api
      .originalURL(evidence.source)
      .then((url) => {
        if (!disposed && access === authority.current) setOriginal(url);
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      });
    return () => {
      disposed = true;
      claim?.classList.remove("citation-claim-active");
    };
  }, [evidence, dockEvidence]);
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
          ? evidenceHref(
              current.collection,
              current.record,
              current.query,
              id === "live" ? "" : id,
              current.offset,
            )
          : current.directory
            ? pagesHref(current, id === "live" ? undefined : id)
            : current.welcome && !current.query
              ? spaceLink(
                  `#/welcome?${new URLSearchParams({ ...(id !== "live" ? { publication: id } : {}), ...(current.topic ? { topic: current.topic } : {}), ...(current.view ? { view: current.view } : {}) })}`,
                )
              : current.query
                ? searchHref(
                    current.query,
                    id === "live" ? undefined : id,
                    current.slug,
                  )
                : pageHref(current.slug || "", id === "live" ? undefined : id)
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
    (marker: number, trigger?: HTMLElement) => {
      const citation = snapshot?.page?.citations.find(
        (c) => Number(c.marker) === marker,
      );
      if (citation) {
        lastCitationFocus.current =
          trigger || (document.activeElement as HTMLElement);
        setEvidence({ ...citation });
      }
    },
    [snapshot?.page],
  );
  const recentPages = useMemo(
    () =>
      (snapshot?.pages || [])
        .filter((item): item is PageSummary & { publishedAt: string } =>
          Boolean(item.publishedAt),
        )
        .sort(
          (a, b) =>
            b.publishedAt.localeCompare(a.publishedAt) ||
            a.title.localeCompare(b.title),
        ),
    [snapshot?.pages],
  );
  const pinned = current.publication || undefined;
  if (!authenticated) return <Login />;
  // Retain one coherent publication (directory, page, links and citations)
  // until the requested replacement is complete. Space switches clear it.
  const page = snapshot?.page;
  const matchingPublication = Boolean(snapshot);
  const pages = snapshot?.pages || [];
  const selection = snapshot?.selection;
  const sameView =
    !selection ||
    (selection.slug === current.slug &&
      selection.welcome === current.welcome &&
      selection.directory === current.directory &&
      selection.catalog === current.catalog &&
      selection.collection === current.collection &&
      selection.record === current.record &&
      selection.publication === current.publication);
  // Evidence views own expiring file tokens and navigation-scoped actions.
  // Preserve their immediate unmount/reset behavior when leaving a record.
  const view =
    selection &&
    !sameView &&
    selection.collection === "pages" &&
    current.collection === "pages"
      ? selection
      : current;
  const displayedPinned = view.publication
    ? snapshot?.publication.id || view.publication
    : undefined;
  const searching =
    !view.catalog &&
    !view.directory &&
    view.collection === "pages" &&
    Boolean(view.query.trim() && !view.slug);
  const topicGroups = groupWelcomePages(pages).filter(
    (group) => group.pages.length || group.definition,
  );
  const customCatalogs = navigationGroups(pages, "catalog");
  const builtInCatalogs = availableCatalogTypes(pages);
  const welcoming =
    !emptySpace &&
    !view.catalog &&
    !view.directory &&
    view.collection === "pages" &&
    !searching &&
    !view.slug &&
    (view.welcome || (matchingPublication && !snapshot?.publication.home));
  const showEmptySpace =
    emptySpace &&
    !current.publication &&
    current.collection === "pages" &&
    !current.directory;
  return (
    <div
      className={`workspace ${evidence && dockEvidence ? "has-docked-evidence" : ""}`}
    >
      <a
        className="skip-link"
        inert={
          (compactNavigation && menu) || Boolean(evidence && !dockEvidence)
        }
        href="#reader"
        onClick={(e) => {
          e.preventDefault();
          reader.current?.focus();
        }}
      >
        Skip to page
      </a>
      <aside
        ref={sidebar}
        id="reader-navigation"
        className={`sidebar ${navigationOpen ? "is-open" : "is-collapsed"}`}
        role={compactNavigation && menu ? "dialog" : undefined}
        aria-modal={compactNavigation && menu ? true : undefined}
        aria-label="Page navigation"
        inert={Boolean(evidence && !dockEvidence) || !navigationOpen}
        onKeyDown={(event) => {
          if (compactNavigation && menu) {
            if (event.key === "Escape") {
              event.preventDefault();
              setMenu(false);
            }
            trapFocus(event);
          }
        }}
      >
        <button
          className="icon-button navigation-close"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        >
          ×
        </button>
        <Brand href={pageHref("")} />
        {spaces.length > 0 && (spaces.length > 1 || !space) ? (
          <label className="publication-control">
            Space
            <select
              aria-label="Space"
              value={space?.id || ""}
              onChange={(e) => {
                location.hash = `#/?space=${encodeURIComponent(e.target.value)}`;
              }}
            >
              {!space && (
                <option value="" disabled>
                  Choose a space
                </option>
              )}
              {spaces
                .filter((item) => !item.archived || item.id === space?.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.archived ? " (archived)" : ""}
                    {item.role === "reader" ? " (read only)" : ""}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <div className="workspace-label">
            <span className="workspace-dot" /> {space?.name || "Company"}
          </div>
        )}
        {membershipsLoaded && (
          <SpaceManager
            selected={space?.id}
            onChanged={async (destination) => {
              await readMemberships(true);
              if (destination)
                location.hash = `#/?space=${encodeURIComponent(destination)}`;
              else await refresh();
            }}
          />
        )}
        {membershipsLoaded &&
          !spaces.some((item) => item.kind === "personal") && (
            <details className="space-options">
              <summary>Space options</summary>
              <button
                className="secondary-button"
                disabled={creatingSpace}
                onClick={() => {
                  const own = ++personalCreation.current,
                    identity = sessionGeneration,
                    destination = location.hash;
                  const active = () =>
                    own === personalCreation.current &&
                    identity === sessionGeneration &&
                    pb.authStore.isValid &&
                    destination === location.hash;
                  setCreatingSpace(true);
                  setError("");
                  void api
                    .createPersonalSpace()
                    .then((result) => {
                      if (active())
                        location.hash = `#/?space=${encodeURIComponent(result.id)}`;
                    })
                    .catch((e) => {
                      if (active()) setError(message(e));
                    })
                    .finally(() => {
                      if (active()) setCreatingSpace(false);
                    });
                }}
              >
                {creatingSpace
                  ? "Creating personal space…"
                  : "Create personal space"}
              </button>
            </details>
          )}
        <nav className="primary-navigation" aria-label="Workspace">
          <a
            href={pageHref("", displayedPinned)}
            aria-current={
              view.collection === "pages" &&
              !view.slug &&
              !view.catalog &&
              !view.directory &&
              !searching
                ? "page"
                : undefined
            }
          >
            ⌂ <span>Overview</span>
          </a>
          <a
            href={pagesHref({}, displayedPinned)}
            aria-current={view.directory ? "page" : undefined}
          >
            ▤ <span>All pages</span>
            <small>{pages.length}</small>
          </a>
          <a
            href={evidenceHref("sources", "", "", current.publication)}
            aria-current={current.collection === "sources" ? "page" : undefined}
          >
            ◈ <span>Sources</span>
            {sourceCount !== null && <small>{sourceCount}</small>}
          </a>
        </nav>
        {current.collection === "passages" && (
          <label className="publication-control">
            Evidence
            <select
              aria-label="Collection"
              value={current.collection}
              onChange={(e) => {
                location.hash = evidenceHref(
                  e.target.value as "sources" | "passages",
                  "",
                  "",
                  current.publication,
                );
              }}
            >
              <option value="sources">Sources</option>
              <option value="passages">Passages</option>
            </select>
          </label>
        )}
        <label className="search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label={
              current.collection === "pages"
                ? "Search pages"
                : `Search ${current.collection}`
            }
            type="search"
            placeholder={
              current.collection === "pages"
                ? "Search published pages…"
                : `Search ${current.collection}…`
            }
            value={search}
            maxLength={500}
            onChange={(e) => {
              const value = e.target.value;
              setSearch(value);
              const href =
                current.collection !== "pages"
                  ? evidenceHref(
                      current.collection,
                      "",
                      value,
                      current.publication,
                    )
                  : value.trim()
                    ? searchHref(value, current.publication || undefined)
                    : pageHref("", current.publication || undefined);
              history.replaceState(null, "", href);
              const next = route();
              routeSelection.current = next;
              setCurrent(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                drawerDestination.current = true;
                setMenu(false);
                if (!compactNavigation) reader.current?.focus();
              }
            }}
          />
          <kbd>/</kbd>
        </label>
        <div className="nav-label" hidden={current.collection === "sources"}>
          {current.collection.toUpperCase()}
          {current.collection === "pages" && <span>{pages.length}</span>}
        </div>
        <div
          ref={setEvidenceNavigation}
          className="evidence-navigation"
          hidden={current.collection !== "passages"}
        />
        <div
          className="page-navigation"
          hidden={current.collection !== "pages"}
        >
          {(builtInCatalogs.length > 0 || customCatalogs.length > 0) && (
            <details
              className="navigation-group"
              key={current.catalog ? "catalog" : "pages"}
              open={current.catalog}
            >
              <summary>Catalogs</summary>
              <nav
                className="catalog-navigation"
                aria-label="Catalog navigation"
              >
                {builtInCatalogs.map((type) => (
                  <a
                    key={type}
                    href={catalogHref({ type }, displayedPinned)}
                    aria-current={
                      current.catalog &&
                      current.catalogState.custom === undefined &&
                      current.catalogState.type === type
                        ? "page"
                        : undefined
                    }
                  >
                    {catalogLabels[type]}
                  </a>
                ))}
                {customCatalogs.map((group) => (
                  <a
                    key={`custom-${group.id}`}
                    href={catalogHref({ custom: group.id }, displayedPinned)}
                    aria-current={
                      current.catalog &&
                      current.catalogState.custom === group.id
                        ? "page"
                        : undefined
                    }
                  >
                    {group.title}
                  </a>
                ))}
              </nav>
            </details>
          )}
          {topicGroups.length > 0 && (
            <details className="navigation-group">
              <summary>Topics</summary>
              <nav className="topic-navigation" aria-label="Topics">
                {topicGroups.map((group) => (
                  <a
                    key={group.id}
                    href={pagesHref({ topic: group.id }, displayedPinned)}
                    aria-current={
                      view.directory && view.topic === group.id
                        ? "page"
                        : undefined
                    }
                  >
                    <span>{group.title}</span>
                    <span className="topic-count">{group.pages.length}</span>
                  </a>
                ))}
              </nav>
            </details>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={connected ? "live-dot" : "offline-dot"} />
            {displayedPinned && current.collection === "pages"
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
      {compactNavigation && menu && (
        <div
          className="navigation-backdrop"
          onClick={() => setMenu(false)}
          aria-hidden="true"
        />
      )}
      <div
        className="main-area"
        inert={
          (compactNavigation && menu) || Boolean(evidence && !dockEvidence)
        }
      >
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            ref={navigationToggle}
            aria-label={navigationOpen ? "Close navigation" : "Open navigation"}
            aria-controls="reader-navigation"
            aria-expanded={navigationOpen}
            onClick={() =>
              compactNavigation
                ? setMenu(!menu)
                : setNavCollapsed(!navCollapsed)
            }
          >
            ☰
          </button>
          <div className="breadcrumb">
            {current.collection === "pages"
              ? "Pages"
              : current.collection === "sources"
                ? "Sources"
                : "Passages"}{" "}
            <span>/</span>{" "}
            <strong>
              {current.collection !== "pages"
                ? evidenceTitle ||
                  (current.record ? "Record details" : "Browse evidence")
                : current.catalog
                  ? "Catalog"
                  : searching
                    ? "Search"
                    : view.directory
                      ? "All pages"
                      : welcoming
                        ? "Overview"
                        : page?.title || "Your knowledge"}
            </strong>
          </div>
          <div className="topbar-actions">
            {current.collection === "pages" && (
              <label className="publication-control">
                <span className="sr-only">Version</span>
                <select
                  aria-label="Version"
                  value={pinned || "live"}
                  onChange={(e) => {
                    if (e.target.value === "more") {
                      const own = generation.current,
                        access = authority.current;
                      void api
                        .listPublications(
                          space?.id || "",
                          historyOffset.current,
                          50,
                        )
                        .then((rows) => {
                          if (
                            own !== generation.current ||
                            access !== authority.current
                          )
                            return;
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
                        .catch((e) => {
                          if (
                            own === generation.current &&
                            access === authority.current
                          )
                            setError(message(e));
                        });
                    } else navigatePublication(e.target.value);
                  }}
                >
                  <option value="live">Current version</option>
                  {publications.map((p) => (
                    <option key={p.id} value={p.id}>
                      {versionDate(p.created)} · #{p.sequence}
                    </option>
                  ))}
                  {moreHistory && (
                    <option value="more">Load older publications…</option>
                  )}
                </select>
              </label>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => void refresh()}>Retry</button>
          </div>
        )}
        {busy && snapshot && (
          <div className="refresh-status" role="status">
            {!sameView ? "Opening page…" : "Checking for updates…"}
          </div>
        )}
        {displayedPinned && view.collection === "pages" && (
          <div className="history-banner">
            Viewing a fixed version from{" "}
            {versionDate(snapshot?.publication.created)}.{" "}
            <button onClick={() => navigatePublication("live")}>
              Return to current version
            </button>
          </div>
        )}
        <div
          className={`reading-layout ${welcoming || view.directory ? "welcome-layout" : view.catalog ? "catalog-layout" : ""}`}
        >
          <main
            id="reader"
            ref={reader}
            className={`reader ${welcoming || view.directory ? "welcome-reader" : view.catalog ? "catalog-reader" : ""}`}
            tabIndex={-1}
            aria-busy={busy}
          >
            {showEmptySpace && (
              <section className="empty-state">
                <h1>This space has no published pages</h1>
                <p>
                  Pages appear here when your agent publishes knowledge in this
                  space.
                </p>
              </section>
            )}
            {view.collection !== "pages" &&
              space &&
              !(view.collection === "sources" && !view.record) && (
                <EvidenceBrowser
                  key={`evidence-${accessEpoch}-${space.id}`}
                  space={space.id}
                  collection={view.collection}
                  id={view.record}
                  passage={view.passage}
                  sourceOrder={view.sourceOrder}
                  term={view.query}
                  publication={view.publication}
                  offset={view.offset}
                  navigation={evidenceNavigation}
                  onTitleChange={setEvidenceTitle}
                />
              )}
            {space &&
              view.collection === "sources" &&
              !view.record &&
              !view.query.trim() && (
                <SourceDirectory
                  key={`sources-${accessEpoch}-${space.id}`}
                  space={space.id}
                  count={sourceCount}
                  offset={view.offset}
                  order={view.sourceOrder}
                  publication={view.publication}
                />
              )}
            {space && (
              <SourceSearch
                key={`source-search-${accessEpoch}-${space.id}`}
                space={space.id}
                query={view.query}
                visible={
                  view.collection === "sources" &&
                  !view.record &&
                  Boolean(view.query.trim())
                }
                epoch={accessEpoch}
              />
            )}
            <SearchResults
              key={`search-${accessEpoch}-${space?.id || "none"}`}
              publication={snapshot?.publication.id || lastPublication.current}
              query={
                view.collection === "pages" && !view.catalog ? view.query : ""
              }
              visible={searching && matchingPublication}
              epoch={accessEpoch}
            />
            {view.catalog &&
              !showEmptySpace &&
              matchingPublication &&
              (!busy || snapshot) && (
                <Catalog
                  key={`${accessEpoch}:${space?.id}:${snapshot?.publication.id}`}
                  space={space?.id}
                  snapshotId={snapshot?.publication.id}
                  pages={pages}
                  state={view.catalogState}
                  publication={displayedPinned}
                  onNavigate={(href) => {
                    history.replaceState(null, "", href);
                    const next = route();
                    routeSelection.current = next;
                    setCurrent(next);
                    setSearch(next.query);
                  }}
                />
              )}
            {view.directory && space && (
              <PagesDirectory
                pages={pages}
                publication={displayedPinned}
                state={view}
                onNavigate={(href) => {
                  history.replaceState(null, "", href);
                  const next = route();
                  routeSelection.current = next;
                  setCurrent(next);
                }}
              />
            )}
            {welcoming && matchingPublication && (!busy || snapshot) && (
              <WelcomePage
                key={displayedPinned || "live"}
                pages={pages}
                recentPages={recentPages}
                publication={snapshot?.publication || null}
                pinned={displayedPinned}
                onTopicChange={(topic) => {
                  location.hash = pagesHref({ topic }, displayedPinned);
                }}
                onBrowsePages={() => {
                  location.hash = pagesHref({}, displayedPinned);
                }}
                onSearch={(query) => {
                  location.hash = searchHref(query, displayedPinned);
                }}
              />
            )}
            {view.collection === "pages" &&
              !view.catalog &&
              !view.directory &&
              !searching &&
              !welcoming &&
              !showEmptySpace &&
              (page ? (
                <article>
                  {view.query && view.slug && (
                    <a
                      className="back-to-search"
                      href={searchHref(view.query, displayedPinned)}
                    >
                      ← Back to search results
                    </a>
                  )}

                  <div className="page-eyebrow">
                    <span>{page.kind || "PAGE"}</span>
                    <span className="quiet">
                      {displayedPinned ? "Fixed version" : "Current version"}
                    </span>
                  </div>
                  <h1 className="page-title">{page.title}</h1>
                  <PageActions
                    key={`${space?.id}:${page.id}:${snapshot?.publication.id}`}
                    slug={page.slug}
                    publication={snapshot!.publication}
                  />
                  {page.summary && (
                    <p className="page-summary">{page.summary}</p>
                  )}
                  <PropertiesPanel
                    key={page.id}
                    page={page}
                    pages={pages}
                    publication={displayedPinned}
                    onCitation={openCitation}
                  />
                  <div className="page-rule" />
                  <div className="markdown">
                    <Markdown
                      body={page.body}
                      publication={displayedPinned}
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
                            setEvidence({ ...c });
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
                      ? "Opening PocketContext…"
                      : view.slug
                        ? "Page unavailable"
                        : "A home for your knowledge"}
                  </h1>
                  <p>
                    {view.slug
                      ? "This page is not available in the selected publication. Choose a page from the sidebar."
                      : "Published pages will appear here as your workspace grows."}
                  </p>
                </div>
              ))}
          </main>
          <aside
            className="context-panel"
            aria-label="Page context"
            hidden={
              view.catalog ||
              view.directory ||
              welcoming ||
              searching ||
              view.collection !== "pages"
            }
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
                href={pageHref(p.slug, displayedPinned)}
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
                    href={pageHref(p.slug, displayedPinned)}
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
        <div
          className={`evidence-backdrop ${dockEvidence ? "is-docked" : ""}`}
          onClick={dockEvidence ? undefined : closeEvidence}
        >
          <section
            className="evidence-panel"
            role={dockEvidence ? "region" : "dialog"}
            aria-modal={dockEvidence ? undefined : true}
            aria-labelledby="evidence-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeEvidence();
              if (e.key === "Tab" && !dockEvidence) {
                const focusable = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    "button,a[href]",
                  ),
                ).filter((node) => node.getClientRects().length > 0);
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
            <EvidenceExcerpt
              body={evidence.passage.body}
              source={evidence.source}
            />
            <p>
              <a href={evidenceHref("passages", evidence.passage.id)}>
                Open passage
              </a>{" "}
              ·{" "}
              <a
                href={sourcePassageHref(
                  evidence.source.id,
                  evidence.passage.id,
                )}
              >
                View in source
              </a>
            </p>
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
            {original && (
              <a
                className="primary-button"
                href={original}
                onClick={(event) => {
                  event.preventDefault();
                  const initiatingToken = pb.authStore.token;
                  const initiatingRoute = location.hash;
                  const initiatingAccess = authority.current;
                  const popup = window.open("about:blank", "_blank");
                  if (popup) popup.opener = null;
                  void api
                    .originalURL(evidence.source)
                    .then((url) => {
                      if (
                        !mounted.current ||
                        initiatingAccess !== authority.current ||
                        !pb.authStore.isValid ||
                        pb.authStore.token !== initiatingToken ||
                        location.hash !== initiatingRoute
                      ) {
                        popup?.close();
                        return;
                      }
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
function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const login = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
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
      <section className="login-card">
        <Brand />
        <h1>
          Your knowledge.
          <br />
          Connected.
        </h1>
        <p>
          A quiet place to explore your workspace’s knowledge, follow
          connections and get back to the source.
        </p>
        <form className="login-form" onSubmit={password}>
          <label>
            Email
            <input required name="email" type="email" autoComplete="username" />
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
          <button className="primary-button" disabled={busy}>
            Sign in
          </button>
        </form>
        <p className="login-hint">
          Or run <code>pocketcontext open</code> to sign in with a single-use
          link.
        </p>
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
