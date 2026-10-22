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
