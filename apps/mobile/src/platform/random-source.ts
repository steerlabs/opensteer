/**
 * Web Crypto's random source, which Hermes does not have.
 *
 * `@opensteer/client` compiles against the DOM lib and reads
 * `globalThis.crypto.randomUUID()` and `getRandomValues` directly — for
 * idempotency keys, socket correlation nonces, ids, and the OAuth PKCE
 * verifier. Expo's WinterCG runtime installs `TextDecoder`, `URL`,
 * `structuredClone` and `fetch`, and React Native's core installs timers and
 * XHR, but neither installs `crypto`. The phone therefore has to provide it,
 * from the platform's own CSPRNG, before any of that code runs.
 *
 * This is the capability, not a fallback: it is installed unconditionally at
 * the entry point, so there is never a question of which implementation is in
 * use.
 */
export interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
}

export function installRandomSource(target: object, source: RandomSource): void {
  Object.defineProperty(target, "crypto", {
    configurable: true,
    enumerable: false,
    value: {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => source.getRandomValues(array),
      randomUUID: (): string => source.randomUUID(),
    },
    writable: true,
  });
}
