import type { UserId } from "@opensteer/core";

export class IntegrationAuthorityCache<Value> {
  readonly #entries = new Map<string, Value>();

  get(input: {
    readonly authorityFingerprint: string;
    readonly generation: number;
    readonly ownerUserId: UserId;
  }): Value | null {
    const key = cacheKey(input);
    const value = this.#entries.get(key);
    if (value === undefined) return null;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(
    input: {
      readonly authorityFingerprint: string;
      readonly generation: number;
      readonly ownerUserId: UserId;
    },
    value: Value,
  ): void {
    const scope = cacheScope(input);
    for (const key of this.#entries.keys()) {
      if (key.startsWith(scope)) this.#entries.delete(key);
    }
    this.#entries.set(cacheKey(input), value);
    if (this.#entries.size > 256) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
  }
}

function cacheKey(input: {
  readonly authorityFingerprint: string;
  readonly generation: number;
  readonly ownerUserId: UserId;
}): string {
  return `${cacheScope(input)}${input.generation}\0${input.authorityFingerprint}`;
}

function cacheScope(input: { readonly ownerUserId: UserId }): string {
  return `${input.ownerUserId}\0`;
}
