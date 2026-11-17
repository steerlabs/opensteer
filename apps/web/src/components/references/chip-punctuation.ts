import { punctuateLinks, type repairStrong } from "@opensteer/shared/markdown";

type MarkdownTree = Parameters<typeof repairStrong>[0];
type MarkdownNode = MarkdownTree | MarkdownTree["children"][number];

/**
 * Hands the punctuation that closes on a link to the link, as `data-trailing`,
 * so `Link` can keep it on a chip's line.
 */
export function remarkChipPunctuation() {
  return (tree: MarkdownTree) => visit(tree);
}

function visit(node: MarkdownNode): void {
  if (!("children" in node)) return;
  for (const child of node.children) visit(child);
  if (!node.children.some((child) => child.type === "link")) return;
  node.children = punctuateLinks(node.children as Parameters<typeof punctuateLinks>[0]).map(
    ({ node: child, trailing }) =>
      trailing && child.type === "link"
        ? {
            ...child,
            data: {
              ...child.data,
              hProperties: { ...child.data?.hProperties, dataTrailing: trailing },
            },
          }
        : child,
  ) as typeof node.children;
}
