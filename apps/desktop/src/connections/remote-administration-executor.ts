import type { PersonalRemoteAdministrationOperation } from "@opensteer/protocol";
import type {
  DesktopPersonalAccountLinkStatus,
  DesktopPersonalRemoteAccessPhase,
} from "@opensteer/protocol/desktop";
import { PersonalHostRefusalError } from "../supervisor/personal-host-control.js";
import type { DesktopSupervisor } from "./desktop-supervisor.js";

/**
 * What a person reads when a change fails: the Host's own refusal, or one plain
 * sentence. Anything else may carry a path, a URL or a credential, so it goes
 * only to the caller's redacting log.
 */
export function remoteAccessFailureDetail(error: unknown): string {
  return error instanceof PersonalHostRefusalError
    ? error.message
    : "Something went wrong. Try again.";
}

/** Progress a person can read while the change runs. */
export function remoteAccessProgressDetail(phase: DesktopPersonalRemoteAccessPhase): string | null {
  switch (phase) {
    case "linking-account":
      return "Adding this computer to your account…";
    case "provisioning":
      return "Setting up the connection…";
    case "revoking":
      return "Turning off the connection…";
    default:
      return null;
  }
}

export function accountLinkProgressDetail(status: DesktopPersonalAccountLinkStatus): string | null {
  if (status.status === "unlinking") return "Removing this computer from your account…";
  if (status.status === "activating") return "Adding this computer to your account…";
  return null;
}
/** Executes durable Host intent independently of the device that requested it. */
export class DesktopRemoteAdministrationExecutor {
  readonly #supervisor: DesktopSupervisor;
  readonly #unsubscribe: () => void;
  readonly #execute: (
    operation: PersonalRemoteAdministrationOperation,
    progress: (detail: string) => void,
  ) => Promise<void>;
  readonly #report: (error: unknown) => void;
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
    /** Receives the raw failure; it must redact before writing anywhere. */
    report?: (error: unknown) => void;
  }) {
    this.#supervisor = options.supervisor;
    this.#execute = options.execute;
    this.#report = options.report ?? (() => {});
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
        detail: "Applying the change…",
      });
      await this.#execute(operation, (detail) =>
        this.#send({ operationId: operation.id, state: "running", detail }),
      );
      this.#result = { operationId: operation.id, state: "succeeded", detail: null };
    } catch (error) {
      this.#report(error);
      this.#result = {
        operationId: operation.id,
        state: "failed",
        detail: remoteAccessFailureDetail(error),
      };
    } finally {
      this.#running = null;
      if (this.#result) this.#send(this.#result);
      void this.#drain();
    }
  }
}
