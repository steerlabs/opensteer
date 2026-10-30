import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import {
  buildAuthenticatorData,
  buildNoneAttestationObject,
  encodeCoseP256Key,
  encodePasskeyCbor,
  passkeyFlags,
} from "./index.js";
import {
  coseKeyToSpki,
  decodePasskeyCbor,
  decodePasskeyRegistration,
  type DecodedPasskeyCbor,
} from "./decode.js";

const x = Buffer.from("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", "hex");
const y = Buffer.from("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", "hex");
const cose = encodeCoseP256Key(x, y);

test("decodes the core encoder and definite arrays, preserving bytes and map keys", () => {
  const value = new Map<string, import("./index.js").PasskeyCborValue>([
    ["bytes", x],
    ["nested", new Map([[1, -257]])],
  ]);
  expect(decodePasskeyCbor(encodePasskeyCbor(value))).toEqual(value);
  expect(decodePasskeyCbor(Buffer.from("83016161820203", "hex"))).toEqual([1, "a", [2, 3]]);
  expect(decodePasskeyCbor(Buffer.from("1b001fffffffffffff", "hex"))).toBe(Number.MAX_SAFE_INTEGER);
});

test.each([
  "",
  "1800ff",
  "5affffffff",
  "9affffffff",
  "a201010102",
  "7f",
  "d80100",
  "fa00000000",
  "61ff",
  "1b0020000000000000",
  "a1810001",
])("rejects malformed or unsupported CBOR %s", (hex) => {
  expect(() => decodePasskeyCbor(Buffer.from(hex, "hex"))).toThrow();
});

test("bounds byte length, nesting and total values before allocating containers", () => {
  expect(() => decodePasskeyCbor(Buffer.alloc(1_048_577))).toThrow();
  expect(() => decodePasskeyCbor(Buffer.from([...Array(18).fill(0x81), 0]))).toThrow();
  expect(() =>
    decodePasskeyCbor(Buffer.concat([Buffer.from([0x99, 0x20, 0]), Buffer.alloc(8192)])),
  ).toThrow();
});

test("converts the P-256 base point and RFC 8032 Ed25519 public key to known SPKI vectors", () => {
  const ec = coseKeyToSpki(decodePasskeyCbor(cose));
  expect(Buffer.from(ec!).toString("hex")).toBe(
    `3059301306072a8648ce3d020106082a8648ce3d03010703420004${x.toString("hex")}${y.toString("hex")}`,
  );
  const ed = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
  expect(
    Buffer.from(
      coseKeyToSpki(
        new Map<number, DecodedPasskeyCbor>([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, ed],
        ]),
      )!,
    ).toString("hex"),
  ).toBe(`302a300506032b6570032100${ed.toString("hex")}`);
});

