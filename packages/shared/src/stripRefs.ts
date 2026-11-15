import { isNetworkPath } from "./fileHref.js";
import { hideIncompleteLinkTail } from "./markdown.js";
import { markdownSourceTree, visitMarkdownSource } from "./markdownParser.js";
import { teamMentionHandles, teamMentionHandleRanges } from "./teamMentions.js";

function privateDestination(url: string): boolean {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    /* Malformed private destinations are still private. */
  }
  if (/^opensteer:/iu.test(decoded) || /^file:/iu.test(decoded) || isNetworkPath(decoded))
    return true;
  if (/^[a-z]:[\\/]/iu.test(decoded)) return true;
  return !/^[a-z][a-z\d+.-]*:/iu.test(decoded) && !/^[#?]/u.test(decoded);
}

function labelSource(source: string): string {
  const start = source.startsWith("![") ? 2 : 1;
  let depth = 1;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === "[") depth++;
    else if (source[index] === "]" && --depth === 0) return source.slice(start, index);
  }
  return "";
}

/** Removes private destinations without rewriting unrelated Markdown or creating recipients. */
export function stripRefs(markdown: string): string {
  if (!markdown.includes("[") && !markdown.includes("<")) return markdown;
  const source = hideIncompleteLinkTail(markdown);
  const tree = markdownSourceTree(source);
  const definitions = new Map<string, string>();
  visitMarkdownSource(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
  });
  const edits: { start: number; end: number; text: string }[] = [];
  visitMarkdownSource(tree, (node) => {
    const url =
      node.type === "link" || node.type === "image" || node.type === "definition"
        ? node.url
        : node.type === "linkReference" || node.type === "imageReference"
          ? definitions.get(node.identifier)
          : undefined;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (url !== undefined && privateDestination(url) && start !== undefined && end !== undefined) {
      const written = source.slice(start, end);
      const label =
        node.type === "definition"
          ? ""
          : written.startsWith("<")
            ? /^opensteer:/iu.test(url)
              ? "Opensteer item"
              : "File"
            : stripRefs(labelSource(written));
      edits.push({ start, end, text: label });
      return false;
    }
    return true;
  });
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  if (result === markdown) return result;
  const originalHandles = new Set(teamMentionHandles(markdown));
  for (const match of [...teamMentionHandleRanges(result)].reverse()) {
    if (!originalHandles.has(match.handle))
      result = result.slice(0, match.start) + "\\" + result.slice(match.start);
  }
  return result;
}
