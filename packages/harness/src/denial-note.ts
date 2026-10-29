import { utf8ByteLength } from "@opensteer/core";

/**
 * The note a person attached to a denial, on its way to the engine. The
 * Request schema bounds the note in bytes, and so does this: a note of 20 000
 * astral characters is 80 000 bytes on the wire, so measuring UTF-16 units
 * would let four times the agreed payload through. A note that is only
 * whitespace is no note at all.
 *
 * The caller supplies the error because an over-long note is that driver's own
 * "this response does not match the pending Request" refusal, not a new kind
 * of failure this helper gets to invent.
 */
export function boundedDenialNote(
  value: string | undefined,
  options: { readonly maximumBytes: number; readonly tooLong: () => Error },
): string | undefined {
  if (value === undefined) return undefined;
  if (utf8ByteLength(value) > options.maximumBytes) throw options.tooLong();
  return value.trim() || undefined;
}
