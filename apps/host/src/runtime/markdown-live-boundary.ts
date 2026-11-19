// This scan follows T3's assistant streaming filter, using absolute UTF-16 offsets in a bounded tail.
const fencePattern = /^( *)(`{3,}(?![^`\r\n]*`)|~{3,})/;
const blankLine = /^[ \t]*$/;
const listItem = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const sectionTitle = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
const heading = /^#{1,6}(?:[ \t]|$)/;
const partialListItem = /[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t][ \t\r]*[^ \t\r]/y;

interface MarkdownScan {
  readonly through: number;
  readonly lineStart: number;
  readonly fence: {
    readonly marker: string;
    readonly length: number;
    readonly indent: number;
  } | null;
  readonly boundary: number;
  readonly titleAwaitingContent: boolean;
}

export function scanMarkdown(text: string, offset: number, previous?: MarkdownScan) {
  let { lineStart, fence, boundary, titleAwaitingContent } = previous ?? {
    lineStart: offset === 0 ? 0 : offset - 1,
    fence: null,
    boundary: -1,
    titleAwaitingContent: false,
  };
  let searchFrom = Math.max(0, (previous?.through ?? offset) - offset);
  for (;;) {
    const newline = text.indexOf("\n", searchFrom);
    if (newline === -1) break;
    if (lineStart >= offset) {
      const line = text.slice(lineStart - offset, newline).replace(/[ \t\r]+$/, "");
      const match = fencePattern.exec(line);
      if (!fence && lineStart > 0 && !titleAwaitingContent && listItem.test(line))
        boundary = lineStart;
      if (match) {
        const indent = match[1]!.length;
        const token = match[2]!;
        if (!fence) {
          fence = { marker: token[0]!, length: token.length, indent };
          titleAwaitingContent = false;
        } else if (
          fence.marker === token[0] &&
          token.length >= fence.length &&
          indent <= fence.indent + 3 &&
          line.length === indent + token.length
        ) {
          fence = null;
          boundary = offset + newline + 1;
        }
      } else if (!fence && blankLine.test(line) && lineStart > 0) {
        if (!titleAwaitingContent) boundary = offset + newline + 1;
      } else if (!fence) {
        if (lineStart > 0 && !titleAwaitingContent && heading.test(line)) boundary = lineStart;
        titleAwaitingContent = sectionTitle.test(line);
      }
    }
    searchFrom = newline + 1;
    lineStart = offset + searchFrom;
  }
  return { through: offset + text.length, lineStart, fence, boundary, titleAwaitingContent };
}

export function markdownBoundary(scan: MarkdownScan, text: string, offset: number): number {
  if (!scan.fence && scan.lineStart > 0 && scan.lineStart >= offset && !scan.titleAwaitingContent) {
    partialListItem.lastIndex = scan.lineStart - offset;
    if (partialListItem.test(text)) return scan.lineStart;
  }
  return scan.boundary;
}
