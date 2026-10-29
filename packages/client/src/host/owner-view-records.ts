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

  #gone(view: Pick<ComputerView, "viewId" | "generation">): boolean {
    return (this.#removed.get(view.viewId) ?? 0) >= view.generation;
  }

  accept(machines: readonly MachineSummary[], view: ComputerView): readonly MachineSummary[] {
    if (this.#gone(view)) return machines;
    return machines.map((machine) => {
      if (machine.id !== view.machineId || !machine.computerUse) return machine;
      const previous = machine.computerUse.ownerViews ?? [];
      const current = previous.find((held) => held.viewId === view.viewId);
      if (
        current &&
        (current.generation > view.generation ||
          (current.generation === view.generation &&
            ["closed", "expired"].includes(current.state) &&
            !["closed", "expired"].includes(view.state)))
      )
        return machine;
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

  /** A reread's machine, without the generations removed while it was on its way. */
  reread(machine: MachineSummary): MachineSummary {
    const views = machine.computerUse?.ownerViews;
    if (!views?.some((view) => this.#gone(view))) return machine;
    return {
      ...machine,
      computerUse: {
        ...machine.computerUse!,
        ownerViews: views.filter((view) => !this.#gone(view)),
      },
    };
  }

  /** Another viewer remembers nothing of this one's views. */
  clear(): void {
    this.#removed.clear();
  }
}
