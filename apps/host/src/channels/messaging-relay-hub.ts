import { randomBytes } from "node:crypto";
import type {
  ChannelProvider,
  ChannelRuntimeCapability,
  ChannelTransportKind,
} from "@opensteer/channel-core";
import { OpensteerError, type RunnerId } from "@opensteer/core";
import type { RunnerAuxiliaryStream, RunnerStreamLossReason } from "@opensteer/orchestration";
import {
  ChannelResponseSchema,
  type ChannelResponse,
  type HostToMessagingRelayMessage,
} from "@opensteer/channel-protocol";

const requestTimeoutMs = 15_000;

export interface MessagingRelayPeer {
  readonly id: string;
  close(code: number, reason: string): void;
  send(message: HostToMessagingRelayMessage): Promise<void>;
}

interface AttachedRelay {
  readonly peer: MessagingRelayPeer;
  readonly stream: RunnerAuxiliaryStream;
}

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly runnerId: RunnerId;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The Host's end of every messaging-module stream.
 *
 * A brief flap must not move a messaging account to another computer: an
 * assignment that bounced between machines whenever a socket blinked would
 * reorder deliveries and duplicate transport subscriptions. So a Runner whose
 * stream dropped stays *assignable* until its stream lease would have expired,
 * even though nothing can be sent to it in the meantime. Revocation and lease
 * expiry drop it at once, because those say the machine is not coming back.
 */
