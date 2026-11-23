/**
 * A name from outside Opensteer (a connected agent's own name, the label a person typed at
 * consent, a chat's conversation, account or sender name, a task title taken from a chat's
 * message) as the Home keeps and serves it: the one cleaner, run where the name enters the Home,
 * so no answer carries it dirty and no client cleans it again.
 *
 * Line and paragraph breaks and tabs become one space; every other control and format character
 * (Unicode Cc and Cf: direction controls, zero-width characters, soft hyphens) is removed; runs of
 * space collapse; the ends are trimmed; and the name is cut at `maximum` characters, never inside
 * a character. 0053 cleans names stored before it with the same classes.
 */
export function outsideName(value: string, maximum: number): string {
  const flat = value
    .replace(/\r\n|[\n\r\t\v\f\u0085\u2028\u2029]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(flat);
  return characters.length > maximum ? characters.slice(0, maximum).join("").trimEnd() : flat;
}
