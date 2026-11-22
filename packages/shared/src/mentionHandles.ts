import { markdownSourceTree, visitMarkdownSource } from "./markdownParser.js";

/** The `@handle`s a Markdown source writes as text, not inside links, code or escapes. */
export function mentionHandles(bodyMarkdown: string): readonly string[] {
  return mentionHandleRanges(bodyMarkdown).map(({ handle }) => handle);
}

/** Source offsets keep escapes and replacement boundaries meaningful to sanitation. */
export function mentionHandleRanges(
  bodyMarkdown: string,
): readonly { handle: string; start: number; end: number }[] {
  if (!bodyMarkdown.includes("@")) return [];
  const ranges: { start: number; end: number }[] = [];
  visitMarkdownSource(markdownSourceTree(bodyMarkdown), (node) => {
    if (["link", "linkReference", "image", "imageReference", "definition"].includes(node.type))
      return false;
    if (node.type === "text") {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    }
    return true;
  });
  const matches: { handle: string; start: number; end: number }[] = [];
  let rangeIndex = 0;
  for (const match of bodyMarkdown.matchAll(/(?:^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)/gu)) {
    const start = match.index + match[0].indexOf("@");
    const end = start + match[1]!.length + 1;
    while (ranges[rangeIndex] && ranges[rangeIndex]!.end <= start) rangeIndex++;
    const range = ranges[rangeIndex];
    if (range && start >= range.start && end <= range.end)
      matches.push({ handle: match[1]!, start, end });
  }
  return matches;
}
