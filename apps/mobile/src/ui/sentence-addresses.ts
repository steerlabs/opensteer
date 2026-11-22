import type { SaidPart } from "@opensteer/client/host";
import type { SentencePart } from "./sentence-parts.js";

/**
 * A sentence made where it was said (`said` in `@opensteer/client/host`): Opensteer's words as
 * words, each address as an address, and a name someone chose as words, never as an address.
 * Nothing here searches finished words for an address: each part is what it was made as.
 */
export function sentenceOf(parts: readonly SaidPart[]): readonly SentencePart[] {
  return parts.map((part) =>
    typeof part === "string" ? part : "address" in part ? { address: part.address } : part.name,
  );
}
