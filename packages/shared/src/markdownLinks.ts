/** A labeled Markdown link with an inert label and an unambiguous destination. */
export function markdownLink(label: string, href: string): string {
  const cleaned = label
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const escaped = cleaned.replace(/[\\[\]`*_!<>~&]/gu, "\\$&");
  const encoded = href.replace(/[<>\\\s]/gu, (character) => encodeURIComponent(character));
  return "[" + escaped + "](" + (/[()]/u.test(encoded) ? "<" + encoded + ">" : encoded) + ")";
}
