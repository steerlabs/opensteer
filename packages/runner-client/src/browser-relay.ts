import { randomUUID } from "node:crypto";
import { type ProtocolError, type RunnerAuxiliaryRequestId } from "@opensteer/protocol";
import {
  HostToBrowserRelayMessageSchema,
  encodeBrowserRelayFrame,
  sameBrowserCapability,
  type BrowserCapabilityLease,
  type BrowserCapabilityReference,
  type BrowserChannelId,
  type HostToBrowserRelayMessage,
} from "@opensteer/protocol/browser-relay";
import {
  BrowserRelayError,
  LocalBrowserRuntimeBridge,
  type BrowserChannelSink,
} from "./browser-bridge.js";
import type { RunnerModuleStream } from "./module-connection.js";

const maxBrowserRelayChannels = 32;

interface ActiveChannel {
  capability: BrowserCapabilityReference;
  expiryTimer: NodeJS.Timeout;
  /**
   * Frames on one channel are strictly ordered, and the Host refuses a sequence
   * that goes backwards. The counter is per channel, so one channel's loss
   * cannot reorder another's.
   */
  sequence: number;
}

/**
 * The Runner's browser module.
 *
 * Everything it does is fenced twice: the auxiliary stream's fence says this is
 * the current stream, and the capability lease says the Host still wants this
 * runtime serving sessions. A grant that has been revoked or has expired closes
 * the channels it covered rather than letting them keep relaying.
 */
export class BrowserModuleRelay {
  readonly #bridge: LocalBrowserRuntimeBridge;
  readonly #channels = new Map<BrowserChannelId, ActiveChannel>();
  #capability: BrowserCapabilityLease | undefined;
  #stream: RunnerModuleStream | undefined;

  constructor(bridge: LocalBrowserRuntimeBridge) {
    this.#bridge = bridge;
  }

  get runtimeId(): string {
    return this.#bridge.runtimeId;
  }

  attach(stream: RunnerModuleStream): void {
    this.#stream = stream;
    if (!stream.browserAttachPublicKeys) {
      throw new BrowserRelayError("The Host did not provide Browser Runtime attach keys.");
    }
    this.#bridge.setAttachPublicKeys(stream.browserAttachPublicKeys);
  }

