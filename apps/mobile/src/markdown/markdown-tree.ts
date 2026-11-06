import { parseMarkdown } from "@opensteer/shared/markdownParser";
import type { Root } from "mdast";

/** How much source stays parsed, in characters: a long Thread's worth of scrolling back. */
const budget = 400_000;

const trees = new Map<string, Root>();
let held = 0;

/**
 * A block's tree. A list unmounts the rows it scrolls past and parsing is the
 * dear part of drawing one on Hermes, so finished blocks stay parsed; the block
 * still being written changes with every delta, so it never enters the cache.
 */
export function markdownTree(source: string, streaming: boolean): Root {
  if (streaming) return parseMarkdown(source, { streaming: true });
  const known = trees.get(source);
  if (known !== undefined) {
    trees.delete(source);
    trees.set(source, known);
    return known;
  }
  const tree = parseMarkdown(source);
  trees.set(source, tree);
  held += source.length;
  for (const oldest of trees.keys()) {
    if (held <= budget) break;
    trees.delete(oldest);
    held -= oldest.length;
  }
  return tree;
}
