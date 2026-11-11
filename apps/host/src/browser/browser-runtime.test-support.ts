import { KeyedStreamPublisher } from "@opensteer/protocol/keyed-stream";
import { BrowserTabRecordSchema, type BrowserTabRecord } from "@opensteer/protocol/browser";
import { createId } from "@opensteer/core";
import {
  BrowserAttachTicketClaimsSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  RunnerBootIdSchema,
  RunnerDescriptorSchema,
  type RunnerAuxiliaryFrameFence,
  type BrowserEngine,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import {
  BrowserRelayFrameHeaderSchema,
  HostToBrowserRelayMessageSchema,
  encodeBrowserRelayFrame,
  type BrowserCapabilityReference,
  type HostToBrowserRelayMessage,
} from "@opensteer/protocol/browser-relay";
import { createRunnerAuxiliarySignature } from "@opensteer/runner-auth";
import { createPublicKey, createHash, randomUUID, verify } from "node:crypto";
import WebSocket from "ws";
import {
  closed,
  connectPrimary,
  type PrimaryConnection,
} from "../runtime/machine-access.test-support.js";

/**
 * One enrolled computer whose only module is a browser.
 *
 * It connects to the Host, asks its primary connection for an auxiliary
 * ticket, opens the browser stream with it, and then plays the relay: it
 * accepts the capability grant, verifies each attach ticket against the Host's
 * published key, and carries snapshots, commands and frames on the channel the
 * Host names. Every frame it sends repeats the stream fence.
 */
export async function startBrowserRuntime(
  hostPort: number,
  enrollmentToken: string,
  options: {
    /** Advertise the agent CDP boundary and shared tab identity, as a current Runtime does. */
    readonly agentReady?: boolean;
    readonly browserEngine?: BrowserEngine;
    readonly device?: RunnerDescriptor["device"];
    readonly agentActions?: boolean;
    readonly basicInput?: boolean;
    readonly surfaceState?: boolean;
    readonly navigation?: boolean;
    readonly navigationAttribution?: boolean;
    readonly editing?: boolean;
    /** Relay the real Chromium runtime instead of synthesizing its messages. */
    readonly runtimeUrl?: string;
    /** Keep the auxiliary lease live during long benchmark/journey workloads. */
    readonly keepAlive?: boolean;
    /** Attach a browser stream to the already enrolled Personal Main identity. */
    readonly primary?: PrimaryConnection;
    readonly targetedStreaming?: boolean;
    readonly personalTabs?: boolean;
    readonly signIn?: boolean;
    readonly initialDialog?: Record<string, unknown>;
  } = {},
): Promise<{
  readonly runnerId: ReturnType<typeof createId<"runner">>;
  close(): Promise<void>;
  connectionCount(): number;
  browserModule(): NonNullable<
    ReturnType<typeof RunnerDescriptorSchema.parse>["modules"]["browser"]
  >;
  protocolErrors(): readonly string[];
  receivedCommands(): readonly Record<string, unknown>[];
  streamOpen(): boolean;
  lastClaims(): ReturnType<typeof BrowserAttachTicketClaimsSchema.parse> | undefined;
  nextCommand(): Promise<Record<string, unknown>>;
  sendFrame(frame: Buffer): void;
  sendServer(message: Record<string, unknown>, sessionId?: string): void;
  publishTabs(
    input: {
      surfaces: readonly Record<string, unknown>[];
      inventoryRevision?: number;
      closed?: readonly string[];
    },
    sessionId?: string,
  ): void;
}> {
  const runnerId = options.primary?.fence.runnerId ?? createId("runner");
  const bootId = options.primary?.bootId ?? RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
  const descriptor = RunnerDescriptorSchema.parse({
    bootId,
    capabilities: [],
    ...(options.device ? { device: options.device } : {}),
    modules: {
      browser: {
        wireVersion: 2,
        ...(!options.runtimeUrl
          ? {
              localProfileStorage: {
                storageInstanceId: "20000000-0000-4000-8000-000000000001",
                engine: options.browserEngine ?? "chromium",
              },
            }
          : {}),
        ...(options.agentActions ? { agentActions: 1, sharedControl: 1, targetControl: 1 } : {}),
        ...(options.basicInput ? { basicInput: 1 } : {}),
        ...(options.surfaceState ? { surfaceState: 1 } : {}),
        ...(options.editing ? { editing: 1, targetControl: 1 } : {}),
        ...(options.navigation ? { navigationVersion: 1 } : {}),
        ...(options.navigationAttribution ? { navigationAttributionVersion: 1 } : {}),
        runtimeId: "browser-runtime-integration",
        ...(options.agentReady ? { cdpBoundary: 1, sharedControl: 1 } : {}),
        ...(options.personalTabs ? { tabRestoreVersion: 1 } : {}),
        ...(options.signIn ? { signIn: { version: 3 } } : {}),
      },
    },
    name: "Relay computer",
    runnerId,
    runnerKind: "local",
    runtimeVersion: "integration",
  });

  const sessionChannels = new Map<string, string>();
  const engineSockets = new Map<string, WebSocket>();
  const connection =
    options.primary ?? (await connectPrimary(hostPort, descriptor, { token: enrollmentToken }));
  const primary = connection.socket;
  const connectionFence = connection.fence;
  const ticketed = nextJson(primary, "host.auxiliary.ticket");
  primary.send(
    JSON.stringify({
      ...connectionFence,
      module: "browser",
      requestId: "browser-relay-stream",
      type: "runner.auxiliary.ticket-request",
    }),
  );
  const ticket = ((await ticketed) as { readonly ticket: string }).ticket;

  const auxiliary = new WebSocket(
    `ws://127.0.0.1:${hostPort}/internal/v1/runners/auxiliary/browser`,
  );
  const auxiliaryChallenge = RunnerAuxiliaryChallengeSchema.parse(
    await nextJson(auxiliary, "host.auxiliary.challenge"),
  );
  const welcomed = nextJson(auxiliary, "host.auxiliary.welcome");
  auxiliary.send(
    JSON.stringify({
      bootId,
      challengeId: auxiliaryChallenge.challengeId,
      module: "browser",
      runnerId,
      signature: createRunnerAuxiliarySignature(connection.privateKey, {
        bootId,
        challenge: auxiliaryChallenge,
        module: "browser",
        runnerId,
        ticket,
      }),
      ticket,
      type: "runner.auxiliary.authenticate",
    }),
  );
  const streamWelcome = RunnerAuxiliaryWelcomeSchema.parse(await welcomed);
  const attachPublicKeys = streamWelcome.browserAttachPublicKeys;
  if (!attachPublicKeys?.length) throw new Error("The Host published no browser attach keys.");
  const fence: RunnerAuxiliaryFrameFence = {
    auxiliaryStreamId: streamWelcome.auxiliaryStreamId,
    bootId: streamWelcome.bootId,
    connectionGeneration: streamWelcome.connectionGeneration,
    connectionId: streamWelcome.connectionId,
    connectionLeaseId: streamWelcome.connectionLeaseId,
    module: "browser",
    runnerId: streamWelcome.runnerId,
  };

  let capability: BrowserCapabilityReference | undefined;
  let channelId: HostToBrowserRelayMessage extends never ? never : string | undefined;
  let connectionCount = 0;
  let latestClaims: ReturnType<typeof BrowserAttachTicketClaimsSchema.parse> | undefined;
  let sequence = 0;
  const commands: Array<Record<string, unknown>> = [];
  const receivedCommands: Array<Record<string, unknown>> = [];
  const protocolErrors: string[] = [];
  const waiters: Array<(command: Record<string, unknown>) => void> = [];
  const send = (message: Record<string, unknown>) =>
    auxiliary.send(JSON.stringify({ ...fence, ...message }));
  const streams = new Map<
    string,
    {
      rows: Map<string, BrowserTabRecord>;
      publisher: KeyedStreamPublisher<
        BrowserTabRecord,
        { activeId: BrowserTabRecord["id"] | null; inventoryRevision: number }
      >;
      meta: { activeId: BrowserTabRecord["id"] | null; inventoryRevision: number };
    }
  >();
  const publishTabs = (
    input: {
      surfaces: readonly Record<string, unknown>[];
      inventoryRevision?: number;
      closed?: readonly string[];
    },
    sessionId?: string,
  ) => {
    const id = sessionId ? sessionChannels.get(sessionId) : channelId;
    if (!id || !capability) throw new Error("No browser channel is attached.");
    const emit = (message: unknown) =>
      send({ type: "browser.server-message", capability, channelId: id, message });
    let stream = streams.get(id);
    if (!stream) {
      const rows = new Map<string, BrowserTabRecord>(),
        meta = { activeId: null as BrowserTabRecord["id"] | null, inventoryRevision: 1 };
      stream = {
        rows,
        meta,
        publisher: new KeyedStreamPublisher({
          ids: () => rows.keys(),
          read: (key) => rows.get(key),
          meta: () => ({ ...meta }),
          targetBytes: 64 * 1024,
          envelopeBytes: 1024,
        }),
      };
      streams.set(id, stream);
    }
    for (const key of stream.rows.keys())
      if (!input.surfaces.some((row) => row.id === key)) {
        stream.rows.delete(key);
        stream.publisher.mark(key);
      }
    for (const [order, surface] of input.surfaces.entries()) {
      const { active: _active, favicon, ...fields } = surface;
      const previous = typeof surface.id === "string" ? stream.rows.get(surface.id) : undefined;
      const icon =
        typeof favicon === "string"
          ? createHash("sha256").update(favicon).digest("base64url")
          : null;
      if (icon) emit({ type: "browser.tab.icon", key: icon, favicon });
      const row = BrowserTabRecordSchema.parse({
        state: "live",
        url: "about:blank",
        openerId: null,
        documentId: "document-integration",
        geometryRevision: options.agentActions ? 1 : 0,
        loading: false,
        navigationFailed: false,
        canGoBack: false,
        canGoForward: false,
        sizedByAgent: false,
        ...previous,
        ...fields,
        order: typeof surface.order === "number" ? surface.order : order,
        title: typeof surface.title === "string" ? surface.title.slice(0, 256) : "",
        icon: icon ?? (previous && previous.url === surface.url ? previous.icon : null),
      });
      stream.rows.set(row.id, row);
      stream.publisher.mark(row.id);
    }
    stream.meta.activeId =
      [...stream.rows.values()].find(
        (row) => input.surfaces.find((surface) => surface.id === row.id)?.active,
      )?.id ??
      stream.rows.values().next().value?.id ??
      null;
    stream.meta.inventoryRevision = input.inventoryRevision ?? stream.meta.inventoryRevision;
    stream.publisher.markMeta();
    let frame = stream.publisher.next();
    if (!frame) {
      stream.publisher.reset();
      frame = stream.publisher.next();
    }
    for (; frame; frame = stream.publisher.next()) {
      emit({ type: "browser.tabs", stream: frame });
      stream.publisher.settled(frame, true);
    }
  };
  const heartbeat = options.keepAlive
    ? setInterval(() => {
        if (auxiliary.readyState === WebSocket.OPEN)
          send({ type: "runner.auxiliary.heartbeat", sentAt: new Date().toISOString() });
      }, streamWelcome.heartbeatIntervalMs)
    : undefined;
  heartbeat?.unref();
  auxiliary.once("close", () => {
    if (heartbeat) clearInterval(heartbeat);
  });

  auxiliary.on("message", (raw, isBinary) => {
    if (isBinary) return;
    const value: unknown = JSON.parse(raw.toString());
    if (options.keepAlive && RunnerAuxiliaryLeaseRenewedSchema.safeParse(value).success) return;
    const schema = HostToBrowserRelayMessageSchema;
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      protocolErrors.push(parsed.error.message);
      auxiliary.close(1011, "Invalid Host browser frame");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "capability.grant": {
        capability = {
          capabilityGeneration: message.lease.capabilityGeneration,
          capabilityLeaseId: message.lease.capabilityLeaseId,
          runtimeId: message.lease.runtimeId,
        };
        send({
          capability,
          requestId: message.requestId,
          type: "capability.accepted",
        });
        return;
      }
      case "browser.profile.delete": {
        // A native profile is erased on its computer; this one keeps no files.
        send({ ...message, type: "browser.profile.delete.result", state: "deleted" });
        return;
      }
      case "browser.health.request": {
        send({
          browserRuntime: {
            checkedAt: new Date().toISOString(),
            detail: null,
            runtimeId: "browser-runtime-integration",
            sessionId: null,
            state: "idle",
          },
          requestId: message.requestId,
          type: "browser.health",
        });
        return;
      }
      case "browser.attach": {
        connectionCount += 1;
        channelId = message.channelId;
        latestClaims = verifyAttachTicket(
          message.attachTicket,
          attachPublicKeys[0]!.publicKeyPem,
          attachPublicKeys[0]!.keyId,
          options.agentReady === true,
        );
        sessionChannels.set(latestClaims.sessionId, message.channelId);
        if (options.runtimeUrl) {
          const engine = new WebSocket(options.runtimeUrl, {
            headers: { authorization: `Bearer ${message.attachTicket}` },
          });
          engineSockets.set(message.channelId, engine);
          engine.on("message", (raw, binary) => {
            if (binary) {
              sequence++;
              const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
              auxiliary.send(
                encodeBrowserRelayFrame(
                  BrowserRelayFrameHeaderSchema.parse({
                    ...fence,
                    capability: message.capability,
                    channelId: message.channelId,
                    sequence,
                    type: "browser.frame",
                  }),
                  bytes,
                ),
                { binary: true },
              );
            } else {
              const event = JSON.parse(raw.toString()) as Record<string, unknown>;
              if (event.type === "browser.attached")
                send({
                  capability: message.capability,
                  channelId: message.channelId,
                  requestId: message.requestId,
                  type: "browser.attached",
                  ...(event.initialPage ? { initialPage: event.initialPage } : {}),
                });
              else
                send({
                  capability: message.capability,
                  channelId: message.channelId,
                  type: "browser.server-message",
                  message: event,
                });
            }
          });
          engine.on("error", (error) => protocolErrors.push(String(error)));
          return;
        }
        send({
          capability: message.capability,
          channelId: message.channelId,
          requestId: message.requestId,
          type: "browser.attached",
          ...(latestClaims.initialNavigation
            ? {
                initialPage: {
                  operationKey: latestClaims.initialNavigation.operationKey,
                  surfaceId: "page-integration",
                  navigation: latestClaims.initialNavigation.url ? "submitted" : "blank",
                },
              }
            : {}),
        });
        send({
          capability: message.capability,
          channelId: message.channelId,
          message: {
            ...(latestClaims.navigationAttributionVersion === 1
              ? { navigationAttributionVersion: 1 }
              : {}),
            ...(latestClaims.basicInput
              ? { basicInput: latestClaims.basicInput, inputLanesVersion: 1 }
              : {}),
            ...(latestClaims.surfaceState ? { surfaceState: latestClaims.surfaceState } : {}),
            ...(options.targetedStreaming !== false ? { targetedStreamingVersion: 1 } : {}),
            access: latestClaims.access,
            dialog: options.initialDialog ?? null,
            sessionId: latestClaims.sessionId,
            state: "ready",
            type: "browser.snapshot",
          },
          type: "browser.server-message",
        });
        publishTabs({
          surfaces: [
            {
              active: true,
              ...(options.agentActions
                ? { documentId: "document-integration", geometryRevision: 1 }
                : {}),
              ...(latestClaims.surfaceState ? { state: "live" } : {}),
              ...(options.navigation && latestClaims.navigationVersion === 1
                ? { canGoBack: false, canGoForward: false }
                : {}),
              id: "page-integration",
              title: "Integration page",
              url: "about:blank",
            },
          ],
        });
        return;
      }
      case "browser.client-message": {
        const engine = engineSockets.get(message.channelId);
        if (engine) {
          const forward = () => engine.send(JSON.stringify(message.message));
          if (engine.readyState === WebSocket.OPEN) forward();
          else engine.once("open", forward);
        }
        receivedCommands.push(message.message);
        const waiter = waiters.shift();
        if (waiter) waiter(message.message);
        else commands.push(message.message);
        return;
      }
      default:
        return;
    }
  });

  if (!options.runtimeUrl && !options.primary)
    send({
      type: "browser.profile.inventory",
      storageInstanceId: "20000000-0000-4000-8000-000000000001",
      engine: options.browserEngine ?? "chromium",
      profiles: [],
      complete: true,
    });

  return {
    runnerId,
    close: async () => {
      if (heartbeat) clearInterval(heartbeat);
      for (const engine of engineSockets.values()) engine.terminate();
      engineSockets.clear();
      auxiliary.terminate();
      await closed(auxiliary);
      if (!options.primary) {
        primary.terminate();
        await closed(primary);
      }
    },
    connectionCount: () => connectionCount,
    browserModule: () => descriptor.modules.browser!,
    protocolErrors: () => protocolErrors,
    receivedCommands: () => receivedCommands,
    streamOpen: () => auxiliary.readyState === WebSocket.OPEN,
    lastClaims: () => latestClaims,
    nextCommand: () => {
      const command = commands.shift();
      return command
        ? Promise.resolve(command)
        : new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
    },
    sendFrame: (frame) => {
      if (!capability || !channelId) throw new Error("No browser channel is attached.");
      sequence += 1;
      auxiliary.send(
        encodeBrowserRelayFrame(
          BrowserRelayFrameHeaderSchema.parse({
            ...fence,
            capability,
            channelId,
            sequence,
            type: "browser.frame",
          }),
          frame,
        ),
        { binary: true },
      );
    },
    publishTabs,
    sendServer: (message, sessionId) => {
      if (!capability || !channelId) throw new Error("No browser channel is attached.");
      send({
        capability,
        channelId: sessionId ? sessionChannels.get(sessionId) : channelId,
        message,
        type: "browser.server-message",
      });
    },
  };
}

export function nextJson(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 10_000);
    const receive = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
    socket.once("error", reject);
  });
}

function verifyAttachTicket(token: string, publicKeyPem: string, keyId: string, _current: boolean) {
  const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
  if (!headerSegment || !payloadSegment || !signatureSegment) throw new Error("Malformed ticket.");
  const header = JSON.parse(Buffer.from(headerSegment, "base64url").toString()) as {
    alg?: unknown;
    kid?: unknown;
    typ?: unknown;
  };
  if (
    header.alg !== "EdDSA" ||
    header.kid !== keyId ||
    header.typ !== "opensteer-browser-attach+jwt"
  ) {
    throw new Error("Invalid ticket header.");
  }
  if (
    !verify(
      null,
      Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureSegment, "base64url"),
    )
  ) {
    throw new Error("Invalid ticket signature.");
  }
  return BrowserAttachTicketClaimsSchema.parse(
    JSON.parse(Buffer.from(payloadSegment, "base64url").toString()),
  );
}
