import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { pb } from "./api";
import "./agentChat.css";

type Event = { seq: number; type: string; text?: string; data?: unknown };
type Permission = {
  id: string;
  toolCall: unknown;
  options: { optionId: string; name: string; kind: string }[];
};
export type ChatSession = {
  id: string;
  space: string;
  status: string;
  error?: string;
  canResume?: boolean;
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
  for (const event of events) {
    if (event.type.includes("thought")) continue;
    const previous = rows.at(-1);
    if (event.type === "agent" && previous?.type === event.type)
      previous.text = (previous.text || "") + (event.text || "");
    else rows.push({ ...event });
  }
  return rows;
}
export default function AgentChat({ space }: { space?: string }) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selected, setSelected] = useState("");
  const [session, setSession] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const action = useRef(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const creation = useRef<{ id: string; space?: string } | null>(null);
  const uncertain = useRef<{
    id: string;
    text: string;
    session: string;
  } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let stopped = false,
      reading = false;
    const refresh = async () => {
      if (reading || action.current || document.visibilityState === "hidden")
        return;
      reading = true;
      const own = epoch.current;
      try {
        const status = await pb.send<{ enabled: boolean }>(
          "/api/chat/status",
          {},
        );
        if (stopped || own !== epoch.current) return;
        setEnabled(status.enabled);
        if (!status.enabled) return;
        const list = await pb.send<{ sessions: ChatSession[] }>(
          "/api/chat/sessions",
          {},
        );
        if (stopped || own !== epoch.current) return;
        setSessions(list.sessions);
        if (selected) {
          const snapshot = await pb.send<ChatSession>(endpoint(selected), {});
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
  async function mutate(path: string, body: unknown, after?: () => void) {
    if (action.current) return;
    action.current = true;
    epoch.current++;
    setPending(true);
    setError("");
    try {
      const snapshot = await pb.send<ChatSession>(path, {
        method: "POST",
        body,
      });
      if (!alive.current) return;
      epoch.current++;
      setSession(snapshot);
      setSelected(snapshot.id);
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
  const send = () => {
    if (!session || !draft.trim()) return;
    let attempt = uncertain.current;
    if (!attempt || attempt.text !== draft || attempt.session !== session.id)
      attempt = { id: requestId(), text: draft, session: session.id };
    uncertain.current = attempt;
    void mutate(
      `${endpoint(session.id)}/prompt`,
      { requestId: attempt.id, text: attempt.text },
      () => {
        uncertain.current = null;
        setDraft("");
      },
    );
  };
  return (
    <>
      <button className="agent-chat-launch" onClick={() => setOpen(true)}>
        Chat
      </button>
      <dialog
        ref={dialog}
        className="agent-chat"
        aria-modal="true"
        aria-labelledby="agent-chat-title"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <header>
          <h2 id="agent-chat-title">Chat with your knowledge base</h2>
          <button aria-label="Close chat" onClick={() => setOpen(false)}>
            Close
          </button>
        </header>
        <p className="agent-chat-note">
          The agent runs on the computer hosting your knowledge base. Work can
          continue while you close this chat.
        </p>
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
            <div className="agent-chat-controls">
              <label>
                Conversation
                <select
                  aria-label="Conversation"
                  value={selected}
                  disabled={pending}
                  onChange={(event) => {
                    epoch.current++;
                    setSelected(event.target.value);
                    setSession(null);
                    setError("");
                  }}
                >
                  <option value="">Choose a conversation</option>
                  {sessions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id.slice(0, 8)} · {item.space} · {item.status}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={pending || !space}
                onClick={() => {
                  if (!creation.current || creation.current.space !== space)
                    creation.current = { id: requestId(), space };
                  void mutate(
                    "/api/chat/sessions",
                    { requestId: creation.current.id, space },
                    () => {
                      creation.current = null;
                    },
                  );
                }}
              >
                New conversation
              </button>
            </div>
            {session && (
              <>
                <p role="status">
                  {session.status} · Space: {session.space}
                </p>
                {session.error && <p role="alert">{session.error}</p>}
                <div
                  className="agent-chat-transcript"
                  aria-label="Conversation messages"
                  tabIndex={0}
                >
                  {transcript(session.events || []).map((event) => (
                    <article key={event.seq} className="agent-chat-message">
                      <strong>
                        {event.type.startsWith("user")
                          ? "You"
                          : event.type.startsWith("agent")
                            ? "Agent"
                            : "Activity"}
                      </strong>
                      {event.text && <ChatMarkdown text={event.text} />}
                      {event.type === "tool" && event.data != null && (
                        <details>
                          <summary>Operation details</summary>
                          <pre>{JSON.stringify(event.data, null, 2)}</pre>
                        </details>
                      )}
                    </article>
                  ))}
                </div>
                {(session.permissions || []).map((permission) => (
                  <section
                    className="agent-chat-permission"
                    key={permission.id}
                    aria-label="Approval requested"
                  >
                    <h3>Approval requested</h3>
                    <pre>{JSON.stringify(permission.toolCall, null, 2)}</pre>
                    <div>
                      {permission.options.map((option) => (
                        <button
                          key={option.optionId}
                          disabled={pending}
                          onClick={() =>
                            void mutate(`${endpoint(session.id)}/permission`, {
                              requestId: permission.id,
                              optionId: option.optionId,
                            })
                          }
                        >
                          {option.name}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
                {session.canResume &&
                  ["closed", "interrupted", "error"].includes(
                    session.status,
                  ) && (
                    <button
                      disabled={pending}
                      onClick={() =>
                        void mutate(`${endpoint(session.id)}/resume`, {})
                      }
                    >
                      Resume conversation
                    </button>
                  )}
                {session.status !== "closed" && (
                  <button
                    disabled={pending}
                    onClick={() =>
                      void mutate(`${endpoint(session.id)}/close`, {})
                    }
                  >
                    End conversation
                  </button>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    send();
                  }}
                >
                  <label htmlFor="agent-chat-draft">Message</label>
                  <textarea
                    id="agent-chat-draft"
                    value={draft}
                    maxLength={32000}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Ask about your knowledge base…"
                  />
                  <div className="agent-chat-controls">
                    <button
                      type="submit"
                      disabled={
                        pending ||
                        busy ||
                        session.status !== "idle" ||
                        !draft.trim()
                      }
                    >
                      Send
                    </button>
                    {busy && (
                      <button
                        type="button"
                        disabled={pending || session.status === "cancelling"}
                        onClick={() =>
                          void mutate(`${endpoint(session.id)}/cancel`, {})
                        }
                      >
                        {session.status === "cancelling" ? "Stopping…" : "Stop"}
                      </button>
                    )}
                  </div>
                </form>
              </>
            )}
          </>
        )}
      </dialog>
    </>
  );
}
