import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  ManagedHostProvisioningBundleSchema,
  type ManagedHostProvisioningBundle,
} from "@opensteer/control-plane-protocol";

const sealedPayloadPattern = /^aop1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/u;

export class AdoptionOperationCipher {
  readonly #key: Buffer;

  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encodedKey) {
      throw new TypeError(
        "Account adoption operation key must be canonical base64url for 32 bytes",
      );
    }
    this.#key = key;
  }

  seal(proofId: string, bundle: ManagedHostProvisioningBundle): string {
    const parsed = ManagedHostProvisioningBundleSchema.parse(bundle);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(proofId, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(parsed), "utf8"),
      cipher.final(),
    ]);
    return `aop1.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  open(proofId: string, sealed: string): ManagedHostProvisioningBundle {
    const match = sealedPayloadPattern.exec(sealed);
    if (!match) throw new Error("Stored Account adoption result is invalid");
    const [, encodedNonce, encodedCiphertext, encodedTag] = match;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(encodedNonce!, "base64url"),
    );
    decipher.setAAD(Buffer.from(proofId, "utf8"));
    decipher.setAuthTag(Buffer.from(encodedTag!, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return ManagedHostProvisioningBundleSchema.parse(JSON.parse(plaintext));
  }
}
