import type { TabViewer } from "@opensteer/protocol";
import { HostCapacityError } from "../connections/host-transport-error.js";
import { ClientOperationError } from "../connections/operation-error.js";
import { HostClientRequestError } from "../host/client.js";
import type { NativeViewerSource } from "../host/surfaces.js";
import type { DisplaySnapshot } from "./phone-display-stream.js";

type OwnerViewSource = Extract<NativeViewerSource, { kind: "owner-view" }>;
export type OwnerViewReconnectState = "idle" | "reconnecting" | "ended" | "timed-out";

const windowMs = 15_000;
const firstDelayMs = 250;
const maxDelayMs = 2_000;
const key = ({ viewId, generation }: Pick<OwnerViewSource, "viewId" | "generation">) =>
  JSON.stringify([viewId, generation]);

/** One recovery window for the selected tab, across any number of view generations. */
export class OwnerViewReconnect {
  readonly #listeners = new Set<() => void>();
  readonly #retired = new Set<string>();
  #state: OwnerViewReconnectState = "idle";
  #window: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #delay = firstDelayMs;

  readonly #activate: (signal: AbortSignal) => Promise<TabViewer>;
  readonly #opened: (viewer: TabViewer) => void;

  constructor(
    activate: (signal: AbortSignal) => Promise<TabViewer>,
    opened: (viewer: TabViewer) => void,
  ) {
    this.#activate = activate;
    this.#opened = opened;
  }

  getSnapshot = (): OwnerViewReconnectState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  observe = (source: OwnerViewSource, { connection, display }: DisplaySnapshot): void => {
    if (display?.state === "stopped" && display.reason === "device-restarting") {
      this.removed(source, "device-restarting");
    } else if (
      connection === "closed" ||
      display?.state === "stopped" ||
      display?.state === "failed" ||
      display?.state === "unsupported"
    ) {
      this.removed(source, undefined);
    }
  };

  removed = (source: OwnerViewSource, reason: "device-restarting" | undefined): void => {
    if (this.#retired.has(key(source))) return;
    if (this.#state === "ended" || this.#state === "timed-out") return;
    if (reason !== "device-restarting") {
      if (this.#window !== undefined)
        this.#finish(this.#state === "reconnecting" ? "ended" : "idle");
      return;
    }
    // The socket and the owner-view projection can both report this generation's end.
    this.#retired.add(key(source));
    this.#window ??= setTimeout(() => {
      this.#finish(this.#state === "reconnecting" ? "timed-out" : "idle");
    }, windowMs);
    this.#set("reconnecting");
    this.#schedule();
  };

  picture = (source: OwnerViewSource): void => {
    if (this.#state === "reconnecting" && !this.#retired.has(key(source))) {
      clearTimeout(this.#retry);
      this.#retry = undefined;
      this.#set("idle");
    }
  };

  reset = (): void => this.#finish("idle");

  #schedule(): void {
    if (this.#retry !== undefined || this.#controller || this.#state !== "reconnecting") return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#open();
    }, this.#delay);
    this.#delay = Math.min(this.#delay * 2, maxDelayMs);
  }

  async #open(): Promise<void> {
    const controller = (this.#controller = new AbortController());
    let retry = false;
    const retired = this.#retired.size;
    try {
      const viewer = await this.#activate(controller.signal);
      if (controller.signal.aborted || this.#state !== "reconnecting") return;
      if (viewer.kind !== "window" && viewer.kind !== "phone") {
        this.#finish("ended");
        return;
      }
      const { view } = viewer;
      if (this.#retired.has(key(view)) || view.state === "opening") {
        retry = true;
        return;
      }
      this.#opened(viewer);
      if (view.state !== "ready") this.#finish("ended");
    } catch (error) {
      if (controller.signal.aborted) return;
      retry =
        error instanceof HostCapacityError ||
        (error instanceof ClientOperationError && error.failure.retryable === true) ||
        (error instanceof HostClientRequestError &&
          (error.retryable ||
            error.reason === "computer-view-unavailable" ||
            error.reason === "driver-offline"));
      if (!retry) this.#finish("ended");
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
      if (!controller.signal.aborted && (retry || retired !== this.#retired.size)) this.#schedule();
    }
  }

  #finish(state: OwnerViewReconnectState): void {
    clearTimeout(this.#window);
    clearTimeout(this.#retry);
    this.#controller?.abort();
    this.#window = this.#retry = this.#controller = undefined;
    this.#delay = firstDelayMs;
    this.#retired.clear();
    this.#set(state);
  }

  #set(state: OwnerViewReconnectState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
