import { createPublicKey, type KeyObject } from "node:crypto";
import type { BrowserAttachPublicKey } from "@opensteer/protocol";

export class BrowserAttachKeyRegistry {
  readonly #relayKeyIds = new Set<string>();
  readonly #keys: Map<string, KeyObject>;
  readonly #staticKeyIds: Set<string>;

  constructor(staticKeys: ReadonlyMap<string, KeyObject>) {
    this.#keys = new Map(staticKeys);
    this.#staticKeyIds = new Set(staticKeys.keys());
  }

  resolve(keyId: string): KeyObject | null {
    return this.#keys.get(keyId) ?? null;
  }

  replaceRelayKeys(entries: readonly BrowserAttachPublicKey[]): void {
    const next = new Map<string, KeyObject>();
    for (const entry of entries) {
      if (next.has(entry.keyId)) {
        throw new Error("The relayed browser attach key IDs are not unique.");
      }
      const key = createEd25519PublicKey(entry.publicKeyPem);
      const configured = this.#keys.get(entry.keyId);
      if (this.#staticKeyIds.has(entry.keyId) && configured && !configured.equals(key)) {
        throw new Error("The relayed browser attach key conflicts with a static key.");
      }
      next.set(entry.keyId, key);
    }

    for (const keyId of this.#relayKeyIds) {
      if (!this.#staticKeyIds.has(keyId)) this.#keys.delete(keyId);
    }
    this.#relayKeyIds.clear();
    for (const [keyId, key] of next) {
      if (this.#staticKeyIds.has(keyId)) continue;
      this.#keys.set(keyId, key);
      this.#relayKeyIds.add(keyId);
    }
  }
}

function createEd25519PublicKey(publicKeyPem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new Error("The relay supplied an invalid browser attach key.", { cause: error });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("The relay supplied a non-Ed25519 browser attach key.");
  }
  return key;
}
