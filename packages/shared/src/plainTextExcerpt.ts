/**
 * Text as one readable line within `limit` UTF-16 units: Markdown punctuation
 * that would show up literally in a banner or a list row is dropped, links keep
 * their words, and whitespace collapses. Null when nothing readable is left.
 */
export function plainTextExcerpt(text: string, limit: number): string | null {
  const plain = text
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gmu, "")
    .replace(/(\*\*|~~|`)(?=\S)([^\n]*?\S)\1/gu, "$2")
    .replace(/\s+/gu, " ")
    .trim();
  return plain ? clipText(plain, limit) : null;
}

/**
 * Text within `limit` UTF-16 units, as the clients' schemas count them, ending
 * in an ellipsis when cut. Whole code points are kept so an emoji is never
 * split in half; this runs on Hermes, which has no `Intl.Segmenter`.
 */
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > limit - 1) break;
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}
