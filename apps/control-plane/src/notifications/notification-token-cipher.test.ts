import { describe, expect, it } from "vitest";
import { NotificationTokenCipher } from "./notification-token-cipher.js";

const secret = "control-plane-auth-secret-at-least-32-characters";
const accountId = "acct_00000000-0000-4000-8000-000000000001";
const token = "a".repeat(64);

describe("NotificationTokenCipher", () => {
  it("round-trips a device token without storing it in the clear", () => {
    const cipher = new NotificationTokenCipher(secret);

    const sealed = cipher.seal(accountId, token);

    expect(sealed).not.toContain(token);
    expect(cipher.open(accountId, sealed)).toBe(token);
  });

  it("refuses a token sealed for another Account", () => {
    const cipher = new NotificationTokenCipher(secret);
    const sealed = cipher.seal(accountId, token);

    expect(() => cipher.open("acct_00000000-0000-4000-8000-000000000002", sealed)).toThrow();
  });

  it("refuses a tampered ciphertext", () => {
    const cipher = new NotificationTokenCipher(secret);
    const sealed = cipher.seal(accountId, token);
    const parts = sealed.split(".");
    const ciphertext = Buffer.from(parts[2]!, "base64url");
    ciphertext[0] = ciphertext[0]! ^ 1;
    const tampered = [parts[0], parts[1], ciphertext.toString("base64url"), parts[3]].join(".");

    expect(() => cipher.open(accountId, tampered)).toThrow();
  });

  it("gives one token one stable slot per platform", () => {
    const cipher = new NotificationTokenCipher(secret);

    expect(cipher.digest("ios", token)).toBe(cipher.digest("ios", token));
    expect(cipher.digest("ios", token)).not.toBe(cipher.digest("android", token));
    expect(cipher.digest("ios", token)).not.toContain(token);
  });

  it("refuses to derive a key from a short secret", () => {
    expect(() => new NotificationTokenCipher("too-short")).toThrow(TypeError);
  });
});
