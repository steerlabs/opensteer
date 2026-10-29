import type { Message } from "@opensteer/core";

export function newestMessageWindow(
  messagesDesc: readonly Message[],
  maxItems: number,
  maxBytes: number,
): { readonly byteCount: number; readonly items: readonly Message[] } {
  const window = boundedSerializedPrefix(messagesDesc, maxItems, maxBytes);
  const items = [...window.items].reverse();
  return { byteCount: serializedArrayBytes(items), items };
}

export function boundedSerializedPrefix<T>(
  items: readonly T[],
  maxItems: number,
  maxBytes: number,
): { readonly byteCount: number; readonly items: readonly T[] } {
  const selected: T[] = [];
  let byteCount = 2;
  for (const item of items.slice(0, maxItems)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const nextBytes = byteCount + itemBytes + (selected.length === 0 ? 0 : 1);
    if (nextBytes > maxBytes) break;
    selected.push(item);
    byteCount = nextBytes;
  }
  return { byteCount, items: selected };
}

export function serializedArrayBytes(items: readonly unknown[]): number {
  return Buffer.byteLength(JSON.stringify(items), "utf8");
}
