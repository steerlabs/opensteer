/**
 * The Markdown an assistant writes, as much of it as a phone should draw.
 *
 * This is a deliberate subset rather than a renderer: headings, paragraphs,
 * nested lists, tables, code (inline and fenced), thematic breaks, and links —
 * everything an agent's answer actually uses. Anything outside it stays the
 * literal text the agent wrote, which is the honest outcome for a format nobody
 * can implement completely.
 *
 * Splitting first and parsing per block is what makes streaming cheap: a
 * delta changes the last block only, so the renderer re-parses one paragraph
 * instead of the whole message.
 */

import { transcriptLinkUrl } from "@opensteer/shared/transcriptLinks";

export type MarkdownSpan =
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "emphasis"; readonly strong: boolean; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly text: string }
  | { readonly kind: "text"; readonly text: string };

export interface MarkdownListItem {
  /** How far the marker was indented, counted in levels: 0 is top level. */
  readonly depth: number;
  /** The marker a reader sees: a bullet, or the number the author wrote. */
  readonly marker: string;
  readonly spans: readonly MarkdownSpan[];
}

export type MarkdownBlock =
  | { readonly kind: "code"; readonly language: string | null; readonly text: string }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly spans: readonly MarkdownSpan[] }
  | { readonly kind: "list"; readonly items: readonly MarkdownListItem[] }
  | { readonly kind: "paragraph"; readonly spans: readonly MarkdownSpan[] }
  | { readonly kind: "quote"; readonly spans: readonly MarkdownSpan[] }
  | { readonly kind: "rule" }
  | {
      readonly kind: "table";
      /** One entry per column, from the delimiter row. */
      readonly align: readonly ("left" | "center" | "right" | null)[];
      readonly header: readonly (readonly MarkdownSpan[])[];
      readonly rows: readonly (readonly MarkdownSpan[])[][];
    };

/** A column's alignment, named here so the delimiter-row reader can return one. */
type ColumnAlign = "left" | "center" | "right" | null;

const openingFence = /^\s*(?:```|~~~)/u;
const closingFence = /^\s*(?:```|~~~)\s*$/u;
const headingLine = /^\s{0,3}#{1,6}\s+/u;
const ruleLine = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const listLine = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/u;
const quoteLine = /^\s{0,3}>/u;
/**
 * An indented line under a list marker stays with the list: as an item of its
 * own when it carries a marker, and otherwise as more of the item above it.
 */
const listContinuation = /^\s{2,}\S/u;

/** What kind of block a line opens, once fences and one-line blocks are out. */
type OpenBlock = "code" | "list" | "paragraph" | "quote" | "table";

/**
 * Splits a message at Markdown block boundaries, keeping a fenced code block
 * whole even when it contains blank lines. The strings are the parser's input
 * and the renderer's memo keys, so they are returned verbatim.
 *
 * A blank line is only one of the boundaries. A heading and a thematic break
 * are a single line each and end whatever preceded them, a fence ends at its
 * closing fence, and a list ends at the first line that is neither a marker nor
 * an indented continuation — so `# Result` followed immediately by its body
 * renders as a heading and a paragraph rather than as a heading that swallowed
 * the answer.
 *
 * A table is the one shape that needs the line after the current one: a header
 * row only becomes a header once a delimiter row turns up beneath it. Until it
 * does the header stays a paragraph, which is what a half-streamed table should
 * look like.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  let open: OpenBlock | null = null;

  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
    open = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (open === "code") {
      current.push(line);
      if (closingFence.test(line)) flush();
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    // A table runs on while its lines still carry cells. The line that stops it
    // is not part of it and still has to open whatever it does belong to, so it
    // falls through to the checks below rather than being consumed here.
    if (open === "table") {
      if (line.includes("|")) {
        current.push(line);
        continue;
      }
      flush();
    }
    if (openingFence.test(line)) {
      flush();
      current.push(line);
      open = "code";
      continue;
    }
    if (headingLine.test(line) || ruleLine.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }
    if (line.includes("|") && tableAlignments(lines[index + 1] ?? "") !== null) {
      flush();
      current.push(line);
      open = "table";
      continue;
    }
    const kind = lineBlock(line, open);
    if (open !== null && open !== kind) flush();
    current.push(line);
    open = kind;
  }
  flush();
  return blocks;
}

function lineBlock(line: string, open: OpenBlock | null): OpenBlock {
  if (quoteLine.test(line)) return "quote";
  if (listLine.test(line)) return "list";
  if (open === "list" && listContinuation.test(line)) return "list";
  return "paragraph";
}

export function parseMarkdownBlock(source: string): MarkdownBlock {
  const lines = source.split("\n");
  const first = lines[0] ?? "";

  const fence = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/u.exec(first);
  if (fence) {
    const closing = lines.length > 1 && /^\s*(?:```|~~~)\s*$/u.test(lines[lines.length - 1] ?? "");
    const body = lines.slice(1, closing ? -1 : undefined);
    return { kind: "code", language: fence[1] ? fence[1] : null, text: body.join("\n") };
  }

  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(first) && lines.length === 1) {
    return { kind: "rule" };
  }

  const heading = /^\s{0,3}(#{1,6})\s+(.*)$/u.exec(first);
  if (heading) {
    const hashes = heading[1] ?? "#";
    // Three levels are all a phone column can distinguish; deeper headings are
    // drawn as the smallest one rather than as progressively invisible text.
    const level = hashes.length === 1 ? 1 : hashes.length === 2 ? 2 : 3;
    return { kind: "heading", level, spans: parseSpans(headingText(heading[2] ?? "")) };
  }

  if (lines.every((line) => /^\s{0,3}>\s?/u.test(line))) {
    return {
      kind: "quote",
      spans: parseSpans(lines.map((line) => line.replace(/^\s{0,3}>\s?/u, "")).join(" ")),
    };
  }

  const table = tableBlock(lines);
  if (table) return table;

  const items = listItems(lines);
  if (items) return { kind: "list", items };

  return { kind: "paragraph", spans: parseSpans(lines.join("\n")) };
}

/** ATX headings may be closed with trailing hashes, which are not content. */
function headingText(text: string): string {
  return text.replace(/\s+#+\s*$/u, "").trim();
}

const listItemLine = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/u;

function listItems(lines: readonly string[]): MarkdownListItem[] | null {
  const items: { depth: number; marker: string; text: string[] }[] = [];
  for (const line of lines) {
    const item = listItemLine.exec(line);
    if (item) {
      const marker = item[2] ? "•" : `${item[3] ?? ""}.`;
      items.push({ depth: markerDepth(item[1] ?? ""), marker, text: [item[4] ?? ""] });
      continue;
    }
    // An indented line that carries no marker of its own is the rest of the
    // item above it; anything before the first marker means this block is not a
    // list at all.
    const last = items[items.length - 1];
    if (!last || line.trim() === "") return null;
    last.text.push(line.trim());
  }
  if (items.length === 0) return null;
  return items.map(({ depth, marker, text }) => ({
    depth,
    marker,
    spans: parseSpans(text.join(" ")),
  }));
}

/**
 * Indentation read as nesting: two spaces, or a tab, is how an author writes
 * one level. Past the third level a phone column has no width left to give, so
 * deeper markers share that indent instead of marching off the screen.
 */
function markerDepth(indent: string): number {
  let width = 0;
  for (const char of indent) width += char === "\t" ? 2 : 1;
  return Math.min(Math.floor(width / 2), 3);
}

/**
 * A table, if these lines are one: a header row, a delimiter row that fixes the
 * column count and their alignment, then the body. The header decides how wide
 * the table is, so a short row is padded and a long one is cut — a ragged row
 * is an author's slip, not a reason to drop back to literal text.
 */
function tableBlock(lines: readonly string[]): MarkdownBlock | null {
  const header = lines[0] ?? "";
  if (!header.includes("|")) return null;
  const align = tableAlignments(lines[1] ?? "");
  if (!align) return null;

  const columns = tableCells(header);
  const width = columns.length;
  return {
    align: Array.from({ length: width }, (_, column) => align[column] ?? null),
    header: columns.map((cell) => parseSpans(cell)),
    kind: "table",
    rows: lines
      .slice(2)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const cells = tableCells(line);
        return Array.from({ length: width }, (_, column) => parseSpans(cells[column] ?? ""));
      }),
  };
}

