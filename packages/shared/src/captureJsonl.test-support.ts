/** Parse a snapshot of an append-only capture; its final record may still be arriving. */
export function parseCaptureJsonl<T = unknown>(text: string): T[] {
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
