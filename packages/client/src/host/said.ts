/**
 * A sentence a client draws, as parts: Opensteer's own words, an address (an email address, a
 * host or a URL), or a name supplied from outside Opensteer, drawn as words and never treated as
 * an address. Each part is what it was made as; nothing searches finished words for either.
 *
 *   sentence`Chrome isn’t signed in to ${domain}`
 *   sentence`Sharing ${domain} is stopped in ${named(chrome)}`
 *
 * Shaped as the shared sentence module the messaging branch moves into `packages/client`
 * (`SentencePart`, `sentence`, `plainSentence`), with the name its third kind; when that lands
 * this file goes and its importers import that module instead.
 */
export type SentencePart = string | { readonly address: string } | { readonly name: string };

/** A slot holding a name someone else chose: drawn as words, never as an address. */
export function named(value: string): { readonly name: string } {
  return { name: value };
}

/** Words and slots, as parts: a slot that is a string is an address; `named` makes a name. */
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

/** The sentence as a person reads it aloud, copies it or sees it in an alert. */
export function plainSentence(parts: readonly SentencePart[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : "address" in part ? part.address : part.name))
    .join("");
}
