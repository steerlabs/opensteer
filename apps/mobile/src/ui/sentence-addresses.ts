import type { SentencePart } from "./sentence-parts.js";

/**
 * A sentence made elsewhere, from data, with the addresses it holds named beside it (as
 * `pluginConsentLines` names them): its words as words and each address as an address, so it is
 * drawn whole, wrapping only at its joints. An address the words do not hold, in that order, is
 * left as words.
 */
export function sentenceWith(text: string, addresses: readonly string[]): readonly SentencePart[] {
  const parts: SentencePart[] = [];
  let rest = text;
  for (const address of addresses) {
    const at = address === "" ? -1 : rest.indexOf(address);
    if (at < 0) continue;
    if (at > 0) parts.push(rest.slice(0, at));
    parts.push({ address });
    rest = rest.slice(at + address.length);
  }
  if (rest !== "") parts.push(rest);
  return parts;
}
