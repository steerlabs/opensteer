import type { UserId } from "@opensteer/core";

/** One value per owner, valid only for the authority generation it was resolved under. */
export class IntegrationAuthorityCache<Value> {
  readonly #entries = new Map<UserId, { readonly generation: number; readonly value: Value }>();

  get(input: { readonly generation: number; readonly ownerUserId: UserId }): Value | null {
    const entry = this.#entries.get(input.ownerUserId);
    if (!entry || entry.generation !== input.generation) return null;
    this.#entries.delete(input.ownerUserId);
    this.#entries.set(input.ownerUserId, entry);
    return entry.value;
  }

  set(input: { readonly generation: number; readonly ownerUserId: UserId }, value: Value): void {
    this.#entries.delete(input.ownerUserId);
    this.#entries.set(input.ownerUserId, { generation: input.generation, value });
    if (this.#entries.size > 256) this.#entries.delete(this.#entries.keys().next().value!);
  }
}
