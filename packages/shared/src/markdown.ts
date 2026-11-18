import type { Nodes, Parents, PhrasingContent, Root } from "mdast";

/**
 * What every client draws an agent's Markdown with. It has no runtime
 * dependency, so a client's first bundle can split a reply without carrying a
 * parser: `markdownParser.ts` is the half that does.
 */

/** Syntax that ties one block to another, so a piece alone would draw differently. */
const spansBlocks = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/mu;
const fenceLine = /^ {0,3}(`{3,}|~{3,})/u;
/** After a blank line these still belong to the block above: an item, or what it holds. */
const continuesBlock = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/u;

/**
 * Cuts Markdown only at blank lines that close every open block, so each piece
 * draws exactly what it does inside the whole text. The pieces are stable while
 * a message streams, which is what lets a client redraw only the last of them.
 */
export function splitMarkdownBlocks(text: string): readonly string[] {
  if (text.includes("\r") || spansBlocks.test(text)) return [text];
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlank = false;
  for (const line of text.split("\n")) {
    const opener = fenceLine.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the item holding it, which isn't tracked.
      if (/\S/u.test(line.slice(0, fenceIndent))) break;
      const closes =
        opener !== undefined &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener;
      if (closes) fence = null;
    } else if (line.trim() === "") {
      afterBlank = true;
    } else {
      if (afterBlank && lineStart > blockStart && !continuesBlock.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlank = false;
      fence = opener ?? null;
      if (opener !== undefined) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

export type ReplyPart =
  | {
      readonly kind: "code";
      readonly language: string;
      readonly source: string;
      readonly text: string;
    }
  | { readonly kind: "draft"; readonly text: string }
  | { readonly kind: "prose"; readonly text: string; readonly wide: boolean };

/** Only a fence at the margin stands alone: an indented one belongs to the list holding it. */
const topFence = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/u;
const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const heldFence = /^[ \t]+(`{3,}|~{3,})/u;
const heldClosingFence = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u;
const needsWidth = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*\||^[ \t]+(?:`{3,}|~{3,})/mu;

/** Without the blank lines around it. Its first line keeps its indent, which can mean code. */
const withoutBlankEdges = (text: string): string => text.replace(/^(?:[ \t]*\n)+/u, "").trimEnd();

/**
 * A reply as the bubbles Chat stacks: its words, and each block of code or
 * draft on its own, because a bubble is what a person holds to copy.
 */
export function replyParts(text: string): readonly ReplyPart[] {
  if (text.trim() === "") return [];
  if (spansBlocks.test(text)) return [{ kind: "prose", text: withoutBlankEdges(text), wide: true }];
  const parts: ReplyPart[] = [];
  let prose: string[] = [];
  let fence: { readonly marker: string; readonly language: string; lines: string[] } | null = null;
  // A fence staying inside the words: its closer must not read as a new opener.
  let held: string | null = null;

  const closeProse = (): void => {
    const body = withoutBlankEdges(prose.join("\n"));
    prose = [];
    if (body !== "") parts.push({ kind: "prose", text: body, wide: needsWidth.test(body) });
  };
  const closeFence = (closing: string | null): void => {
    if (fence === null) return;
    const { language, lines, marker } = fence;
    fence = null;
    const body = lines.join("\n");
    if (language === "draft") {
      parts.push({ kind: "draft", text: body.trim() });
      return;
    }
    // A fence the text has not closed yet stays open, so a highlighter sees it is still growing.
    const source = [`${marker}${language}`, ...lines, ...(closing === null ? [] : [closing])].join(
      "\n",
    );
    parts.push({ kind: "code", language, source, text: body });
  };

  for (const line of text.split("\n")) {
    if (fence !== null) {
      const closing = closingFence.exec(line)?.[1];
      const closes =
        closing !== undefined &&
        closing[0] === fence.marker[0] &&
        closing.length >= fence.marker.length;
      if (closes) closeFence(closing);
      else fence.lines.push(line);
      continue;
    }
    if (held !== null) {
      prose.push(line);
      const closing = heldClosingFence.exec(line)?.[1];
      if (closing !== undefined && closing[0] === held[0] && closing.length >= held.length) {
        held = null;
      }
      continue;
    }
    const opener = topFence.exec(line);
    if (opener === null) {
      prose.push(line);
      held = heldFence.exec(line)?.[1] ?? null;
      continue;
    }
    closeProse();
    fence = { language: opener[2] ?? "", lines: [], marker: opener[1] ?? "```" };
  }
  closeFence(null);
  closeProse();
  return parts;
}

