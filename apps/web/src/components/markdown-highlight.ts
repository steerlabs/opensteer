import rehypeHighlight from "rehype-highlight";
import { BoundedCache } from "@opensteer/shared/boundedCache";

type Highlight = ReturnType<typeof rehypeHighlight>;
type Tree = Parameters<Highlight>[0];
type Element = Extract<Tree["children"][number], { type: "element" }>;
type HighlightedCode = Pick<Element, "children" | "properties">;

const highlight = rehypeHighlight();
const openingFence = /^(`{3,}|~{3,})/u;
const closingFence = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/u;

/**
 * Finished code, highlighted, by its language and text, shared by every reply: a block drawn
 * again, as a reply streams on below it or after a task switch, is not highlighted again. The
 * highlighted tree holds tens of bytes per character of code, so this stays within ~50 MB.
 * Cached trees are shared, so nothing may change them.
 */
export const highlightedCode = new BoundedCache<string, HighlightedCode>({
  maxEntries: 500,
  maxSize: 1_000_000,
});

function growingFence(code: Element, source: string): boolean {
  const { start, end } = code.position ?? {};
  if (start?.offset === undefined || end?.offset === undefined || end.offset < source.length)
    return false;
  const opener = openingFence.exec(source.slice(start.offset))?.[1];
  if (!opener) return false;
  if (start.line === end.line) return true;
  const closer = closingFence.exec(source.slice(end.offset - end.column + 1))?.[1];
  return !closer || opener[0] !== closer[0] || opener.length > closer.length;
}

/** Highlights each finished code fence; one still being written stays plain until it closes. */
export function markdownHighlight({ streaming }: { streaming: boolean }): Highlight {
  return (tree, file) => {
    const source = streaming ? String(file).trimEnd() : "";
    const visit = (parent: Tree | Element) => {
      for (const node of parent.children) {
        if (node.type !== "element") continue;
        if (parent.type !== "element" || parent.tagName !== "pre" || node.tagName !== "code") {
          visit(node);
          continue;
        }
        const body = node.children[0];
        if (!node.properties.className || body?.type !== "text" || growingFence(node, source))
          continue;
        const key = `${String(node.properties.className)}\n${body.value}`;
        const held = highlightedCode.get(key);
        if (held) Object.assign(node, held);
        else {
          highlight({ type: "root", children: [parent] }, file);
          highlightedCode.set(
            key,
            { children: node.children, properties: node.properties },
            key.length,
          );
        }
      }
    };
    visit(tree);
  };
}