export class MessagingRelayHub {
  readonly #attached = new Map<RunnerId, AttachedRelay>();
  readonly #byPeer = new Map<string, AttachedRelay>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #recentlyLost = new Map<
    RunnerId,
    { readonly capabilities: readonly ChannelRuntimeCapability[]; readonly expiresAt: number }
  >();
  readonly #now: () => number;
  #closed = false;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  attach(peer: MessagingRelayPeer, stream: RunnerAuxiliaryStream): void {
    if (this.#closed) throw new Error("The messaging relay hub is closed");
    const entry = { peer, stream };
    const previous = this.#attached.get(stream.identity.runnerId);
    this.#attached.set(stream.identity.runnerId, entry);
    this.#byPeer.set(peer.id, entry);
    this.#recentlyLost.delete(stream.identity.runnerId);
    if (previous && previous.peer !== peer) {
      this.#byPeer.delete(previous.peer.id);
      this.#rejectRunnerRequests(
        stream.identity.runnerId,
        "The messaging relay connection was replaced",
      );
      previous.peer.close(4001, "Messaging relay superseded");
    }
  }

  /** Keeps flap retention aligned with the registry's renewed stream lease. */
  renew(peer: MessagingRelayPeer, stream: RunnerAuxiliaryStream): void {
    const current = this.#byPeer.get(peer.id);
    if (!current || current.peer !== peer) return;
    const entry = { peer, stream };
    this.#byPeer.set(peer.id, entry);
    if (this.#attached.get(stream.identity.runnerId) === current) {
      this.#attached.set(stream.identity.runnerId, entry);
    }
  }

  detach(peer: MessagingRelayPeer, reason: RunnerStreamLossReason): void {
    const entry = this.#byPeer.get(peer.id);
    if (!entry || entry.peer !== peer) return;
    this.#byPeer.delete(peer.id);
    if (this.#attached.get(entry.stream.identity.runnerId) !== entry) return;
    this.#attached.delete(entry.stream.identity.runnerId);
    this.#rejectRunnerRequests(entry.stream.identity.runnerId, "The messaging relay disconnected");
    const capabilities = entry.stream.identity.modules.messaging?.capabilities;
    if (reason === "revoked" || reason === "lease-expired" || !capabilities) return;
    this.#recentlyLost.set(entry.stream.identity.runnerId, {
      capabilities,
      expiresAt: Date.parse(entry.stream.streamLeaseExpiresAt),
    });
  }

  /** Drops a Runner's assignments immediately, however its stream ended. */
  forget(runnerId: RunnerId): void {
    this.#recentlyLost.delete(runnerId);
    const entry = this.#attached.get(runnerId);
    if (!entry) return;
    this.#attached.delete(runnerId);
    this.#byPeer.delete(entry.peer.id);
    this.#rejectRunnerRequests(runnerId, "The messaging relay was revoked");
    entry.peer.close(4003, "Messaging relay revoked");
  }

  /**
   * Lets go of a Runner's stream when the registry decided it is over. The
   * reason is what says whether the machine keeps its messaging assignments:
   * `detach` holds them through a flap and drops them on revocation.
   */
  detachRunner(runnerId: RunnerId, reason: RunnerStreamLossReason): void {
    const entry = this.#attached.get(runnerId);
    if (!entry) return;
    this.detach(entry.peer, reason);
    entry.peer.close(reason === "revoked" ? 4003 : 4001, `messaging stream ${reason}`);
  }

  isConnected(runnerId: RunnerId): boolean {
    return this.#attached.has(runnerId);
  }

  capabilities(runnerId: RunnerId): readonly ChannelRuntimeCapability[] {
    const attached = this.#attached.get(runnerId)?.stream.identity.modules.messaging?.capabilities;
    if (attached) return attached;
    return this.#liveRecentlyLost().get(runnerId) ?? [];
  }

  /**
   * Which computers may hold a messaging assignment. It deliberately includes a
   * Runner whose stream dropped a moment ago; see the class comment.
   */
  assignableRunnerIds(): readonly RunnerId[] {
    return [...new Set([...this.#attached.keys(), ...this.#liveRecentlyLost().keys()])].sort();
  }

  connectedRunnerIds(): readonly RunnerId[] {
    return [...this.#attached.keys()].sort();
  }

  /**
   * Whether some connected computer can actually carry this provider. What a
   * provider *is* comes from the catalog, never from a computer, so there is
   * nothing here for two computers to disagree about.
   */
  supports(provider: ChannelProvider, transportKind: ChannelTransportKind): boolean {
    return this.selectRunner(provider, transportKind) !== null;
  }

  selectRunner(provider: ChannelProvider, transportKind: ChannelTransportKind): RunnerId | null {
    const available = [...this.#attached.values()]
      .filter(({ stream }) =>
        (stream.identity.modules.messaging?.capabilities ?? []).some(
          (capability) =>
            capability.provider === provider && capability.transportKinds.includes(transportKind),
        ),
      )
      .map(({ stream }) => stream.identity.runnerId)
      .sort();
    return available[0] ?? null;
  }

  async request(
    runnerId: RunnerId,
    operation: "connection.inspect" | "connections.sync",
    payload: unknown,
  ): Promise<unknown> {
    const entry = this.#attached.get(runnerId);
    if (!entry) {
      throw new OpensteerError({
        code: "conflict",
        message: "Messaging service is not connected",
        retryable: true,
      });
    }
    const requestId = `crq_${randomBytes(24).toString("base64url")}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(
          new OpensteerError({
            code: "timeout",
            message: "Messaging service did not answer in time",
            retryable: true,
          }),
        );
      }, requestTimeoutMs);
      timer.unref();
      this.#pending.set(requestId, { reject, resolve, runnerId, timer });
    });
    try {
      await entry.peer.send({
        ...entry.stream.fence,
        operation,
        payload,
        requestId,
        type: "host.request",
      } as HostToMessagingRelayMessage);
    } catch (error) {
      const pending = this.#pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error("Messaging request failed"));
      }
    }
    return result;
  }

  handleResponse(runnerId: RunnerId, input: unknown): void {
    const response: ChannelResponse = ChannelResponseSchema.parse(input);
    if (response.type !== "runtime.response") {
      throw new OpensteerError({ code: "bad_request", message: "Invalid messaging response" });
    }
    const pending = this.#pending.get(response.requestId);
    if (!pending || pending.runnerId !== runnerId) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown messaging request" });
    }
    clearTimeout(pending.timer);
    this.#pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else {
      pending.reject(
        new OpensteerError({
          code: protocolErrorCode(response.error.code),
          message: response.error.message,
          retryable: response.error.retryable,
        }),
      );
    }
  }

  stream(runnerId: RunnerId): RunnerAuxiliaryStream | null {
    return this.#attached.get(runnerId)?.stream ?? null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#attached.values()) entry.peer.close(1001, "Host stopping");
    this.#attached.clear();
    this.#byPeer.clear();
    this.#recentlyLost.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Host is stopping"));
    }
    this.#pending.clear();
  }

  #liveRecentlyLost(): Map<RunnerId, readonly ChannelRuntimeCapability[]> {
    const now = this.#now();
    const live = new Map<RunnerId, readonly ChannelRuntimeCapability[]>();
    for (const [runnerId, entry] of this.#recentlyLost) {
      if (entry.expiresAt <= now) {
        this.#recentlyLost.delete(runnerId);
        continue;
      }
      live.set(runnerId, entry.capabilities);
    }
    return live;
  }

  #rejectRunnerRequests(runnerId: RunnerId, message: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.runnerId !== runnerId) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(new OpensteerError({ code: "conflict", message, retryable: true }));
    }
  }
}

function protocolErrorCode(code: string): "bad_request" | "conflict" | "internal" | "timeout" {
  if (code === "bad_request" || code === "conflict" || code === "timeout") return code;
  return "internal";
}
