import type * as SecureStore from "expo-secure-store";
import type { SecureStoreLike } from "./secure-record-store.js";

/** One small slot, no SecureRecordStore generations or duplicate copies of its AES key. */
export function createSavedViewKeyStore(
  store: Pick<
    typeof SecureStore,
    | "getItemAsync"
    | "setItemAsync"
    | "deleteItemAsync"
    | "isAvailableAsync"
    | "WHEN_UNLOCKED_THIS_DEVICE_ONLY"
  >,
  keychainService: string,
): SecureStoreLike {
  const options = {
    keychainService,
    keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: false,
  };
  return {
    isAvailableAsync: () => store.isAvailableAsync(),
    getItemAsync: (key) => store.getItemAsync(key, options),
    setItemAsync: (key, value) => store.setItemAsync(key, value, options),
    deleteItemAsync: (key) => store.deleteItemAsync(key, options),
  };
}
