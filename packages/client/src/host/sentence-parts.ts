/**
 * Addresses inside sentences, as parts. The code that knows a value is an address says so by
 * putting it in a part of its own; nothing guesses what an address is inside a sentence. Screens
 * draw an address part with their address rule (the web's `Address`), and everything that is not
 * drawn (a screen reader, an alert, a copy, the phone for now) takes `plainSentence`: the sentence
 * exactly as written. Taken from the first-run branch's phone files (`sentence-parts.ts`,
 * `address-words.ts`), with one change: a dot's joint is before the dot, so a line never ends in
 * a dot that reads as a full stop.
 */
export type SentencePart = string | { readonly address: string };

/** `Send ${code} to ${address}.`, as parts: each interpolated value is an address. */
export function sentence(
  strings: TemplateStringsArray,
  ...addresses: readonly string[]
): readonly SentencePart[] {
  return strings.flatMap((words, index) => {
    const address = addresses[index];
    const parts: SentencePart[] = words === "" ? [] : [words];
    if (address !== undefined) parts.push({ address });
    return parts;
  });
}

/**
 * A sentence from words with one slot for a value that may be an address, such as a copy
 * table's template: `sentenceAround((slot) => agentWords("chat.where.dm", { account: slot }),
 * account)`. The value is an address part only when it is one (`isAddress`); otherwise the
 * sentence is plain words.
 */
export function sentenceAround(
  words: (slot: string) => string,
  value: string,
): readonly SentencePart[] {
  if (!isAddress(value)) return [words(value)];
  const slot = String.fromCharCode(0);
  const [before = "", after = ""] = words(slot).split(slot);
  return [...(before === "" ? [] : [before]), { address: value }, ...(after === "" ? [] : [after])];
}

/** The sentence as a person reads it aloud, copies it or sees it in an alert. */
export function plainSentence(parts: readonly SentencePart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.address)).join("");
}

/**
 * Whether a value is an address: an origin or a URL (`scheme:`), an email address, or a host (an
 * IP address, `localhost`, or a name with a dot). A sentence or a name is not: nothing with a
 * space in it is. The one place the apps decide this, for a value already known to stand alone.
 */
export function isAddress(value: string): boolean {
  if (value === "" || /\s/u.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return true;
  if (/^[^@]+@[^@]+$/u.test(value)) return true;
  if (/^\[?[0-9a-f:.]+\]?(?::\d+)?$/iu.test(value) && /[.:]/u.test(value)) return true;
  return value === "localhost" || /^[^.]+(\.[^.]+)+\.?(?::\d+)?$/u.test(value);
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
