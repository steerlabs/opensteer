import { isRecord } from "@opensteer/shared/isRecord";

/**
 * The same JSON value as PostgreSQL can store it. jsonb refuses half of a
 * surrogate pair and U+0000 in any text, keys included: the one is made
 * well-formed and the other becomes U+FFFD, as in tool output.
 */
export function storableJson<Value>(value: Value): Value {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "string") return storableText(item);
      if (!isRecord(item)) return item;
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [storableText(key), entry]),
      );
    }),
  ) as Value;
}
export function storableText(text: string): string {
  return text.toWellFormed().replaceAll("\u0000", "\uFFFD");
}
