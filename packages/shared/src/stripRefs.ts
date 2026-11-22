import { isNetworkPath } from "./fileHref.js";
import { hideIncompleteLinkTail } from "./markdown.js";
import { markdownSourceTree, visitMarkdownSource } from "./markdownParser.js";
import { mentionHandles, mentionHandleRanges } from "./mentionHandles.js";

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

// HTML attributes that name a destination; any other attribute is just text.
const htmlDestinationAttribute =
  /(\s(?:href|src|srcset|action|formaction|poster|data|cite|background|longdesc|ping|xlink:href)\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+)/giu;

/** Empties every HTML destination naming a private place; the tag and its text stay. */
function stripHtmlDestinations(html: string): string {
  return html.replace(htmlDestinationAttribute, (whole, prefix: string, quoted: string) => {
    const value = /^["']/u.test(quoted) ? quoted.slice(1, -1) : quoted;
    // `ping` lists URLs by spaces and `srcset` by commas with size descriptors: check every token.
    const destinations = value
      .split(/[\s,]+/u)
      .filter((token) => !/^\d+(\.\d+)?[wxh]$/u.test(token));
    return destinations.some((url) => url !== "" && privateDestination(url))
      ? `${prefix}""`
      : whole;
  });
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

function escapeLinkSyntax(source: string): string {
  return source.replace(/\\[\s\S]|[[<]/gu, (token) => (token.length === 1 ? "\\" + token : token));
}

function stripPrivateLinks(markdown: string, neutralize = false): string {
  const source = hideIncompleteLinkTail(markdown);
  const tree = markdownSourceTree(source);
  const definitions = new Map<string, string>();
  visitMarkdownSource(
    tree,
    (node) => {
      if (node.type === "definition" && !definitions.has(node.identifier))
        definitions.set(node.identifier, node.url);
    },
    { inlineHtml: "visit" },
  );
  const edits: { start: number; end: number; text: string }[] = [];
  visitMarkdownSource(
    tree,
    (node) => {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (neutralize && node.type === "text" && start !== undefined && end !== undefined) {
        edits.push({ start, end, text: escapeLinkSyntax(source.slice(start, end)) });
        return false;
      }
      if (node.type === "html" && start !== undefined && end !== undefined) {
        const written = source.slice(start, end);
        const stripped = stripHtmlDestinations(written);
        if (stripped !== written) edits.push({ start, end, text: stripped });
        return false;
      }
      const url =
        node.type === "link" || node.type === "image" || node.type === "definition"
          ? node.url
          : node.type === "linkReference" || node.type === "imageReference"
            ? definitions.get(node.identifier)
            : undefined;
      if (
        url !== undefined &&
        privateDestination(url) &&
        start !== undefined &&
        end !== undefined
      ) {
        const written = source.slice(start, end);
        const label =
          node.type === "definition"
            ? ""
            : written.startsWith("<")
              ? /^opensteer:/iu.test(url)
                ? "Opensteer item"
                : "File"
              : labelSource(written);
        edits.push({ start, end, text: neutralize ? escapeLinkSyntax(label) : label });
        return false;
      }
      return true;
    },
    { inlineHtml: "visit" },
  );
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** Removes private destinations without rewriting unrelated Markdown or creating recipients. */
export function stripRefs(markdown: string): string {
  if (!markdown.includes("[") && !markdown.includes("<")) return markdown;
  let result = markdown;
  // Removing an inner link can activate an outer one; cap reparsing for adversarial nesting.
  for (let pass = 0; pass < 32; pass++) {
    const next = stripPrivateLinks(result);
    if (next === result) break;
    result = next;
    if (pass === 31) result = stripPrivateLinks(result, true);
  }
  if (result === markdown) return result;
  const originalHandles = new Set(mentionHandles(markdown));
  for (const match of [...mentionHandleRanges(result)].reverse()) {
    if (!originalHandles.has(match.handle))
      result = result.slice(0, match.start) + "\\" + result.slice(match.start);
  }
  return result;
}
