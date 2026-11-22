import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const sealedPattern = /^hts1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{22})$/u;

/**
 * Seals a Cloud Computer's secrets at rest (setup codes, boot tokens, backup keys, egress
 * passwords, OIDC client secrets), each bound to the context and generation it was sealed for, so
 * a value copied to another row or generation won't open. The key label and the `hts1.` prefix
 * are what every value already stored carries; they are kept byte for byte, names included.
 */
export class CloudComputerSecretCipher {
  readonly #key: Buffer;

  /** `encodedKey` is the Account adoption operation key; this derives its own key from it. */
  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encodedKey) {
      throw new TypeError("The secret key must be canonical base64url for 32 bytes");
    }
    this.#key = Buffer.from(
      hkdfSync("sha256", key, Buffer.alloc(0), "opensteer-hosted-team-setup-token-v1", 32),
    );
  }

  seal(context: string, generation: number, value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(aad(context, generation));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `hts1.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  open(context: string, generation: number, sealed: string): string {
    const match = sealedPattern.exec(sealed);
    if (!match) throw new Error("A stored secret is invalid");
    const [, nonce, ciphertext, tag] = match;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(nonce!, "base64url"));
    decipher.setAAD(aad(context, generation));
    decipher.setAuthTag(Buffer.from(tag!, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

function aad(context: string, generation: number): Buffer {
  return Buffer.from(`${context}\0${generation}`, "utf8");
}
