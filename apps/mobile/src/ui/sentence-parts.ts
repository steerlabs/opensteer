import { isAddress } from "./address-words.js";

/**
 * A sentence that holds an address, as parts: its words, and the address as a part of its own.
 * Models build one of these and never a decorated string; `AddressSentence` (`address-text.tsx`)
 * draws the address part as an address, and everything that is not drawn (a screen reader, an
 * announcement, an alert, a copy) takes `plainSentence`, the sentence exactly as written.
 */
export type SentencePart = string | { readonly address: string };

/** `Your agent will be able to use ${address} as you.`, as parts. */
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
 * A sentence from words with one slot for an address, such as a copy table's template:
 * `sentenceAround((slot) => workWords("work.header", { origin: slot }), origin)`.
 */
export function sentenceAround(
  words: (slot: string) => string,
  address: string,
): readonly SentencePart[] {
  const slot = String.fromCharCode(0);
  const [before = "", after = ""] = words(slot).split(slot);
  return [...(before === "" ? [] : [before]), { address }, ...(after === "" ? [] : [after])];
}

/**
 * A native row's detail that may be an address: the row draws it as one only when it is one
 * (`isAddress`), and words as words.
 */
export function addressDetail(value: string): {
  readonly detail: string;
  readonly addressIn?: "detail";
} {
  return isAddress(value) ? { addressIn: "detail", detail: value } : { detail: value };
}

/** The sentence as a person reads it aloud, copies it or sees it in an alert. */
export function plainSentence(parts: readonly SentencePart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.address)).join("");
}
