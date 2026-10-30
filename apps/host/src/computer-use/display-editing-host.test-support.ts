import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";
import { z } from "zod";
import { createId } from "@opensteer/core";
import {
  encodeDisplayMediaFrame,
  mintComputerUseSessionId,
  RunnerAuxiliaryFrameFenceSchema,
  type HostIntegrationsOperation,
  type HostIntegrationsDisplayStart,
  type DisplayViewerServerMessage,
} from "@opensteer/protocol";
import { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { DisplayStreamHub } from "./display-stream-hub.js";
import { registerComputerUseDisplayRoutes } from "./computer-use-display-routes.js";

/** Real Host display routes/hubs and signed media admission; only services and producers are fake. */
export async function displayEditingHost(options: {
  readonly mac: boolean;
  readonly editing: boolean;
  readonly baselineHost?: boolean;
  readonly mediaPayload?: Uint8Array;
}) {
  const owner = createId("user");
  const runnerId = createId("runner");
  const sessionId = mintComputerUseSessionId();
  const bindingId = randomUUID();
  const source = options.mac
    ? { kind: "owner-view" as const, viewId: `cvw_${randomUUID()}`, generation: 1 }
    : { kind: "task-session" as const, sessionId };
  const context = {
    contextId: randomUUID(),
    field: { kind: "text" as const, multiline: true, sensitive: false },
    caret: { x: 0.25, y: 0.5, height: 0.02 },
  };
  const fence = RunnerAuxiliaryFrameFenceSchema.extend({ module: z.literal("integrations") }).parse(
    {
      auxiliaryStreamId: `rax_${randomUUID()}`,
      bootId: `rbt_${randomUUID()}`,
      connectionGeneration: 1,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      module: "integrations",
      runnerId,
    },
  );
  type Auxiliary = Parameters<ComputerAppHub["attach"]>[1];
  const stream = {
    auxiliaryStreamId: fence.auxiliaryStreamId,
    fence,
    identity: {
      runnerId,
      modules: {
        integrations: {
          platform: options.mac ? "darwin" : "android",
          protocolVersion: options.mac ? 5 : 4,
          ...(!options.mac && options.editing ? { sharedInput: 1 } : {}),
          ...(options.editing ? { editing: 1 } : {}),
          ...(options.mac
            ? {
                computerUseVersion: 2,
                ownerViewVersion: 3,
                macWindowVideoVersion: 1,
                macOwnerInputVersion: 2,
              }
            : {}),
        },
      },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 120000).toISOString(),
  } as unknown as Auxiliary;
  const sent: HostIntegrationsOperation[] = [];
  const failures: string[] = [];
  const sockets = new Set<WebSocket>();
  const keys = generateKeyPairSync("ed25519");
  const authenticator = new RunnerAuthenticator({
    issuancePrivateKey: keys.privateKey,
    store: {} as never,
  });
  let start: HostIntegrationsDisplayStart | undefined;
  let data: WebSocket | undefined;
  let hub: DisplayStreamHub;
  let released = false;
  const apps = new ComputerAppHub({
    knownDefinitionIds: () => new Set(),
    onChanged: () => undefined,
    onRunnerDetached: (id, reason) => hub.forgetRunner(id, reason),
    onDisplayEvent: (id, event) => hub.handlePhoneEvent(id, event),
  });
  const emit = async (message: DisplayViewerServerMessage) => {
    if (!start) throw new Error("No producer stream");
    if (options.mac) {
      await apps.handleMessage(peer, stream, {
        ...fence,
        type: "runner.integrations.mac-owner.event",
        streamId: start.streamId,
        source,
        message,
      } as never);
      return;
    }
    const base = { ...fence, streamId: start.streamId, sessionId, geometry: 1 };
    if (message.type === "display.editing")
      await apps.handleMessage(peer, stream, {
        ...base,
        type: "runner.integrations.display.editing",
        context: message.context,
      } as never);
    else if (message.type === "display.input.result")
      await apps.handleMessage(peer, stream, {
        ...base,
        type: "runner.integrations.display.input-result",
        sequence: message.sequence,
        outcome: message.outcome,
        ...(message.reason ? { reason: message.reason } : {}),
      } as never);
    else if (message.type === "display.clipboard")
      await apps.handleMessage(peer, stream, {
        ...base,
        type: "runner.integrations.display.clipboard",
        sequence: message.sequence,
        outcome: message.outcome,
        ...(message.text ? { text: message.text } : {}),
      } as never);
  };
  const peer = {
    id: "viewer-journey-producer",
    close: () => undefined,
    send: async (message: HostIntegrationsOperation) => {
      sent.push(message);
      if (message.type === "host.integrations.display.resolve") {
        await apps.handleMessage(peer, stream, {
          ...fence,
          type: "runner.integrations.display.resolved",
          requestId: message.requestId,
          target: {
            kind: "mac-window",
            bindingId,
            ...(options.editing && message.ownerInputVersion === 2 ? { editingVersion: 1 } : {}),
          },
        });
      } else if (message.type === "host.integrations.display.start") {
        start = message;
        // The hub must finish installing its stream before the fake producer answers.
        setTimeout(() => {
          void (async () => {
            data = new WebSocket(`${base}/internal/v1/computer-use/display`, {
              headers: { Authorization: `Bearer ${message.dataTicket}` },
            });
            sockets.add(data);
            await once(data, "open");
            await apps.handleMessage(peer, stream, {
              ...fence,
              type: "runner.integrations.display.state",
              display: "main",
              streamId: message.streamId,
              state: "live",
              generation: 1,
              width: 360,
              height: 780,
              rotation: 0,
            });
            if (options.editing) await emit({ type: "display.editing", generation: 1, context });
            data.send(
              encodeDisplayMediaFrame(
                {
                  streamId: message.streamId,
                  generation: 1,
                  sequence: 0,
                  ptsUs: 0,
                  key: true,
                  codec: "avc1.42C01E",
                  width: 360,
                  height: 780,
                },
                options.mediaPayload ?? new Uint8Array([0, 0, 0, 1, 101, 255]),
              ),
            );
          })().catch((error) => failures.push(String(error)));
        }, 0);
      } else if (
        message.type === "host.integrations.display.input" ||
        message.type === "host.integrations.mac-owner.input"
      ) {
        const unsupported = message.events.some(
          (event) => event.kind === "paste" && "items" in event,
        );
        if (options.editing) {
          await emit({
            type: "display.input.result",
            sequence: message.sequence,
            outcome: unsupported ? "refused" : "dispatched",
            ...(unsupported ? { reason: "unsupported" as const } : {}),
          });
          if (message.events.some((event) => event.kind === "copy"))
            await emit({
              type: "display.clipboard",
              sequence: message.sequence,
              outcome: "copied",
              text: "fixture selection",
            });
        }
      } else if (
        message.type === "host.integrations.display.input-reset" ||
        message.type === "host.integrations.mac-owner.input-reset"
      )
        released = true;
    },
  };
  hub = new DisplayStreamHub({
    authenticator,
    computerApps: apps,
    computerUse: {
      authorizeDisplay: async () => runnerId,
      isDisplaySessionLive: () => true,
      noteOwnerActivity: () => undefined,
    },
    computerViews: {
      authorizeDisplay: async () => runnerId,
      isDisplayLive: () => true,
      endDisplaySource: () => undefined,
      authorizeInput: async () => runnerId,
    },
  });
  apps.attach(peer, stream);
  await apps.handleMessage(peer, stream, {
    ...fence,
    type: "runner.integrations.status",
    apps: [],
    displayAvailable: true,
    ...(options.mac ? { ownerViewVersion: 3 } : {}),
  });
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  const closing: (() => Promise<void>)[] = [];
  // These are the only Fastify members used by the production display route registrar.
  const app = {
    server,
    addHook: (_name: string, close: () => Promise<void>) => closing.push(close),
  };
  registerComputerUseDisplayRoutes(
    app as unknown as Parameters<typeof registerComputerUseDisplayRoutes>[0],
    {
      hub,
      authenticator: {
        authenticateSession: async () => ({
          id: "viewer-fixture-login",
          user: { id: owner },
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          absoluteExpiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      } as unknown as Parameters<typeof registerComputerUseDisplayRoutes>[1]["authenticator"],
    },
  );
  if (options.baselineHost)
    server.prependListener("upgrade", (request) => {
      if (request.url) {
        const url = new URL(request.url, "http://fixture");
        url.searchParams.delete("editing");
        url.searchParams.delete("sharedInput");
        request.url = url.pathname + url.search;
      }
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const base = `ws://127.0.0.1:${address.port}`;
  return {
    base,
    source,
    context,
    sent,
    failures,
    released: () => released,
    socket: (editing: boolean) => {
      const route =
        source.kind === "owner-view" ? `views/${source.viewId}/1` : `sessions/${source.sessionId}`;
      const socket = new WebSocket(
        `${base}/v1/computer-use/${route}/display${editing ? "?editing=1&sharedInput=1" : ""}`,
      );
      sockets.add(socket);
      return socket;
    },
    close: async () => {
      for (const close of closing) await close();
      for (const socket of sockets) socket.terminate();
      hub.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
