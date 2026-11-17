import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CodexContextEntry {
  readonly kind: "application";
  readonly value: string;
}

// Codex middle-truncates values beyond 1,000 tokens, estimated as UTF-8 bytes / 4.
const maximumValueBytes = 4_000;

/** Unnumbered keys drivers sent before the inventory existed. */
export const legacyCodexContextKeys: readonly string[] = [
  "opensteer_computers",
  "opensteer_current_instructions",
  "opensteer_skills",
];

/** The last write to each inventory, so every builder of one conversation writes in turn. */
const inventoryWrites = new Map<string, Promise<void>>();

/**
 * Opensteer's application context as bounded, ordered keys. Codex emits a key
 * only when its value changes and never retracts a key that disappears, so
 * every key the conversation was ever sent stays in the map, empty once
 * retired. The inventory lives beside the native conversation because a
 * replaced engine resumes the same conversation and must still retire it.
 */
export class CodexAdditionalContext {
  readonly #keys: Set<string>;
  readonly #path: string;

  private constructor(path: string, keys: Iterable<string>) {
    this.#path = path;
    this.#keys = new Set(keys);
  }

  /**
   * A conversation with no recorded inventory may still hold keys an earlier
   * driver sent; `unrecorded` names them so they are retired too.
   */
  static async open(
    path: string,
    unrecorded: readonly string[] = [],
  ): Promise<CodexAdditionalContext> {
    const recorded = await readInventory(path);
    return new CodexAdditionalContext(path, recorded.length > 0 ? recorded : unrecorded);
  }

  async build(
    families: Readonly<Record<string, string>>,
  ): Promise<Record<string, CodexContextEntry>> {
    const entries = new Map<string, CodexContextEntry>();
    const known = this.#keys.size;
    for (const [family, value] of Object.entries(families)) {
      for (const [index, chunk] of splitValue(value).entries()) {
        const key = `${family}_${String(index + 1).padStart(6, "0")}`;
        this.#keys.add(key);
        entries.set(key, { kind: "application", value: chunk });
      }
    }
    if (this.#keys.size !== known) await this.#persist();
    return Object.fromEntries(
      [...this.#keys]
        .sort()
        .map((key) => [key, entries.get(key) ?? { kind: "application", value: "" }]),
    );
  }

  /** One write at a time per conversation, each merging what is recorded and replacing it atomically. */
  #persist(): Promise<void> {
    const path = this.#path;
    const write = (inventoryWrites.get(path) ?? Promise.resolve()).then(async () => {
      for (const key of await readInventory(path)) this.#keys.add(key);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify([...this.#keys].sort()), { mode: 0o600 });
      await rename(temporary, path);
    });
    const settled = write.catch(() => undefined);
    inventoryWrites.set(path, settled);
    void settled.then(() => {
      if (inventoryWrites.get(path) === settled) inventoryWrites.delete(path);
    });
    return write;
  }
}

/**
 * The keys recorded for a conversation. A missing record is a conversation
 * that has none yet; an unreadable one is replaced by the next write, and its
 * lost keys simply stay unretired in the native history.
 */
async function readInventory(path: string): Promise<readonly string[]> {
  const stored: unknown = await readFile(path, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => []);
  return Array.isArray(stored)
    ? stored.filter((key): key is string => typeof key === "string")
    : [];
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
