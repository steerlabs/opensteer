import { getRandomValues, randomUUID } from "expo-crypto";
import { installRandomSource } from "./platform/random-source.js";
import { installAbortSupport } from "./platform/abort-support.js";

// Expo adds static AbortSignal helpers, but RN's signal still lacks instance
// cancellation checks and reasons used by Account and Host authorization leases.
installAbortSupport(AbortController, AbortSignal);

/**
 * The first thing this bundle runs.
 *
 * Hermes has no Web Crypto, and `@opensteer/client` reads
 * `globalThis.crypto` directly for ids, idempotency keys, socket nonces and the
 * OAuth PKCE verifier. Installing it here, in a module the entry point imports
 * before anything else, is what makes that code correct on a phone.
 */
installRandomSource(globalThis, {
  // `expo-crypto` fills the typed arrays it knows; this widens it to the whole
  // `ArrayBufferView` surface Web Crypto promises by filling the same bytes
  // through a `Uint8Array` view of them.
  getRandomValues: (array) => {
    getRandomValues(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  },
  randomUUID,
});
