import { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Markdown, pageHref } from "./Markdown";
describe("safe page rendering", () => {
  it("renders aliases, publication-pinned heading links and evidence controls", () => {
    const click = vi.fn();
    render(
      <Markdown
        body={"[[observatory#Night sky|The sky]] and evidence[^2]."}
        publication="pub123"
        onCitation={click}
      />,
    );
    expect(screen.getByRole("link", { name: "The sky" })).toHaveAttribute(
      "href",
      "#/page/observatory?publication=pub123&heading=night-sky",
    );
    fireEvent.click(screen.getByRole("button", { name: "Citation 2" }));
    expect(click).toHaveBeenCalledWith(2, screen.getByRole("button", { name: "Citation 2" }));
  });
  it("does not render raw HTML, remote images or unsafe links", () => {
    const { container } = render(
      <Markdown
        body={
          "<img src=x onerror=alert(1)>\n\n![tracking](https://example.com/pixel)\n\n[bad](javascript:alert)"
        }
        onCitation={() => {}}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.getByText("bad").closest("a")).toBeNull();
  });
  it("keeps code literal and renders headings", () => {
    render(
      <Markdown body={"## Night sky\n\n`[[literal]]`"} onCitation={() => {}} />,
    );
    expect(screen.getByRole("heading", { name: "Night sky" })).toHaveAttribute(
      "id",
      "night-sky",
    );
    expect(screen.getByText("[[literal]]").tagName).toBe("CODE");
  });
});

it("keeps live heading routes and malformed custom links safe", () => {
  expect(pageHref("observatory", undefined, "night-sky")).toBe(
    "#/page/observatory?heading=night-sky",
  );
  render(<Markdown body={"[malformed](page:%ZZ)"} onCitation={() => {}} />);
  expect(screen.getByText("malformed").closest("a")).toBeNull();
});

it("uses stable unique heading anchors under strict rendering and supports callouts", () => {
  const { container } = render(
    <StrictMode>
      <Markdown
        body={"## Same\n\n## Same\n\n> [!NOTE]\n> Read the evidence."}
        onCitation={() => {}}
      />
    </StrictMode>,
  );
  expect(
    Array.from(container.querySelectorAll("h2")).map((node) => node.id),
  ).toEqual(["same", "same-1"]);
  expect(container.querySelector('[data-callout="NOTE"]')).toHaveTextContent(
    "Note",
  );
  expect(container).not.toHaveTextContent("[!NOTE]");
});


it("home links preserve a dynamic root with optional publication", () => {
  expect(pageHref("")).toBe("#/");
  expect(pageHref("", "publication-id")).toBe("#/?publication=publication-id");
});

it("renders original Markdown with normal footnotes and anchors but no publication citation or page controls", () => {
  const { container } = render(<Markdown mode="source" body={"## Source section\n\n[[literal-page]] and [^42].\n\nA real footnote[^1].\n\n[^1]: Original footnote text.\n\n[Jump](#source-section) [False citation](citation:1) [False page](page:example)\n\n![remote](https://example.com/image)\n\n<script>alert(1)</script>"} />);
  expect(screen.getByRole("heading", { name: "Source section" })).toHaveAttribute("id", "source-section");
  expect(container).toHaveTextContent("[[literal-page]] and [^42]");
  expect(container.querySelector(".citation")).toBeNull();
  expect(screen.getByText("False citation").closest("a")).toBeNull();
  expect(screen.getByText("False page").closest("a")).toBeNull();
  expect(screen.getByRole("link", { name: "Jump" })).toHaveAttribute("href", "#source-section");
  expect(container.querySelector('a[href="#user-content-fn-1"]')).toHaveAttribute("id", "user-content-fnref-1");
  expect(container).toHaveTextContent("Original footnote text.");
  expect(container.querySelector("img, script")).toBeNull();
});

it("keeps imported footnotes separate from evidence citations and resolves their source links", () => {
  location.hash = "#/page/example?space=space0000000001";
  const { container } = render(<Markdown body={"Imported claim[^import-a]. Verified[^1].\n\n[^import-a]: See [original](source:source000000001)."} onCitation={() => {}} />);
  expect(screen.getByRole("link", { name: "original" })).toHaveAttribute("href", "#/sources/source000000001?space=space0000000001");
  expect(container.querySelector('a[href="#user-content-fn-import-a"]')).not.toBeNull();
  expect(container.querySelectorAll(".citation")).toHaveLength(1);
  location.hash = "";
});

it("cross-space links select the destination live space without carrying a publication", () => {
  location.hash = "#/page/example?space=space0000000001&publication=old";
  render(<Markdown publication="old" body="[Elsewhere](space:space0000000002/overview#Night%20sky) [Invalid](space:bad/overview)" />);
  expect(screen.getByRole("link", { name: "Elsewhere" })).toHaveAttribute("href", "#/page/overview?space=space0000000002&heading=night-sky");
  expect(screen.getByText("Invalid").closest("a")).toBeNull();
  location.hash = "";
});

it("renders formatted imported labels while preserving page headings and publication", () => {
  location.hash = "#/page/example?space=space0000000001";
  render(<Markdown publication="published-version" body={"[BERT's `[CLS]`/`[SEP]` scheme](page:bert-input#Token%20scheme)"} />);
  const link = screen.getByRole("link", { name: /BERT's \[CLS\]\s*\/\s*\[SEP\] scheme/ });
  expect(link).toHaveAttribute("href", "#/page/bert-input?publication=published-version&heading=token-scheme&space=space0000000001");
  expect(link.querySelectorAll("code")).toHaveLength(2);
  expect(link.querySelector("code")).toHaveTextContent("[CLS]");
  location.hash = "";
});
