import { describe, expect, it, vi } from "vitest";
import type { DesktopSecretCryptography } from "./protected-json-file.js";
import { VerifiedDesktopSecretCryptography } from "./verified-secret-cryptography.js";

describe("VerifiedDesktopSecretCryptography", () => {
  it("requires a successful encryption round trip instead of trusting the capability flag", async () => {
    const cryptography = delegate();
    cryptography.encryptStringAsync = vi.fn(async () => {
      throw new Error("login keychain is locked");
    });
    const onVerificationFailure = vi.fn();
    const verified = new VerifiedDesktopSecretCryptography(cryptography, {
      onVerificationFailure,
    });

    await expect(verified.isAsyncEncryptionAvailable()).resolves.toBe(false);
    expect(cryptography.encryptStringAsync).toHaveBeenCalledOnce();
    expect(onVerificationFailure).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "login keychain is locked" }),
      phase: "encrypt",
    });
  });

  it("rejects a backend that cannot decrypt its own readiness probe", async () => {
    const cryptography = delegate();
    cryptography.decryptStringAsync = vi.fn(async () => ({
      result: "different plaintext",
      shouldReEncrypt: false,
    }));

    await expect(
      new VerifiedDesktopSecretCryptography(cryptography).isAsyncEncryptionAvailable(),
    ).resolves.toBe(false);
  });

  it("retries after a failure and shares a successful verification", async () => {
    const cryptography = delegate();
    let unlocked = false;
    cryptography.encryptStringAsync = vi.fn(async (plaintext) => {
      if (!unlocked) throw new Error("login keychain is locked");
      return Buffer.from(plaintext, "utf8");
    });
    const verified = new VerifiedDesktopSecretCryptography(cryptography);

    await expect(verified.isAsyncEncryptionAvailable()).resolves.toBe(false);
    unlocked = true;
    await expect(
      Promise.all([verified.isAsyncEncryptionAvailable(), verified.isAsyncEncryptionAvailable()]),
    ).resolves.toEqual([true, true]);
    await expect(verified.isAsyncEncryptionAvailable()).resolves.toBe(true);
    expect(cryptography.encryptStringAsync).toHaveBeenCalledTimes(2);
  });
});

function delegate(): DesktopSecretCryptography {
  return {
    decryptStringAsync: vi.fn(async (encrypted) => ({
      result: encrypted.toString("utf8"),
      shouldReEncrypt: false,
    })),
    encryptStringAsync: vi.fn(async (plaintext) => Buffer.from(plaintext, "utf8")),
    getSelectedStorageBackend: () => "keychain",
    isAsyncEncryptionAvailable: vi.fn(async () => true),
  };
}
