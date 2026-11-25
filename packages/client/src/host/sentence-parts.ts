/**
 * Sentences with values from outside Opensteer in them, as parts. The code that knows what a
 * field is says so by the part it puts it in; nothing guesses from what a string looks like:
 *
 * - plain words (`string`): Opensteer's own;
 * - `{ address }`: an address (an origin, a provider's handle), drawn by the address rule;
 * - `{ name }`: a name someone else chose (an account's or a person's display name, a channel's
 *   name), drawn as a name and never as an address, whatever it looks like.
 *
 * A name reaches a client already clean: the Home cleans every name where it enters
 * (`outsideName` in `@opensteer/shared`). An address is cleaned here (`addressText`): it comes
 * from a page or a provider, not through a name's entrance. Screens isolate each from the
 * direction of the text around it and draw a name in its own weight (the web's `SentenceText`);
 * in plain text (`plainSentence`: a label read aloud, an alert, a copy, the phone) a name stands
 * in quotation marks, so a person can tell where a name ends and Opensteer's words begin. A name
 * drawn alone (a heading, a title) has nothing to be told from and stands unquoted, everywhere.
 */
export type SentencePart = string | { readonly address: string } | { readonly name: string };

/** Join composed parts without flattening the names or addresses. */
export function joinSentenceParts(
  lines: readonly (readonly SentencePart[])[],
  separator = " · ",
): readonly SentencePart[] {
  return lines
    .filter((parts) => parts.length)
    .flatMap((parts, index) => (index ? [separator, ...parts] : parts));
}

/**
 * A name from outside as it stands in a sentence. The Home cleans every name where it enters
 * (`outsideName` in `@opensteer/shared`): no control, format or line-break character reaches a
 * client. What is left here is presentation: a double quotation mark is a single one, so a name
 * never ends the quotation it stands in.
 */
export function outsideText(value: string): string {
  return value
    .replace(/[\u201C\u201F\u301D\u301E]/gu, "\u2018")
    .replace(/[\u201D\u201E\u301F]/gu, "\u2019")
    .replace(/[\u0022\uFF02]/gu, "\u0027");
}

/**
 * An address (an origin, a host, a provider's handle) as it may be drawn: it comes from a page or
 * a provider rather than through a name's entrance, so it is cleaned here. Direction controls,
 * zero-width characters and soft hyphens are removed, and each line break is a space.
 */
export function addressText(value: string): string {
  return value
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/[\u00AD\u180E\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/gu, " ");
}

/**
 * The origin a person decides about, from URL parsing: scheme, host and port, the host in its
 * ASCII form. Userinfo and path are no part of it (`https://google.com@evil.example/` is
 * `https://evil.example`). Null for anything that is not a URL with an origin.
 */
export function siteOrigin(value: string): string | null {
  try {
    const origin = new URL(addressText(value).trim()).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** A name a person gave (a computer, a profile, an app), never drawn as an address. */
export function named(value: string): { readonly name: string } {
  return { name: value };
}

/** `Send ${code} to ${address}.`, as parts: each bare string is an address; `named(...)` is a name. */
export function sentence(
  strings: TemplateStringsArray,
  ...slots: readonly (string | { readonly name: string })[]
): readonly SentencePart[] {
  return strings.flatMap((words, index) => {
    const slot = slots[index];
    const parts: SentencePart[] = words === "" ? [] : [words];
    if (slot !== undefined) parts.push(typeof slot === "string" ? { address: slot } : slot);
    return parts;
  });
}

/**
 * A sentence from words with slots for values whose kind the caller knows, such as a copy table's
 * template: `sentenceWith((slot) => agentWords("chat.where.dm", { account: slot("account") }),
 * { account: { name: bridge.accountName } })`.
 */
export function sentenceWith(
  words: (slot: (key: string) => string) => string,
  values: Readonly<Record<string, { readonly address: string } | { readonly name: string }>>,
): readonly SentencePart[] {
  const mark = String.fromCharCode(0);
  const text = words((key) => `${mark}${key}${mark}`);
  return text.split(mark).flatMap((piece, index): SentencePart[] => {
    if (index % 2 === 0) return piece === "" ? [] : [piece];
    const value = values[piece];
    return value ? [value] : [];
  });
}

/** A name part's or an address part's text, as it is drawn. */
export function partText(part: { readonly address: string } | { readonly name: string }): string {
  return "address" in part ? addressText(part.address) : outsideText(part.name);
}

/**
 * The sentence as plain text: Opensteer's words as written, each address cleaned, each name
 * cleaned and in quotation marks (unquoted when it is the whole sentence).
 */
export function plainSentence(
  parts: readonly SentencePart[],
  { quoteNames = parts.length > 1 }: { readonly quoteNames?: boolean } = {},
): string {
  return parts
    .map((part) =>
      typeof part === "string"
        ? part
        : "address" in part || !quoteNames
          ? partText(part)
          : `“${partText(part)}”`,
    )
    .join("");
}

/**
 * The sentence as plain text for a surface that has no `<bdi>` boxes (`aria-label`, `title`,
 * push notifications): each name is cleaned, quoted and bidi-isolated (`\u2068...\u2069`), and
 * each address is cleaned and bidi-isolated, so an RTL name with digits cannot reorder surrounding
 * words.
 */
export function isolatedPlainSentence(parts: readonly SentencePart[]): string {
  const isolate = (text: string) => `\u2068${text}\u2069`;
  const quote = parts.length > 1;
  return parts
    .map((part) =>
      typeof part === "string"
        ? part
        : "address" in part || !quote
          ? isolate(partText(part))
          : `“${isolate(partText(part))}”`,
    )
    .join("");
}

/**
 * The sentence as the phone draws it, where text has no boxes: the one place every phone sentence
 * with a name or an address goes through. An address breaks only at its joints and is never
 * hyphenated (a word joiner between each two of a part's characters, a zero-width space at each
 * joint); each name and address is isolated from the direction of the text around it; a name
 * stands in quotation marks unless it is the whole sentence. Its words are the same as
 * `plainSentence`'s; what it adds is invisible, so it is for drawing, never for a copy.
 */
export function phoneSentence(
  parts: readonly SentencePart[],
  { quoteNames = parts.length > 1 }: { readonly quoteNames?: boolean } = {},
): string {
  const isolate = (text: string) => `\u2068${text}\u2069`;
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if ("name" in part)
        return quoteNames ? `“${isolate(partText(part))}”` : isolate(partText(part));
      return isolate(
        addressParts(partText(part))
          .map((piece) => Array.from(piece).join("\u2060"))
          .join("\u200B"),
      );
    })
    .join("");
}

/**
 * The parts an address wraps at; joined, they are the address. A line may break after "@",
 * before a dot, before a single "/", "?" or "#", and after "&", "=" or a scheme's "//". Never
 * after a hyphen the address has, and never inside a part.
 */
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
    if (character === "." || character === "?" || character === "#" || singleSlash) end();
    part += character;
    const schemeSlashes = character === "/" && before === "/" && after !== "/";
    if (character === "@" || character === "&" || character === "=" || schemeSlashes) end();
  });
  end();
  return parts;
}
