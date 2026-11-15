import { stripRefs } from "@opensteer/shared/stripRefs";

const link =
  /!?\[((?:\\.|[^\]\\\n])*)\]\((?:<[^>\n]*>|(?:\\.|\([^()\s]*\)|[^()\s\\])*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/gu;

/**
 * Markdown as words while its renderer is still loading: each link or image
 * reads as its label, never its destination, so a reference never shows an
 * id or a path.
 */
export function readableMarkdown(text: string): string {
  return stripRefs(text.replace(link, (_, label: string) => label.replace(/\\(.)/gu, "$1")));
}
