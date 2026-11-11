import { BrowserRuntimeError } from "../errors.js";

export class TabLease {
  state: "live" | "sleeping" | "suspended" | "resuming" | "closing" = "live";
  demanded = false;
  private operations = 0;
  private sleeping: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  private resuming: Promise<void> | null = null;

  private readonly changed: () => void;
  constructor(changed: () => void = () => {}) {
    this.changed = changed;
  }

  get busy(): boolean {
    return this.operations > 0;
  }

  async use<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "sleeping") {
      this.demand();
      await this.sleeping!.promise;
    }
    if (this.state === "closing")
      throw new BrowserRuntimeError("not_found", "The browser tab closed.");
    if (this.state !== "live")
      throw new BrowserRuntimeError("conflict", "Resume this tab before using its new document.", {
        reason: "target-suspended",
        retryable: true,
      });
    this.operations++;
    try {
      return await operation();
    } finally {
      this.operations--;
      this.changed();
    }
  }

  demand(): void {
    if (this.state === "sleeping") this.demanded = true;
  }

  beginSleep(): boolean {
    if (this.state !== "live" || this.busy) return false;
    this.state = "sleeping";
    this.demanded = false;
    this.sleeping = Promise.withResolvers<void>();
    return true;
  }

  endSleep(committed: boolean): void {
    if (this.state === "sleeping") this.state = committed ? "suspended" : "live";
    this.sleeping?.resolve();
    this.sleeping = null;
    this.changed();
  }

  resume(start: () => Promise<void>): Promise<void> {
    if (this.resuming) return this.resuming;
    const resume = async () => {
      if (this.state === "sleeping") {
        this.demand();
        await this.sleeping!.promise;
      }
      if (this.state === "live") return;
      if (this.state === "closing")
        throw new BrowserRuntimeError("not_found", "The browser tab closed.");
      this.state = "resuming";
      try {
        await start();
        if (this.state === "resuming") this.state = "live";
      } catch (error) {
        if (this.state === "resuming") this.state = "suspended";
        throw error;
      }
    };
    this.resuming = resume().finally(() => {
      this.resuming = null;
      this.changed();
    });
    return this.resuming;
  }

  close(): void {
    this.state = "closing";
    this.sleeping?.resolve();
    this.changed();
  }
}
