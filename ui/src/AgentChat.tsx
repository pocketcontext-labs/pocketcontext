import Brand from "./Brand";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { pb } from "./api";
import "./agentChat.css";
import {
  ComposerTools,
  ImagePreview,
  type PromptImage,
  type ModelState,
} from "./ComposerTools";

type Event = { seq: number; type: string; text?: string; data?: unknown };
type Permission = {
  id: string;
  toolCall: unknown;
  options: { optionId: string; name: string; kind: string }[];
};
function ApprovalCard({
  permission,
  pending,
  decide,
}: {
  permission: Permission;
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
          <h3>Approval requested</h3>
          <p>
            {typeof call?.title === "string"
              ? call.title
              : "Review the requested action"}
          </p>
        </div>
      </div>
      {(command || path) && (
        <pre className="approval-command">
          <code>{command || path}</code>
        </pre>
      )}
      <details
        className="approval-details"
        onToggle={(e) => setShowDetails(e.currentTarget.open)}
      >
        <summary>Request details</summary>
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
              {option.name}
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
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        img: ({ alt }) => <span>[Image: {alt || "not loaded"}]</span>,
        a: ({ href, children }) =>
          /^https?:\/\//i.test(href || "") ? (
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
function transcript(events: Event[]) {
  const rows: Event[] = [];
  let previousId: unknown;
  let continuing = false;
  for (const event of events) {
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
function RailIcon({ name }: { name: "home" | "chat" | "history" }) {
  const paths = {
    home: "M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3z",
    chat: "M4 4h16v13H9l-5 4z M8 9h8 M8 12h5",
    history: "M3 12a9 9 0 1 0 2-6L3 8 M3 3v5h5 M12 7v5l3 2",
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
}: {
  space?: string;
  spaces?: { id: string; name: string; archived?: boolean }[];
  onSpaceChange?: (id: string) => void;
}) {
  const [allSpaces, setAllSpaces] = useState(false);
  const [allowWorkspace, setAllowWorkspace] = useState(false);
  const [allowFullAccess, setAllowFullAccess] = useState(false);
  const [preferred, setPreferred] = useState(
    () => localStorage.getItem("chat.defaultMode") || "read-only",
  );
  const mode =
    allowWorkspace && preferred === "workspace-write" ? preferred : "read-only";
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selected, setSelected] = useState("");
  const [session, setSession] = useState<ChatSession | null>(null);
  const [images, setImages] = useState<PromptImage[]>([]);
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
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
          allowWorkspace?: boolean;
          allowFullAccess?: boolean;
        }>("/api/chat/status", {});
        if (stopped || own !== epoch.current) return;
        setEnabled(status.enabled);
        setAllowWorkspace(Boolean(status.allowWorkspace));
        setAllowFullAccess(Boolean(status.allowFullAccess));
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
      if (alive.current) setPending(false);
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
  const scoped = sessions.filter((item) => allSpaces || item.space === space);
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
  function spacePicker(id: string | undefined, label: string) {
    const choices = spaces.filter((item) => !item.archived || item.id === id);
    if (
      !onSpaceChange ||
      !choices.some((item) => item.id !== id && !item.archived)
    )
      return <strong>{id ? nameOf(id) : "No space selected"}</strong>;
    return (
      <select
        aria-label={label}
        value={id || ""}
        disabled={pending}
        onChange={(event) => {
          rememberDraft();
          epoch.current++;
          setHistoryOpen(true);
          setAllSpaces(false);
          setSession(null);
          setSelected("");
          setDraft("");
          setImages([]);
          setModel("");
          setError("");
          creation.current = null;
          onSpaceChange(event.target.value);
        }}
      >
        {!id && (
          <option value="" disabled>
            Choose a space
          </option>
        )}
        {choices.map((item) => (
          <option key={item.id} value={item.id} disabled={item.archived}>
            {item.name}
          </option>
        ))}
      </select>
    );
  }
  function historyRow(item: ChatSession) {
    const title = item.title || "Untitled chat";
    return (
      <div className="history-entry" key={item.id}>
        <button
          className="history-row"
          aria-label={allSpaces ? title + ", " + nameOf(item.space) : title}
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
          <span>
            {title}
            {allSpaces && (
              <small className="history-space-name">{nameOf(item.space)}</small>
            )}
          </span>
          {[
            "running",
            "waiting",
            "starting",
            "initializing",
            "cancelling",
          ].includes(item.status) && <small aria-label={item.status}>◌</small>}
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
  return (
    <>
      <nav className="reader-rail" aria-label="Reader tools">
        <button
          title="Knowledge base"
          aria-label={open ? "Close chat" : "Knowledge base"}
          aria-pressed={!open}
          onClick={() => {
            setOpen(false);
          }}
        >
          <RailIcon name="home" />
        </button>
        <button
          title="Chat"
          aria-label="Chat"
          aria-pressed={open}
          onClick={() => {
            setOpen(true);
            setHistoryOpen(!selected);
          }}
        >
          <RailIcon name="chat" />
        </button>
        {open && (
          <button
            className="rail-history"
            title="Conversation history"
            aria-label="Conversation history"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <RailIcon name="history" />
          </button>
        )}
      </nav>
      {open && (
        <section className="agent-chat" aria-label="Chat workspace">
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
              <div className="chat-layout" data-history={historyOpen}>
                <nav className="chat-history" aria-label="Chat history">
                  <Brand />
                  <div className="publication-control nav-space-picker">
                    <span>Space</span>
                    {spacePicker(space, "Space for new chats")}
                  </div>
                  <button
                    className="new-chat-action"
                    disabled={pending || !space}
                    onClick={() => {
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
                    }}
                  >
                    <span aria-hidden="true">＋</span> New chat
                  </button>
                  <div
                    className="history-scope"
                    role="group"
                    aria-label="History scope"
                  >
                    <button
                      aria-pressed={!allSpaces}
                      onClick={() => setAllSpaces(false)}
                    >
                      Current space
                    </button>
                    <button
                      aria-pressed={allSpaces}
                      onClick={() => setAllSpaces(true)}
                    >
                      All spaces
                    </button>
                  </div>
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
                <div className="chat-thread">
                  {session && (
                    <header
                      className="chat-space-header"
                      aria-label="Conversation space"
                    >
                      <span>Space</span>
                      <strong>{nameOf(session.space)}</strong>
                    </header>
                  )}
                  {!session && (
                    <p>Start a new chat or choose a conversation.</p>
                  )}
                  {session && (
                    <>
                      {session.error && <p role="alert">{session.error}</p>}
                      <div
                        className="agent-chat-transcript"
                        aria-label="Conversation messages"
                        tabIndex={0}
                      >
                        {transcript(session.events || []).map((event) => (
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
                            <ChatMarkdown text={event.text || ""} />
                          </article>
                        ))}
                      </div>
                      {(session.permissions || []).map((permission) => (
                        <ApprovalCard
                          key={permission.id}
                          permission={permission}
                          pending={pending}
                          decide={(optionId) =>
                            void mutate(`${endpoint(session.id)}/permission`, {
                              requestId: permission.id,
                              optionId,
                            })
                          }
                        />
                      ))}
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
                            allowWorkspace={allowWorkspace}
                            allowFullAccess={allowFullAccess}
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
