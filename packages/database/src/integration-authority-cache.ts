import type { UserId, WorkspaceId } from "@opensteer/core";

/**
 * What one owner's Workspace may call, per authority generation. Main
 * inheritance is part of the scope because two Threads in the same Main can
 * stand differently to it (see `mainAccess`), and neither answer may evict or
 * stand in for the other.
 */
export class IntegrationAuthorityCache<Value> {
  readonly #entries = new Map<string, Value>();

  get(input: {
    readonly authorityFingerprint: string;
    readonly generation: number;
    readonly inheritsMain: boolean;
    readonly ownerUserId: UserId;
    readonly workspaceId: WorkspaceId;
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
      readonly inheritsMain: boolean;
      readonly ownerUserId: UserId;
      readonly workspaceId: WorkspaceId;
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
  readonly inheritsMain: boolean;
  readonly ownerUserId: UserId;
  readonly workspaceId: WorkspaceId;
}): string {
  return `${cacheScope(input)}${input.generation}\0${input.authorityFingerprint}`;
}

function cacheScope(input: {
  readonly inheritsMain: boolean;
  readonly ownerUserId: UserId;
  readonly workspaceId: WorkspaceId;
}): string {
  return `${input.ownerUserId}\0${input.workspaceId}\0${input.inheritsMain ? "main" : "own"}\0`;
}
