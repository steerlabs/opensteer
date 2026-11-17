import type { Nodes, PhrasingContent, Root } from "mdast";

export type MarkdownProfile = "assistant" | "person";
export const personMarkdownGfmOptions = { singleTilde: false } as const;

function softBreaks(value: string): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  value.split(/\r\n|\r|\n/u).forEach((line, index) => {
    if (index > 0) children.push({ type: "break" });
    children.push({ type: "text", value: line });
  });
  return children;
}

export function personMarkdownTree(tree: Root): Root {
  const visit = (node: Nodes): void => {
    if (node.type === "code" || node.type === "inlineCode" || !("children" in node)) return;
    const children: Nodes[] = [];
    for (const child of node.children) {
      if (child.type === "html") {
        const words = softBreaks(child.value);
        if (["root", "blockquote", "listItem", "footnoteDefinition"].includes(node.type))
          children.push({ type: "paragraph", children: words });
        else children.push(...words);
      } else if (child.type === "text") children.push(...softBreaks(child.value));
      else {
        visit(child);
        children.push(child);
      }
    }
    node.children = children as typeof node.children;
  };
  visit(tree);
  return tree;
}
