export interface JsonSizeBudget {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
}

/** Measures plain JSON data without serializing it or enumerating oversized collections into arrays. */
export function boundedJsonSize(value: unknown, budget: JsonSizeBudget): number | undefined {
  let bytes = budget.maxBytes;
  let entries = budget.maxEntries;
  function stringSize(text: string): boolean {
    bytes -= 2;
    if (text.length > bytes) return false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || (code >= 8 && code <= 13 && code !== 11)) bytes -= 2;
      else if (code < 32) bytes -= 6;
      else if (code < 128) bytes--;
      else if (code < 2048) bytes -= 2;
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        i++;
        bytes -= 4;
      } else bytes -= code >= 0xd800 && code <= 0xdfff ? 6 : 3;
      if (bytes < 0) return false;
    }
    return bytes >= 0;
  }
  function visit(item: unknown, depth: number): boolean {
    if (--entries < 0 || bytes < 0) return false;
    if (typeof item === "string") return stringSize(item);
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      bytes -=
        item === null || (typeof item === "number" && !Number.isFinite(item))
          ? 4
          : String(item).length;
      return bytes >= 0;
    }
    if (!item || typeof item !== "object" || depth >= budget.maxDepth) return false;
    bytes -= 2;
    if (Array.isArray(item)) {
      if (item.length > entries || item.length > bytes) return false;
      for (let i = 0; i < item.length; i++) {
        if (i) bytes--;
        const element = Object.getOwnPropertyDescriptor(item, i);
        if (element && !("value" in element)) return false;
        if (!visit(element?.value ?? null, depth + 1)) return false;
      }
      return bytes >= 0;
    }
    if (![null, Object.prototype].includes(Object.getPrototypeOf(item))) return false;
    let first = true;
    for (const key in item) {
      if (--entries < 0) return false;
      const field = Object.getOwnPropertyDescriptor(item, key);
      if (!field) continue;
      if (!("value" in field) || typeof field.value === "function") return false;
      if (field.value === undefined) continue;
      bytes -= first ? 1 : 2;
      first = false;
      if (!stringSize(key) || !visit(field.value, depth + 1)) return false;
    }
    return bytes >= 0;
  }
  return visit(value, 0) ? budget.maxBytes - bytes : undefined;
}

/** Commands whose answer is a page's own value, where reading less of the page is the advice. */
const pageReadMethods = new Set(["Runtime.evaluate", "Runtime.callFunctionOn"]);

/**
 * What an agent is told when a browser command ran but its answer was over the limit and was
 * dropped: the answer's size where it can be measured (one too deep or with too many entries
 * cannot), the limit, how to ask for less, and that the command itself ran. The answer arrived,
 * so the command finished: this is a failure of that command, never an unknown outcome.
 */
export function answerTooLargeMessage(
  value: unknown,
  maxBytes: number,
  shape: Pick<JsonSizeBudget, "maxDepth" | "maxEntries"> = { maxDepth: 32, maxEntries: 16_384 },
  method?: string,
): string {
  return answerTooLargeWords(
    boundedJsonSize(value, { ...shape, maxBytes: Number.MAX_SAFE_INTEGER }),
    maxBytes,
    method,
  );
}

/**
 * The same words from an answer's measured size: undefined, or within the limit, when its shape
 * was what failed. Both numbers are in KiB, the size rounded up and the limit down, so the size
 * printed is always more than the limit printed.
 */
export function answerTooLargeWords(
  size: number | undefined,
  maxBytes: number,
  method?: string,
): string {
  const what =
    size === undefined || size <= maxBytes
      ? "is too deeply nested or has too many entries"
      : `is ${Math.ceil(size / 1_024)} KiB, over the ${Math.floor(maxBytes / 1_024)} KiB limit for one answer`;
  const less =
    method !== undefined && pageReadMethods.has(method)
      ? "Ask the page for less: a slice of the text, an element by selector, or innerText instead of the HTML."
      : "Ask for less.";
  return `The command ran, but its answer ${what}, so it exceeds the bounded agent transport and was dropped. ${less} If the command changed something, do not run it again.`;
}
