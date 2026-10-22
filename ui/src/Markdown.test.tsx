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
