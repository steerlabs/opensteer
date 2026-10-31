import {
  ScreenDoneMessageSchema,
  ScreenReadyMessageSchema,
  ScreenShowMessageSchema,
  screenPresentationDispatchMs,
  type ScreenShowMessage,
} from "@opensteer/protocol";
import type { ScreenPresentationReceipt } from "@opensteer/core";
import type { WebSocketClient } from "../host/host-session-client.js";
import type { ScreenPresentationEndpoint, ScreenPresentationTransport } from "./contract.js";

// Supported relative Host/client rate error: 1,000 ppm. Bound its accumulated
// uncertainty instead of treating a connection's first clock sample as timeless.
const relativeClockRateBudget = 0.001;
const clockSampleLifetimeMs = 300_000;
const clockDiscontinuityMs = 1_000;
const clockResolutionAllowanceMs = 5;
const renewalIntervalMs = 30_000;
type Timer = ReturnType<typeof globalThis.setTimeout>;

/** Only the opted-in Main Workspace socket may deliver or acknowledge presentations. */
export class SocketScreenPresentationTransport implements ScreenPresentationTransport {
  readonly #listeners = new Set<(message: ScreenShowMessage | null) => void>();
  readonly #monotonicNow: () => number;
  readonly #renew: ((socket: WebSocketClient) => void) | undefined;
  #socket: WebSocketClient | null = null;
  #retiredSocket: WebSocketClient | null = null;
  #subscribedAt = 0;
  #subscribedWallAt = 0;
  #endpoint: ScreenPresentationEndpoint | null = null;
  #sampleTimer: Timer | null = null;
  #renewalTimer: Timer | null = null;
  #lastRenewalAt = -Infinity;

  constructor(
    monotonicNow: () => number = () => performance.now(),
    renew?: (socket: WebSocketClient) => void,
  ) {
    this.#monotonicNow = monotonicNow;
    this.#renew = renew;
  }

  getEndpoint = (): ScreenPresentationEndpoint | null => {
    const endpoint = this.#endpoint;
    return endpoint && Number.isFinite(endpoint.serverTimeUpperBound()) ? endpoint : null;
  };

  subscribe = (listener: (message: ScreenShowMessage | null) => void): (() => void) => {
    this.#listeners.add(listener);
    this.#observeClock();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#clearTimers();
    };
  };

  begin(socket: WebSocketClient): void {
    this.clear();
    this.#socket = socket;
    this.#subscribedAt = this.#monotonicNow();
    this.#subscribedWallAt = Date.now();
  }

  clear(socket?: WebSocketClient): void {
    if (socket && this.#socket !== socket && this.#retiredSocket !== socket) return;
    this.#clearTimers();
    this.#socket = null;
    this.#retiredSocket = null;
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
      const setupElapsed = this.#monotonicNow() - subscribedAt;
      const endpoint: ScreenPresentationEndpoint = {
        endpointRef: ready.data.endpointRef,
        serverTimeUpperBound: () => {
          if (this.#endpoint !== endpoint) return Infinity;
          const monotonicElapsed = this.#monotonicNow() - subscribedAt;
          const wallElapsed = Date.now() - subscribedWallAt;
          const elapsed = Math.max(0, monotonicElapsed, wallElapsed);
          if (
            monotonicElapsed < 0 ||
            !Number.isFinite(elapsed) ||
            elapsed >= clockSampleLifetimeMs ||
            setupElapsed >= screenPresentationDispatchMs / 2 ||
            Math.abs(wallElapsed - monotonicElapsed) >
              clockDiscontinuityMs + elapsed * relativeClockRateBudget
          ) {
            this.#retire(socket);
            return Infinity;
          }
          return (
            ready.data.serverTime +
            elapsed * (1 + relativeClockRateBudget) +
            clockResolutionAllowanceMs
          );
        },
      };
      this.#endpoint = endpoint;
      this.#observeClock();
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

  #observeClock(): void {
    if (this.#listeners.size === 0) return;
    if (this.#retiredSocket) {
      this.#requestRenewal(this.#retiredSocket);
      return;
    }
    if (!this.getEndpoint() || this.#sampleTimer !== null) return;
    const socket = this.#socket!;
    this.#sampleTimer = globalThis.setTimeout(
      () => this.#retire(socket),
      Math.max(0, clockSampleLifetimeMs - (this.#monotonicNow() - this.#subscribedAt)),
    );
  }

  #retire(socket: WebSocketClient): void {
    if (this.#socket !== socket) return;
    this.clear(socket);
    this.#retiredSocket = socket;
    this.#requestRenewal(socket);
  }

  #requestRenewal(socket: WebSocketClient): void {
    if (!this.#renew || this.#listeners.size === 0 || this.#renewalTimer !== null) return;
    const renew = () => {
      this.#renewalTimer = null;
      this.#lastRenewalAt = this.#monotonicNow();
      this.#renew?.(socket);
    };
    const remaining = renewalIntervalMs - (this.#monotonicNow() - this.#lastRenewalAt);
    if (remaining <= 0) renew();
    else this.#renewalTimer = globalThis.setTimeout(renew, remaining);
  }

  #clearTimers(): void {
    if (this.#sampleTimer !== null) globalThis.clearTimeout(this.#sampleTimer);
    if (this.#renewalTimer !== null) globalThis.clearTimeout(this.#renewalTimer);
    this.#sampleTimer = null;
    this.#renewalTimer = null;
  }
}
