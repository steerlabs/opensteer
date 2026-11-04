import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  DesktopSupervisorOutputSchema,
  type DesktopSupervisorInput,
  type DesktopSupervisorOutput,
} from "@opensteer/protocol/desktop-supervisor";
import type { DesktopUpdateState } from "@opensteer/protocol/maintenance";
import type { HostNetwork } from "@opensteer/client/connections";
import type {
  PersonalHostRuntimeRecord,
  PersonalHostRuntimeSource,
} from "../supervisor/personal-host-runtime.js";

export const supervisorAcknowledgementMs = 30_000;
/** The Host answered and said no, unlike a timeout or a lost socket. */
export class DesktopSupervisorRefusal extends Error {}
interface DesktopSupervisorOptions {
  network: Pick<HostNetwork, "openWebSocket">;
  runtime: PersonalHostRuntimeSource;
  authorization: (runtime: PersonalHostRuntimeRecord) => string;
  state: () => DesktopUpdateState;
}
export class DesktopSupervisor {
  readonly #options: DesktopSupervisorOptions;
  readonly incarnationId = crypto.randomUUID();
  readonly #listeners = new Set<(message: DesktopSupervisorOutput) => void>();
  readonly #pending = new Map<
    string,
    {
      message: DesktopSupervisorInput;
      resolve(): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #socket: ReturnType<HostNetwork["openWebSocket"]> | null = null;
  #runtimeIdentity: string | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ready = false;
  #stopped = false;
  constructor(options: DesktopSupervisorOptions) {
    this.#options = options;
  }
  subscribe(listener: (message: DesktopSupervisorOutput) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async connect(): Promise<void> {
    if (this.#stopped) return;
    try {
      const runtime = await this.#options.runtime.current();
      if (this.#stopped || !runtime) return;
      const identity = JSON.stringify(runtime);
      if (this.#socket && identity === this.#runtimeIdentity) return;
      this.#socket?.close();
      this.#ready = false;
      this.#runtimeIdentity = identity;
      this.#open(runtime);
    } catch {
      this.#reconnect();
    }
  }
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#ready = false;
    this.#socket?.close();
    this.#socket = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Desktop supervisor stopped"));
    }
    this.#pending.clear();
  }
  state(state: DesktopUpdateState): void {
    if (this.#ready) this.#send({ type: "desktop-update.state", state });
  }
  acknowledge(message: DesktopSupervisorInput & { messageId: string }): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("Desktop supervisor stopped"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(message.messageId);
        reject(new Error("Desktop supervisor did not acknowledge the update phase"));
      }, supervisorAcknowledgementMs);
      this.#pending.set(message.messageId, { message, resolve, reject, timer });
      if (this.#ready) this.#send(message);
    });
  }
  #reconnect(): void {
    if (!this.#stopped) {
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => void this.connect(), 1000);
    }
  }
  #send(message: DesktopSupervisorInput): void {
    try {
      this.#socket?.send(JSON.stringify(message));
    } catch {
      this.#socket?.close();
    }
  }
  #open(runtime: PersonalHostRuntimeRecord): void {
    const url = new URL("/v1/desktop-supervisor", runtime.localOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("apiVersion", String(hostApiVersion));
    const helloId = crypto.randomUUID();
    const socket = this.#options.network.openWebSocket(
      {
        deploymentId: runtime.discovery.deploymentId,
        url: url.toString(),
        canonicalOrigin: runtime.discovery.canonicalOrigin,
        requestOrigin: runtime.localOrigin,
        authorization: this.#options.authorization(runtime),
      },
      {
        open: () =>
          this.#send({
            type: "hello",
            messageId: helloId,
            incarnationId: this.incarnationId,
            state: this.#options.state(),
          }),
        error: () => socket.close(),
        close: () => {
          if (this.#socket !== socket) return;
          this.#socket = null;
          this.#ready = false;
          this.#reconnect();
        },
        message: (data) => {
          if (this.#socket !== socket) return;
          try {
            if (data.length > 16_384) throw new Error("Oversized supervisor frame");
            const message = DesktopSupervisorOutputSchema.parse(
              JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)),
            );
            if (message.type === "ack") {
              if (message.messageId === helloId) {
                if (!message.accepted) {
                  socket.close();
                  return;
                }
                this.#ready = true;
                for (const pending of this.#pending.values()) this.#send(pending.message);
                return;
              }
              const pending = this.#pending.get(message.messageId);
              if (!pending) return;
              clearTimeout(pending.timer);
              this.#pending.delete(message.messageId);
              if (message.accepted) pending.resolve();
              else
                pending.reject(
                  new DesktopSupervisorRefusal("Desktop supervisor refused the operation phase"),
                );
            } else for (const listener of this.#listeners) listener(message);
          } catch {
            socket.close(1008, "Invalid supervisor message");
          }
        },
      },
    );
    this.#socket = socket;
  }
}