const marker = "**";

/** Where bold could have been written: every parent that holds words directly. */
const holdsWords = new Set<Nodes["type"]>([
  "delete",
  "emphasis",
  "heading",
  "link",
  "paragraph",
  "tableCell",
]);

interface Mark {
  readonly before: string;
  readonly after: string;
}

type Piece = Mark | PhrasingContent;

const isMark = (piece: Piece): piece is Mark => "before" in piece;
const canOpen = (mark: Mark): boolean => mark.after !== "" && !/\s/u.test(mark.after);
const canClose = (mark: Mark): boolean => mark.before !== "" && !/\s/u.test(mark.before);

/** Text the parser took verbatim: an escape or an entity makes it shorter than its source. */
function isVerbatim(node: PhrasingContent): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return (
    node.type === "text" &&
    (start === undefined || end === undefined || end - start === node.value.length)
  );
}

/** `**` the parser left as words, each knowing what touches it. */
function pieces(children: readonly PhrasingContent[]): readonly Piece[] {
  const found: Piece[] = [];
  children.forEach((child, index) => {
    if (child.type !== "text" || !child.value.includes(marker) || !isVerbatim(child)) {
      found.push(child);
      return;
    }
    const words = child.value.split(marker);
    words.forEach((word, wordIndex) => {
      if (word !== "") found.push({ type: "text", value: word });
      if (wordIndex === words.length - 1) return;
      const next = words[wordIndex + 1] ?? "";
      found.push({
        after: next[0] ?? (children[index + 1] === undefined ? "" : "x"),
        before: word.at(-1) ?? (wordIndex === 0 && index > 0 ? "x" : ""),
      });
    });
  });
  return found;
}

const asWords = (found: readonly Piece[]): PhrasingContent[] =>
  found.map((piece) => (isMark(piece) ? { type: "text", value: marker } : piece));

function joined(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  const merged: PhrasingContent[] = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (node.type === "text" && last?.type === "text") {
      merged[merged.length - 1] = { type: "text", value: last.value + node.value };
    } else {
      merged.push(node);
    }
  }
  return merged;
}

function repaired(children: readonly PhrasingContent[], tail: boolean): PhrasingContent[] {
  const found = pieces(children);
  if (!found.some(isMark)) return [...children];
  const out: PhrasingContent[] = [];
  let index = 0;
  while (index < found.length) {
    const piece = found[index];
    if (piece === undefined) break;
    if (!isMark(piece)) {
      out.push(piece);
      index += 1;
      continue;
    }
    const closing = canOpen(piece)
      ? found.findIndex((other, at) => at > index + 1 && isMark(other) && canClose(other))
      : -1;
    if (closing !== -1) {
      out.push({ type: "strong", children: asWords(found.slice(index + 1, closing)) });
      index = closing + 1;
    } else if (tail && canOpen(piece)) {
      out.push({ type: "strong", children: asWords(found.slice(index + 1)) });
      index = found.length;
    } else {
      if (!tail || index !== found.length - 1) out.push({ type: "text", value: marker });
      index += 1;
    }
  }
  return joined(out);
}

function lastHolder(node: Parents): Parents | null {
  if (holdsWords.has(node.type)) return node;
  const last = node.children.at(-1);
  return last !== undefined && "children" in last ? lastHolder(last) : null;
}

/**
 * Bold the parser refused. CommonMark won't close `**` after punctuation when a
 * letter follows, so `**Note:**next` and most bold in Chinese stay literal, and
 * models write both. This runs on the tree, where code and escapes are already
 * settled, so it can't reach into either. While a message streams, `streaming`
 * also draws the tail's unclosed `**` as the bold it is about to be.
 */
export function repairStrong(tree: Root, options?: { readonly streaming?: boolean }): void {
  const tail = options?.streaming === true ? lastHolder(tree) : null;
  const visit = (node: Parents): void => {
    for (const child of node.children) {
      if ("children" in child) visit(child);
    }
    if (holdsWords.has(node.type)) {
      node.children = repaired(
        node.children as PhrasingContent[],
        node === tail,
      ) as typeof node.children;
    }
  };
  visit(tree);
}

