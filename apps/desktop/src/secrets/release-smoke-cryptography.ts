import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DesktopSecretCryptography } from "./protected-json-file.js";

/** A fresh smoke profile is single-use and must never consult the person's Keychain. */
export function releaseSmokeCryptography(): DesktopSecretCryptography {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "release-smoke",
    encryptStringAsync: async (plaintext) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptStringAsync: async (encrypted) => {
      if (encrypted.length < 28) throw Error("Invalid smoke ciphertext");
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
      return { result: plaintext.toString("utf8"), shouldReEncrypt: false };
    },
  };
}
