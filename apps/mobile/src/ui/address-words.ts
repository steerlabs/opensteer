import { splitGraphemes } from "@opensteer/client/editing";

/**
 * The characters an email address, a host or a URL is drawn with, so it never takes a hyphen it
 * does not have and wraps only at its own joints. Why, and the rules: `address-text.tsx`.
 *
 * Only the components that draw an address call `addressWords` (`tests/mobile-address-text.test.ts`
 * holds the list). Everything else carries the plain value, so what is selected, copied, read
 * aloud or put in an alert is the address exactly.
 */

/** U+2060 WORD JOINER: no line break here, so no hyphen either. */
const joiner = "\u2060";
/** U+200B ZERO WIDTH SPACE: a line may break here, and nothing is drawn. */
const opportunity = "\u200B";

/**
 * Whether a value is an address: an origin or a URL (`scheme:`), an email address, or a host (an
 * IP address, `localhost`, or a name with a dot). A sentence or a name is not: nothing with a
 * space in it is. The one place the app decides this.
 */
export function isAddress(value: string): boolean {
  if (value === "" || /\s/u.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return true;
  if (/^[^@]+@[^@]+$/u.test(value)) return true;
  if (/^\[?[0-9a-f:.]+\]?(?::\d+)?$/iu.test(value) && /[.:]/u.test(value)) return true;
  return value === "localhost" || /^[^.]+(\.[^.]+)+\.?(?::\d+)?$/u.test(value);
}

/** The parts an address wraps at, each ending at its joint; joined, they are the address. */
export function addressParts(value: string): readonly string[] {
  const characters = Array.from(value);
  const parts: string[] = [];
  let part = "";
  const end = () => {
    if (part !== "") parts.push(part);
    part = "";
  };
  characters.forEach((character, index) => {
    const before = characters[index - 1];
    const after = characters[index + 1];
    const singleSlash = character === "/" && before !== "/" && after !== "/";
    if (character === "?" || character === "#" || singleSlash) end();
    part += character;
    const schemeSlashes = character === "/" && before === "/" && after !== "/";
    if (
      character === "@" ||
      character === "." ||
      character === "&" ||
      character === "=" ||
      schemeSlashes
    )
      end();
  });
  end();
  return parts;
}

/**
 * The address as the phone draws it: held together inside each part, breakable between. A value
 * that is not an address (`isAddress`) is a mistake by the caller: under test it throws, and in
 * the app it is drawn as it is, as words.
 */
export function addressWords(value: string): string {
  if (!isAddress(value)) {
    if (underTest()) throw new Error(`Not an address, so not drawn as one: "${value}"`);
    return value;
  }
  return addressParts(value).map(holdTogether).join(opportunity);
}

/** The address as a person reads and copies it, from what `addressWords` drew. */
export function addressValue(drawn: string): string {
  return drawn.replace(/[\u2060\u200B]/gu, "");
}

/** A joiner between every two characters a person sees, never inside one. */
function holdTogether(part: string): string {
  return Array.from(splitGraphemes(part)).join(joiner);
}

function underTest(): boolean {
  const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return environment?.["VITEST"] !== undefined;
}
