import { spaceLink } from "./spaceLinks";
import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";

export function headingId(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}
export function pageHref(slug: string, publication?: string, anchor?: string) {
  const query = new URLSearchParams();
  if (publication) query.set("publication", publication);
  if (anchor) query.set("heading", anchor);
  return spaceLink(`${slug ? `#/page/${encodeURIComponent(slug)}` : "#/"}${query.size ? `?${query}` : ""}`);
}
// Operates on Markdown text nodes only: code spans and fenced code remain literal.
function pageSyntax(options: { source?: boolean } = {}) {
  return (tree: any) => {
    const counts = new Map<string, number>();
    const nodeText = (node: any): string =>
      node.value || (node.children || []).map(nodeText).join("");
    visit(tree, "heading", (node: any) => {
      const base = headingId(nodeText(node));
      const count = counts.get(base) || 0;
      counts.set(base, count + 1);
      node.data = {
        ...node.data,
        hProperties: { id: count ? `${base}-${count}` : base },
      };
    });
    visit(tree, "blockquote", (node: any) => {
      const first = node.children?.[0]?.children?.[0];
      if (first?.type !== "text") return;
      const match = first.value.match(/^\[!([A-Za-z]+)\][+-]?\s*/);
      if (!match) return;
      node.data = {
        ...node.data,
        hProperties: { className: "callout", "data-callout": match[1] },
      };
      first.value = first.value.slice(match[0].length);
      node.children.unshift({
        type: "paragraph",
        children: [
          {
            type: "strong",
            children: [
              {
                type: "text",
                value:
                  match[1].charAt(0).toUpperCase() +
                  match[1].slice(1).toLowerCase(),
              },
            ],
          },
        ],
      });
    });

    if (options.source) return;
    visit(tree, "text", (node: any, index: number | undefined, parent: any) => {
      if (index === undefined || !parent || parent.type === "link") return;
      const expression = /\[\[([^\]\n]+)\]\]|\[\^(\d+)\]/g;
      const nodes: any[] = [];
      let end = 0;
      let match;
      while ((match = expression.exec(node.value))) {
        if (match.index > end)
          nodes.push({
            type: "text",
            value: node.value.slice(end, match.index),
          });
        if (match[2])
          nodes.push({
            type: "link",
            url: `citation:${match[2]}`,
            children: [{ type: "text", value: match[2] }],
          });
        else {
          const [target, alias] = match[1].split("|");
          nodes.push({
            type: "link",
            url: `page:${encodeURIComponent(target)}`,
            children: [{ type: "text", value: alias || target.split("#")[0] }],
          });
        }
        end = expression.lastIndex;
      }
      if (!nodes.length) return;
      if (end < node.value.length)
        nodes.push({ type: "text", value: node.value.slice(end) });
      parent.children.splice(index, 1, ...nodes);
      return index + nodes.length;
    });
  };
}
export const Markdown = memo(function Markdown({
  body,
  publication,
  onCitation,
  resolveSlug,
  mode = "page",
}: {
  body: string;
  publication?: string;
  onCitation?: (marker: number, trigger?: HTMLElement) => void;
  resolveSlug?: (target: string) => string;
  mode?: "page" | "source";
}) {
  const heading = (level: number, children: ReactNode, id?: string) => {
    return level === 1 ? (
      <h1 id={id}>{children}</h1>
    ) : level === 2 ? (
      <h2 id={id}>{children}</h2>
    ) : level === 3 ? (
      <h3 id={id}>{children}</h3>
    ) : level === 4 ? (
      <h4 id={id}>{children}</h4>
    ) : level === 5 ? (
      <h5 id={id}>{children}</h5>
    ) : (
      <h6 id={id}>{children}</h6>
    );
  };
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [pageSyntax, { source: mode === "source" }]]}
      skipHtml
      urlTransform={(url) =>
        (mode === "source" ? /^(https?:|mailto:|#)/i : /^(page:|citation:|https?:|mailto:|#)/i).test(url) ? url : ""
      }
      components={{
        h1: ({ children, id }) => heading(1, children, id),
        h2: ({ children, id }) => heading(2, children, id),
        h3: ({ children, id }) => heading(3, children, id),
        h4: ({ children, id }) => heading(4, children, id),
        h5: ({ children, id }) => heading(5, children, id),
        h6: ({ children, id }) => heading(6, children, id),
        a: ({ href, children, id, "aria-label": ariaLabel, "aria-describedby": ariaDescription }) => {
          if (href?.startsWith("citation:"))
            return (
              <button
                className="citation"
                data-citation={href.slice(9)}
                aria-label={`Citation ${href.slice(9)}`}
                onClick={event => onCitation?.(Number(href.slice(9)), event.currentTarget)}
              >
                {children}
              </button>
            );
          if (href?.startsWith("page:")) {
            let decoded;
            try {
              decoded = decodeURIComponent(href.slice(5));
            } catch {
              return <span>{children}</span>;
            }
            const [target, anchor] = decoded.split("#");
            return (
              <a
                href={pageHref(
                  resolveSlug?.(target) || target,
                  publication,
                  anchor ? headingId(anchor) : undefined,
                )}
              >
                {children}
              </a>
            );
          }
          if (href?.startsWith("#"))
            return (
              <a
                id={id}
                href={href}
                aria-label={ariaLabel}
                aria-describedby={ariaDescription}
                onClick={(event) => {
                  event.preventDefault();
                  document
                    .getElementById(href.slice(1))
                    ?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                {children}
              </a>
            );
          return href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
              <span className="external" aria-label="opens in new tab">
                {" "}
                ↗
              </span>
            </a>
          ) : (
            <span>{children}</span>
          );
        },
        img: ({ alt }) => (
          <span className="image-placeholder">
            Image: {alt || "embedded image"}
          </span>
        ),
        blockquote: ({ children, node }) => (
          <blockquote
            className={String(node?.properties.className || "")}
            data-callout={node?.properties["data-callout"]}
          >
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="table-scroll">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {body}
    </ReactMarkdown>
  );
});
