import type { SecureStoreLike } from "./secure-record-store.js";

/**
 * The `expo-secure-store` contract without a Keychain, for this app's tests.
 *
 * Secrecy of the medium is the platform's guarantee and is not something a
 * test can observe; what the tests need is the shape — one short string per
 * key, no enumeration, and a missing key reading as `null`. The value ceiling
 * is enforced here rather than tolerated, so a test that writes an oversized
 * value fails the way the device would.
 */
export class MemorySecureStore implements SecureStoreLike {
  available = true;
  /**
   * Called before every mutation with a label, so a test can stop a write
   * exactly where the operating system would and then inspect what a reader
   * finds.
   */
  interrupt: (step: string) => void = () => undefined;
  readonly #items = new Map<string, string>();

  get keys(): readonly string[] {
    return [...this.#items.keys()].sort();
  }

  peek(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  put(key: string, value: string): void {
    this.#items.set(key, value);
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.interrupt(`delete:${key}`);
    this.#items.delete(key);
  }

  async getItemAsync(key: string): Promise<string | null> {
    return this.#items.get(key) ?? null;
  }

  async isAvailableAsync(): Promise<boolean> {
    return this.available;
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    if (new TextEncoder().encode(value).byteLength > 2_048) {
      throw new Error(`Value for ${key} exceeds the secure store limit.`);
    }
    this.interrupt(`set:${key}`);
    this.#items.set(key, value);
  }
}