/** Holds only a private link's incomplete trailing token while its destination streams. */
export function hideIncompleteLinkTail(text: string): string {
  const brackets: number[] = [];
  let fence: string | null = null;
  for (let index = 0; index < text.length; index++) {
    if (index === 0 || text[index - 1] === "\n") {
      const rest = text.slice(index);
      if (fence === null && /^(?: {4}|\t)/u.test(rest)) {
        const end = text.indexOf("\n", index);
        index = end === -1 ? text.length : end;
        continue;
      }
      if (
        fence === null &&
        /^ {0,3}\[[^\]\r\n]+\]:[ \t]*<(?:opensteer:|file:|[/\\])/iu.test(rest) &&
        !/[>\r\n]/u.test(rest)
      )
        return text.slice(0, index);
      const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(text.slice(index))?.[1];
      if (marker) {
        const lineEnd = text.indexOf("\n", index);
        const end = lineEnd === -1 ? text.length : lineEnd;
        if (fence === null) fence = marker;
        else if (
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          text.slice(index, end).trim() === marker
        )
          fence = null;
        index = end;
        continue;
      }
    }
    if (fence !== null) continue;
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === "`") {
      const run = /^`+/u.exec(text.slice(index))![0];
      let end = index + run.length;
      while (end < text.length) {
        const next = text.indexOf("`", end);
        if (next === -1) {
          end = text.length;
          break;
        }
        const closer = /^`+/u.exec(text.slice(next))![0];
        end = next + closer.length;
        if (closer.length === run.length) break;
      }
      index = end - 1;
      continue;
    }
    if (text[index] === "[") {
      brackets.push(index);
      continue;
    }
    if (text[index] !== "]") continue;
    const start = brackets.pop();
    if (start === undefined || text[index + 1] !== "(") continue;
    let depth = 1;
    let end = index + 2;
    while (/\s/u.test(text[end] ?? "") && end < text.length) end++;
    const destinationStart = end;
    let angle = false;
    let quote: string | null = null;
    for (; end < text.length; end++) {
      if (text[end] === "\\") {
        end++;
        continue;
      }
      if (angle) {
        if (text[end] === ">") angle = false;
        continue;
      }
      if (quote !== null) {
        if (text[end] === quote) quote = null;
        continue;
      }
      if (end === destinationStart && text[end] === "<") {
        angle = true;
        continue;
      }
      if ((text[end] === '"' || text[end] === "'") && /\s/u.test(text[end - 1] ?? "")) {
        quote = text[end]!;
        continue;
      }
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    if (depth === 0) {
      index = end;
      continue;
    }
    let destination = text
      .slice(index + 2)
      .trimStart()
      .replace(/^</u, "");
    try {
      destination = decodeURIComponent(destination.replace(/%[0-9a-f]?$/iu, ""));
    } catch {
      /* A partial escape still follows the private prefix. */
    }
    const image = start > 0 && text[start - 1] === "!" && (start < 2 || text[start - 2] !== "\\");
    const privateTail =
      destination === "" ||
      "opensteer:".startsWith(destination.toLowerCase()) ||
      /^opensteer:/iu.test(destination) ||
      /^[/\\~]/u.test(destination) ||
      /^[a-z](?::|$)/iu.test(destination) ||
      /^file:/iu.test(destination);
    if (image || privateTail) return text.slice(0, image ? start - 1 : start);
  }
  return text;
}

const closingPunctuation = /^[.,;:!?)\]}»›”’…。，、；：！？）」』】〉》]+/u;

/** A phrasing node, and for a link the punctuation that closes on it. */
export interface PunctuatedNode {
  readonly node: PhrasingContent;
  readonly trailing: string;
}

/**
 * Hands each link the closing punctuation that follows it in `nodes`, taking
 * it from the text after, so a renderer can draw a chip and its period as one
 * unbreakable piece: a period never starts a line of its own. The source is
 * unchanged; only what is drawn moves.
 */
export function punctuateLinks(nodes: readonly PhrasingContent[]): readonly PunctuatedNode[] {
  const out: PunctuatedNode[] = [];
  let taken = 0;
  for (const [index, node] of nodes.entries()) {
    if (node.type === "text" && taken > 0) {
      const rest = node.value.slice(taken);
      taken = 0;
      if (rest !== "") out.push({ node: { ...node, value: rest }, trailing: "" });
      continue;
    }
    const next = nodes[index + 1];
    const trailing =
      node.type === "link" && next?.type === "text"
        ? (closingPunctuation.exec(next.value)?.[0] ?? "")
        : "";
    taken = trailing.length;
    out.push({ node, trailing });
  }
  return out;
}
