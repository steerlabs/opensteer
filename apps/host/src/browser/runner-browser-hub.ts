import { OpensteerError, type RunnerId } from "@opensteer/core";
import type { RunnerAuxiliaryStream, RunnerStreamLossReason } from "@opensteer/orchestration";
import {
  decodeBrowserRelayFrame,
  type BrowserRelayFrameHeader,
} from "@opensteer/protocol/browser-relay";
import type {
  BrowserRuntimeRelayEvent,
  BrowserRuntimeRelayRequest,
} from "./runner-browser-runtime.js";

/**
 * What the browser module's auxiliary socket can do, as the relay sees it. The
 * fence, the lease and the Runner's identity all come from the registry that
 * admitted the socket; this hub only remembers which socket belongs to which
 * Runner and carries frames between it and the relay.
 */
export interface RunnerBrowserPeer {
  readonly id: string;
  close(code: number, reason: string): void;
  send(message: BrowserRuntimeRelayRequest): Promise<void>;
}

export type BrowserRelayEvent = BrowserRuntimeRelayEvent;

export interface RunnerBrowserHooks {
  readonly onFrame?: (
    stream: RunnerAuxiliaryStream,
    frame: { readonly frame: Buffer; readonly header: BrowserRelayFrameHeader },
  ) => Promise<void>;
  readonly onLost?: (stream: RunnerAuxiliaryStream, reason: RunnerStreamLossReason) => void;
  readonly onMessage?: (stream: RunnerAuxiliaryStream, message: BrowserRelayEvent) => Promise<void>;
}

export interface RunnerBrowserRegistry {
  browserStreams(): readonly RunnerAuxiliaryStream[];
  stream(runnerId: RunnerId): RunnerAuxiliaryStream | null;
  send(runnerId: RunnerId, message: BrowserRuntimeRelayRequest): Promise<void>;
  subscribe(hooks: RunnerBrowserHooks): () => void;
}

/**
 * The Host's end of every browser-module stream.
 *
 * One Runner holds at most one: the registry supersedes an older stream when a
 * newer one is admitted for the same module, so a machine can never be relaying
 * two browsers that each believe they are the machine's browser.
 */
export class RunnerBrowserHub implements RunnerBrowserRegistry {
  readonly #hooks = new Set<RunnerBrowserHooks>();
  readonly #byPeer = new Map<string, { peer: RunnerBrowserPeer; stream: RunnerAuxiliaryStream }>();
  readonly #byRunner = new Map<
    RunnerId,
    { peer: RunnerBrowserPeer; stream: RunnerAuxiliaryStream }
  >();
  #closed = false;

  subscribe(hooks: RunnerBrowserHooks): () => void {
    if (this.#closed) throw new Error("The browser relay hub is closed.");
    this.#hooks.add(hooks);
    return () => this.#hooks.delete(hooks);
  }

  attach(peer: RunnerBrowserPeer, stream: RunnerAuxiliaryStream): void {
    if (this.#closed) throw new Error("The browser relay hub is closed.");
    const entry = { peer, stream };
    this.#byPeer.set(peer.id, entry);
    this.#byRunner.set(stream.identity.runnerId, entry);
  }

  /** Keeps the stream's renewed lease visible to capability leases derived from it. */
  renew(peer: RunnerBrowserPeer, stream: RunnerAuxiliaryStream): void {
    const entry = { peer, stream };
    if (this.#byPeer.has(peer.id)) this.#byPeer.set(peer.id, entry);
    if (this.#byRunner.get(stream.identity.runnerId)?.peer === peer) {
      this.#byRunner.set(stream.identity.runnerId, entry);
    }
  }

  detach(peer: RunnerBrowserPeer, reason: RunnerStreamLossReason): void {
    const entry = this.#byPeer.get(peer.id);
    if (!entry || entry.peer !== peer) return;
    this.#byPeer.delete(peer.id);
    if (this.#byRunner.get(entry.stream.identity.runnerId)?.peer === peer) {
      this.#byRunner.delete(entry.stream.identity.runnerId);
    }
    for (const hooks of this.#hooks) {
      try {
        hooks.onLost?.(entry.stream, reason);
      } catch {
        // A relay observer cannot prevent stream cleanup.
      }
    }
  }

  /**
   * Lets go of a Runner's stream when the registry — not the socket — decided
   * it is over: a lease expired, the machine was revoked, or the primary
   * connection it hung off went away.
   */
  detachRunner(runnerId: RunnerId, reason: RunnerStreamLossReason): void {
    const entry = this.#byRunner.get(runnerId);
    if (!entry) return;
    this.detach(entry.peer, reason);
    entry.peer.close(reason === "revoked" ? 4003 : 4001, `browser stream ${reason}`);
  }

  browserStreams(): readonly RunnerAuxiliaryStream[] {
    return [...this.#byRunner.values()].map((entry) => entry.stream);
  }

  stream(runnerId: RunnerId): RunnerAuxiliaryStream | null {
    return this.#byRunner.get(runnerId)?.stream ?? null;
  }

  async send(runnerId: RunnerId, message: BrowserRuntimeRelayRequest): Promise<void> {
    const entry = this.#byRunner.get(runnerId);
    if (!entry) {
      throw new OpensteerError({
        code: "conflict",
        message: "The browser relay is not connected.",
        retryable: true,
      });
    }
    await entry.peer.send(message);
  }

  async handleMessage(peer: RunnerBrowserPeer, message: BrowserRelayEvent): Promise<void> {
    const entry = this.#requireEntry(peer);
    for (const hooks of this.#hooks) {
      if (hooks.onMessage) await hooks.onMessage(entry.stream, message);
    }
  }

  async handleBinary(peer: RunnerBrowserPeer, value: Buffer): Promise<void> {
    const entry = this.#requireEntry(peer);
    const decoded = decodeBrowserRelayFrame(value);
    for (const hooks of this.#hooks) {
      if (hooks.onFrame) await hooks.onFrame(entry.stream, decoded);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Detaching mutates the map, so iterate a snapshot of it.
    for (const entry of Array.from(this.#byPeer.values())) {
      this.detach(entry.peer, "host-shutdown");
      entry.peer.close(1001, "Host shutting down");
    }
    this.#byPeer.clear();
    this.#byRunner.clear();
    this.#hooks.clear();
  }

  #requireEntry(peer: RunnerBrowserPeer): {
    peer: RunnerBrowserPeer;
    stream: RunnerAuxiliaryStream;
  } {
    const entry = this.#byPeer.get(peer.id);
    if (!entry || entry.peer !== peer) {
      throw new OpensteerError({
        code: "forbidden",
        message: "The browser relay stream is not attached.",
      });
    }
    return entry;
  }
}
