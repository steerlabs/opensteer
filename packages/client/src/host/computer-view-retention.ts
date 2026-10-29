import type { ComputerView } from "@opensteer/protocol";
import { HostClientRequestError } from "./client.js";
export interface ComputerViewRetention {
  setVisible(visible: boolean): void;
  release(): void;
}
const renewEveryMs = 30_000;
/** A failed renewal is asked again soon, backing off to the ordinary period. */
const retryBaseMs = 1_000;
/** Refusals that end the view for good: asking again cannot bring it back. */
const endedReasons = new Set([
  "computer-view-ended",
  "computer-view-stale-generation",
  "computer-view-not-approved",
]);
function ended(error: unknown): boolean {
  return (
    error instanceof HostClientRequestError &&
    (endedReasons.has(error.reason ?? "") ||
      error.code === "conflict" ||
      error.code === "unauthorized" ||
      error.code === "forbidden" ||
      error.code === "not_found")
  );
}
interface Retained {
  readonly connected: (connected: boolean) => void;
  readonly release: () => void;
}
/**
 * A visible viewer's demand, independent of capture and of every other
 * client's demand. It outlives a failed renewal and a dropped connection —
 * renewing again soon, and at once on reconnecting — and ends only when its
 * viewer lets go, the view is refused for good, or the signed-in viewer
 * changes.
 */
export class ComputerViewRetainers {
  readonly #renew: (viewId: string, generation: number) => Promise<ComputerView>;
  readonly #held = new Set<Retained>();
  readonly #live: (viewId: string, generation: number) => boolean;
  #connected = true;
  constructor(
    renew: (viewId: string, generation: number) => Promise<ComputerView>,
    live: (viewId: string, generation: number) => boolean,
  ) {
    this.#renew = renew;
    this.#live = live;
  }
  retain(viewId: string, generation: number, visible = true): ComputerViewRetention {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    let shown = visible;
    let pending = false;
    let failures = 0;
    const schedule = () => {
      clearTimeout(timer);
      if (released || !shown || !this.#connected) return;
      timer = setTimeout(
        () => void renew(),
        failures === 0 ? renewEveryMs : Math.min(renewEveryMs, retryBaseMs * 2 ** (failures - 1)),
      );
    };
    const release = () => {
      released = true;
      clearTimeout(timer);
      this.#held.delete(held);
    };
    const renew = async () => {
      if (released || !shown || pending || !this.#connected) return;
      if (!this.#live(viewId, generation)) {
        release();
        return;
      }
      pending = true;
      try {
        const view = await this.#renew(viewId, generation);
        if (view.generation !== generation || view.state !== "ready") release();
        failures = 0;
      } catch (error) {
        if (ended(error)) release();
        else failures += 1;
      } finally {
        pending = false;
        schedule();
      }
    };
    const held: Retained = {
      // Reconnected, it renews at once: the period may have passed offline.
      connected: (connected) => (connected ? void renew() : clearTimeout(timer)),
      release,
    };
    this.#held.add(held);
    schedule();
    return {
      setVisible: (value) => {
        if (released || shown === value) return;
        shown = value;
        // Shown again, it renews at once: it may have been hidden for most of its life.
        if (shown) void renew();
        else schedule();
      },
      release,
    };
  }
  /** Disconnected, nothing is asked; reconnected, every visible view renews at once. */
  setConnected(connected: boolean): void {
    if (this.#connected === connected) return;
    this.#connected = connected;
    for (const held of this.#held) held.connected(connected);
  }
  /** The signed-in viewer changed or left: nobody's demand carries over. */
  clear(): void {
    for (const held of this.#held) held.release();
  }
}
