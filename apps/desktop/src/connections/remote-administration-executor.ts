import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  PersonalRemoteAdministrationOperationSchema,
  type PersonalRemoteAdministrationOperation,
} from "@opensteer/protocol";
import type { HostNetwork } from "@opensteer/client/connections";
import type {
  PersonalHostRuntimeRecord,
  PersonalHostRuntimeSource,
} from "../supervisor/personal-host-runtime.js";

/** Executes durable Host intent independently of the device that requested it. */
export class DesktopRemoteAdministrationExecutor {
  readonly #network: Pick<HostNetwork, "openWebSocket">;
  readonly #runtime: PersonalHostRuntimeSource;
  readonly #authorization: (runtime: PersonalHostRuntimeRecord) => string;
  readonly #execute: (
    operation: PersonalRemoteAdministrationOperation,
    progress: (detail: string) => void,
  ) => Promise<void>;
  #ready = false;
  #socket: ReturnType<HostNetwork["openWebSocket"]> | null = null;
  #runtimeIdentity: string | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #running: string | null = null;
  #queued: PersonalRemoteAdministrationOperation | null = null;
  #result: { operationId: string; state: "succeeded" | "failed"; detail: string | null } | null =
    null;

  constructor(options: {
    network: Pick<HostNetwork, "openWebSocket">;
    runtime: PersonalHostRuntimeSource;
    authorization: (runtime: PersonalHostRuntimeRecord) => string;
    execute: (
      operation: PersonalRemoteAdministrationOperation,
      progress: (detail: string) => void,
    ) => Promise<void>;
  }) {
    this.#network = options.network;
    this.#authorization = options.authorization;
    this.#runtime = options.runtime;
    this.#execute = options.execute;
  }

  async connect(): Promise<void> {
    if (this.#stopped) return;
    try {
      const runtime = await this.#runtime.current();
      if (this.#stopped || !runtime) return;
      const identity = JSON.stringify(runtime);
      if (this.#socket && identity === this.#runtimeIdentity) return;
      this.#socket?.close();
      this.#ready = false;
      this.#runtimeIdentity = identity;
      this.#open(runtime);
    } catch {
      if (!this.#stopped) this.#timer = setTimeout(() => void this.connect(), 1000);
    }
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#socket?.close();
    this.#socket = null;
  }

  #open(runtime: PersonalHostRuntimeRecord): void {
    const url = new URL("/v1/personal-remote-access/executor", runtime.localOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("apiVersion", String(hostApiVersion));
    const authorization = this.#authorization(runtime);
    const socket = this.#network.openWebSocket(
      {
        deploymentId: runtime.discovery.deploymentId,
        url: url.toString(),
        canonicalOrigin: runtime.discovery.canonicalOrigin,
        requestOrigin: runtime.localOrigin,
        authorization,
      },
      {
        open: () => {
          this.#ready = true;
        },
        error: () => socket.close(),
        close: () => {
          if (this.#socket !== socket) return;
          this.#socket = null;
          this.#ready = false;
          if (!this.#stopped) this.#timer = setTimeout(() => void this.connect(), 1000);
        },
        message: (data) => {
          try {
            const operation = PersonalRemoteAdministrationOperationSchema.parse(
              JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)),
            );
            if (this.#result?.operationId === operation.id) {
              this.#send(this.#result);
              return;
            }
            if (this.#running === operation.id) return;
            this.#queued = operation;
            void this.#drain();
          } catch {
            socket.close(1008, "Invalid remote access operation");
          }
        },
      },
    );
    this.#socket = socket;
  }

  #send(progress: {
    operationId: string;
    state: "running" | "succeeded" | "failed";
    detail: string | null;
  }): void {
    if (this.#ready) {
      try {
        this.#socket?.send(JSON.stringify(progress));
      } catch {
        this.#socket?.close();
      }
    }
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
