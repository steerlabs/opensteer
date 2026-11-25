import { standardCdpSettledReason } from "@opensteer/protocol/standard-cdp";
import { RawCdpChunks, RawCdpWriter } from "@opensteer/protocol/raw-cdp-relay";
import {
  BrowserAttachTicketClaimsSchema,
  browserHostMethods,
  type BrowserClientMessage,
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
import { randomUUID } from "node:crypto";
import {
  BrowserRelayError,
  LocalBrowserRuntimeBridge,
  type BrowserChannelSink,
} from "./browser-bridge.js";
import type { RunnerModuleStream } from "./module-connection.js";

/** How long a pool guest's runtime may take to answer the Home's close of a channel. */
const pooledCloseReceiptMs = 5_000;

interface ActiveChannel {
  capability: BrowserCapabilityReference;
  expiryTimer: NodeJS.Timeout;
  /**
   * Frames on one channel are strictly ordered, and the Host refuses a sequence
   * that goes backwards. The counter is per channel, so one channel's loss
   * cannot reorder another's.
   */
  sequence: number;
  readonly raw?: { reader: RawCdpChunks; writer: RawCdpWriter };
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
  readonly #stopped: () => boolean;
  readonly #channels = new Map<BrowserChannelId, ActiveChannel>();
  #inventoryComplete = false;
  #capability: BrowserCapabilityLease | undefined;
  #authority = Symbol();
  #stream: RunnerModuleStream | undefined;
  #streamLifetime = new AbortController();

  constructor(bridge: LocalBrowserRuntimeBridge, stopped: boolean | (() => boolean) = false) {
    this.#bridge = bridge;
    this.#stopped = typeof stopped === "function" ? stopped : () => stopped;
  }

  get busy(): boolean {
    return this.#channels.size > 0;
  }

  get runtimeId(): string {
    return this.#bridge.runtimeId;
  }

  async attach(stream: RunnerModuleStream, signal?: AbortSignal): Promise<void> {
    this.#stream = stream;
    this.#streamLifetime.abort();
    this.#streamLifetime = new AbortController();
    const attachSignal = signal
      ? AbortSignal.any([signal, this.#streamLifetime.signal])
      : this.#streamLifetime.signal;
    attachSignal.throwIfAborted();
    if (stream.browserWireVersion !== 2)
      throw new BrowserRelayError("Update this Host to use the current browser runtime contract.");
    const capabilities = await this.#bridge.capabilities(attachSignal);
    attachSignal.throwIfAborted();
    if (capabilities.wireVersion !== 2)
      throw new BrowserRelayError(
        "Update the Browser Runtime on this computer. The current native browser contract is required.",
      );
    this.#inventoryComplete = !capabilities.localProfileStorage;
    this.#bridge.setPasskeysEnabled(stream.passkeys === 1);

    if (!stream.browserAttachPublicKeys) {
      throw new BrowserRelayError("The Host did not provide Browser Runtime attach keys.");
    }
    this.#bridge.setAttachPublicKeys(stream.browserAttachPublicKeys);
    if (capabilities.localProfileStorage) {
      const inventory = await this.#bridge.localProfileInventory(attachSignal);
      attachSignal.throwIfAborted();
      for (let offset = 0; offset < inventory.profiles.length || offset === 0; offset += 128) {
        attachSignal.throwIfAborted();
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
    attachSignal.throwIfAborted();
    if (this.#stream !== stream)
      throw new BrowserRelayError("The browser inventory stream was superseded.");
    this.#inventoryComplete = true;
  }

  detach(): void {
    this.#bridge.setPasskeysEnabled(false);
    this.#stream = undefined;
    this.#streamLifetime.abort();
    this.#capability = undefined;
    this.#authority = Symbol();
    for (const channelId of this.#channels.keys()) this.#removeChannel(channelId);
    this.#channels.clear();
    this.#bridge.closeAll();
  }

  async handleFrame(frame: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary)
      throw new BrowserRelayError("The browser module stream expects JSON from the Host.");
    const stream = this.#requireStream();
    const message = createHostToBrowserRelayMessageSchema().parse(
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
      message.type === "browser.profile.delete" ||
      message.type === "browser.standard-cdp.reconcile" ||
      (message.type === "browser.close" && this.#channels.get(message.channelId)?.raw)
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
      case "browser.attach": {
        if (this.#stopped() && (message.standardCdp || !isPersonTicket(message.attachTicket)))
          throw new BrowserRelayError(stoppedError.message, { runtimeError: stoppedError });
        if (!this.#inventoryComplete)
          throw new BrowserRelayError("Local browser profile inventory has not completed.");
        const lease = this.#assertCapability(message.capability);
        if (this.#channels.has(message.channelId)) {
          throw new BrowserRelayError("The browser relay channel already exists.");
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
          ...(message.standardCdp
            ? {
                raw: {
                  reader: new RawCdpChunks(),
                  writer: new RawCdpWriter(async (chunk) => {
                    const current = this.#channels.get(message.channelId);
                    if (current !== channel || this.#stream !== stream)
                      throw new BrowserRelayError("The raw CDP channel ended.");
                    this.#assertCapability(current.capability);
                    await this.#send({
                      ...stream.fence,
                      channelId: message.channelId,
                      capability: current.capability,
                      type: "browser.server-message",
                      message: chunk,
                    });
                  }),
                },
              }
            : {}),
        };
        this.#channels.set(message.channelId, channel);
        const authority = this.#authority;
        let attached: BrowserBridgeAttached;
        try {
          attached = await this.#bridge.attach(
            message.channelId,
            message.attachTicket,
            this.#sink(channel),
            message.standardCdp === 1,
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
          type: "browser.attached",
          ...(attached.initialPage ? { initialPage: attached.initialPage } : {}),
          ...(attached.standardCdpMode ? { standardCdpMode: attached.standardCdpMode } : {}),
        });
        return;
      }
      case "browser.client-message": {
        // A relay-side close can race an event the Host already sent. Once the
        // channel is terminal there is nothing left to deliver.
        if (!this.#channels.has(message.channelId)) return;
        const channel = this.#assertChannel(message.channelId, message.capability);
        if (
          this.#stopped() &&
          (message.message.type === "cdp.raw" || !isPersonFrame(message.message))
        ) {
          if (message.message.type === "cdp.command")
            this.#sink(channel).onServerMessage(message.channelId, {
              type: "cdp.error",
              requestId: message.message.requestId,
              error: stoppedError,
            });
          return;
        }
        try {
          if (message.message.type === "cdp.raw") {
            if (!channel.raw) throw new BrowserRelayError("Raw CDP was not negotiated.");
            const frame = channel.raw.reader.read(message.message);
            if (frame)
              void this.#bridge
                .sendRawCdp(message.channelId, frame)
                .catch(() => this.#overloadRaw(message.channelId, channel))
                .catch(() => undefined);
          } else {
            if (channel.raw) throw new BrowserRelayError("A raw CDP channel requires raw frames.");
            await this.#bridge.send(message.channelId, message.message);
          }
        } catch (error) {
          await this.#failChannel(message.channelId, channel, error);
        }
        return;
      }
      case "browser.standard-cdp.reconcile": {
        const evidence = await this.#bridge.reconcileStandardCdpLease(
          message.attempt ?? message.lease,
          this.#streamLifetime.signal,
        );
        if (this.#stream !== stream) return;
        await this.#send({
          ...stream.fence,
          requestId: message.requestId,
          type: "browser.standard-cdp.reconciled",
          ...evidence,
        });
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
      case "browser.close": {
        const channel = this.#assertChannel(message.channelId, message.capability);
        this.#removeChannel(message.channelId);
        const settled = channel.raw
          ? await this.#bridge.settleStandardCdp(message.channelId)
          : false;
        // A pool guest's runtime is behind a tunnel that can break: its own close is the answer
        // passed on, never this relay's queueing of it. A local runtime is closed as before.
        let code = 1000;
        if (!channel.raw && this.#bridge.pooled)
          code = await this.#bridge.closeWithReceipt(message.channelId, pooledCloseReceiptMs);
        else if (!channel.raw) this.#bridge.close(message.channelId);
        if (this.#stream !== stream) return;
        await this.#send({
          ...stream.fence,
          capability: message.capability,
          channelId: message.channelId,
          code,
          reason: settled ? standardCdpSettledReason : "Host closed the browser relay.",
          requestId: message.requestId,
          type: "browser.closed",
        });
        return;
      }
    }
  }

  #sink(owner: ActiveChannel): BrowserChannelSink {
    return {
      onRawCdp: (channelId, frame) => {
        if (this.#channels.get(channelId) !== owner || !owner.raw) return;
        void owner.raw.writer
          .send(frame)
          .catch(() => this.#overloadRaw(channelId, owner))
          .catch(() => undefined);
      },
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
        const envelope = {
          ...stream.fence,
          capability: channel.capability,
          channelId,
          message,
          type: "browser.server-message" as const,
        };
        if (Buffer.byteLength(JSON.stringify(envelope)) > 1024 * 1024) {
          void this.#failChannel(
            channelId,
            channel,
            new BrowserRelayError("Browser Runtime sent an oversized text frame."),
          ).catch(() => undefined);
          return;
        }
        void this.#send(envelope).catch(() => undefined);
      },
    };
  }

  async #overloadRaw(channelId: BrowserChannelId, channel: ActiveChannel): Promise<void> {
    if (this.#channels.get(channelId) !== channel) return;
    this.#removeChannel(channelId);
    this.#bridge.close(channelId, 1013, "raw CDP relay overloaded");
    const stream = this.#stream;
    if (stream)
      await this.#send({
        ...stream.fence,
        channelId,
        capability: channel.capability,
        type: "browser.closed",
        code: 1013,
        reason: "Raw CDP relay overloaded.",
      });
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
      // Keep the ordered writer and partial reader. Each chunk uses the fence at send time.
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
    channel.raw?.writer.close();
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

const stoppedError: ProtocolError = {
  code: "forbidden",
  message: "Agents are stopped on this computer. Resume them on this computer to continue.",
  reason: "device-stopped",
  retryable: false,
};

function isPersonTicket(ticket: unknown): boolean {
  if (typeof ticket !== "string") return false;
  const payload = ticket.split(".")[1];
  if (!payload) return false;
  try {
    const { data } = BrowserAttachTicketClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return !!data && (data.actor ?? data.creationOrigin) === "person";
  } catch {
    return false;
  }
}

function isPersonFrame(message: BrowserClientMessage): boolean {
  switch (message.type) {
    case "cdp.command":
      if (message.actorToken || message.attachmentId || message.scriptAttachmentId) return false;
      if (message.command.method === browserHostMethods.openTab) {
        return isPersonTicket(message.command.parameters?.operationAuthority);
      }
      return (
        message.command.method === browserHostMethods.closeTab ||
        message.command.method === browserHostMethods.fenceTab ||
        message.command.method === browserHostMethods.resumeTab
      );
    case "tabs.resync":
    case "session.state":
    case "session.saved":
    case "cursor.query":
    case "cursor.reset":
    case "stream.demand":
    case "stream.subscribe":
    case "stream.unsubscribe":
    case "stream.ack":
    case "viewport.set":
    case "viewport.follow":
    case "surface.activate":
    case "surface.close":
    case "surface.open":
    case "navigation.go":
    case "navigation.back":
    case "navigation.forward":
    case "navigation.reload":
    case "navigation.stop":
    case "input.pointer":
    case "input.wheel":
    case "input.cancel":
    case "input.key":
    case "input.command":
    case "input.compose":
    case "input.text":
    case "clipboard.paste-data":
    case "clipboard.part":
    case "clipboard.paste":
    case "dialog.respond":
    case "passkey.result":
    case "passkey.claim":
    case "passkey.respond":
    case "passkey.cancel":
    case "autofill.fill":
    case "passwordSave.answer":
      return true;
    default:
      return false;
  }
}

function protocolError(error: unknown): ProtocolError {
  const relay = error instanceof BrowserRelayError ? error : undefined;
  if (relay?.runtimeError) return relay.runtimeError;
  return {
    code: relay ? "forbidden" : "internal",
    message: (error instanceof Error ? error.message : "The browser relay failed.").slice(0, 2_000),
    retryable: relay?.retryable ?? false,
  };
}
