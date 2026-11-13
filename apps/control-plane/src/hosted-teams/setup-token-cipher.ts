import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const sealedPattern = /^hts1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{22})$/u;

/**
 * Seals a hosted team's plaintext first-owner setup token at rest, bound to the team and the
 * setup generation it was minted for, so a row copied to another team or generation won't open.
 */
export class HostedTeamSetupTokenCipher {
  readonly #key: Buffer;

  /** `encodedKey` is the Account adoption operation key; this derives its own key from it. */
  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encodedKey) {
      throw new TypeError("Hosted team setup token key must be canonical base64url for 32 bytes");
    }
    this.#key = Buffer.from(
      hkdfSync("sha256", key, Buffer.alloc(0), "opensteer-hosted-team-setup-token-v1", 32),
    );
  }

  seal(teamId: string, generation: number, token: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(aad(teamId, generation));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return `hts1.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  open(teamId: string, generation: number, sealed: string): string {
    const match = sealedPattern.exec(sealed);
    if (!match) throw new Error("Stored hosted team setup token is invalid");
    const [, nonce, ciphertext, tag] = match;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(nonce!, "base64url"));
    decipher.setAAD(aad(teamId, generation));
    decipher.setAuthTag(Buffer.from(tag!, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

function aad(teamId: string, generation: number): Buffer {
  return Buffer.from(`${teamId}\0${generation}`, "utf8");
}
