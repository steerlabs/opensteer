/**
 * A sentence a client draws, made where it is said: Opensteer's own words, and slots that are an
 * address or a name, each known as what it is from the start. A client draws an address as an
 * address and a name as words; nothing ever searches the finished words for either.
 *
 *   said`Chrome isn’t signed in to ${address(domain)}`
 *   said`Sharing ${address(domain)} is stopped in ${named(chrome)}`
 */
export type SaidPart = string | { readonly address: string } | { readonly name: string };

export interface Said {
  /** The sentence as written: what a screen reader hears and a client without parts draws. */
  readonly text: string;
  readonly parts: readonly SaidPart[];
}

/** A slot holding an email address, a host or a URL. */
export function address(value: string): { readonly address: string } {
  return { address: value };
}

/** A slot holding a name someone else chose: drawn as words, never as an address. */
export function named(value: string): { readonly name: string } {
  return { name: value };
}

export function said(
  words: TemplateStringsArray,
  ...slots: readonly ({ readonly address: string } | { readonly name: string })[]
): Said {
  const parts: SaidPart[] = [];
  words.forEach((word, index) => {
    if (word !== "") parts.push(word);
    const slot = slots[index];
    if (slot !== undefined) parts.push(slot);
  });
  return { parts, text: parts.map(saidWords).join("") };
}

/** A part as plain words. */
export function saidWords(part: SaidPart): string {
  return typeof part === "string" ? part : "address" in part ? part.address : part.name;
}
