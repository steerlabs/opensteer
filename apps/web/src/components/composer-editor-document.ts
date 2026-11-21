import { Node as EditorNode, type JSONContent } from "@tiptap/core";
import type { Fragment, Node as DocNode, Schema } from "@tiptap/pm/model";
import { collectComposerTokens, type ComposerToken } from "@opensteer/client/references";

/**
 * The composer's document is its Markdown source and nothing more: one
 * paragraph of text, line breaks and reference atoms, where every atom keeps
 * the exact source it stands for. Serializing gives back the stored string
 * byte for byte, so drafts, sends and edits never carry editor JSON.
 */
export const referenceNodeName = "composerReference";

export const ComposerDocument = EditorNode.create({
  name: "doc",
  topNode: true,
  content: "paragraph",
});

export const ComposerParagraph = EditorNode.create({
  name: "paragraph",
  content: "inline*",
  whitespace: "pre",
  parseHTML: () => [{ tag: "p" }],
  renderHTML: () => ["p", 0],
});

export const ComposerText = EditorNode.create({ name: "text", group: "inline" });

export const ComposerHardBreak = EditorNode.create({
  name: "hardBreak",
  inline: true,
  group: "inline",
  selectable: false,
  parseHTML: () => [{ tag: "br" }],
  renderHTML: () => ["br"],
  renderText: () => "\n",
});

export const ComposerReference = EditorNode.create({
  name: referenceNodeName,
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({
    source: { default: "", rendered: false },
    label: { default: "", rendered: false },
    href: { default: "", rendered: false },
    kind: { default: "personal", rendered: false },
  }),
  parseHTML: () => [{ tag: "span[data-composer-reference]" }],
  renderHTML: ({ node }) => ["span", { "data-composer-reference": "" }, referenceOf(node).label],
  renderText: ({ node }) => referenceOf(node).source,
});

export const composerNodes = [
  ComposerDocument,
  ComposerParagraph,
  ComposerText,
  ComposerHardBreak,
  ComposerReference,
];

/** What an atom stands for, read back from its attributes. */
export function referenceOf(node: DocNode): ComposerToken {
  const attrs: Record<string, unknown> = node.attrs;
  const kind = attrs.kind === "file" ? attrs.kind : "personal";
  return {
    start: 0,
    end: 0,
    source: String(attrs.source),
    label: String(attrs.label),
    href: String(attrs.href),
    kind,
  };
}

/** The tokens that become atoms: a link written across lines stays editable source. */
export function composerTokens(text: string): readonly ComposerToken[] {
  if (!text.includes("](")) return [];
  return collectComposerTokens(text, { commitTrailing: true }).filter(
    (token) => !token.source.includes("\n"),
  );
}

type Piece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "break" }
  | { readonly kind: "token"; readonly token: ComposerToken };

function pieces(text: string, tokens: readonly ComposerToken[]): Piece[] {
  const out: Piece[] = [];
  const words = (value: string) =>
    value.split("\n").forEach((line, index) => {
      if (index > 0) out.push({ kind: "break" });
      if (line) out.push({ kind: "text", text: line });
    });
  let at = 0;
  for (const token of tokens) {
    words(text.slice(at, token.start));
    out.push({ kind: "token", token });
    at = token.end;
  }
  words(text.slice(at));
  return out;
}

const tokenAttrs = (token: ComposerToken) => ({
  source: token.source,
  label: token.label,
  href: token.href,
  kind: token.kind,
});

