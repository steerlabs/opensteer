import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { OpensteerError, type CredentialId, type UserId } from "@opensteer/core";
import { z } from "zod";

export interface EncryptionKey {
  readonly key: Buffer;
  readonly version: number;
}

export interface EncryptionKeyProvider {
  current(): Promise<EncryptionKey>;
  byVersion(version: number): Promise<EncryptionKey>;
}

export interface CredentialEnvelopeContext {
  readonly credentialId: CredentialId;
  readonly ownerId: UserId;
  readonly provider: string;
}

export interface SealedCredential {
  readonly envelope: Buffer;
  readonly keyVersion: number;
}

export interface SecretEnvelopeContext {
  readonly binding?: string;
  readonly purpose: string;
  readonly recordId: string;
  readonly scope: string;
}

export type SealedSecret = SealedCredential;

const EnvelopeSchema = z.strictObject({
  algorithm: z.literal("aes-256-gcm"),
  ciphertext: z.string(),
  iv: z.string(),
  keyVersion: z.number().int().nonnegative(),
  tag: z.string(),
  version: z.literal(1),
});

export class AesGcmCredentialVault {
  readonly #keys: EncryptionKeyProvider;

  constructor(keys: EncryptionKeyProvider) {
    this.#keys = keys;
  }

  async seal(
    payload: Readonly<Record<string, string>>,
    context: CredentialEnvelopeContext,
  ): Promise<SealedCredential> {
    return sealPayload(this.#keys, payload, aad(context));
  }

  async open(
    sealed: Buffer,
    context: CredentialEnvelopeContext,
  ): Promise<Readonly<Record<string, string>>> {
    return openPayload(this.#keys, sealed, aad(context), "Credential");
  }
}

/** Authenticated encryption for non-grantable Host secrets such as OAuth app credentials. */
export class AesGcmSecretVault {
  readonly #keys: EncryptionKeyProvider;

  constructor(keys: EncryptionKeyProvider) {
    this.#keys = keys;
  }

  seal(
    payload: Readonly<Record<string, string>>,
    context: SecretEnvelopeContext,
  ): Promise<SealedSecret> {
    return sealPayload(this.#keys, payload, genericAad(context));
  }

  open(sealed: Buffer, context: SecretEnvelopeContext): Promise<Readonly<Record<string, string>>> {
    return openPayload(this.#keys, sealed, genericAad(context), "Secret");
  }

  async fingerprint(
    payload: Readonly<Record<string, string>>,
    context: SecretEnvelopeContext,
    keyVersion?: number,
  ): Promise<string> {
    const encryptionKey =
      keyVersion === undefined
        ? await this.#keys.current()
        : await this.#keys.byVersion(keyVersion);
    assertKey(encryptionKey.key);
    const authenticatedData = genericAad(context);
    const fingerprintKey = createHmac("sha256", encryptionKey.key)
      .update("opensteer-secret-fingerprint-v1", "utf8")
      .digest();
    try {
      const digest = createHmac("sha256", fingerprintKey)
        .update(authenticatedData)
        .update("\0", "utf8")
        .update(stableSecretRecord(payload), "utf8")
        .digest("base64url");
      return `hmac-sha256-v1:${encryptionKey.version}:${digest}`;
    } finally {
      authenticatedData.fill(0);
      fingerprintKey.fill(0);
    }
  }
}

export class StaticEncryptionKeyProvider implements EncryptionKeyProvider {
  readonly #keys: ReadonlyMap<number, Buffer>;
  readonly #currentVersion: number;

  constructor(keys: ReadonlyMap<number, Buffer>, currentVersion: number) {
    const current = keys.get(currentVersion);
    if (!current) throw new TypeError("Current encryption key version is missing");
    for (const key of keys.values()) assertKey(key);
    this.#keys = new Map([...keys].map(([version, key]) => [version, Buffer.from(key)]));
    this.#currentVersion = currentVersion;
  }

  async current(): Promise<EncryptionKey> {
    return this.byVersion(this.#currentVersion);
  }

  async byVersion(version: number): Promise<EncryptionKey> {
    const key = this.#keys.get(version);
    if (!key)
      throw new OpensteerError({
        code: "internal",
        message: "Encryption key version is unavailable",
      });
    return { key: Buffer.from(key), version };
  }
}

function aad(context: CredentialEnvelopeContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      credentialId: context.credentialId,
      ownerId: context.ownerId,
      provider: context.provider,
    }),
    "utf8",
  );
}

function genericAad(context: SecretEnvelopeContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      ...(context.binding === undefined ? {} : { binding: context.binding }),
      purpose: context.purpose,
      recordId: context.recordId,
      scope: context.scope,
    }),
    "utf8",
  );
}

async function sealPayload(
  keys: EncryptionKeyProvider,
  payload: Readonly<Record<string, string>>,
  authenticatedData: Buffer,
): Promise<SealedSecret> {
  const encryptionKey = await keys.current();
  assertKey(encryptionKey.key);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", encryptionKey.key, iv);
    cipher.setAAD(authenticatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = Buffer.from(
      JSON.stringify({
        algorithm: "aes-256-gcm",
        ciphertext: ciphertext.toString("base64url"),
        iv: iv.toString("base64url"),
        keyVersion: encryptionKey.version,
        tag: cipher.getAuthTag().toString("base64url"),
        version: 1,
      }),
      "utf8",
    );
    ciphertext.fill(0);
    return { envelope, keyVersion: encryptionKey.version };
  } finally {
    authenticatedData.fill(0);
    plaintext.fill(0);
    iv.fill(0);
  }
}

async function openPayload(
  keys: EncryptionKeyProvider,
  sealed: Buffer,
  authenticatedData: Buffer,
  label: string,
): Promise<Readonly<Record<string, string>>> {
  let parsed: z.infer<typeof EnvelopeSchema>;
  try {
    parsed = EnvelopeSchema.parse(JSON.parse(sealed.toString("utf8")));
  } catch (error) {
    throw new OpensteerError({
      cause: error,
      code: "internal",
      message: `${label} envelope is invalid`,
    });
  }
  const encryptionKey = await keys.byVersion(parsed.keyVersion);
  assertKey(encryptionKey.key);
  const iv = Buffer.from(parsed.iv, "base64url");
  const ciphertext = Buffer.from(parsed.ciphertext, "base64url");
  const tag = Buffer.from(parsed.tag, "base64url");
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey.key, iv);
    decipher.setAAD(authenticatedData);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const value: unknown = JSON.parse(plaintext.toString("utf8"));
    return secretRecord(value);
  } catch (error) {
    throw new OpensteerError({
      cause: error,
      code: "internal",
      message: `${label} could not be decrypted`,
    });
  } finally {
    authenticatedData.fill(0);
    plaintext?.fill(0);
    iv.fill(0);
    ciphertext.fill(0);
    tag.fill(0);
  }
}

function assertKey(key: Buffer): void {
  if (key.byteLength !== 32) throw new TypeError("AES-256-GCM keys must contain exactly 32 bytes");
}

function secretRecord(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Credential payload is not an object");
  }
  const output: Record<string, string> = {};
  for (const [key, secret] of Object.entries(value)) {
    if (typeof secret !== "string") throw new TypeError("Credential values must be strings");
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: secret,
      writable: false,
    });
  }
  return output;
}

function stableSecretRecord(value: Readonly<Record<string, string>>): string {
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`)
    .join(",")}}`;
}
