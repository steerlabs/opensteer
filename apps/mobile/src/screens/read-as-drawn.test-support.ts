/**
 * What a person reads in what the phone draws: the invisible marks `phoneSentence` adds (word
 * joiners, zero-width spaces at an address's joints, direction isolates) taken out of every
 * string, so a test finds a row by its words. Functions and everything else stay as they are.
 */
export function readAsDrawn<T>(value: T): T {
  if (typeof value === "string") return value.replace(/[⁠​⁨⁩]/gu, "") as T;
  if (Array.isArray(value)) return value.map(readAsDrawn) as T;
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, readAsDrawn(entry)]),
    ) as T;
  return value;
}
