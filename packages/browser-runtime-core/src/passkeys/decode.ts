import { createPublicKey, type webcrypto } from "node:crypto";

import { passkeyFlags } from "./flags.js";

export type DecodedPasskeyCbor =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | DecodedPasskeyCbor[]
  | Map<number | string, DecodedPasskeyCbor>;
const maxBytes = 1_048_576;

/** CTAP2 canonical, definite-length CBOR. Limits apply before allocating or descending. */
function readCbor(bytes: Uint8Array, start = 0): { value: DecodedPasskeyCbor; end: number } {
  if (bytes.length > maxBytes) throw new RangeError("CBOR exceeds byte limit");
  let offset = start;
  let budget = 4096;
  const take = (length: number) => {
    if (length > bytes.length - offset) throw new RangeError("Truncated CBOR");
    const result = bytes.subarray(offset, offset + length);
    offset += length;
    return result;
  };
  const read = (depth: number): DecodedPasskeyCbor => {
    if (depth > 16 || --budget < 0) throw new RangeError("CBOR exceeds structural limit");
    const first = take(1)[0]!;
    const major = first >> 5;
    const additional = first & 31;
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      throw new TypeError("Unsupported CBOR simple value");
    }
    if (major > 5 || additional > 27) throw new TypeError("Unsupported CBOR encoding");
    let n = additional;
    if (additional >= 24) {
      n = 0;
      for (const byte of take(2 ** (additional - 24))) n = n * 256 + byte;
      if (!Number.isSafeInteger(n)) throw new RangeError("CBOR integer exceeds safe range");
      if (n < [24, 256, 65_536, 4_294_967_296][additional - 24]!)
        throw new TypeError("CBOR requires the shortest integer/length encoding");
    }
    if (major === 0) return n;
    if (major === 1) {
      if (!Number.isSafeInteger(-1 - n)) throw new RangeError("CBOR integer exceeds safe range");
      return -1 - n;
    }
    if (major === 2) return take(n).slice();
    if (major === 3) return new TextDecoder("utf-8", { fatal: true }).decode(take(n));
    if (n > 1024 || n * (major === 5 ? 2 : 1) > budget)
      throw new RangeError("CBOR container exceeds limit");
    if (major === 4) return Array.from({ length: n }, () => read(depth + 1));
    const map = new Map<number | string, DecodedPasskeyCbor>();
    let previousKey: Uint8Array | undefined;
    for (let i = 0; i < n; i++) {
      const keyStart = offset;
      const key = read(depth + 1);
      const encodedKey = bytes.subarray(keyStart, offset);
      if ((typeof key !== "string" && typeof key !== "number") || map.has(key))
        throw new TypeError("Invalid or duplicate CBOR map key");
      if (previousKey) {
        const order =
          (previousKey[0]! >> 5) - (encodedKey[0]! >> 5) ||
          previousKey.length - encodedKey.length ||
          Buffer.compare(previousKey, encodedKey);
        if (order >= 0) throw new TypeError("CBOR map keys are not in CTAP2 canonical order");
      }
      previousKey = encodedKey;
      map.set(key, read(depth + 1));
    }
    return map;
  };
  return { value: read(0), end: offset };
}

export function decodePasskeyCbor(bytes: Uint8Array): DecodedPasskeyCbor {
  const { value, end } = readCbor(bytes);
  if (end !== bytes.length) throw new TypeError("Trailing CBOR data");
  return value;
}

function keyMap(value: DecodedPasskeyCbor): Map<number | string, DecodedPasskeyCbor> {
  if (!(value instanceof Map)) throw new TypeError("Expected CBOR map");
  return value;
}

/** Supported COSE signing keys only; unknown algorithms have no SPKI projection. */
export function coseKeyToSpki(value: DecodedPasskeyCbor): Uint8Array | null {
  const key = keyMap(value);
  const alg = key.get(3);
  const bytes = (label: number, length?: number) => {
    const b = key.get(label);
    if (
      !(b instanceof Uint8Array) ||
      b.length === 0 ||
      b.length > 1024 ||
      (length !== undefined && b.length !== length)
    )
      throw new TypeError("Invalid COSE key bytes");
    return Buffer.from(b).toString("base64url");
  };
  let jwk: webcrypto.JsonWebKey;
  if (alg === -7 || alg === -35 || alg === -36) {
    const [crv, id, length] =
      alg === -7
        ? (["P-256", 1, 32] as const)
        : alg === -35
          ? (["P-384", 2, 48] as const)
          : (["P-521", 3, 66] as const);
    if (key.get(1) !== 2 || key.get(-1) !== id)
      throw new TypeError("COSE curve/algorithm mismatch");
    jwk = { kty: "EC", crv, x: bytes(-2, length), y: bytes(-3, length) };
  } else if (alg === -8) {
    const crv = key.get(-1);
    if (key.get(1) !== 1 || (crv !== 6 && crv !== 7)) throw new TypeError("Invalid COSE OKP curve");
    jwk = { kty: "OKP", crv: crv === 6 ? "Ed25519" : "Ed448", x: bytes(-2, crv === 6 ? 32 : 57) };
  } else if (typeof alg === "number" && [-257, -258, -259, -37, -38, -39].includes(alg)) {
    if (key.get(1) !== 3) throw new TypeError("Invalid COSE RSA key");
    jwk = { kty: "RSA", n: bytes(-1), e: bytes(-2) };
  } else return null;
  return createPublicKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "spki" });
}

/** Extracts projections without rewriting the authenticator's flags or counters. */
export function decodePasskeyRegistration(
  attestation: Uint8Array,
  credentialId: Uint8Array,
): {
  authenticatorData: Uint8Array;
  publicKey: Uint8Array | null;
  publicKeyAlgorithm: number;
} {
  const object = keyMap(decodePasskeyCbor(attestation));
  const authenticatorData = object.get("authData");
  if (
    !(authenticatorData instanceof Uint8Array) ||
    authenticatorData.length < 55 ||
    !(authenticatorData[32]! & passkeyFlags.AT)
  )
    throw new TypeError("Missing attested credential data");
  const length = authenticatorData[53]! * 256 + authenticatorData[54]!;
  const end = 55 + length;
  if (
    length < 1 ||
    length > 1023 ||
    end >= authenticatorData.length ||
    !Buffer.from(authenticatorData.subarray(55, end)).equals(credentialId)
  )
    throw new TypeError("Attested credential ID mismatch");
  const decoded = readCbor(authenticatorData, end);
  const key = keyMap(decoded.value);
  const publicKeyAlgorithm = key.get(3);
  if (
    typeof publicKeyAlgorithm !== "number" ||
    !Number.isInteger(publicKeyAlgorithm) ||
    publicKeyAlgorithm < -2147483648 ||
    publicKeyAlgorithm > 2147483647
  )
    throw new TypeError("Invalid COSE algorithm");
  let consumed = decoded.end;
  if (authenticatorData[32]! & passkeyFlags.ED) {
    const extensions = readCbor(authenticatorData, consumed);
    keyMap(extensions.value);
    consumed = extensions.end;
  }
  if (consumed !== authenticatorData.length) throw new TypeError("Trailing authenticator data");
  return { authenticatorData, publicKey: coseKeyToSpki(key), publicKeyAlgorithm };
}
