export interface CodexContextEntry {
  readonly kind: "application";
  readonly value: string;
}

// Codex middle-truncates values beyond 1,000 tokens, estimated as UTF-8 bytes / 4.
const maximumValueBytes = 4_000;

export class CodexAdditionalContext {
  readonly #keys = new Set<string>();

  build(families: Readonly<Record<string, string>>): Record<string, CodexContextEntry> {
    const entries = new Map<string, CodexContextEntry>();
    for (const [family, value] of Object.entries(families)) {
      for (const [index, chunk] of splitValue(value).entries()) {
        const key = `${family}_${String(index + 1).padStart(6, "0")}`;
        this.#keys.add(key);
        entries.set(key, { kind: "application", value: chunk });
      }
    }
    return Object.fromEntries(
      [...this.#keys]
        .sort()
        .map((key) => [key, entries.get(key) ?? { kind: "application", value: "" }]),
    );
  }
}

function splitValue(value: string, level = 0): string[] {
  if (Buffer.byteLength(value, "utf8") <= maximumValueBytes) return [value];
  const parts =
    level === 0
      ? value.split(/(?<=\n\n)/u)
      : level === 1
        ? value.split(/(?<=\n)/u)
        : Array.from(value);
  const chunks: string[] = [];
  let chunk = "";
  for (const part of parts) {
    if (Buffer.byteLength(part, "utf8") > maximumValueBytes) {
      if (chunk) chunks.push(chunk);
      chunk = "";
      chunks.push(...splitValue(part, level + 1));
    } else if (Buffer.byteLength(chunk + part, "utf8") > maximumValueBytes) {
      chunks.push(chunk);
      chunk = part;
    } else chunk += part;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
