import { deviceDriverKey } from "./device-projection.js";
import type { MachineSummary, TabViewer } from "@opensteer/protocol";

/**
 * This device's viewer of each tab, as its own activation bound it. A window
 * or phone viewer reads its owner view as the Host lists it now, never as it
 * was answered: a view the Host removed reads as no viewer, so the tab's next
 * selection acquires a fresh one, and a newer generation replaces the old.
 */
export class TabViewers {
  readonly #bound = new Map<string, TabViewer>();
  readonly #drivers = new Map<string, string | null>();

  set(tabId: string, viewer: TabViewer, machines?: readonly MachineSummary[]): void {
    if (viewer.kind === "phone") {
      const machine = machines?.find((machine) => machine.id === viewer.view.machineId);
      this.#drivers.set(tabId, machine ? deviceDriverKey(machine) : null);
    }
    this.#bound.set(tabId, viewer);
  }
  /** Keeps only the tabs still listed. */
  retain(listed: { has(tabId: string): boolean }): void {
    for (const tabId of this.#bound.keys())
      if (!listed.has(tabId)) {
        this.#bound.delete(tabId);
        this.#drivers.delete(tabId);
      }
  }
  clear(): void {
    this.#bound.clear();
    this.#drivers.clear();
  }
  /** The same object while nothing it shows changed, so selectors stay still. */
  get(tabId: string, machines: readonly MachineSummary[]): TabViewer | null {
    const viewer = this.#bound.get(tabId);
    if (!viewer || viewer.kind === "page" || viewer.kind === "app") return viewer ?? null;
    const machine = machines.find((machine) => machine.id === viewer.view.machineId);
    if (
      viewer.kind === "phone" &&
      machine &&
      this.#drivers.has(tabId) &&
      this.#drivers.get(tabId) !== deviceDriverKey(machine)
    )
      return null;
    const current = machines
      .find((machine) => machine.id === viewer.view.machineId)
      ?.computerUse?.ownerViews?.find((view) => view.viewId === viewer.view.viewId);
    if (
      !current ||
      (machine?.phoneDisplay?.driver?.role === "screen" &&
        (!("driverGeneration" in current) ||
          current.driverGeneration !== machine.phoneDisplay.driver.generation))
    )
      return null;
    if (current === viewer.view) return viewer;
    const followed = { ...viewer, view: current };
    this.#bound.set(tabId, followed);
    return followed;
  }
}
