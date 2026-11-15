import { parseMarkdown } from "@opensteer/shared/markdownParser";
import type { MarkdownProfile } from "@opensteer/shared/personMarkdown";
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
export function markdownTree(
  source: string,
  streaming: boolean,
  profile: MarkdownProfile = "assistant",
): Root {
  if (streaming) return parseMarkdown(source, { streaming: true, profile });
  // The same words parse differently as a person's and as an agent's.
  const key = `${profile}:${source}`;
  const known = trees.get(key);
  if (known !== undefined) {
    trees.delete(key);
    trees.set(key, known);
    return known;
  }
  const tree = parseMarkdown(source, { profile });
  trees.set(key, tree);
  held += key.length;
  for (const oldest of trees.keys()) {
    if (held <= budget) break;
    trees.delete(oldest);
    held -= oldest.length;
  }
  return tree;
}
