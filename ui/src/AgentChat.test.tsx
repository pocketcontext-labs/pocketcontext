import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentChat, { ChatMarkdown, type ChatSession } from "./AgentChat";
import { pb } from "./api";
vi.mock("./api", () => ({ pb: { send: vi.fn() } }));
const send = vi.mocked(pb.send);
const snapshot: ChatSession = {
  id: "session-one",
  space: "space-one",
  status: "idle",
  lastSeq: 1,
  events: [{ seq: 1, type: "agent", text: "Hello **reader**" }],
  permissions: [],
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  send.mockReset();
  send.mockImplementation(async (path) => {
    if (path === "/api/chat/status") return { enabled: true } as never;
    if (path === "/api/chat/sessions") return { sessions: [snapshot] } as never;
    return snapshot as never;
  });
});
afterEach(cleanup);
async function openSession() {
  render(<AgentChat space="space-one" />);
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Untitled chat" }))[0],
  );
  await screen.findByText("reader", { selector: "strong" });
}
it("explains unavailable host chat", async () => {
  send.mockResolvedValue({ enabled: false });
  render(<AgentChat space="space-one" />);
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(await screen.findByText(/Chat is not set up/)).toBeVisible();
  expect(screen.queryByText("New conversation")).not.toBeInTheDocument();
});
it("keeps failed drafts and reuses request identity for explicit retry", async () => {
  await openSession();
  const attempts: unknown[] = [];
  send.mockImplementation(async (path, options) => {
    if (path.endsWith("/prompt")) {
      attempts.push(options?.body);
      throw new Error("Connection lost");
    }
    if (path === "/api/chat/status") return { enabled: true } as never;
    if (path === "/api/chat/sessions") return { sessions: [snapshot] } as never;
    return snapshot as never;
  });
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Summarize my notes" },
  });
  fireEvent.click(screen.getByText("Send"));
  await screen.findByText("Connection lost");
  expect(screen.getByLabelText("Message")).toHaveValue("Summarize my notes");
  expect(attempts).toHaveLength(1);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(attempts).toHaveLength(2));
  expect(attempts[0]).toEqual(attempts[1]);
});
it("submits actual permission option and shows command detail", async () => {
  send.mockImplementation(async (path) => {
    if (path === "/api/chat/status") return { enabled: true } as never;
    if (path === "/api/chat/sessions") return { sessions: [snapshot] } as never;
    return {
      ...snapshot,
      status: "waiting",
      permissions: [
        {
          id: "permission-42",
          toolCall: {
            title: "Write page",
            rawInput: { path: "/work/page.md" },
          },
          options: [
            {
              optionId: "custom-deny",
              name: "Reject this action",
              kind: "reject_once",
            },
          ],
        },
      ],
    } as never;
  });
  await openSession();
  expect(screen.getByText(/\/work\/page.md/)).toBeVisible();
  fireEvent.click(screen.getByText("Reject this action"));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      "/api/chat/sessions/session-one/permission",
      {
        method: "POST",
        body: { requestId: "permission-42", optionId: "custom-deny" },
      },
    ),
  );
});
it("renders safe markdown without remote images or active HTML", () => {
  const { container } = render(
    <ChatMarkdown
      text={
        "**Hello** ![private](https://evil.test/track) <script>alert(1)</script> [unsafe](javascript:alert%281%29) [safe](https://example.com)"
      }
    />,
  );
  expect(container.querySelector("img, script")).toBeNull();
  expect(screen.getByText("Hello").tagName).toBe("STRONG");
  expect(screen.getByRole("link")).toHaveAttribute(
    "href",
    "https://example.com",
  );
});
it("reconnects to the same conversation after closing without stopping host work", async () => {
  await openSession();
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Draft for later" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
  expect(
    send.mock.calls.filter(
      ([path]) => path.endsWith("/cancel") || path.endsWith("/close"),
    ),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "Untitled chat" })[0],
    ).toHaveAttribute("aria-current", "page"),
  );
  expect(screen.getByLabelText("Message")).toHaveValue("Draft for later");
});
it("restores an interrupted conversation without replaying its prompt", async () => {
  send.mockImplementation(async (path) => {
    if (path === "/api/chat/status") return { enabled: true } as never;
    if (path === "/api/chat/sessions") return { sessions: [snapshot] } as never;
    return (
      path.endsWith("/resume")
        ? snapshot
        : { ...snapshot, status: "interrupted", canResume: true }
    ) as never;
  });
  await openSession();
  expect(send).toHaveBeenCalledWith("/api/chat/sessions/session-one/resume", {
    method: "POST",
    body: {},
  });
  expect(send.mock.calls.some(([path]) => path.endsWith("/prompt"))).toBe(
    false,
  );
});
it("merges streamed agent chunks into one markdown message", async () => {
  send.mockImplementation(async (path) => {
    if (path === "/api/chat/status") return { enabled: true } as never;
    if (path === "/api/chat/sessions") return { sessions: [snapshot] } as never;
    return {
      ...snapshot,
      events: [
        { seq: 0, type: "agent", text: "Looking it up." },
        { seq: 1, type: "tool", data: { title: "Run command" } },
        { seq: 2, type: "agent", text: "Hello **rea" },
        { seq: 3, type: "status", text: "Ready" },
        { seq: 4, type: "agent", text: "der**" },
      ],
    } as never;
  });
  await openSession();
  expect(screen.getAllByRole("article", { name: "Agent reply" })).toHaveLength(
    1,
  );
  expect(screen.queryByText("Looking it up.")).not.toBeInTheDocument();
  expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  expect(screen.queryByText("Operation details")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Agent", { selector: "strong" }),
  ).not.toBeInTheDocument();
});

