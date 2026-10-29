/**
 * Unpadded base64url, strictly. Node's `Buffer.from(value, "base64url")` is
 * lenient — it accepts padding, the standard `+`/`/` alphabet, whitespace, and
 * trailing bits that no encoder would ever emit — so every caller that cared
 * about canonicality had to re-encode and compare. Here a non-canonical
 * spelling simply fails to decode, which is what a signed artifact wants: two
 * spellings of the same key must never both verify.
 *
 * Both directions are pure TypeScript so that the client packages, which run
 * on Hermes without `node:buffer`, share one implementation with the Host.
 */

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const digits = new Map([...alphabet].map((character, value) => [character, value]));

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    output += alphabet[first >> 2]!;
    output += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)]!;
    if (second !== undefined) {
      output += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]!;
    }
    if (third !== undefined) output += alphabet[third & 0x3f]!;
  }
  return output;
}

/** Throws unless `value` is the one canonical spelling of the bytes it names. */
export function decodeBase64Url(value: string): Uint8Array {
  // A final group of one character carries six bits, which cannot complete a
  // byte: no encoder produces it, so it is a malformed length, not padding.
  if (value.length % 4 === 1) {
    throw new TypeError("base64url input has an impossible length");
  }
  const bytes = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const digit = digits.get(character);
    if (digit === undefined) {
      throw new TypeError("base64url input is outside the unpadded base64url alphabet");
    }
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (accumulator >> bits) & 0xff;
      offset += 1;
    }
  }
  if ((accumulator & ((1 << bits) - 1)) !== 0) {
    throw new TypeError("base64url input has non-zero trailing bits");
  }
  return bytes;
}
