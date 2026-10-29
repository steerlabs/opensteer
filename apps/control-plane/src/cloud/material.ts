import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const MaterialSchema = z.record(z.string().min(1), z.string());

/** The Account retains exact credentials across worker crashes; responses never carry them. */
export class CloudMaterialCipher {
  readonly #key: Buffer;

  constructor(encodedKey: string) {
    this.#key = Buffer.from(encodedKey, "base64url");
    if (this.#key.byteLength !== 32 || this.#key.toString("base64url") !== encodedKey) {
      throw new TypeError("Cloud operation key must be canonical base64url for 32 bytes");
    }
  }

  seal(operationId: string, material: Readonly<Record<string, string>>): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`opensteer-cloud:${operationId}`));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(MaterialSchema.parse(material))),
      cipher.final(),
    ]);
    return [
      "cloud1",
      nonce.toString("base64url"),
      encrypted.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(".");
  }

  open(operationId: string, value: string): Record<string, string> {
    const match = /^cloud1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/u.exec(
      value,
    );
    if (!match) throw new Error("Stored cloud material is invalid");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(match[1]!, "base64url"),
    );
    decipher.setAAD(Buffer.from(`opensteer-cloud:${operationId}`));
    decipher.setAuthTag(Buffer.from(match[3]!, "base64url"));
    return MaterialSchema.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(match[2]!, "base64url")),
          decipher.final(),
        ]).toString("utf8"),
      ),
    );
  }
}
