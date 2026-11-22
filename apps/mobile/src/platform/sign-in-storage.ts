import type { SecureStoreLike } from "./secure-record-store.js";

/** What a person reads when this phone's Keychain or Keystore refuses their sign-in. */
export function signInStorageSentence(noun: "iPhone" | "phone"): string {
  return `Opensteer couldn't save your sign-in on this ${noun}. Try again.`;
}

/**
 * `expo-secure-store` as sign-in keeps credentials in it: a call the platform refuses (an
 * unsigned build without its Keychain entitlement, a locked Keystore) is reported to the log
 * with Expo's own words and reaches the sign-in screens as one plain sentence, its cause kept.
 */
export function signInStorage(
  store: SecureStoreLike,
  noun: "iPhone" | "phone",
  report: (error: unknown) => void = (error) =>
    console.warn("opensteer.mobile.sign-in-storage.failed", error),
): SecureStoreLike {
  const plainly = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (cause) {
      report(cause);
      throw new Error(signInStorageSentence(noun), { cause });
    }
  };
  return {
    deleteItemAsync: (key) => plainly(() => store.deleteItemAsync(key)),
    getItemAsync: (key) => plainly(() => store.getItemAsync(key)),
    isAvailableAsync: () => plainly(() => store.isAvailableAsync()),
    setItemAsync: (key, value) => plainly(() => store.setItemAsync(key, value)),
  };
}
