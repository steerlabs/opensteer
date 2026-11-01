import { randomUUID } from "node:crypto";
import {
  type BrowserBridgeAttached,
  type ProtocolError,
  type RunnerAuxiliaryRequestId,
} from "@opensteer/protocol";
import {
  createHostToBrowserRelayMessageSchema,
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
  #inventoryComplete = false;
  #capability: BrowserCapabilityLease | undefined;
  #authority = Symbol();
  #stream: RunnerModuleStream | undefined;

  constructor(bridge: LocalBrowserRuntimeBridge) {
    this.#bridge = bridge;
  }

  get runtimeId(): string {
    return this.#bridge.runtimeId;
  }

  async attach(stream: RunnerModuleStream): Promise<void> {
    this.#stream = stream;
    this.#inventoryComplete = stream.localProfiles !== 1;
    this.#bridge.setPasskeysEnabled(stream.passkeys === 1);
    this.#bridge.setNegotiation({
      ...(stream.localProfiles === 1
        ? { localProfiles: 1, ...(stream.profilePrepare === 1 ? { profilePrepare: 1 } : {}) }
        : {}),
      ...(stream.initialNavigationVersion === 1 ? { initialNavigationVersion: 1 } : {}),
    });
    if (!stream.browserAttachPublicKeys) {
      throw new BrowserRelayError("The Host did not provide Browser Runtime attach keys.");
    }
    this.#bridge.setAttachPublicKeys(stream.browserAttachPublicKeys);
    if (stream.localProfiles === 1) {
      const inventory = await this.#bridge.localProfileInventory();
      for (let offset = 0; offset < inventory.profiles.length || offset === 0; offset += 128) {
        if (this.#stream !== stream)
          throw new BrowserRelayError("The browser inventory stream was superseded.");
        await stream.send(
          JSON.stringify({
            ...stream.fence,
            type: "browser.profile.inventory",
            storageInstanceId: inventory.storage.storageInstanceId,
            engine: inventory.storage.engine,
            profiles: inventory.profiles.slice(offset, offset + 128),
            complete: offset + 128 >= inventory.profiles.length,
          }),
          false,
        );
      }
    }
    if (this.#stream !== stream)
      throw new BrowserRelayError("The browser inventory stream was superseded.");
    this.#inventoryComplete = true;
  }

  detach(): void {
    this.#bridge.setPasskeysEnabled(false);
    this.#bridge.setNegotiation({});
    this.#stream = undefined;
    this.#capability = undefined;
    this.#authority = Symbol();
    for (const channel of this.#channels.values()) clearTimeout(channel.expiryTimer);
    this.#channels.clear();
    this.#bridge.closeAll();
  }

  async handleFrame(frame: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary)
      throw new BrowserRelayError("The browser module stream expects JSON from the Host.");
    const stream = this.#requireStream();
    const message = createHostToBrowserRelayMessageSchema(stream).parse(
      JSON.parse(frame.toString("utf8")),
    );
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
    const handle = async () => {
      try {
        await this.#handle(message);
      } catch (error) {
        if (this.#stream !== stream) return;
        if (message.type === "browser.client-message") throw error;
        await this.#send({
          ...stream.fence,
          channelId: "channelId" in message ? message.channelId : null,
          error: protocolError(error),
          requestId: message.requestId,
          type: "browser.command-error",
        });
      }
    };
    // Process start/import never occupies the auxiliary stream's ordered input
    // dispatcher. Channel registration happens synchronously before the await.
    if (
      message.type === "browser.attach" ||
      message.type === "browser.profile.prepare" ||
      message.type === "browser.profile.delete"
    ) {
      void handle().catch(() => undefined);
      return;
    }
    await handle();
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
        if (
          !this.#capability ||
          this.#capability.runtimeId !== message.lease.runtimeId ||
          Date.parse(this.#capability.expiresAt) <= Date.now() ||
          (message.lease.capabilityGeneration <= this.#capability.capabilityGeneration &&
            !sameBrowserCapability(message.lease, this.#capability))
        ) {
          if (this.#capability) this.#closeCapabilityChannels(this.#capability);
          this.#authority = Symbol();
        }
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
        this.#authority = Symbol();
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
      case "browser.profile.prepare":
      case "browser.attach": {
        if (!this.#inventoryComplete)
          throw new BrowserRelayError("Local browser profile inventory has not completed.");
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
        const channel: ActiveChannel = {
          capability: message.capability,
          expiryTimer,
          sequence: 0,
        };
        this.#channels.set(message.channelId, channel);
        const authority = this.#authority;
        let attached: BrowserBridgeAttached & { retained?: boolean };
        try {
          attached = await this.#bridge.attach(
            message.channelId,
            message.type === "browser.attach" ? message.attachTicket : message.preparationTicket,
            this.#sink(channel),
            message.type === "browser.profile.prepare",
          );
          if (
            this.#stream !== stream ||
            this.#authority !== authority ||
            this.#channels.get(message.channelId) !== channel
          )
            throw new BrowserRelayError("The browser attachment authority was superseded.");
          this.#assertCapability(channel.capability);
        } catch (error) {
          const current = this.#channels.get(message.channelId);
          if (!current || current === channel) {
            this.#removeChannel(message.channelId);
            this.#bridge.close(message.channelId, 4003, "browser attachment invalidated");
          }
          throw error;
        }
        await this.#send({
          ...stream.fence,
          capability: message.capability,
          channelId: message.channelId,
          requestId: message.requestId,
          type: message.type === "browser.attach" ? "browser.attached" : "browser.profile.prepared",
          ...(message.type === "browser.profile.prepare"
            ? { retained: attached.retained === true }
            : {}),
          ...(message.type === "browser.attach" &&
          stream.initialNavigationVersion === 1 &&
          attached.initialPage
            ? { initialPage: attached.initialPage }
            : {}),
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
      case "browser.profile.delete": {
        this.#assertCapability(message.capability);
        const authority = this.#authority;
        const state = await this.#bridge.deleteLocalProfile(message.binding, message.deletionId);
        if (this.#stream !== stream || this.#authority !== authority || !this.#capability)
          throw new BrowserRelayError("The browser deletion authority was superseded.");
        this.#assertCapability(capabilityReference(this.#capability));
        await this.#send({ ...message, type: "browser.profile.delete.result", state });
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

  #sink(owner: ActiveChannel): BrowserChannelSink {
    return {
      onClosed: (channelId, code, reason) => {
        const channel = this.#channels.get(channelId);
        const stream = this.#stream;
        if (!channel || channel !== owner || !stream) return;
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
        if (!channel || channel !== owner || !stream) return;
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
        if (!channel || channel !== owner || !stream) return;
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
