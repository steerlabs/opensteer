import type { Definition, Nodes, Parents, Root } from "mdast";
import type { CompileContext, Token } from "mdast-util-from-markdown";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import {
  personMarkdownGfmOptions,
  personMarkdownTree,
  type MarkdownProfile,
} from "./personMarkdown.js";
import { hideIncompleteLinkTail, repairStrong } from "./markdown.js";

const extensions = [gfm()];
const personExtensions = [gfm(personMarkdownGfmOptions)];
const mdastExtensions = [
  gfmFromMarkdown(),
  { exit: { resourceDestinationString: keepPath, definitionDestinationString: keepPath } },
];
export type { Nodes, Root } from "mdast";

function keepPath(this: CompileContext, token: Token): void {
  const decoded = this.resume();
  const authored = this.sliceSerialize(token);
  const node = this.stack.at(-1);
  if (node && (node.type === "image" || node.type === "link" || node.type === "definition"))
    node.url =
      (/^[a-z]:[\\/]/i.test(authored) || authored.startsWith("\\\\")) && !authored.includes("&")
        ? authored
        : decoded;
}

export function markdownSourceTree(
  text: string,
  options?: { readonly profile?: MarkdownProfile },
): Root {
  return fromMarkdown(text, {
    extensions: options?.profile === "person" ? personExtensions : extensions,
    mdastExtensions,
  });
}

/** A `[ref]` as the link or image it names, so a renderer only ever meets those two. */
function resolveReferences(tree: Root): void {
  const definitions = new Map<string, Definition>();
  const gather = (node: Nodes): void => {
    // The first definition of a label wins, as CommonMark and web read it.
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if ("children" in node) node.children.forEach(gather);
  };
  gather(tree);
  if (definitions.size === 0) return;
  const resolve = (node: Parents): void => {
    node.children = node.children.map((child) => {
      if (child.type !== "linkReference" && child.type !== "imageReference") return child;
      const url = definitions.get(child.identifier)?.url;
      if (url === undefined) return child;
      return child.type === "linkReference"
        ? { type: "link", children: child.children, url }
        : { type: "image", alt: child.alt ?? null, url };
    }) as typeof node.children;
    for (const child of node.children) {
      if ("children" in child) resolve(child);
    }
  };
  resolve(tree);
}

/** An agent's Markdown as a tree: the parser web's renderer uses, for a client that draws its own. */
export function parseMarkdown(
  text: string,
  options?: { readonly streaming?: boolean; readonly profile?: MarkdownProfile },
): Root {
  const tree = markdownSourceTree(
    options?.streaming ? hideIncompleteLinkTail(text) : text,
    options,
  );
  resolveReferences(tree);
  if (options?.profile === "person") personMarkdownTree(tree);
  else repairStrong(tree, options);
  return tree;
}

/**
 * Visits source nodes outside code. Markdown between inline HTML tags, and the HTML
 * itself, is skipped unless `inlineHtml` is "visit": it still renders, so sanitation must see it.
 */
export function visitMarkdownSource(
  tree: Root,
  visit: (node: Nodes) => boolean | void,
  options: { readonly inlineHtml?: "skip" | "visit" } = {},
): void {
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const walk = (node: Nodes): void => {
    if (node.type === "code" || node.type === "inlineCode") return;
    if (node.type === "html") {
      if (options.inlineHtml === "visit") visit(node);
      return;
    }
    if (visit(node) === false || !("children" in node)) return;
    const tags: string[] = [];
    for (const child of node.children) {
      if (child.type === "html") {
        if (options.inlineHtml === "visit") walk(child);
        for (const match of child.value.matchAll(/<\/?([a-z][a-z\d-]*)\b[^>]*>/giu)) {
          const tag = match[1]!.toLowerCase();
          if (match[0].startsWith("</")) {
            const index = tags.lastIndexOf(tag);
            if (index !== -1) tags.length = index;
          } else if (!voidTags.has(tag) && !match[0].endsWith("/>")) tags.push(tag);
        }
      } else if (tags.length === 0 || options.inlineHtml === "visit") walk(child);
    }
  };
  walk(tree);
}
