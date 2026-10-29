import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Device tokens at rest.
 *
 * A provider token is a capability to put words on somebody's lock screen, so
 * it is never stored in the clear. The key is derived from the control plane's
 * own secret with a purpose label rather than declared as a seventh
 * environment variable: the same secret already encrypts this Account's stored
 * provider tokens, and a separate variable an operator could forget would turn
 * a missing key into plaintext rather than a startup error.
 *
 * The lookup hash is keyed by the same secret under a different label, so a
 * database copy alone cannot be tested against a candidate token.
 */
export class NotificationTokenCipher {
  readonly #hashKey: Buffer;
  readonly #key: Buffer;

  constructor(authSecret: string) {
    if (authSecret.length < 32) {
      throw new TypeError("Notification token encryption requires the control-plane auth secret");
    }
    const secret = Buffer.from(authSecret, "utf8");
    this.#key = Buffer.from(
      hkdfSync("sha256", secret, Buffer.alloc(0), "opensteer-notification-token", 32),
    );
    this.#hashKey = Buffer.from(
      hkdfSync("sha256", secret, Buffer.alloc(0), "opensteer-notification-token-hash", 32),
    );
  }

  seal(accountId: string, token: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`opensteer-notification:${accountId}`));
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return [
      "ntok1",
      nonce.toString("base64url"),
      encrypted.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(".");
  }

  open(accountId: string, value: string): string {
    const match = /^ntok1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/u.exec(
      value,
    );
    if (!match) throw new Error("Stored notification device token is invalid");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(match[1]!, "base64url"),
    );
    decipher.setAAD(Buffer.from(`opensteer-notification:${accountId}`));
    decipher.setAuthTag(Buffer.from(match[3]!, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(match[2]!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  /** The unique key a token occupies, without revealing the token itself. */
  digest(platform: string, token: string): string {
    return createHmac("sha256", this.#hashKey).update(`${platform}:${token}`).digest("base64url");
  }
}
