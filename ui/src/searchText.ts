import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const markdown = unified().use(remarkParse).use(remarkGfm);

type TextNode = {
  type: string;
  value?: string;
  alt?: string | null;
  children?: TextNode[];
};

const blocks = new Set([
  "root",
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
]);

function nodeText(node: TextNode): string {
  if (
    ["html", "definition", "footnoteDefinition", "footnoteReference"].includes(
      node.type,
    )
  )
    return "";
  if (node.type === "break" || node.type === "thematicBreak") return " ";
  if (node.type === "image" || node.type === "imageReference")
    return node.alt || "";
  if (node.type === "text") {
    return (
      (node.value || "")
        // Complete tables are parsed by GFM; remove rulers in clipped table fragments.
        .replace(
          /^[\t ]*\|?[\t ]*:?-{3,}:?[\t ]*(?:\|[\t ]*:?-{3,}:?[\t ]*)+\|?[\t ]*$/gmu,
          "",
        )
        // Search snippets often omit the definitions, leaving citation markers as text.
        .replace(/\[\^[^\]\s]+\]/gu, "")
        .replace(/\[\[([^\]\n]+)\]\]/gu, (_, value: string) => {
          const [target, alias] = value.split("|");
          return alias || target.split("#")[0];
        })
        // A snippet can start halfway through a Markdown table.
        .replace(/\|/gu, " ")
    );
  }
  if (node.value !== undefined) return node.value;
  return (node.children || [])
    .map(nodeText)
    .join(blocks.has(node.type) ? " " : "");
}

/** Extract visible Markdown content without ever constructing HTML or DOM nodes. */
export function searchExcerpt(source: string): string {
  return nodeText(markdown.parse(source)).replace(/\s+/gu, " ").trim();
}

export type SearchTextPart = { text: string; match: boolean };

/** Split literal matches for React text/mark rendering; the query is never HTML or a regex. */
export function highlightSearchText(
  text: string,
  query: string,
): SearchTextPart[] {
  const terms = Array.from(query.matchAll(/"([^"]+)"|([^\s"]+)/gu), (match) =>
    (match[1] || match[2]).trim(),
  )
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!terms.length || !text) return [{ text, match: false }];
  const escaped = [...new Set(terms)].map((term) =>
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const matches = text.matchAll(new RegExp(escaped.join("|"), "giu"));
  const parts: SearchTextPart[] = [];
  let start = 0;
  for (const match of matches) {
    if (match.index > start)
      parts.push({ text: text.slice(start, match.index), match: false });
    parts.push({ text: match[0], match: true });
    start = match.index + match[0].length;
  }
  if (start < text.length)
    parts.push({ text: text.slice(start), match: false });
  return parts.length ? parts : [{ text, match: false }];
}
