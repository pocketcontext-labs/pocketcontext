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
  await screen.findByRole("option", { name: /session-/ });
  fireEvent.change(screen.getByLabelText("Conversation"), {
    target: { value: snapshot.id },
  });
  await screen.findByText("reader", { selector: "strong" });
}
it("explains unavailable host chat", async () => {
  send.mockResolvedValue({ enabled: false });
  render(<AgentChat space="space-one" />);
  fireEvent.click(screen.getByText("Chat"));
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
    expect(screen.getByLabelText("Conversation")).toHaveValue("session-one"),
  );
  expect(screen.getByLabelText("Message")).toHaveValue("Draft for later");
});
it("ends a host conversation explicitly", async () => {
  await openSession();
  fireEvent.click(screen.getByRole("button", { name: "End conversation" }));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith("/api/chat/sessions/session-one/close", {
      method: "POST",
      body: {},
    }),
  );
});
it("merges streamed agent chunks into one markdown message", async () => {
  send.mockImplementation(async (path) => {
    if (path === "/api/chat/status") return { enabled: true } as never;
    if (path === "/api/chat/sessions") return { sessions: [snapshot] } as never;
    return {
      ...snapshot,
      events: [
        { seq: 1, type: "agent", text: "Hello **rea" },
        { seq: 2, type: "agent", text: "der**" },
      ],
    } as never;
  });
  await openSession();
  expect(screen.getAllByText("Agent", { selector: "strong" })).toHaveLength(1);
});
