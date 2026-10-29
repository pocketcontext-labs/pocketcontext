import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SourceContent } from "./SourceContent";
import { EvidenceExcerpt } from "./EvidenceExcerpt";
const source = {
  id: "source000000001",
  media_type: "text/markdown",
  original_name: "note.md",
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const withMetadata =
  "---\ntitle: Example note\ndate: 2026-10-22\n---\n\n# Example note\n\nCited **words**.";

it("tucks source front matter away without rendering it as a heading", () => {
  const { container } = render(
    <SourceContent source={source} text={withMetadata} />,
  );
  expect(screen.getAllByRole("heading")).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "Example note" })).toBeVisible();
  const metadata = container.querySelector("details")!;
  expect(metadata).not.toHaveAttribute("open");
  expect(metadata.querySelector("summary")).toHaveTextContent(
    "Source metadata",
  );
  expect(metadata.querySelector("code")).toHaveTextContent(
    "title: Example note",
  );
});

it("preserves original line offsets when highlighting prose after front matter", () => {
  const { container } = render(
    <SourceContent
      source={source}
      text={withMetadata}
      passage={{
        id: "metadata-prose",
        locator: "document; line 8",
        body: "Cited **words**.",
      }}
      passageRequested
    />,
  );
  expect(screen.getByRole("button", { name: "Reading view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(container.querySelector("strong mark")).toHaveTextContent("words");
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Exact source" }));
  expect(container.querySelector("pre")?.textContent).toBe(withMetadata);
});

it("opens and highlights cited front matter and renders metadata safely in evidence", () => {
  const body = "---\ntitle: <script>alert(1)</script>\n---";
  const { container, rerender } = render(
    <SourceContent
      source={source}
      text={body}
      passage={{
        id: "metadata-only",
        locator: "front matter; lines 1-3",
        body,
      }}
      passageRequested
    />,
  );
  expect(container.querySelector("details")).toHaveAttribute("open");
  expect(container.querySelector("[data-source-highlight]")).toHaveTextContent(
    "title:",
  );
  expect(container.querySelector("script")).toBeNull();
  rerender(<EvidenceExcerpt source={source} body={body} />);
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  expect(container.querySelector("h2,script")).toBeNull();
});

it("keeps ordinary separators, incomplete front matter and plain text unchanged", () => {
  const { container, rerender } = render(
    <SourceContent source={source} text={"Opening\n\n---\n\nAfter"} />,
  );
  expect(container.querySelector("hr")).not.toBeNull();
  expect(container.querySelector("details")).toBeNull();
  rerender(<SourceContent source={source} text={"---\ntitle: Unclosed"} />);
  expect(container).toHaveTextContent("title: Unclosed");
  expect(container.querySelector("details")).toBeNull();
  rerender(
    <SourceContent
      source={{
        ...source,
        media_type: "text/plain",
        original_name: "note.txt",
      }}
      text={withMetadata}
    />,
  );
  expect(container.querySelector("pre")?.textContent).toBe(withMetadata);
});

it("marks only the verified occurrence in rendered Markdown and scrolls to it", () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    value: scroll,
    configurable: true,
  });
  const { container } = render(
    <SourceContent
      source={source}
      text={"## Heading\n\nSame **words**\n\nSame **words**"}
      passage={{
        id: "passage00000001",
        locator: "document; line 5",
        body: "Same **words**",
      }}
      passageRequested
    />,
  );
  expect(screen.getByRole("heading", { name: "Heading" })).toBeVisible();
  expect(container.querySelectorAll("mark")).toHaveLength(2);
  expect(container.querySelectorAll("p")[1].querySelector("mark")).toBeNull();
  expect(container.querySelector("strong mark")).toHaveTextContent("words");
  expect(scroll).toHaveBeenCalledWith({ block: "center" });
  expect(screen.getByRole("button", { name: "Reading view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("uses exact source for a partial code span and lets the reader switch back", () => {
  const { container } = render(
    <SourceContent
      source={source}
      text="before `abcd` after"
      passage={{
        id: "passage00000001",
        locator: "document; line 1, characters 10-11",
        body: "bc",
      }}
      passageRequested
    />,
  );
  expect(screen.getByRole("button", { name: "Exact source" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(container.querySelector("pre mark")).toHaveTextContent("bc");
  expect(container.querySelector("pre")).toHaveTextContent(
    "before `abcd` after",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reading view" }));
  expect(container.querySelector("code")).toHaveTextContent("abcd");
  expect(container.querySelector("mark")).toBeNull();
});

it("does not fabricate a highlight when original content and locator disagree", () => {
  const { container } = render(
    <SourceContent
      source={source}
      text="Same words\nOther words"
      passage={{
        id: "passage00000001",
        locator: "document; line 2",
        body: "Same words",
      }}
      passageRequested
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("could not be verified");
  expect(container.querySelector("mark")).toBeNull();
});

it("renders evidence as safe source Markdown only for Markdown originals", () => {
  const body =
    "## Evidence\n\n- **One**\n- Two\n\n[[literal-link]] [^42] [invalid](citation:1)\n\n![tracker](https://example.com/image)\n\n<script>alert(1)</script>";
  const { container, rerender } = render(
    <EvidenceExcerpt body={body} source={source} />,
  );
  expect(screen.getByRole("heading", { name: "Evidence" })).toBeVisible();
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.querySelector("strong")).toHaveTextContent("One");
  expect(container).toHaveTextContent("[[literal-link]] [^42]");
  expect(container.querySelector("button,img,script,a")).toBeNull();
  rerender(
    <EvidenceExcerpt
      body={body}
      source={{ media_type: "text/plain", original_name: "note.txt" }}
    />,
  );
  expect(container.querySelector("pre")).toHaveTextContent("## Evidence");
  expect(container.querySelector("h2,strong,ul")).toBeNull();
});

it("never highlights an agent-text passage in an original and says why", () => {
  const { container } = render(
    <SourceContent
      source={source}
      text={"Same words\nOther words"}
      passage={{
        id: "passage00000001",
        locator: "document; line 1",
        body: "Same words",
        kind: "agent-text",
      }}
      passageRequested
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent-derived text — not an exact copy",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "no source range is highlighted",
  );
  expect(container.querySelector("mark")).toBeNull();
});

it("labels agent-text evidence and shows it as plain text", () => {
  const { container, rerender } = render(
    <EvidenceExcerpt
      body={"## Heading\n\n**Derived**"}
      source={source}
      kind="agent-text"
    />,
  );
  expect(
    screen.getByText("Agent-derived text — not an exact copy"),
  ).toBeVisible();
  expect(container.querySelector("pre")).toHaveTextContent("## Heading");
  expect(container.querySelector("h2,strong")).toBeNull();
  rerender(<EvidenceExcerpt body="Exact" source={source} kind="text" />);
  expect(
    screen.queryByText("Agent-derived text — not an exact copy"),
  ).toBeNull();
});
