import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  createHash,
} from "node:crypto";

export interface OAuthBrokerEphemeralKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface OAuthBrokerSealedValue {
  readonly ciphertext: string;
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly tag: string;
  readonly version: 1;
}

const sealingPurpose = "opensteer-oauth-broker-sealed-payload-v1";

export function generateOAuthBrokerEphemeralKeyPair(): OAuthBrokerEphemeralKeyPair {
  const pair = generateKeyPairSync("x25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  if (typeof publicJwk.x !== "string") throw new Error("X25519 public key export failed");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: publicJwk.x,
  };
}

export function sealOAuthBrokerPayload(
  value: unknown,
  recipientPublicKey: string,
  authenticatedContext: unknown,
): OAuthBrokerSealedValue {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralJwk = ephemeral.publicKey.export({ format: "jwk" });
  if (typeof ephemeralJwk.x !== "string") throw new Error("X25519 public key export failed");
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: importX25519PublicKey(recipientPublicKey),
  });
  const aad = authenticatedContextBytes(authenticatedContext);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), aad, 32));
  shared.fill(0);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  key.fill(0);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(canonicalJson(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  return {
    ciphertext: ciphertext.toString("base64url"),
    ephemeralPublicKey: ephemeralJwk.x,
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    version: 1,
  };
}

export function openOAuthBrokerPayload(
  sealed: OAuthBrokerSealedValue,
  recipientPrivateKey: string,
  authenticatedContext: unknown,
): unknown {
  if (sealed.version !== 1) throw new Error("Unsupported broker sealed-payload version");
  const shared = diffieHellman({
    privateKey: createPrivateKey({
      format: "der",
      key: Buffer.from(recipientPrivateKey, "base64url"),
      type: "pkcs8",
    }),
    publicKey: importX25519PublicKey(sealed.ephemeralPublicKey),
  });
  const aad = authenticatedContextBytes(authenticatedContext);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), aad, 32));
  shared.fill(0);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64url"));
  key.fill(0);
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
    decipher.final(),
  ]);
  try {
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } finally {
    plaintext.fill(0);
  }
}

function importX25519PublicKey(value: string) {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) {
    throw new TypeError("Broker public key must be canonical base64url for 32 bytes");
  }
  return createPublicKey({
    format: "jwk",
    key: { crv: "X25519", kty: "OKP", x: value },
  });
}

function authenticatedContextBytes(context: unknown): Buffer {
  return Buffer.from(`${sealingPurpose}\0${canonicalJson(context)}`, "utf8");
}

/**
 * Deliberately local, and deliberately NOT `@opensteer/shared/canonicalJson`.
 * These bytes are the sealed plaintext and the HKDF/AES-GCM additional
 * authenticated data: a Host that seals and a Host that opens must produce
 * byte-identical output forever, so this encoding is frozen at the point of
 * use and must never be replaced with a helper that can evolve underneath it.
 * It is also stricter on purpose — a non-finite number or a non-JSON value is
 * refused rather than coerced, because a coerced field would authenticate
 * something the caller never wrote.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Sealed payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Sealed payload is not JSON-compatible");
}

/**
 * The one digest a Host and the Account service both compute over the Host's
 * current authority before a hosted OAuth attempt or refresh is honoured. It
 * lived as two copies, one in the Host runtime and one in the control-plane,
 * and the two drifted to different domain separators; a single function is
 * the only thing that keeps both ends agreeing.
 */
export function hostedOAuthDeploymentAuthorityDigest(binding: {
  readonly activeHostInstanceId: string;
  readonly canonicalOrigin: string;
  readonly hostKeyFingerprint: string;
  readonly id: string;
}): string {
  return createHash("sha256")
    .update("opensteer-hosted-oauth-deployment-authority-v2\0")
    .update(
      JSON.stringify([
        binding.id,
        binding.activeHostInstanceId,
        binding.canonicalOrigin,
        binding.hostKeyFingerprint,
      ]),
    )
    .digest("base64url");
}
