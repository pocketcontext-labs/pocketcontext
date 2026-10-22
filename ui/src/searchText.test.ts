import { describe, expect, it } from "vitest";
import { highlightSearchText, searchExcerpt } from "./searchText";

describe("searchExcerpt", () => {
  it("shows internal link labels without their targets or section anchors", () => {
    expect(
      searchExcerpt(
        "Follow [[reference-01#instrument|telescope catalog notes]], [[star-chart#north]] or [[overview]].",
      ),
    ).toBe("Follow telescope catalog notes, star-chart or overview.");
  });
  it("turns headings, formatting, citations, links and tables into readable text", () => {
    const excerpt = searchExcerpt(
      `# Observatory\n\nA **bright** _star_ with ~~old~~ data[^1] and [a link](https://example.test) plus [[star-chart]].\n\n| Instrument | Result |\n| --- | :---: |\n| Telescope | Clear |\n\n[^1]: Private citation details`,
    );
    expect(excerpt).toBe(
      "Observatory A bright star with old data and a link plus star-chart. Instrument Result Telescope Clear",
    );
  });
  it("preserves code, Unicode, decoded entities and list text", () => {
    expect(
      searchExcerpt(
        "- Café &amp; 東京\n- `x < y`\n\n```js\nconst answer = 42;\n```",
      ),
    ).toBe("Café & 東京 x < y const answer = 42;");
  });
  it("removes table fragments and dangling citations", () => {
    expect(
      searchExcerpt(
        "… | Observatory | **Online** |\n| --- | --- |\n| Next | Soon |[^42]",
      ),
    ).toBe("… Observatory Online Next Soon");
  });
  it("drops raw HTML and executable blocks while preserving visible inline text", () => {
    expect(
      searchExcerpt(
        '<script>alert("unsafe")</script>\n\nRead <span onclick="unsafe()">this</span> <img src=x onerror=unsafe()> safely.',
      ),
    ).toBe("Read this safely.");
    expect(
      searchExcerpt(
        "[safe label](javascript:unsafe()) ![diagram](javascript:unsafe())",
      ),
    ).toBe("safe label diagram");
  });
});

describe("highlightSearchText", () => {
  it("preserves text exactly and matches Unicode without ASCII word boundaries", () => {
    const text = "CAFÉ, 東京 and café.";
    const parts = highlightSearchText(text, "café 東京");
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(
      ["CAFÉ", "東京", "café"],
    );
  });
  it("treats metacharacters literally and prefers complete quoted phrases", () => {
    const parts = highlightSearchText(
      "C++ [a.b] (x) star chart star",
      'C++ [a.b] (x) "star chart" star',
    );
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(
      ["C++", "[a.b]", "(x)", "star chart", "star"],
    );
    expect(highlightSearchText("anything", ".*")).toEqual([
      { text: "anything", match: false },
    ]);
  });
  it("handles empty, repeated, partial and HTML-shaped queries safely as text", () => {
    expect(highlightSearchText("unchanged", ' "" ')).toEqual([
      { text: "unchanged", match: false },
    ]);
    expect(highlightSearchText("", "query")).toEqual([
      { text: "", match: false },
    ]);
    expect(highlightSearchText("<script> café", '<script> "café')).toEqual([
      { text: "<script>", match: true },
      { text: " ", match: false },
      { text: "café", match: true },
    ]);
    expect(highlightSearchText("star", "star star")).toEqual([
      { text: "star", match: true },
    ]);
  });
});