test("exports supported RSA, EC2 and OKP algorithms and leaves unknown algorithms null", () => {
  for (const [curve, crv, alg, size] of [
    ["P-256", 1, -7, 32],
    ["P-384", 2, -35, 48],
    ["P-521", 3, -36, 66],
  ] as const) {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
    const jwk = publicKey.export({ format: "jwk" });
    expect(Buffer.from(jwk.x!, "base64url")).toHaveLength(size);
    const mapped = coseKeyToSpki(
      new Map<number, DecodedPasskeyCbor>([
        [1, 2],
        [3, alg],
        [-1, crv],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    expect(mapped).toEqual(publicKey.export({ format: "der", type: "spki" }));
  }
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const jwk = publicKey.export({ format: "jwk" });
  for (const alg of [-257, -258, -259, -37, -38, -39]) {
    expect(
      coseKeyToSpki(
        new Map<number, DecodedPasskeyCbor>([
          [1, 3],
          [3, alg],
          [-1, Buffer.from(jwk.n!, "base64url")],
          [-2, Buffer.from(jwk.e!, "base64url")],
        ]),
      ),
    ).toEqual(publicKey.export({ format: "der", type: "spki" }));
  }
  expect(
    coseKeyToSpki(
      new Map<number, DecodedPasskeyCbor>([
        [1, 2],
        [3, -999],
      ]),
    ),
  ).toBeNull();
  expect(() =>
    coseKeyToSpki(
      new Map<number, DecodedPasskeyCbor>([
        [1, 2],
        [3, -7],
        [-1, 2],
        [-2, x],
        [-3, y],
      ]),
    ),
  ).toThrow();
});

test("extracts native attestation bytes and refuses truncated, substituted or trailing data", () => {
  const credentialId = Buffer.from([1, 2, 3]);
  const auth = buildAuthenticatorData({
    rpId: "example.com",
    flags: passkeyFlags.UP | passkeyFlags.AT,
    signCount: 0,
    attested: { credentialId, publicKey: cose },
  });
  auth.writeUInt32BE(42, 33);
  const decoded = decodePasskeyRegistration(buildNoneAttestationObject(auth), credentialId);
  expect(decoded.authenticatorData).toEqual(auth);
  expect(decoded.publicKeyAlgorithm).toBe(-7);
  expect(
    createPublicKey({ key: Buffer.from(decoded.publicKey!), format: "der", type: "spki" })
      .asymmetricKeyType,
  ).toBe("ec");
  for (const bytes of [auth.subarray(0, 54), Buffer.concat([auth, Buffer.from([0])])])
    expect(() =>
      decodePasskeyRegistration(buildNoneAttestationObject(bytes), credentialId),
    ).toThrow();
  expect(() =>
    decodePasskeyRegistration(buildNoneAttestationObject(auth), Buffer.from([4])),
  ).toThrow();
  auth[32] = passkeyFlags.UP;
  expect(() => decodePasskeyRegistration(buildNoneAttestationObject(auth), credentialId)).toThrow();
});

test.each([
  ["integer", "1800"],
  ["byte-string length", "580101"],
  ["map key order", "a202000100"],
  ["negative integer", "3800"],
  ["16-bit integer", "190018"],
  ["32-bit integer", "1a00000100"],
  ["64-bit integer", "1b0000000000010000"],
  ["text length", "780161"],
  ["array length", "980100"],
  ["map length", "b800"],
  ["map key major type", "a220000100"],
  ["map key encoded length", "a26161006000"],
  ["text map key byte order", "a2616200616100"],
  ["nested map order", "81a202000100"],
])("rejects non-canonical %s in isolation", (_kind, hex) => {
  expect(() => decodePasskeyCbor(Buffer.from(hex, "hex"))).toThrow(/canonical|shortest/u);
});

test("round trips every core-encoder value family and supported head width within decoder limits", () => {
  type Value = import("./index.js").PasskeyCborValue;
  const values: Value[] = [
    cose,
    new Map(),
    new Map<number | string, Value>([
      ["b", "last"],
      [-25, 0],
      [24, 1],
      [-1, "negative"],
      [1, "unsigned"],
      ["", new Map([["nested", "é🙂"]])],
    ]),
  ];
  for (const n of [0, 1, 23, 24, 255, 256, 65_535, 65_536, 0xffffffff]) values.push(n, -1 - n);
  for (const length of [0, 1, 23, 24, 255, 256, 65_535, 65_536])
    values.push(Buffer.alloc(length, 0x55), "a".repeat(length));
  for (const length of [1, 23, 24, 255, 256])
    values.push(new Map(Array.from({ length }, (_, i) => [length - i, i])));
  for (const value of values) {
    const encoded = encodePasskeyCbor(value);
    const decoded = decodePasskeyCbor(encoded);
    if (value instanceof Uint8Array)
      expect(decoded instanceof Uint8Array && Buffer.from(decoded).equals(value)).toBe(true);
    else expect(decoded).toEqual(value);
    expect(encodePasskeyCbor(decoded as Value).equals(encoded)).toBe(true);
  }
});
