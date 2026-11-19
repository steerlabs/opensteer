/** Image types every client draws inertly in an image element: no script, no external fetch. */
const iconImageTypes = ["image/svg+xml", "image/png", "image/webp", "image/jpeg"] as const;
export type IconImageType = (typeof iconImageTypes)[number];

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, offset) => bytes[at + offset] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const svgProlog =
  /^(?:\s+|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)/iu;

/**
 * The type these bytes are, by their content rather than any name or header that came with
 * them, or undefined when they are none of `iconImageTypes`. SVG is UTF-8 text whose root, after
 * an optional byte order mark, XML declaration, comments and doctype, is `<svg>`.
 */
export function iconImageType(bytes: Uint8Array): IconImageType | undefined {
  if (startsWith(bytes, [0x89, ...ascii("PNG\r\n\x1a\n")])) return "image/png";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  for (let match = svgProlog.exec(text); match; match = svgProlog.exec(text))
    text = text.slice(match[0].length);
  return /^<svg[\s/>]/u.test(text) ? "image/svg+xml" : undefined;
}
