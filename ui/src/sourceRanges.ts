import type { Passage, Source } from "./types";

export interface SourceRange {
  start: number;
  end: number;
}
export interface VerifiedSourceRange {
  text: string;
  range: SourceRange;
}

export function isMarkdownSource(
  source?: Pick<Source, "media_type" | "original_name">,
): boolean {
  return Boolean(
    source &&
    (source.media_type.split(";")[0].toLowerCase() === "text/markdown" ||
      /\.(md|markdown)$/i.test(source.original_name)),
  );
}

// Locators count Go runes; JavaScript Markdown positions count UTF-16 units.
function characterOffset(text: string, count: number): number | null {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  let offset = 0,
    characters = 0;
  for (const character of text) {
    if (characters === count) return offset;
    offset += character.length;
    characters++;
  }
  return characters === count ? offset : null;
}

/** Verify exact locator bounds and body against an authorized, hash-checked original.
 * Never search for the first matching phrase: identical passages can occur twice. */
export function verifySourceRange(
  original: string,
  passage: Pick<Passage, "locator" | "body">,
): VerifiedSourceRange | null {
  // sourceText's UTF-8 decoder removes the same single BOM as ingestion.
  const raw = original;
  const delimiter = passage.locator.lastIndexOf("; ");
  const suffix = passage.locator.slice(delimiter < 0 ? 0 : delimiter + 2);
  const legacy = /^characters (\d+)-(\d+)$/.exec(suffix);
  // v1 counted original characters; v2/v3 normalized newlines before assigning lines.
  const text = legacy ? raw : raw.replace(/\r\n?/g, "\n");
  let start: number | null = null,
    end: number | null = null;
  if (legacy) {
    const from = Number(legacy[1]),
      to = Number(legacy[2]);
    if (from < 1 || to < from) return null;
    start = characterOffset(text, from - 1);
    end = characterOffset(text, to);
  } else {
    const lines = text.split("\n");
    const offsets = [0];
    for (let i = 0; i < lines.length; i++)
      offsets.push(offsets[i] + lines[i].length + 1);
    const bounds = (from: number, to: number) =>
      Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      from >= 1 &&
      to >= from &&
      to <= lines.length;
    const prefix =
      /^lines (\d+)-(\d+), characters (\d+)-(\d+) of line (\d+)$/.exec(suffix);
    const chars = /^line (\d+), characters (\d+)-(\d+)$/.exec(suffix);
    const span = /^lines? (\d+)(?:-(\d+))?$/.exec(suffix);
    if (prefix) {
      const [from, to, first, last, line] = prefix.slice(1).map(Number);
      // The supported prefixed cut is contiguous only for the first part of its final line.
      if (!bounds(from, to) || line !== to || first !== 1 || last < first)
        return null;
      const cut = characterOffset(lines[line - 1], last);
      if (cut === null) return null;
      start = offsets[from - 1];
      end = offsets[line - 1] + cut;
    } else if (chars) {
      const [line, first, last] = chars.slice(1).map(Number);
      if (!bounds(line, line) || first < 1 || last < first) return null;
      const left = characterOffset(lines[line - 1], first - 1),
        right = characterOffset(lines[line - 1], last);
      if (left === null || right === null) return null;
      start = offsets[line - 1] + left;
      end = offsets[line - 1] + right;
    } else if (span) {
      const from = Number(span[1]),
        to = Number(span[2] || span[1]);
      if (!bounds(from, to)) return null;
      start = offsets[from - 1];
      end = offsets[to - 1] + lines[to - 1].length;
    }
  }
  if (
    start === null ||
    end === null ||
    end <= start ||
    text.slice(start, end) !== passage.body
  )
    return null;
  return { text, range: { start, end } };
}
