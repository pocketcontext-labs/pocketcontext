import { visit } from "unist-util-visit";
import type { SourceRange } from "./sourceRanges";

/** Keep front matter out of the prose without changing original source offsets. */
export function sourceMetadata({ range }: { range?: SourceRange } = {}) {
  return (tree: any) => {
    visit(tree, "yaml", (node: any) => {
      const cited =
        range &&
        node.position.start.offset < range.end &&
        node.position.end.offset > range.start;
      node.type = "sourceMetadata";
      node.data = {
        hName: "details",
        hProperties: { className: "source-metadata", open: Boolean(cited) },
      };
      node.children = [
        {
          type: "sourceMetadataSummary",
          data: { hName: "summary" },
          children: [{ type: "text", value: "Source metadata" }],
        },
        { type: "code", value: node.value, position: node.position },
      ];
    });
  };
}
