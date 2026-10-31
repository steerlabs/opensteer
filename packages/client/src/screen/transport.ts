import {
  ScreenDoneMessageSchema,
  ScreenReadyMessageSchema,
  ScreenShowMessageSchema,
  type ScreenShowMessage,
} from "@opensteer/protocol";
import type { ScreenPresentationReceipt } from "@opensteer/core";
import type { WebSocketClient } from "../host/host-session-client.js";
import type { ScreenPresentationEndpoint, ScreenPresentationTransport } from "./contract.js";

/** Only the opted-in Main Workspace socket may deliver or acknowledge presentations. */
export class SocketScreenPresentationTransport implements ScreenPresentationTransport {
  readonly #listeners = new Set<(message: ScreenShowMessage | null) => void>();
  readonly #monotonicNow: () => number;
  #socket: WebSocketClient | null = null;
  #subscribedAt = 0;
  #subscribedWallAt = 0;
  #endpoint: ScreenPresentationEndpoint | null = null;

  constructor(monotonicNow: () => number = () => performance.now()) {
    this.#monotonicNow = monotonicNow;
  }

  getEndpoint = (): ScreenPresentationEndpoint | null => this.#endpoint;

  subscribe = (listener: (message: ScreenShowMessage | null) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  begin(socket: WebSocketClient): void {
    this.clear();
    this.#socket = socket;
    this.#subscribedAt = this.#monotonicNow();
    this.#subscribedWallAt = Date.now();
  }

  clear(socket?: WebSocketClient): void {
    if (socket && this.#socket !== socket) return;
    this.#socket = null;
    this.#endpoint = null;
    this.#publish(null);
  }

  receive(socket: WebSocketClient, value: unknown): boolean {
    if (socket !== this.#socket) return false;
    const ready = ScreenReadyMessageSchema.safeParse(value);
    if (ready.success) {
      // A duplicate readiness frame cannot renew old opportunities on this socket.
      if (this.#endpoint) return true;
      const subscribedAt = this.#subscribedAt;
      const subscribedWallAt = this.#subscribedWallAt;
      this.#endpoint = {
        endpointRef: ready.data.endpointRef,
        serverTimeUpperBound: () =>
          ready.data.serverTime +
          Math.max(
            0,
            this.#monotonicNow() - subscribedAt,
            // Some platform monotonic clocks pause during machine suspension.
            Date.now() - subscribedWallAt,
          ),
      };
      this.#publish(null);
      return true;
    }
    const show = ScreenShowMessageSchema.safeParse(value);
    if (!show.success) return false;
    if (show.data.endpointRef === this.#endpoint?.endpointRef) this.#publish(show.data);
    return true;
  }

  acknowledge = (operationId: string, receipt: ScreenPresentationReceipt): void => {
    const socket = this.#socket;
    if (!this.#endpoint || socket?.readyState !== 1) return;
    socket.send(
      JSON.stringify(
        ScreenDoneMessageSchema.parse({
          type: "client.screen.done",
          operationId,
          receipt,
        }),
      ),
    );
  };

  #publish(message: ScreenShowMessage | null): void {
    for (const listener of this.#listeners) listener(message);
  }
}
