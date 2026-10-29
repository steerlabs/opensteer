import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import type { PasskeyAssertedOutcome, PasskeyCreatedOutcome } from "./authenticator.js";
export * from "./options.js";

export const opensteerAaguid = "dd9443d6-4875-44f3-a68d-5d17076af9c5";
export const passkeyFlags = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;
/** Bits 1 and 5 of the flags byte are reserved for future use. */
const reservedFlags = 0x22;
/** SecurityError is a page error name, not a DOM dependency. */
export function resolveRpId(
  origin: string,
  requestedRpId?: string,
): { rpId: string } | { error: "SecurityError" } {
  const failure = { error: "SecurityError" } as const;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (
      host.length > 253 ||
      url.protocol !== "https:" ||
      url.origin !== origin ||
      host.endsWith(".") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      !/^[a-z0-9.-]+$/u.test(host) ||
      !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    )
      return failure;
    const site = new URL(browserSiteFromUrl(origin)).hostname;
    // source-state is the shared PSL authority, including private suffixes. IPs
    // are valid password sites but are deliberately outside this authenticator.
    if (/^[0-9.]+$/u.test(host) || site === "localhost") return failure;
    if (requestedRpId !== undefined && /[\s%/:@?#\\]/u.test(requestedRpId)) return failure;
    const rpId = requestedRpId === undefined ? host : domainToASCII(requestedRpId);
    if (
      !rpId ||
      rpId.endsWith(".") ||
      !rpId.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    )
      return failure;
    if (
      rpId !== host &&
      (!host.endsWith(`.${rpId}`) || (rpId !== site && !rpId.endsWith(`.${site}`)))
    )
      return failure;
    // An exact public suffix must be refused too.
    browserSiteFromUrl(`https://${rpId}`);
    return { rpId };
  } catch {
    return failure;
  }
}
/** CCDToString, L3 §5.8.1.1: control characters use lowercase Unicode escapes. */
function ccdString(value: string): string {
  return (
    '"' +
    [...value]
      .map((c) => {
        if (c === '"') return '\\"';
        if (c === "\\") return "\\\\";
        const code = c.codePointAt(0)!;
        return code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : c;
      })
      .join("") +
    '"'
  );
}
export function serializeClientData(input: {
  type: "webauthn.create" | "webauthn.get";
  challenge: string;
  origin: string;
}): Uint8Array {
  return Buffer.from(
    `{"type":${ccdString(input.type)},"challenge":${ccdString(input.challenge)},"origin":${ccdString(input.origin)},"crossOrigin":false}`,
    "utf8",
  );
}
export type PasskeyCborValue =
  number | string | Uint8Array | ReadonlyMap<number | string, PasskeyCborValue>;
/** Small CTAP2 canonical encoder: integers, UTF-8, bytes and maps only. */
export function encodePasskeyCbor(value: PasskeyCborValue): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
      throw new RangeError("CBOR length/integer out of range");
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(n < 65536 ? 3 : 5);
    b[0] = (major << 5) | (n < 65536 ? 25 : 26);
    if (n < 65536) b.writeUInt16BE(n, 1);
    else b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === "number") return head(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === "string") {
    const b = Buffer.from(value);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const entries = [...value]
    .map(([k, v]) => [encodePasskeyCbor(k), encodePasskeyCbor(v)] as const)
    // CTAP2 canonical order: major type, then encoded length, then bytes.
    .sort(([a], [b]) => (a[0]! >> 5) - (b[0]! >> 5) || a.length - b.length || Buffer.compare(a, b));
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [k, v])]);
}
export function encodeCoseP256Key(x: Uint8Array, y: Uint8Array): Buffer {
  if (x.length !== 32 || y.length !== 32)
    throw new RangeError("P-256 coordinates must be 32 bytes");
  return encodePasskeyCbor(
    new Map<number, PasskeyCborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}
export function buildAuthenticatorData(input: {
  rpId: string;
  flags: number;
  signCount: 0;
  attested?: { credentialId: Uint8Array; publicKey: Uint8Array };
}): Buffer {
  const { flags, attested } = input;
  if (
    !Number.isInteger(flags) ||
    flags < 0 ||
    flags > 255 ||
    flags & reservedFlags ||
    flags & passkeyFlags.ED ||
    Boolean(flags & passkeyFlags.AT) !== Boolean(attested) ||
    (flags & passkeyFlags.BS && !(flags & passkeyFlags.BE)) ||
    input.signCount !== 0
  )
    throw new TypeError("Unsupported authenticator flags/counter");
  const prefix = Buffer.concat([
    createHash("sha256").update(input.rpId).digest(),
    Buffer.from([flags]),
    Buffer.alloc(4),
  ]);
  if (!attested) return prefix;
  if (attested.credentialId.length < 1 || attested.credentialId.length > 1023)
    throw new RangeError("Invalid credential ID");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(attested.credentialId.length);
  return Buffer.concat([
    prefix,
    Buffer.from(opensteerAaguid.replaceAll("-", ""), "hex"),
    length,
    attested.credentialId,
    attested.publicKey,
  ]);
}
export function buildNoneAttestationObject(authData: Uint8Array): Buffer {
  return encodePasskeyCbor(
    new Map<string, PasskeyCborValue>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
}
const credentialBase = (
  outcome: PasskeyCreatedOutcome | PasskeyAssertedOutcome,
  clientExtensionResults: Record<string, unknown>,
) => ({
  id: encodeBase64Url(outcome.credentialId),
  rawId: encodeBase64Url(outcome.credentialId),
  type: "public-key" as const,
  ...(outcome.authenticatorAttachment === null
    ? {}
    : { authenticatorAttachment: outcome.authenticatorAttachment }),
  clientExtensionResults,
});
/** The page's `toJSON()` of a created credential; `credProps` is the client's own output. */
export function buildRegistrationResponseJSON(
  outcome: PasskeyCreatedOutcome,
  requested: { credProps: boolean },
) {
  return {
    ...credentialBase(
      outcome,
      requested.credProps
        ? { credProps: outcome.discoverable === null ? {} : { rk: outcome.discoverable } }
        : {},
    ),
    response: {
      clientDataJSON: encodeBase64Url(outcome.clientDataJSON),
      attestationObject: encodeBase64Url(outcome.attestationObject),
      authenticatorData: encodeBase64Url(outcome.authenticatorData),
      ...(outcome.publicKey === null ? {} : { publicKey: encodeBase64Url(outcome.publicKey) }),
      publicKeyAlgorithm: outcome.publicKeyAlgorithm,
      transports: [...outcome.transports],
    },
  };
}
/** The page's `toJSON()` of an assertion; an absent user handle is omitted, never null. */
export function buildAuthenticationResponseJSON(outcome: PasskeyAssertedOutcome) {
  return {
    ...credentialBase(outcome, {}),
    response: {
      clientDataJSON: encodeBase64Url(outcome.clientDataJSON),
      authenticatorData: encodeBase64Url(outcome.authenticatorData),
      signature: encodeBase64Url(outcome.signature),
      ...(outcome.userHandle === null ? {} : { userHandle: encodeBase64Url(outcome.userHandle) }),
    },
  };
}

export * from "./authenticator.js";