it("filters history by space, lists pinned chats once and labels a cross-space conversation", async () => {
  const other = { ...snapshot, id: "other", space: "two", title: "Elsewhere" };
  send.mockImplementation(async (path) => {
    if (path === "/api/chat/status") return { enabled: true } as never;
    if (path === "/api/chat/sessions")
      return {
        sessions: [
          { ...snapshot, title: "Recent" },
          other,
          { ...snapshot, id: "pin", pinned: true, title: "Important" },
        ],
      } as never;
    return other as never;
  });
  render(
    <AgentChat
      space="space-one"
      spaces={[
        { id: "space-one", name: "Research" },
        { id: "two", name: "Recipes" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  const pinned = await screen.findByRole("button", { name: "Important" });
  expect(
    pinned.compareDocumentPosition(
      screen.getByRole("button", { name: "Recent" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByText("Elsewhere")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All spaces" }));
  fireEvent.click(screen.getByRole("button", { name: "Elsewhere, Recipes" }));
  expect(await screen.findByLabelText("Conversation space")).toHaveTextContent(
    "Recipes",
  );
});

it("switches from a conversation to another space's history and creates there", async () => {
  const spaces = [
    { id: "space-one", name: "Research" },
    { id: "two", name: "Recipes" },
  ];
  const other = { ...snapshot, id: "other", space: "two", title: "Dinner" };
  send.mockImplementation(async (path, options) => {
    if (path === "/api/chat/status") return { enabled: true } as never;
    if (path === "/api/chat/sessions" && options?.method !== "POST")
      return { sessions: [snapshot, other] } as never;
    return (path.endsWith(snapshot.id) ? snapshot : other) as never;
  });
  const switchSpace = vi.fn();
  const view = render(
    <AgentChat space="space-one" spaces={spaces} onSpaceChange={switchSpace} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  fireEvent.click(await screen.findByRole("button", { name: "Untitled chat" }));
  const header = await screen.findByLabelText("Conversation space");
  expect(header).toHaveTextContent("Research");
  expect(header.querySelector("select")).toBeNull();
  fireEvent.change(screen.getByLabelText("Space for new chats"), {
    target: { value: "two" },
  });
  expect(switchSpace).toHaveBeenCalledWith("two");
  view.rerender(
    <AgentChat space="two" spaces={spaces} onSpaceChange={switchSpace} />,
  );
  expect(screen.getByLabelText("Space for new chats")).toHaveValue("two");
  expect(screen.queryByLabelText("Message")).toBeNull();
  await screen.findByRole("button", { name: "Dinner" });
  fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith("/api/chat/sessions", {
      method: "POST",
      body: expect.objectContaining({ space: "two" }),
    }),
  );
});

it("applies full access directly to the open session", async () => {
  send.mockImplementation(async (path) => {
    if (path === "/api/chat/status")
      return { enabled: true, allowFullAccess: true } as never;
    if (path === "/api/chat/sessions") return { sessions: [snapshot] } as never;
    return {
      ...snapshot,
      mode: path.endsWith("/mode") ? "agent-full-access" : "workspace-write",
    } as never;
  });
  await openSession();
  fireEvent.click(
    screen.getByRole("radio", { name: /Full access/, hidden: true }),
  );
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith("/api/chat/sessions/session-one/mode", {
      method: "POST",
      body: { mode: "agent-full-access" },
    }),
  );
});
