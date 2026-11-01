export const browserOpeningTimeoutMs = 25_000;
export const browserPresentationTimeoutMessage =
  "This page is open, but it could not be shown. Retry viewing this page.";

/** A local presentation wait; retry never creates or navigates a browser page. */
export class BrowserPresentationWait {
  readonly #listeners = new Set<() => void>();
  #deadline: number;
  #state: "waiting" | "presented" | "expired" = "waiting";
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(deadline: number) {
    this.#deadline = deadline;
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly getSnapshot = (): "waiting" | "presented" | "expired" =>
    this.#state === "waiting" && Date.now() >= this.#deadline ? "expired" : this.#state;
  start(): void {
    clearTimeout(this.#timer);
    if (this.#state !== "waiting") return;
    this.#timer = setTimeout(
      () => {
        this.#state = "expired";
        this.#notify();
      },
      Math.max(0, this.#deadline - Date.now()),
    );
  }
  readonly presented = (): boolean => {
    if (this.getSnapshot() === "expired") return false;
    this.#state = "presented";
    clearTimeout(this.#timer);
    this.#notify();
    return true;
  };
  readonly retry = (): void => {
    this.#deadline = Date.now() + browserOpeningTimeoutMs;
    this.#state = "waiting";
    this.start();
    this.#notify();
  };
  dispose(): void {
    clearTimeout(this.#timer);
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