/** The editor's starting document for a source string. */
export function composerContent(text: string): JSONContent {
  const content = pieces(text, composerTokens(text)).map((piece): JSONContent =>
    piece.kind === "text"
      ? { type: "text", text: piece.text }
      : piece.kind === "break"
        ? { type: "hardBreak" }
        : { type: referenceNodeName, attrs: tokenAttrs(piece.token) },
  );
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

/** Inline nodes for a source string, its completed links as atoms. */
export function composerInline(
  schema: Schema,
  text: string,
  tokens: readonly ComposerToken[],
): DocNode[] {
  return pieces(text, tokens).map((piece) =>
    piece.kind === "text"
      ? schema.text(piece.text)
      : piece.kind === "break"
        ? schema.nodes.hardBreak!.create()
        : schema.nodes[referenceNodeName]!.create(tokenAttrs(piece.token)),
  );
}

function nodeSource(node: DocNode): string {
  if (node.isText) return node.text ?? "";
  if (node.type.name === "hardBreak") return "\n";
  if (node.type.name === referenceNodeName) return referenceOf(node).source;
  let out = "";
  node.forEach((child) => {
    out += nodeSource(child);
  });
  return out;
}

/** The exact Markdown source a document, or a copied piece of one, stands for. */
export function composerSource(content: DocNode | Fragment): string {
  if ("type" in content && content.type.name !== "doc") return nodeSource(content);
  const blocks: string[] = [];
  let inline = "";
  const fragment = "type" in content ? content.content : content;
  fragment.forEach((node) => {
    if (node.isBlock) blocks.push(nodeSource(node));
    else inline += nodeSource(node);
  });
  return blocks.length > 0 ? [...blocks, ...(inline ? [inline] : [])].join("\n") : inline;
}

const sourceLength = (node: DocNode) =>
  node.isText
    ? node.nodeSize
    : node.type.name === referenceNodeName
      ? referenceOf(node).source.length
      : 1;

/** Each inline node with its document position and source offset. */
function inlineRuns(doc: DocNode) {
  const runs: { node: DocNode; pos: number; start: number; end: number }[] = [];
  const paragraph = doc.firstChild;
  if (!paragraph) return runs;
  let start = 0;
  paragraph.forEach((node, offset) => {
    const end = start + sourceLength(node);
    runs.push({ node, pos: 1 + offset, start, end });
    start = end;
  });
  return runs;
}

/** The source offset at a document position. */
export function sourceOffsetAt(doc: DocNode, pos: number): number {
  let offset = 0;
  for (const run of inlineRuns(doc)) {
    if (pos <= run.pos) return run.start;
    if (pos < run.pos + run.node.nodeSize) return run.start + (pos - run.pos);
    offset = run.end;
  }
  return offset;
}

/** The document position at a source offset; an offset inside an atom goes to its nearer edge. */
export function docPosAt(doc: DocNode, offset: number): number {
  for (const run of inlineRuns(doc)) {
    if (offset <= run.start) return run.pos;
    if (offset < run.end) {
      if (run.node.isText) return run.pos + (offset - run.start);
      return offset - run.start < run.end - offset ? run.pos : run.pos + run.node.nodeSize;
    }
  }
  return 1 + (doc.firstChild?.content.size ?? 0);
}

/** Each atom with where it sits in the source. */
export function atomTokens(doc: DocNode): readonly ComposerToken[] {
  return inlineRuns(doc)
    .filter((run) => run.node.type.name === referenceNodeName)
    .map((run) => ({ ...referenceOf(run.node), start: run.start, end: run.end }));
}

/**
 * The smallest replacement that turns `doc` into `target`: unchanged text and
 * atoms on either side keep their nodes, so history and the caret map through
 * it. It never cuts an atom or a new token in half.
 */
export function sourceReplacement(
  doc: DocNode,
  target: string,
): { readonly from: number; readonly to: number; readonly nodes: DocNode[] } | null {
  const current = composerSource(doc);
  if (current === target) return null;
  let start = 0;
  const shortest = Math.min(current.length, target.length);
  while (start < shortest && current[start] === target[start]) start += 1;
  let tail = 0;
  while (
    tail < shortest - start &&
    current[current.length - 1 - tail] === target[target.length - 1 - tail]
  )
    tail += 1;
  const atoms = atomTokens(doc);
  const tokens = composerTokens(target);
  const delta = target.length - current.length;
  let oldEnd = current.length - tail;
  for (let changed = true; changed;) {
    changed = false;
    for (const atom of atoms)
      if (atom.start < oldEnd && atom.end > start && (atom.start < start || atom.end > oldEnd)) {
        start = Math.min(start, atom.start);
        oldEnd = Math.max(oldEnd, atom.end);
        changed = true;
      }
    for (const token of tokens) {
      const newEnd = oldEnd + delta;
      if (
        token.start < newEnd &&
        token.end > start &&
        (token.start < start || token.end > newEnd)
      ) {
        start = Math.min(start, token.start);
        oldEnd = Math.max(oldEnd, token.end - delta);
        changed = true;
      }
    }
  }
  const newEnd = oldEnd + delta;
  const inner = tokens
    .filter((token) => token.start >= start && token.end <= newEnd)
    .map((token) => ({ ...token, start: token.start - start, end: token.end - start }));
  return {
    from: docPosAt(doc, start),
    to: docPosAt(doc, oldEnd),
    nodes: composerInline(doc.type.schema, target.slice(start, newEnd), inner),
  };
}

/**
 * Links finished by typing, as the atoms they become: only once the caret has
 * left them, so a link being written stays source until it is done.
 */
export function typedTokenConversions(
  doc: DocNode,
  caret: number | null,
): readonly { readonly from: number; readonly to: number; readonly node: DocNode }[] {
  const text = composerSource(doc);
  const schema = doc.type.schema;
  const out: { from: number; to: number; node: DocNode }[] = [];
  for (const token of composerTokens(text)) {
    if (caret !== null && caret >= token.start && caret <= token.end) continue;
    const from = docPosAt(doc, token.start);
    const to = docPosAt(doc, token.end);
    // Plain text maps one to one; a stretch holding an atom or a break does not.
    if (to - from !== token.end - token.start) continue;
    out.push({ from, to, node: schema.nodes[referenceNodeName]!.create(tokenAttrs(token)) });
  }
  return out.reverse();
}
