import { visit } from "unist-util-visit";
import type { SourceRange } from "./sourceRanges";

/** Mark only text backed by the verified original range. Ambiguous Markdown
 * transformations request an exact-source fallback instead of widening a mark. */
export function sourceHighlight({
  text,
  range,
}: {
  text: string;
  range?: SourceRange;
}) {
  return (tree: any) => {
    if (!range) return;
    let needsExact = false;
    visit(tree, (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined || parent.type === "sourceHighlight")
        return;
      if (!["text", "inlineCode", "code"].includes(node.type)) return;
      const from = node.position?.start.offset,
        to = node.position?.end.offset;
      if (
        typeof from !== "number" ||
        typeof to !== "number" ||
        from >= range.end ||
        to <= range.start
      )
        return;
      const contained = from >= range.start && to <= range.end;
      if (node.type !== "text") {
        if (!contained) {
          needsExact = true;
          return;
        }
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            className: "source-highlight",
            "data-source-highlight": "true",
          },
        };
        return;
      }
      const left = Math.max(from, range.start),
        right = Math.min(to, range.end);
      if (!contained && text.slice(from, to) !== node.value) {
        needsExact = true;
        return;
      }
      const begin = contained ? 0 : left - from,
        finish = contained ? node.value.length : right - from;
      const replacements = [];
      if (begin > 0)
        replacements.push({ type: "text", value: node.value.slice(0, begin) });
      replacements.push({
        type: "sourceHighlight",
        data: {
          hName: "mark",
          hProperties: {
            className: "source-highlight",
            "data-source-highlight": "true",
          },
        },
        children: [{ type: "text", value: node.value.slice(begin, finish) }],
      });
      if (finish < node.value.length)
        replacements.push({ type: "text", value: node.value.slice(finish) });
      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
    if (needsExact)
      tree.children.unshift({
        type: "sourceRangeNotice",
        data: {
          hName: "span",
          hProperties: { hidden: true, "data-source-range-fallback": "true" },
        },
        children: [],
      });
  };
}