const delimiterCell = /^(:?)-+(:?)$/u;

/**
 * The delimiter row read as alignments, and `null` for a line that is not one.
 * This is what separates a table from a paragraph that happens to contain a
 * pipe, so it also insists on a pipe: a bare `---` is a thematic break and must
 * not promote the line above it into a header.
 */
function tableAlignments(line: string): ColumnAlign[] | null {
  if (!line.includes("|")) return null;
  const align: ColumnAlign[] = [];
  for (const cell of tableCells(line)) {
    const match = delimiterCell.exec(cell);
    if (!match) return null;
    const left = match[1] === ":";
    const right = match[2] === ":";
    align.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return align;
}

/**
 * One row split into its cells. The pipes at either end are decoration and are
 * dropped, a `\|` is the author asking for a pipe inside a cell, and the
 * surrounding whitespace is alignment the delimiter row already speaks for.
 */
function tableCells(line: string): string[] {
  const row = line.trim();
  const cells: string[] = [];
  let cell = "";
  let trailingPipe = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === "\\" && row[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(cell);
      cell = "";
      trailingPipe = index === row.length - 1;
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  if (cells.length > 1 && row.startsWith("|")) cells.shift();
  if (cells.length > 1 && trailingPipe) cells.pop();
  return cells.map((text) => text.trim());
}

const inlinePattern =
  /(`+)([\s\S]*?)\1|\[([^\]]*)\]\(([^()\s]+)\)|(\*\*|__)([\s\S]+?)\5|(\*|_)([\s\S]+?)\7|(<?https?:\/\/[^\s<>)]+>?)/gu;

/**
 * Inline spans, matched in the order Markdown resolves them: code first,
 * because a backtick span suspends every other marker inside it, then links,
 * then emphasis, then a bare URL the author did not wrap.
 */
export function parseSpans(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let index = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const start = match.index;
    if (start > index) spans.push({ kind: "text", text: text.slice(index, start) });
    index = start + match[0].length;
    if (match[2] !== undefined) {
      spans.push({ kind: "code", text: match[2].trim() });
    } else if (match[4] !== undefined) {
      const label = match[3] || match[4];
      spans.push(
        transcriptLinkUrl(match[4])
          ? { href: match[4], kind: "link", text: label }
          : { kind: "text", text: label },
      );
    } else if (match[6] !== undefined) {
      spans.push({ kind: "emphasis", strong: true, text: match[6] });
    } else if (match[8] !== undefined) {
      spans.push({ kind: "emphasis", strong: false, text: match[8] });
    } else if (match[9] !== undefined) {
      const href = match[9].replace(/^<|>$/gu, "");
      spans.push(
        transcriptLinkUrl(href) ? { href, kind: "link", text: href } : { kind: "text", text: href },
      );
    }
  }
  if (index < text.length) spans.push({ kind: "text", text: text.slice(index) });
  return spans.length > 0 ? spans : [{ kind: "text", text }];
}
