import type { PersonalRemoteAdministrationOperation } from "@opensteer/protocol";
import type { DesktopSupervisor } from "./desktop-supervisor.js";
/** Executes durable Host intent independently of the device that requested it. */
export class DesktopRemoteAdministrationExecutor {
  readonly #supervisor: DesktopSupervisor;
  readonly #unsubscribe: () => void;
  readonly #execute: (
    operation: PersonalRemoteAdministrationOperation,
    progress: (detail: string) => void,
  ) => Promise<void>;
  #stopped = false;
  #running: string | null = null;
  #queued: PersonalRemoteAdministrationOperation | null = null;
  #result: { operationId: string; state: "succeeded" | "failed"; detail: string | null } | null =
    null;

  constructor(options: {
    supervisor: DesktopSupervisor;
    execute: (
      operation: PersonalRemoteAdministrationOperation,
      progress: (detail: string) => void,
    ) => Promise<void>;
  }) {
    this.#supervisor = options.supervisor;
    this.#execute = options.execute;
    this.#unsubscribe = options.supervisor.subscribe((message) => {
      if (message.type !== "remote-access.operation") return;
      const operation = message.operation;
      if (this.#result?.operationId === operation.id) {
        this.#send(this.#result);
        return;
      }
      if (this.#running === operation.id) return;
      this.#queued = operation;
      void this.#drain();
    });
  }
  stop(): void {
    this.#stopped = true;
    this.#unsubscribe();
  }
  #send(progress: {
    operationId: string;
    state: "running" | "succeeded" | "failed";
    detail: string | null;
  }): void {
    void this.#supervisor
      .acknowledge({ type: "remote-access.progress", messageId: crypto.randomUUID(), progress })
      .catch(() => {});
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#stopped || !this.#queued) return;
    const operation = this.#queued;
    this.#queued = null;
    this.#running = operation.id;
    try {
      this.#send({
        operationId: operation.id,
        state: "running",
        detail: "Applying remote access change",
      });
      await this.#execute(operation, (detail) =>
        this.#send({ operationId: operation.id, state: "running", detail }),
      );
      this.#result = { operationId: operation.id, state: "succeeded", detail: null };
    } catch {
      this.#result = {
        operationId: operation.id,
        state: "failed",
        detail: "Remote access change failed. Use Recover to resume it.",
      };
    } finally {
      this.#running = null;
      if (this.#result) this.#send(this.#result);
      void this.#drain();
    }
  }
}
