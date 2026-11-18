import rehypeHighlight from "rehype-highlight";

type Highlight = ReturnType<typeof rehypeHighlight>;
type Tree = Parameters<Highlight>[0];
type Element = Extract<Tree["children"][number], { type: "element" }>;
type HighlightedCode = Pick<Element, "children" | "properties">;

const highlight = rehypeHighlight();
const openingFence = /^(`{3,}|~{3,})/u;
const closingFence = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/u;

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

export function createMarkdownHighlight() {
  let previous = new Map<string, HighlightedCode>();
  return ({ streaming }: { streaming: boolean }): Highlight =>
    (tree, file) => {
      const next = new Map<string, HighlightedCode>();
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
          const key = `${node.properties.className}\n${body.value}`;
          const held = next.get(key) ?? previous.get(key);
          if (held) Object.assign(node, held);
          else highlight({ type: "root", children: [parent] }, file);
          next.set(key, { children: node.children, properties: node.properties });
        }
      };
      visit(tree);
      previous = next;
    };
}
