/**
 * The start of a Markdown text as one plain line, for lists: no markup, list items and
 * paragraphs joined with " · ", at most `maxChars` characters ending in "…" when cut.
 */
export function markdownPreview(markdown: string, maxChars: number): string {
  const parts: string[] = [];
  let fenced = false;
  for (const raw of markdown.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(raw)) {
      fenced = !fenced;
      continue;
    }
    const line = (fenced ? raw : inline(raw.replace(/^\s*(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/u, "")))
      .replace(/\s+/gu, " ")
      .trim();
    if (line && !/^(?:[-*_]\s*){3,}$/u.test(line)) parts.push(line);
  }
  const flat = parts.join(" · ");
  const chars = [...flat];
  return chars.length <= maxChars
    ? flat
    : `${chars
        .slice(0, maxChars - 1)
        .join("")
        .trimEnd()}…`;
}

function inline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<([a-z][a-z0-9+.-]*:[^>\s]+)>/giu, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/gu, "$2")
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/gu, "$1$2")
    .replace(/`([^`]*)`/gu, "$1");
}