  detach(): void {
    this.#stream = undefined;
    this.#capability = undefined;
    for (const channel of this.#channels.values()) clearTimeout(channel.expiryTimer);
    this.#channels.clear();
    this.#bridge.closeAll();
  }

  async handleFrame(frame: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary)
      throw new BrowserRelayError("The browser module stream expects JSON from the Host.");
    const message = HostToBrowserRelayMessageSchema.parse(JSON.parse(frame.toString("utf8")));
    const stream = this.#requireStream();
    if (
      message.type === "host.auxiliary.challenge" ||
      message.type === "host.auxiliary.welcome" ||
      message.type === "host.auxiliary.rejected"
    ) {
      throw new BrowserRelayError("The Host repeated the browser stream handshake.");
    }
    if (message.type === "host.auxiliary.lease-renewed") {
      if (message.browserAttachPublicKeys) {
        this.#bridge.setAttachPublicKeys(message.browserAttachPublicKeys);
      }
      return;
    }
    if (message.auxiliaryStreamId !== stream.fence.auxiliaryStreamId) {
      throw new BrowserRelayError("The Host addressed a superseded browser stream.");
    }
    try {
      await this.#handle(message);
    } catch (error) {
      if (message.type === "browser.client-message") throw error;
      await this.#send({
        ...stream.fence,
        channelId: "channelId" in message ? message.channelId : null,
        error: protocolError(error),
        requestId: message.requestId,
        type: "browser.command-error",
      });
    }
  }

  async #handle(
    message: Exclude<
      HostToBrowserRelayMessage,
      {
        readonly type:
          | "host.auxiliary.challenge"
          | "host.auxiliary.lease-renewed"
          | "host.auxiliary.rejected"
          | "host.auxiliary.welcome";
      }
    >,
  ): Promise<void> {
    const stream = this.#requireStream();
    switch (message.type) {
      case "capability.grant":
        this.#capability = message.lease;
        this.#renewChannels(message.lease);
        await this.#send({
          ...stream.fence,
          capability: capabilityReference(message.lease),
          requestId: message.requestId,
          type: "capability.accepted",
        });
        return;
      case "capability.revoke":
        this.#assertCapability(message.capability);
        this.#closeCapabilityChannels(message.capability);
        this.#capability = undefined;
        await this.#send({
          ...stream.fence,
          capability: message.capability,
          requestId: message.requestId,
          type: "capability.revoked",
        });
        return;
      case "browser.health.request":
        await this.#send({
          ...stream.fence,
          browserRuntime: await this.#bridge.health(),
          requestId: message.requestId,
          type: "browser.health",
        });
        return;
      case "browser.attach": {
        const lease = this.#assertCapability(message.capability);
        if (this.#channels.has(message.channelId)) {
          throw new BrowserRelayError("The browser relay channel already exists.");
        }
        if (this.#channels.size >= maxBrowserRelayChannels) {
          throw new BrowserRelayError("This browser relay capacity is full.");
        }
        const expiryTimer = setTimeout(
          () => this.#expireChannel(message.channelId),
          Math.max(0, Date.parse(lease.expiresAt) - Date.now()),
        );
        expiryTimer.unref();
        this.#channels.set(message.channelId, {
          capability: message.capability,
          expiryTimer,
          sequence: 0,
        });
        try {
          await this.#bridge.attach(message.channelId, message.attachTicket, this.#sink());
        } catch (error) {
          this.#removeChannel(message.channelId);
          throw error;
        }
        this.#assertChannel(message.channelId, message.capability);
        await this.#send({
          ...stream.fence,
          capability: message.capability,
          channelId: message.channelId,
          requestId: message.requestId,
          type: "browser.attached",
        });
        return;
      }
      case "browser.client-message": {
        // A relay-side close can race an event the Host already sent. Once the
        // channel is terminal there is nothing left to deliver.
        if (!this.#channels.has(message.channelId)) return;
        const channel = this.#assertChannel(message.channelId, message.capability);
        try {
          await this.#bridge.send(message.channelId, message.message);
        } catch (error) {
          await this.#failChannel(message.channelId, channel, error);
        }
        return;
      }
      case "browser.close":
        this.#assertChannel(message.channelId, message.capability);
        this.#removeChannel(message.channelId);
        this.#bridge.close(message.channelId);
        await this.#send({
          ...stream.fence,
          capability: message.capability,
          channelId: message.channelId,
          code: 1000,
          reason: "Host closed the browser relay.",
          requestId: message.requestId,
          type: "browser.closed",
        });
        return;
    }
  }

  #sink(): BrowserChannelSink {
    return {
      onClosed: (channelId, code, reason) => {
        const channel = this.#channels.get(channelId);
        const stream = this.#stream;
        if (!channel || !stream) return;
        this.#removeChannel(channelId);
        void this.#send({
          ...stream.fence,
          capability: channel.capability,
          channelId,
          code,
          reason,
          type: "browser.closed",
        }).catch(() => undefined);
      },
      onFrame: (channelId, frame) => {
        const channel = this.#channels.get(channelId);
        const stream = this.#stream;
        if (!channel || !stream) return;
        const envelope = encodeBrowserRelayFrame(
          {
            ...stream.fence,
            capability: channel.capability,
            channelId,
            sequence: channel.sequence,
            type: "browser.frame",
          },
          frame,
        );
        channel.sequence += 1;
        void stream.send(envelope, true).catch(() => undefined);
      },
      onServerMessage: (channelId, message) => {
        const channel = this.#channels.get(channelId);
        const stream = this.#stream;
        if (!channel || !stream) return;
        void this.#send({
          ...stream.fence,
          capability: channel.capability,
          channelId,
          message,
          type: "browser.server-message",
        }).catch(() => undefined);
      },
    };
  }

  async #failChannel(
    channelId: BrowserChannelId,
    channel: ActiveChannel,
    error: unknown,
  ): Promise<void> {
    if (this.#channels.get(channelId) !== channel) return;
    const stream = this.#stream;
    this.#removeChannel(channelId);
    this.#bridge.close(channelId, 1011, "browser channel failed");
    if (!stream) return;
    await this.#send({
      ...stream.fence,
      capability: channel.capability,
      channelId,
      error: protocolError(error),
      type: "browser.channel-error",
    });
  }

  #expireChannel(channelId: BrowserChannelId): void {
    const channel = this.#channels.get(channelId);
    const stream = this.#stream;
    if (!channel) return;
    this.#removeChannel(channelId);
    this.#bridge.close(channelId, 4003, "capability lease expired");
    if (!stream) return;
    void this.#send({
      ...stream.fence,
      capability: channel.capability,
      channelId,
      code: 4003,
      reason: "Browser capability lease expired.",
      type: "browser.closed",
    }).catch(() => undefined);
  }

  #renewChannels(lease: BrowserCapabilityLease): void {
    for (const [channelId, channel] of this.#channels) {
      if (channel.capability.runtimeId !== lease.runtimeId) continue;
      clearTimeout(channel.expiryTimer);
      channel.capability = capabilityReference(lease);
      channel.expiryTimer = setTimeout(
        () => this.#expireChannel(channelId),
        Math.max(0, Date.parse(lease.expiresAt) - Date.now()),
      );
      channel.expiryTimer.unref();
    }
  }

  #closeCapabilityChannels(capability: BrowserCapabilityReference): void {
    // Removing a channel mutates the map, so iterate a snapshot of it.
    for (const [channelId, channel] of Array.from(this.#channels)) {
      if (channel.capability.capabilityLeaseId !== capability.capabilityLeaseId) continue;
      this.#removeChannel(channelId);
      this.#bridge.close(channelId, 4003, "capability revoked");
    }
  }

  #assertCapability(capability: BrowserCapabilityReference): BrowserCapabilityLease {
    const lease = this.#capability;
    if (!lease || !sameBrowserCapability(capabilityReference(lease), capability)) {
      throw new BrowserRelayError("The browser capability grant is stale or missing.");
    }
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      throw new BrowserRelayError("The browser capability lease has expired.");
    }
    return lease;
  }

  #assertChannel(
    channelId: BrowserChannelId,
    capability: BrowserCapabilityReference,
  ): ActiveChannel {
    const channel = this.#channels.get(channelId);
    if (!channel || !sameBrowserCapability(channel.capability, capability)) {
      throw new BrowserRelayError("The browser relay channel is stale or missing.");
    }
    return channel;
  }

  #removeChannel(channelId: BrowserChannelId): void {
    const channel = this.#channels.get(channelId);
    if (!channel) return;
    this.#channels.delete(channelId);
    clearTimeout(channel.expiryTimer);
  }

  #requireStream(): RunnerModuleStream {
    const stream = this.#stream;
    if (!stream) throw new BrowserRelayError("The browser module stream is not connected.");
    return stream;
  }

  async #send(message: object): Promise<void> {
    await this.#requireStream().send(JSON.stringify(message), false);
  }
}

export function browserRelayRequestId(prefix: string): RunnerAuxiliaryRequestId {
  return `${prefix}:${randomUUID()}` as RunnerAuxiliaryRequestId;
}

function capabilityReference(lease: BrowserCapabilityLease): BrowserCapabilityReference {
  return {
    capabilityGeneration: lease.capabilityGeneration,
    capabilityLeaseId: lease.capabilityLeaseId,
    runtimeId: lease.runtimeId,
  };
}

function protocolError(error: unknown): ProtocolError {
  const relay = error instanceof BrowserRelayError ? error : undefined;
  return {
    code: relay ? "forbidden" : "internal",
    message: (error instanceof Error ? error.message : "The browser relay failed.").slice(0, 2_000),
    retryable: relay?.retryable ?? false,
  };
}
