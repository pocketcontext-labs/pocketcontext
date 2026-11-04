import { useLayoutEffect, useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { spaceLink } from "./spaceLinks";
import remarkGfm from "remark-gfm";
import { pb } from "./api";
import "./agentChat.css";
import {
  ComposerTools,
  ImagePreview,
  type PromptImage,
  type ModelState,
} from "./ComposerTools";

type Event = {
  seq: number;
  type: string;
  time?: string;
  text?: string;
  data?: unknown;
};
type Permission = {
  id: string;
  importFile?: string;
  toolCall: unknown;
  options: { optionId: string; name: string; kind: string }[];
};
function ApprovalCard({
  permission,
  spaceName,
  pending,
  decide,
}: {
  permission: Permission;
  spaceName: string;
  pending: boolean;
  decide: (option: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const call = permission.toolCall as {
    title?: unknown;
    rawInput?: { command?: unknown; cwd?: unknown; path?: unknown };
  } | null;
  const input = call?.rawInput;
  const command =
    typeof input?.command === "string" ? input.command : undefined;
  const path = typeof input?.path === "string" ? input.path : undefined;
  return (
    <section className="agent-chat-permission" aria-label="Approval requested">
      <div className="approval-heading">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <path d="m12 2 8 4v6c0 5-4 8-8 10-4-2-8-5-8-10V6zM12 7v6m0 2v2" />
        </svg>
        <div>
          <h3>
            {permission.importFile
              ? `Import ${permission.importFile} into ${spaceName}?`
              : "Approval requested"}
          </h3>
          <p>
            {permission.importFile
              ? "Adds one source to this space."
              : typeof call?.title === "string"
                ? call.title
                : "Review the requested action"}
          </p>
        </div>
      </div>
      {!permission.importFile && (command || path) && (
        <pre className="approval-command">
          <code>{command || path}</code>
        </pre>
      )}
      <details
        className="approval-details"
        onToggle={(e) => setShowDetails(e.currentTarget.open)}
      >
        <summary>
          {permission.importFile ? "Command details" : "Request details"}
        </summary>
        {showDetails && (
          <pre>{JSON.stringify(permission.toolCall, null, 2)}</pre>
        )}
      </details>
      <div className="approval-actions">
        {permission.options.map((option) => {
          const button = (
            <button
              type="button"
              data-kind={option.kind}
              disabled={pending}
              onClick={() => decide(option.optionId)}
            >
              {option.name === "Yes, proceed" && option.kind === "allow_once"
                ? "Allow once"
                : option.name === "No, and tell Codex what to do differently" &&
                    option.kind === "reject_once"
                  ? "Deny"
                  : option.name}
            </button>
          );
          if (option.kind === "allow_always" || option.kind === "reject_always")
            return (
              <details key={option.optionId} className="approval-rule">
                <summary>
                  {option.kind === "allow_always"
                    ? "Review remembered approval"
                    : "Review remembered denial"}
                </summary>
                {button}
              </details>
            );
          return <div key={option.optionId}>{button}</div>;
        })}
      </div>
    </section>
  );
}
export type ChatSession = {
  id: string;
  space: string;
  preview?: string;
  updated?: string;
  needsApproval?: boolean;
  status: string;
  error?: string;
  canResume?: boolean;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  images?: boolean;
  models?: ModelState;
  mode?: string;
  lastSeq: number;
  events?: Event[];
  permissions?: Permission[];
};
const requestId = () => crypto.randomUUID();
const endpoint = (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}`;
function failure(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Chat could not connect. Your draft is still here.";
}
type PageTarget = { title: string; slug: string };
function listTitle(node: MarkdownNode): string | null {
  if (node.type === "text") return String(node.value);
  if (!["li", "p", "strong", "em", "code"].includes(node.tagName || ""))
    return null;
  const parts = node.children?.map(listTitle) || [];
  return parts.includes(null) ? null : parts.join("");
}
type MarkdownNode = {
  type: string;
  value?: unknown;
  tagName?: string;
  children?: readonly MarkdownNode[];
};
export function ChatMarkdown({
  text,
  space,
  pages,
  onNavigate,
}: {
  text: string;
  space?: string;
  pages?: PageTarget[];
  onNavigate?: () => void;
}) {
  const internal = (kind: string, id: string) =>
    spaceLink(`#/${kind}/${encodeURIComponent(id)}`, space);
  const follow = (e: React.MouseEvent) => {
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey)
      onNavigate?.();
  };
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) =>
        /^(?:page:[a-z0-9]+(?:-[a-z0-9]+)*|source:[a-z0-9]{15})$/.test(url)
          ? url
          : defaultUrlTransform(url)
      }
      skipHtml
      components={{
        img: ({ alt }) => <span>[Image: {alt || "not loaded"}]</span>,
        li: ({ node, children }) => {
          const title = pages?.length && node ? listTitle(node)?.trim() : null;
          const matches = title
            ? pages?.filter(
                (p) => p.title === title || title === `${p.title} — ${p.slug}`,
              )
            : undefined;
          return (
            <li>
              {space && matches?.length === 1 ? (
                <a href={internal("page", matches[0].slug)} onClick={follow}>
                  {children}
                </a>
              ) : (
                children
              )}
            </li>
          );
        },
        a: ({ href, children }) =>
          space && href && /^(page|source):/.test(href) ? (
            <a
              href={internal(
                href.startsWith("page:") ? "page" : "sources",
                href.slice(href.indexOf(":") + 1),
              )}
              onClick={follow}
            >
              {children}
            </a>
          ) : /^https?:\/\//i.test(href || "") ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
function duration(start: number, end: number) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function WorkingTimer({ start }: { start?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const began = Date.parse(start || "");
  return (
    <div className="chat-worked" role="timer" aria-label="Agent working">
      {Number.isFinite(began) && now - began >= 1000
        ? "Working for " + duration(began, now)
        : "Working..."}
    </div>
  );
}
function transcript(events: Event[]) {
  const rows: (Event & { workedFor?: string })[] = [];
  let started = NaN;
  let previousId: unknown;
  let continuing = false;
  for (const event of events) {
    if (event.type === "user") started = Date.parse(event.time || "");
    if (
      event.type === "status" &&
      event.data == null &&
      [
        "end_turn",
        "max_tokens",
        "max_turn_requests",
        "refusal",
        "cancelled",
      ].includes(event.text || "")
    ) {
      const reply = rows.at(-1),
        end = Date.parse(event.time || "");
      if (
        reply?.type === "agent" &&
        Number.isFinite(started) &&
        Number.isFinite(end)
      )
        reply.workedFor = duration(started, end);
    }
    if (event.type !== "agent" && event.type !== "user") {
      if (event.type === "tool" || event.type === "error") continuing = false;
      continue;
    }
    if (!event.text && event.type !== "user") continue;
    const id =
      event.data && typeof event.data === "object" && "messageId" in event.data
        ? event.data.messageId
        : undefined;
    const previous = rows.at(-1);
    if (event.type === "agent" && continuing && previous && previousId === id)
      previous.text = (previous.text || "") + event.text;
    else if (event.type === "agent" && previous?.type === "agent")
      rows[rows.length - 1] = { ...event };
    else rows.push({ ...event });
    continuing = event.type === "agent";
    previousId = id;
  }
  return rows;
}
function DestinationIcon({ name }: { name: "space" | "bot" }) {
  const paths = {
    space: "M3 7V5h6l2 2h10v12H3z",
    bot: "M4 7h16v12H4z M12 7V3 M8 11v3 M16 11v3",
  };
  return (
    <svg
      aria-hidden="true"
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export default function AgentChat({
  space,
  spaces = [],
  onSpaceChange,
  onCreateSpace,
  spaceManagement,
  pageIndex,
  loadPages,
  spaceList,
  setSpaceList,
}: {
  loadPages?: (space: string) => Promise<PageTarget[]>;
  pageIndex?: { space: string; pages: PageTarget[] };
  spaceList: boolean;
  setSpaceList: (visible: boolean) => void;
  space?: string;
  spaces?: { id: string; name: string; archived?: boolean }[];
  onSpaceChange?: (id: string) => void;
  spaceManagement?: React.ReactNode;
  onCreateSpace?: (name: string) => Promise<string>;
}) {
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [spaceDraft, setSpaceDraft] = useState("");
  const [savingSpace, setSavingSpace] = useState(false);
  const [spaceError, setSpaceError] = useState("");
  const [preferred, setPreferred] = useState(
    () => localStorage.getItem("chat.defaultMode") || "read-only",
  );
  const mode = preferred === "workspace-write" ? preferred : "read-only";
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selected, setSelected] = useState("");
  const [session, setSession] = useState<ChatSession | null>(null);
  const [remoteIndex, setRemoteIndex] = useState<{
    space: string;
    pages: PageTarget[];
  }>();
  const sessionSpace = session?.space;
  const readerSpace = pageIndex?.space;
  useEffect(() => {
    if (!open || !sessionSpace || sessionSpace === readerSpace || !loadPages)
      return;
    let active = true;
    loadPages(sessionSpace)
      .then((pages) => {
        if (active) setRemoteIndex({ space: sessionSpace, pages });
      })
      .catch(() => {
        if (active) setRemoteIndex(undefined);
      });
    return () => {
      active = false;
    };
  }, [open, sessionSpace, readerSpace, loadPages]);
  const chatPages =
    readerSpace === sessionSpace
      ? pageIndex?.pages
      : remoteIndex?.space === sessionSpace
        ? remoteIndex?.pages
        : undefined;

  const [images, setImages] = useState<PromptImage[]>([]);
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sendingTo, setSendingTo] = useState("");
  const [pending, setPending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
  const messagePane = useRef<HTMLDivElement>(null);
  const messageContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pane = messagePane.current,
      content = messageContent.current;
    if (!open || historyOpen || !pane || !content) return;
    const follow = () => {
      pane.scrollTop = pane.scrollHeight;
    };
    follow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [open, historyOpen, enabled, session?.id]);
  const pager = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pager.current;
    if (!el) return;
    const go = (smooth: boolean) =>
      el.scrollTo?.({
        left: historyOpen ? 0 : el.clientWidth,
        behavior:
          smooth &&
          !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
            ? "smooth"
            : "instant",
      });
    go(true);
    const resize = () => go(false);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [historyOpen, open, enabled]);
  const workspace = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || !viewport) return;
    const resize = () => {
      workspace.current?.style.setProperty(
        "--chat-visible-height",
        viewport.height + "px",
      );
      workspace.current?.style.setProperty(
        "--chat-visible-top",
        viewport.offsetTop + "px",
      );
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
    };
  }, [open]);
  const action = useRef(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const creation = useRef<{ id: string; space?: string; mode: string } | null>(
    null,
  );
  const uncertain = useRef<{
    id: string;
    text: string;
    session: string;
    images: PromptImage[];
    model: string;
  } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    let attemptedRestore = false;
    let stopped = false,
      reading = false;
    const refresh = async () => {
      if (reading || action.current || document.visibilityState === "hidden")
        return;
      reading = true;
      const own = epoch.current;
      try {
        const status = await pb.send<{
          enabled: boolean;
        }>("/api/chat/status", {});
        if (stopped || own !== epoch.current) return;
        setEnabled(status.enabled);
        if (!status.enabled || !open) return;
        const list = await pb.send<{ sessions: ChatSession[] }>(
          "/api/chat/sessions",
          {},
        );
        if (stopped || own !== epoch.current) return;
        setSessions(list.sessions);
        if (selected) {
          let snapshot = await pb.send<ChatSession>(endpoint(selected), {});
          if (
            !stopped &&
            own === epoch.current &&
            !attemptedRestore &&
            snapshot.canResume &&
            ["closed", "interrupted", "error"].includes(snapshot.status)
          ) {
            attemptedRestore = true;
            snapshot = await pb.send<ChatSession>(
              endpoint(selected) + "/resume",
              { method: "POST", body: {} },
            );
          }
          if (!stopped && own === epoch.current) setSession(snapshot);
        }
      } catch (err) {
        if (!stopped && own === epoch.current) setError(failure(err));
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, selected]);
  async function mutate(
    path: string,
    body: unknown,
    after?: () => void,
    selectResult = true,
  ) {
    if (action.current) return;
    action.current = true;
    epoch.current++;
    setPending(true);
    if (session && path === endpoint(session.id) + "/prompt")
      setSendingTo(session.id);
    setError("");
    try {
      if (
        path.endsWith("/prompt") &&
        session?.canResume &&
        ["closed", "interrupted", "error"].includes(session.status)
      ) {
        await pb.send(endpoint(session.id) + "/resume", {
          method: "POST",
          body: {},
        });
      }
      const snapshot = await pb.send<ChatSession>(path, {
        method: "POST",
        body,
      });
      if (!alive.current) return;
      epoch.current++;
      if (selectResult || selected === snapshot.id) {
        setSession(snapshot);
        setSelected(snapshot.id);
      }
      setSessions((old) => [
        snapshot,
        ...old.filter((item) => item.id !== snapshot.id),
      ]);
      after?.();
    } catch (err) {
      if (alive.current) setError(failure(err));
    } finally {
      action.current = false;
      if (alive.current) {
        setPending(false);
        setSendingTo("");
      }
    }
  }
  const busy = [
    "starting",
    "initializing",
    "running",
    "waiting",
    "cancelling",
  ].includes(session?.status || "");
  const canSend =
    session?.status === "idle" ||
    (!!session?.canResume &&
      ["closed", "interrupted", "error"].includes(session.status));
  const send = () => {
    if (!session || (!draft.trim() && !images.length)) return;
    let attempt = uncertain.current;
    if (
      !attempt ||
      attempt.text !== draft ||
      attempt.session !== session.id ||
      attempt.images !== images ||
      attempt.model !== model
    )
      attempt = {
        id: requestId(),
        text: draft,
        session: session.id,
        images,
        model,
      };
    uncertain.current = attempt;
    void mutate(
      `${endpoint(session.id)}/prompt`,
      {
        requestId: attempt.id,
        text: attempt.text,
        ...(images.length ? { images } : {}),
        ...(model ? { model } : {}),
      },
      () => {
        uncertain.current = null;
        setDraft("");
        setImages([]);
        setModel("");
      },
    );
  };
  const scoped = sessions;
  const pinned = scoped.filter((item) => item.pinned && !item.archived);
  const recent = scoped.filter((item) => !item.pinned && !item.archived);
  const archived = scoped.filter((item) => item.archived);
  const nameOf = (id: string) =>
    spaces.find((item) => item.id === id)?.name || id;
  const savedDrafts = useRef(
    new Map<string, { text: string; images: PromptImage[]; model: string }>(),
  );
  function rememberDraft() {
    if (!selected) return;
    if (draft || images.length || model)
      savedDrafts.current.set(selected, { text: draft, images, model });
    else savedDrafts.current.delete(selected);
  }
  function changeSpace(id: string) {
    rememberDraft();
    epoch.current++;
    setHistoryOpen(true);

    setSession(null);
    setSelected("");
    setDraft("");
    setImages([]);
    setModel("");
    setError("");
    creation.current = null;
    onSpaceChange?.(id);
  }
  function historyRow(item: ChatSession) {
    const title = item.title || "Untitled chat";
    return (
      <div className="history-entry" key={item.id}>
        <button
          className="history-row"
          aria-label={title}
          aria-description={
            item.needsApproval ? "Approval needed" : item.preview
          }
          aria-current={selected === item.id ? "page" : undefined}
          disabled={pending}
          title={title}
          onClick={() => {
            setHistoryOpen(false);
            if (selected === item.id) return;
            epoch.current++;
            rememberDraft();
            const saved = savedDrafts.current.get(item.id);
            setSelected(item.id);
            setDraft(saved?.text || "");
            setImages(saved?.images || []);
            setModel(saved?.model || "");
            setSession(null);
            setError("");
          }}
        >
          <DestinationIcon name="bot" />
          <span className="chat-row-copy">
            <strong>{title}</strong>
            <small className={item.needsApproval ? "chat-attention" : ""}>
              {item.needsApproval
                ? "Approval needed"
                : item.preview || "No messages yet"}
            </small>
            {
              <small className="history-space-name">
                <span aria-hidden="true">
                  {
                    ["◇", "○", "△", "□", "⬡"][
                      Array.from(item.space).reduce(
                        (hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0,
                        0,
                      ) % 5
                    ]
                  }{" "}
                </span>
                {nameOf(item.space)}
              </small>
            }
          </span>
          {item.updated && (
            <time dateTime={item.updated}>
              {new Intl.DateTimeFormat(
                undefined,
                new Date(item.updated).toDateString() ===
                  new Date().toDateString()
                  ? { hour: "numeric", minute: "2-digit" }
                  : { month: "short", day: "numeric" },
              ).format(new Date(item.updated))}
            </time>
          )}
        </button>
        <div className="history-actions">
          {(item.archived
            ? ["restore"]
            : [item.pinned ? "unpin" : "pin", "archive"]
          ).map((action) => {
            const label = action[0].toUpperCase() + action.slice(1) + " chat";
            return (
              <button
                key={action}
                title={label}
                aria-label={label}
                disabled={pending}
                onClick={() =>
                  void mutate(
                    endpoint(item.id) + "/organize",
                    { action },
                    undefined,
                    false,
                  )
                }
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  width="17"
                  height="17"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {action === "pin" || action === "unpin" ? (
                    <>
                      <path d="m15 3 6 6-3 1-4 5v3l-8-8h3l5-4zM10 14l-7 7" />
                      {action === "unpin" && <path d="m3 3 18 18" />}
                    </>
                  ) : (
                    <>
                      <path d="M3 5h18v4H3zM5 9v11h14V9" />
                      {action === "restore" ? (
                        <path d="m9 15 3-3 3 3m-3-3v6" />
                      ) : (
                        <path d="M10 12h4" />
                      )}
                    </>
                  )}
                </svg>
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  const chatSpaceDialog = useRef<HTMLDialogElement>(null);
  const availableSpaces = spaces.filter((item) => !item.archived);
  function newChat(space: string) {
    chatSpaceDialog.current?.close();
    if (
      !creation.current ||
      creation.current.space !== space ||
      creation.current.mode !== mode
    )
      creation.current = { id: requestId(), space, mode };
    void mutate(
      "/api/chat/sessions",
      { requestId: creation.current.id, space, mode },
      () => {
        setHistoryOpen(false);
        rememberDraft();
        setDraft("");
        creation.current = null;
        setImages([]);
        setModel("");
      },
    );
  }
  async function createSpace(event: React.FormEvent) {
    event.preventDefault();
    if (!spaceDraft.trim() || !onCreateSpace || savingSpace) return;
    setSavingSpace(true);
    setSpaceError("");
    try {
      const id = await onCreateSpace(spaceDraft.trim());
      changeSpace(id);
      setSpaceDraft("");
      setCreatingSpace(false);
      setSpaceList(false);
    } catch (err) {
      setSpaceError(failure(err));
    } finally {
      setSavingSpace(false);
    }
  }
  const messages = transcript(session?.events || []);
  const last = messages.at(-1);
  const submitting = !!session && sendingTo === session.id;
  const working =
    session &&
    (submitting || session.status === "running") &&
    !session.permissions?.length;
  const liveReply =
    working && !submitting && last?.type === "agent" && !last.workedFor
      ? last
      : undefined;
  const timer = working ? (
    <WorkingTimer
      start={
        submitting
          ? undefined
          : session.events
              ?.slice()
              .reverse()
              .find((event) => event.type === "user")?.time
      }
    />
  ) : null;
  return (
    <>
      <nav
        hidden={open ? !historyOpen && !!enabled : !spaceList}
        className="destination-strip"
        aria-label="Workspace navigation"
      >
        <div className="workspace-switch">
          <button
            type="button"
            aria-pressed={!open}
            disabled={savingSpace}
            onClick={() => {
              setOpen(false);
              setSpaceList(true);
            }}
          >
            Spaces
          </button>
          <button
            type="button"
            aria-pressed={open}
            disabled={savingSpace}
            onClick={() => {
              setOpen(true);
              setHistoryOpen(true);
              setCreatingSpace(false);
            }}
          >
            Chats
          </button>
        </div>
        <button
          className="destination-add"
          type="button"
          aria-label={open ? "New chat" : "New space"}
          title={open ? "New chat" : "New space"}
          disabled={
            open
              ? pending || !availableSpaces.length || !enabled
              : !onCreateSpace || savingSpace
          }
          onClick={() => {
            if (open) chatSpaceDialog.current?.showModal();
            else {
              setSpaceList(true);
              setCreatingSpace(true);
              setSpaceError("");
            }
          }}
        >
          ＋
        </button>
      </nav>
      <dialog
        ref={chatSpaceDialog}
        className="chat-space-choice"
        aria-labelledby="new-chat-space-title"
      >
        <h2 id="new-chat-space-title">Choose a space for this chat</h2>
        <div>
          {availableSpaces.map((item) => (
            <button
              type="button"
              key={item.id}
              className="space-list-row"
              onClick={() => newChat(item.id)}
            >
              <DestinationIcon name="space" />
              {item.name}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => chatSpaceDialog.current?.close()}>
          Cancel
        </button>
      </dialog>
      {!open && (
        <section
          className="spaces-index"
          data-visible={spaceList}
          inert={!spaceList}
          aria-label="Spaces list"
        >
          <div className="spaces-list-heading">
            <h2>Spaces</h2>
            {spaceManagement}
          </div>
          {creatingSpace && (
            <form onSubmit={createSpace}>
              <label>
                Space name
                <input
                  autoFocus
                  value={spaceDraft}
                  onChange={(e) => setSpaceDraft(e.target.value)}
                  disabled={savingSpace}
                />
              </label>
              <button disabled={!spaceDraft.trim() || savingSpace}>
                Create space
              </button>
              <button
                type="button"
                disabled={savingSpace}
                onClick={() => setCreatingSpace(false)}
              >
                Cancel
              </button>
              {spaceError && <p role="alert">{spaceError}</p>}
            </form>
          )}
          {spaces
            .filter((item) => !item.archived || item.id === space)
            .map((item) => (
              <button
                className="space-list-row"
                key={item.id}
                aria-current={item.id === space ? "page" : undefined}
                disabled={savingSpace}
                onClick={() => {
                  changeSpace(item.id);
                  setSpaceList(false);
                  setCreatingSpace(false);
                }}
              >
                <DestinationIcon name="space" />
                <strong>{item.name}</strong>
                <span aria-hidden="true">›</span>
              </button>
            ))}
        </section>
      )}
      {open && (
        <section
          ref={workspace}
          className="agent-chat"
          aria-label="Chat workspace"
        >
          {enabled === null && <p role="status">Connecting…</p>}
          {enabled === false && (
            <p>
              Chat is not set up on this computer yet. Ask your setup agent to
              enable host chat.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {enabled && (
            <>
              <div
                ref={pager}
                className="chat-layout"
                data-history={historyOpen}
              >
                <nav
                  className="chat-history"
                  aria-label="Chat history"
                  inert={!historyOpen}
                >
                  {!!pinned.length && (
                    <>
                      <h3>Pinned</h3>
                      {pinned.map(historyRow)}
                    </>
                  )}
                  {!!recent.length && (
                    <>
                      <h3>Recent chats</h3>
                      {recent.map(historyRow)}
                    </>
                  )}
                  {!!archived.length && (
                    <details className="history-archive">
                      <summary>Archived chats</summary>
                      {archived.map(historyRow)}
                    </details>
                  )}
                  {!scoped.length && <p>No conversations yet</p>}
                </nav>
                <div className="chat-thread" inert={historyOpen}>
                  {(session || !historyOpen) && (
                    <header
                      className="chat-space-header"
                      aria-label="Conversation space"
                    >
                      <button
                        className="thread-back"
                        aria-label="Back to chats"
                        onClick={() => setHistoryOpen(true)}
                      >
                        ‹
                      </button>
                      <div>
                        <strong>
                          {session
                            ? session.title || "Untitled chat"
                            : "Opening chat…"}
                        </strong>
                        {session && <small>{nameOf(session.space)}</small>}
                      </div>
                    </header>
                  )}
                  {!session && historyOpen && (
                    <p>Start a new chat or choose a conversation.</p>
                  )}
                  {session && (
                    <>
                      <div className="chat-thread-scroll" ref={messagePane}>
                        <div
                          ref={messageContent}
                          className="chat-thread-content"
                        >
                          {session.error && <p role="alert">{session.error}</p>}
                          <div
                            className="agent-chat-transcript"
                            aria-label="Conversation messages"
                            tabIndex={0}
                          >
                            {messages.map((event) => (
                              <article
                                key={event.seq}
                                className="agent-chat-message"
                                data-speaker={event.type}
                                aria-label={
                                  event.type === "user"
                                    ? "Your message"
                                    : "Agent reply"
                                }
                              >
                                {event.type === "user" &&
                                  Array.isArray(
                                    (
                                      event.data as {
                                        images?: PromptImage[];
                                      } | null
                                    )?.images,
                                  ) &&
                                  (
                                    event.data as { images: PromptImage[] }
                                  ).images.map((img, i) => (
                                    <ImagePreview
                                      image={img}
                                      key={i}
                                      alt={"Attached image " + (i + 1)}
                                    />
                                  ))}
                                {event === liveReply && timer}
                                {event.workedFor && (
                                  <div className="chat-worked">
                                    Worked for {event.workedFor}
                                  </div>
                                )}
                                <ChatMarkdown
                                  text={event.text || ""}
                                  space={
                                    event.type === "agent"
                                      ? session.space
                                      : undefined
                                  }
                                  pages={
                                    event.type === "agent"
                                      ? chatPages
                                      : undefined
                                  }
                                  onNavigate={() => {
                                    setOpen(false);
                                    setSpaceList(false);
                                  }}
                                />
                              </article>
                            ))}
                            {!liveReply && timer}
                          </div>
                          {(session.permissions || []).map((permission) => (
                            <ApprovalCard
                              key={permission.id}
                              permission={permission}
                              spaceName={nameOf(session.space)}
                              pending={pending}
                              decide={(optionId) =>
                                void mutate(
                                  `${endpoint(session.id)}/permission`,
                                  {
                                    requestId: permission.id,
                                    optionId,
                                  },
                                )
                              }
                            />
                          ))}
                        </div>
                      </div>
                      <form
                        className="agent-composer"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (busy)
                            void mutate(`${endpoint(session.id)}/cancel`, {});
                          else send();
                        }}
                      >
                        {images.length > 0 && (
                          <div className="composer-images">
                            {images.map((img, i) => (
                              <div key={i}>
                                <ImagePreview
                                  image={img}
                                  alt={"Attachment " + (i + 1)}
                                />
                                <button
                                  type="button"
                                  aria-label={"Remove attachment " + (i + 1)}
                                  onClick={() =>
                                    setImages(images.filter((_, n) => i !== n))
                                  }
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <textarea
                          rows={2}
                          id="agent-chat-draft"
                          aria-label="Message"
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              if (!pending && !busy && canSend) send();
                            }
                          }}
                          value={draft}
                          maxLength={32000}
                          onChange={(event) => setDraft(event.target.value)}
                          placeholder="Ask about your knowledge base…"
                        />
                        <div className="agent-chat-controls">
                          <ComposerTools
                            key={session.id}
                            images={images}
                            onImages={setImages}
                            canAttach={!!session.images}
                            models={session.models}
                            model={model}
                            onModel={setModel}
                            onText={(text) =>
                              setDraft((old) => (old ? old + " " : "") + text)
                            }
                            onError={setError}
                            disabled={pending || busy || !canSend}
                            currentMode={session.mode || "read-only"}
                            modePending={pending}
                            onMode={(value) =>
                              void mutate(
                                endpoint(session.id) + "/mode",
                                { mode: value },
                                () => {
                                  if (value !== "agent-full-access") {
                                    localStorage.setItem(
                                      "chat.defaultMode",
                                      value,
                                    );
                                    setPreferred(value);
                                  }
                                },
                              )
                            }
                            permission={
                              session.mode === "agent-full-access"
                                ? "Full access (YOLO)"
                                : session.mode === "workspace-write"
                                  ? "Workspace access"
                                  : "Read-only"
                            }
                          />
                          <button
                            type="submit"
                            className="composer-action"
                            data-stopping={busy}
                            aria-label={busy ? "Stop" : "Send"}
                            title={
                              busy
                                ? session.status === "cancelling"
                                  ? "Stopping…"
                                  : "Stop"
                                : "Send"
                            }
                            disabled={
                              pending ||
                              (busy
                                ? session.status === "cancelling"
                                : !canSend || (!draft.trim() && !images.length))
                            }
                          >
                            {busy ? "Stop" : "Send"}
                          </button>
                        </div>
                      </form>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
