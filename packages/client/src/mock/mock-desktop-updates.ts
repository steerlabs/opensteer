import {
  DesktopUpdateRequestSchema,
  desktopUpdateLongPollMs,
  type DesktopUpdateOperation,
  type DesktopUpdateRequest,
  type DesktopUpdateStatus,
} from "@opensteer/protocol/maintenance";
import { DesktopUpdatesError, type DesktopUpdates } from "../connections/desktop-updates.js";

export type MockDesktopUpdateScenario =
  "idle" | "available" | "in-progress" | "succeeded" | "failed" | "unsupported" | "offline";
export class MockDesktopUpdates implements DesktopUpdates {
  #scenario: MockDesktopUpdateScenario;
  #revision = 0;
  #operation: DesktopUpdateOperation | null = null;
  readonly #requests = new Map<
    string,
    { request: DesktopUpdateRequest; operation: DesktopUpdateOperation }
  >();
  readonly #listeners = new Set<() => void>();
  constructor(scenario: MockDesktopUpdateScenario = "idle") {
    this.#scenario = scenario;
    this.setScenario(scenario);
  }
  setScenario(scenario: MockDesktopUpdateScenario): void {
    this.#scenario = scenario;
    if (["in-progress", "succeeded", "failed"].includes(scenario)) {
      const now = new Date().toISOString();
      this.#operation = {
        id: this.#operation?.id ?? crypto.randomUUID(),
        intent: this.#operation?.intent ?? { action: "update" },
        state:
          scenario === "in-progress" ? "staged" : scenario === "succeeded" ? "succeeded" : "failed",
        fromVersion: "0.1.400",
        targetVersion: "0.1.401",
        incarnationId: crypto.randomUUID(),
        detail: scenario === "failed" ? "update-failed" : null,
        createdAt: this.#operation?.createdAt ?? now,
        updatedAt: now,
      };
    } else this.#operation = null;
    if (this.#operation) {
      for (const entry of this.#requests.values())
        if (entry.operation.id === this.#operation.id) entry.operation = this.#operation;
    }
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }
  async status(
    options: { after?: string; signal?: AbortSignal } = {},
  ): Promise<DesktopUpdateStatus> {
    options.signal?.throwIfAborted();
    this.#assertOnline();
    if (options.after === this.#cursor())
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(options.signal?.reason);
        };
        const timer = setTimeout(finish, desktopUpdateLongPollMs);
        const cleanup = () => {
          clearTimeout(timer);
          this.#listeners.delete(finish);
          options.signal?.removeEventListener("abort", abort);
        };
        this.#listeners.add(finish);
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    this.#assertOnline();
    return this.#view();
  }
  async request(
    input: DesktopUpdateRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<DesktopUpdateOperation> {
    options.signal?.throwIfAborted();
    const request = DesktopUpdateRequestSchema.parse(input);
    if (this.#scenario === "unsupported" || this.#scenario === "offline")
      throw new DesktopUpdatesError(this.#scenario);
    const replay = this.#requests.get(request.idempotencyKey);
    if (replay) {
      if (JSON.stringify(replay.request.intent) !== JSON.stringify(request.intent))
        throw new DesktopUpdatesError("conflict");
      return this.#operation?.id === replay.operation.id ? this.#operation : replay.operation;
    }
    if (this.#operation && !["failed", "succeeded"].includes(this.#operation.state))
      throw new DesktopUpdatesError("conflict");
    const now = new Date().toISOString();
    this.#operation = {
      id: crypto.randomUUID(),
      intent: request.intent,
      state: "pending",
      fromVersion: null,
      targetVersion: null,
      incarnationId: null,
      detail: null,
      createdAt: now,
      updatedAt: now,
    };
    this.setScenario("in-progress");
    const operation = this.#operation;
    this.#requests.set(request.idempotencyKey, { request, operation });
    return operation;
  }
  subscribeWhileVisible(
    listener: (status: DesktopUpdateStatus) => void,
    options: { signal: AbortSignal; onError: (error: unknown) => void },
  ): () => void {
    const emit = () => {
      if (options.signal.aborted) return;
      if (this.#scenario === "offline") options.onError(new DesktopUpdatesError("offline"));
      else listener(this.#view());
    };
    const stop = () => {
      this.#listeners.delete(emit);
      options.signal.removeEventListener("abort", stop);
    };
    if (!options.signal.aborted) {
      this.#listeners.add(emit);
      options.signal.addEventListener("abort", stop, { once: true });
      emit();
    }
    return stop;
  }
  #assertOnline(): void {
    if (this.#scenario === "offline") throw new DesktopUpdatesError("offline");
  }
  #cursor(): string {
    return `mock:${this.#revision}`;
  }
  #view(): DesktopUpdateStatus {
    return {
      supported: this.#scenario !== "unsupported",
      revision: this.#cursor(),
      operation: this.#operation,
      state:
        this.#scenario === "unsupported"
          ? null
          : {
              status:
                this.#scenario === "available"
                  ? "available"
                  : this.#scenario === "in-progress"
                    ? "downloading"
                    : this.#scenario === "failed"
                      ? "error"
                      : "idle",
              currentVersion: this.#scenario === "succeeded" ? "0.1.401" : "0.1.400",
              channel: "stable",
              availableVersion: ["available", "in-progress"].includes(this.#scenario)
                ? "0.1.401"
                : null,
              latestVersion: "0.1.401",
              failed: this.#scenario === "failed" ? "download" : null,
              downloadPercent: this.#scenario === "in-progress" ? 42 : null,
            },
    };
  }
}
