import type { BrowserProfileId } from "@opensteer/core";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";

export class StandardCdpProfileLeases {
  readonly #lane = new KeyedMutationQueue();
  readonly #active = new Map<BrowserProfileId, { generation: number; bindingId: string }>();
  #generation = 0;

  run<T>(profileId: BrowserProfileId | null, operation: () => Promise<T>): Promise<T> {
    return profileId ? this.#lane.run(profileId, operation) : operation();
  }

  held(profileId: BrowserProfileId) {
    return this.#active.get(profileId);
  }

  acquire(profileId: BrowserProfileId, bindingId: string) {
    const generation = (this.#generation = Math.max(Date.now() * 1_000, this.#generation + 1));
    const lease = { bindingId, generation };
    this.#active.set(profileId, lease);
    return lease;
  }

  release(
    profileId: BrowserProfileId,
    generation: number,
    persist: () => Promise<void>,
  ): Promise<void> {
    return this.run(profileId, async () => {
      if (this.#active.get(profileId)?.generation !== generation) return;
      await persist();
      this.#active.delete(profileId);
    });
  }
}
