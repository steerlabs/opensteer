import { OpensteerError, type RunnerId, type UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";

interface PhoneTabsOptions {
  readonly store: Pick<OpensteerStore, "closePhoneTab" | "effectiveMachineOwners" | "openPhoneTab">;
  readonly heldByTask: (machine: RunnerId) => boolean;
  readonly closeViews: (owner: UserId, machine: RunnerId) => void;
  readonly changed: () => void;
  readonly onError: (error: unknown) => void;
}

/**
 * An Agent Phone's tab outlives every session and view that shows it, so a
 * person keeps their place between an agent's turns. It carries no authority:
 * what the tab shows still needs its own live session or owner view.
 */
export class PhoneTabs {
  readonly #options: PhoneTabsOptions;
  /** In order per phone, or a close being written would erase a new task's open. */
  readonly #turns = new KeyedMutationQueue();
  constructor(options: PhoneTabsOptions) {
    this.#options = options;
  }

  /**
   * A live session or view lists its phone without this, so nothing waits on it.
   * `still` is asked in turn: a close ahead of this may have ended what opened it.
   */
  opened(machine: RunnerId, still: () => boolean = () => true): void {
    void this.#turns
      .run(machine, async () => {
        if (still() && (await this.#options.store.openPhoneTab(machine))) this.#options.changed();
      })
      .catch(this.#options.onError);
  }

  close(owner: UserId, machine: RunnerId): Promise<void> {
    return this.#turns.run(machine, async () => {
      const owners = await this.#options.store.effectiveMachineOwners([machine]);
      if (owners.get(machine)?.effectiveOwner !== owner)
        throw new OpensteerError({ code: "not_found", message: "This phone is unavailable." });
      if (this.#options.heldByTask(machine))
        throw new OpensteerError({
          code: "conflict",
          message: "An agent is using this phone. Stop it to close the tab.",
        });
      // Written first: a tab in front reopens a view it loses, unless the tab has gone too.
      await this.#options.store.closePhoneTab(machine);
      this.#options.closeViews(owner, machine);
      this.#options.changed();
    });
  }
}
