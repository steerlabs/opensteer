import type { Definition, Nodes, Parents, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { repairStrong } from "./markdown.js";

const extensions = [gfm()];
const mdastExtensions = [gfmFromMarkdown()];

/** A `[ref]` as the link or image it names, so a renderer only ever meets those two. */
function resolveReferences(tree: Root): void {
  const definitions = new Map<string, Definition>();
  const gather = (node: Nodes): void => {
    if (node.type === "definition") definitions.set(node.identifier, node);
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
export function parseMarkdown(text: string, options?: { readonly streaming?: boolean }): Root {
  const tree = fromMarkdown(text, { extensions, mdastExtensions });
  resolveReferences(tree);
  repairStrong(tree, options);
  return tree;
}
