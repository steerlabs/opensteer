/**
 * The characters an email address, a host or a URL is drawn with, so it never takes a hyphen it
 * does not have and wraps only at its own joints. Why, and the rules: `address-text.tsx`.
 */

/** U+2060 WORD JOINER: no line break here, so no hyphen either. */
const joiner = "\u2060";
/** U+200B ZERO WIDTH SPACE: a line may break here, and nothing is drawn. */
const opportunity = "\u200B";
// Characters that belong to the one before them: no joiner may come between.
const attached = /^(?:\p{M}|\u200D|[\uFE00-\uFE0F])$/u;

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

/** The address as the phone draws it: held together inside each part, breakable between. */
export function addressWords(value: string): string {
  return addressParts(value).map(holdTogether).join(opportunity);
}

/** The address as a person reads and copies it, from what `addressWords` drew. */
export function addressValue(drawn: string): string {
  return drawn.replace(/[\u2060\u200B]/gu, "");
}

function holdTogether(part: string): string {
  const characters = Array.from(part);
  return characters
    .map((character, index) => {
      const previous = characters[index - 1];
      const join = index > 0 && !attached.test(character) && previous !== "\u200D";
      return join ? joiner + character : character;
    })
    .join("");
}
