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
      else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
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
      bytes -= item === null || (typeof item === "number" && !Number.isFinite(item)) ? 4 : String(item).length;
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
