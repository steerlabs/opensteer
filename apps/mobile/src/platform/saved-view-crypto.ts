import type { SavedViewCrypto } from "./saved-host-view-store.js";

/** Lazy loading makes a custom client without ExpoCryptoAES a cache miss, not an app failure. */
export const nativeSavedViewCrypto: SavedViewCrypto = {
  async generateKey() {
    const { AESEncryptionKey, AESKeySize } = await import("expo-crypto");
    return (await AESEncryptionKey.generate(AESKeySize.AES256)).encoded("base64");
  },
  async encrypt(key, plaintext, aad) {
    const { AESEncryptionKey, aesEncryptAsync } = await import("expo-crypto");
    const imported = await AESEncryptionKey.import(key, "base64");
    return (
      await aesEncryptAsync(plaintext, imported, {
        additionalData: aad,
        nonce: { length: 12 },
        tagLength: 16,
      })
    ).combined();
  },
  async decrypt(key, sealed, aad) {
    const { AESEncryptionKey, AESSealedData, aesDecryptAsync } = await import("expo-crypto");
    return aesDecryptAsync(
      AESSealedData.fromCombined(sealed, { ivLength: 12, tagLength: 16 }),
      await AESEncryptionKey.import(key, "base64"),
      { additionalData: aad },
    );
  },
};
