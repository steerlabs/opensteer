import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

describe("base64url", () => {
  it("matches Node's unpadded base64url in both directions", () => {
    for (let length = 0; length <= 64; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length) & 0xff);
      const expected = Buffer.from(bytes).toString("base64url");

      expect(encodeBase64Url(bytes)).toBe(expected);
      expect(decodeBase64Url(expected)).toEqual(bytes);
    }
  });

  it("refuses every spelling Node would silently accept", () => {
    // Padding, the standard alphabet, and whitespace all decode under
    // `Buffer.from(value, "base64url")`, which is how a second spelling of a
    // signed key would otherwise fingerprint as the first.
    for (const value of ["AAAA=", "AA==", "++++", "////", "AA AA", "AAAA\n", "AAA*"]) {
      expect(() => decodeBase64Url(value)).toThrow(TypeError);
    }
  });

  it("refuses lengths and trailing bits no encoder produces", () => {
    // A trailing group of one character cannot complete a byte.
    expect(() => decodeBase64Url("AAAAA")).toThrow("impossible length");
    // "AB" holds four spare bits, and "AAB" two; both must be zero.
    expect(() => decodeBase64Url("AB")).toThrow("non-zero trailing bits");
    expect(() => decodeBase64Url("AAB")).toThrow("non-zero trailing bits");
    expect(decodeBase64Url("AQ")).toEqual(Uint8Array.of(0x01));
    expect(decodeBase64Url("AAE")).toEqual(Uint8Array.of(0x00, 0x01));
  });
});
