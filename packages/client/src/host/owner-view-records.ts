import type { ComputerView, MachineSummary } from "@opensteer/protocol";

/** Enough to outlast any answer in flight; the oldest is forgotten first. */
const removedLimit = 256;

/**
 * The person's owner views as this client holds them, from the Host's
 * notices, its command answers and its rereads alike. A generation the Host
 * removed never comes back: an answer or reread that left before the removal
 * cannot revive it, while a newer generation of the same view is shown.
 */
export class OwnerViewRecords {
  /** Each removed view's newest removed generation. */
  readonly #removed = new Map<string, number>();
  #accepted = new WeakMap<ComputerView, number>();
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  #gone(view: Pick<ComputerView, "viewId" | "generation">): boolean {
    return (this.#removed.get(view.viewId) ?? 0) >= view.generation;
  }

  #canReplace(current: ComputerView | undefined, view: ComputerView): boolean {
    return (
      !current ||
      (current.generation <= view.generation &&
        (current.generation !== view.generation ||
          !["closed", "expired"].includes(current.state) ||
          ["closed", "expired"].includes(view.state)))
    );
  }

  accept(machines: readonly MachineSummary[], view: ComputerView): readonly MachineSummary[] {
    if (this.#gone(view)) return machines;
    return machines.map((machine) => {
      if (machine.id !== view.machineId || !machine.computerUse) return machine;
      const previous = machine.computerUse.ownerViews ?? [];
      const current = previous.find((held) => held.viewId === view.viewId);
      if (!this.#canReplace(current, view)) return machine;
      this.#accepted.set(view, ++this.#revision);
      return {
        ...machine,
        computerUse: {
          ...machine.computerUse,
          ownerViews: [...previous.filter((held) => held.viewId !== view.viewId), view],
        },
      };
    });
  }

  remove(
    machines: readonly MachineSummary[],
    removal: { readonly machineId: string; readonly viewId: string; readonly generation: number },
  ): readonly MachineSummary[] {
    if (!this.#gone(removal)) {
      this.#removed.delete(removal.viewId);
      this.#removed.set(removal.viewId, removal.generation);
      if (this.#removed.size > removedLimit)
        this.#removed.delete(this.#removed.keys().next().value!);
    }
    return machines.map((machine) =>
      machine.id !== removal.machineId || !machine.computerUse
        ? machine
        : {
            ...machine,
            computerUse: {
              ...machine.computerUse,
              ownerViews: (machine.computerUse.ownerViews ?? []).filter(
                (view) => view.viewId !== removal.viewId || view.generation > removal.generation,
              ),
            },
          },
    );
  }

  /** A reread cannot undo command answers or notices accepted after it began. */
  reread(
    machine: MachineSummary,
    current: MachineSummary | undefined,
    revision: number,
  ): MachineSummary {
    if (!machine.computerUse) return machine;
    const views = machine.computerUse.ownerViews;
    const updates = (current?.computerUse?.ownerViews ?? []).filter(
      (view) => (this.#accepted.get(view) ?? 0) > revision && !this.#gone(view),
    );
    if (!updates.length && !views?.some((view) => this.#gone(view))) return machine;
    const merged = new Map(
      (views ?? []).filter((view) => !this.#gone(view)).map((view) => [view.viewId, view]),
    );
    for (const view of updates)
      if (this.#canReplace(merged.get(view.viewId), view)) merged.set(view.viewId, view);
    return {
      ...machine,
      computerUse: {
        ...machine.computerUse,
        ownerViews: [...merged.values()],
      },
    };
  }

  /** Another viewer remembers nothing of this one's views. */
  clear(): void {
    this.#removed.clear();
    this.#accepted = new WeakMap();
  }
}
