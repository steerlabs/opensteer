import { expect, it, vi } from "vitest";
import { nativeSavedViewCrypto } from "./saved-view-crypto.js";
import { createSavedViewKeyStore } from "./saved-view-keys.js";

const aes = vi.hoisted(() => {
  const key = { encoded: vi.fn(async () => "base64-key") };
  const combined = new Uint8Array([4, 5, 6]);
  const sealed = { combined: vi.fn(async () => combined) };
  return {
    key,
    combined,
    sealed,
    generate: vi.fn(async () => key),
    import: vi.fn(async () => key),
    encrypt: vi.fn(async () => sealed),
    fromCombined: vi.fn(() => sealed),
    decrypt: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
});
vi.mock("expo-crypto", () => ({
  AESKeySize: { AES256: 256 },
  AESEncryptionKey: { generate: aes.generate, import: aes.import },
  AESSealedData: { fromCombined: aes.fromCombined },
  aesEncryptAsync: aes.encrypt,
  aesDecryptAsync: aes.decrypt,
}));

it("uses device-only unlocked keys in the saved-view service without biometric prompts", async () => {
  const native = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    isAvailableAsync: vi.fn(async () => true),
    getItemAsync: vi.fn(async () => "key"),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
  };
  const keys = createSavedViewKeyStore(native, "mobile.saved-views");
  expect(await keys.isAvailableAsync()).toBe(true);
  expect(await keys.getItemAsync("deployment")).toBe("key");
  await keys.setItemAsync("deployment", "value");
  await keys.deleteItemAsync("deployment");
  const options = {
    keychainService: "mobile.saved-views",
    keychainAccessible: 6,
    requireAuthentication: false,
  };
  expect(native.getItemAsync).toHaveBeenCalledWith("deployment", options);
  expect(native.setItemAsync).toHaveBeenCalledWith("deployment", "value", options);
  expect(native.deleteItemAsync).toHaveBeenCalledWith("deployment", options);
});
it("calls native AES-256-GCM with a fresh 12-byte nonce, 16-byte tag and the supplied scope AAD", async () => {
  const plaintext = new Uint8Array([1, 2, 3]),
    aad = new TextEncoder().encode("scope-aad");
  expect(await nativeSavedViewCrypto.generateKey()).toBe("base64-key");
  expect(aes.generate).toHaveBeenCalledWith(256);
  expect(aes.key.encoded).toHaveBeenCalledWith("base64");
  expect(await nativeSavedViewCrypto.encrypt("key", plaintext, aad)).toEqual(aes.combined);
  expect(aes.import).toHaveBeenCalledWith("key", "base64");
  expect(aes.encrypt).toHaveBeenCalledWith(plaintext, aes.key, {
    additionalData: aad,
    nonce: { length: 12 },
    tagLength: 16,
  });
  expect(await nativeSavedViewCrypto.decrypt("key", aes.combined, aad)).toEqual(plaintext);
  expect(aes.fromCombined).toHaveBeenCalledWith(aes.combined, { ivLength: 12, tagLength: 16 });
  expect(aes.decrypt).toHaveBeenCalledWith(aes.sealed, aes.key, { additionalData: aad });
});
