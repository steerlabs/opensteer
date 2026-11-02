import { generateKeyPairSync, randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { createId } from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
  RunnerAuxiliaryFrameFenceSchema,
  type DisplayStreamId,
  type HostIntegrationsOperation,
} from "@opensteer/protocol";
import { z } from "zod";
import WebSocket from "ws";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { DisplayStreamHub } from "./display-stream-hub.js";
import { registerComputerUseDisplayRoutes } from "./computer-use-display-routes.js";

/**
 * The same in-process Mac binding/fence admission as display-stream-hub.test.ts.
 * `legacy` stands in for a desktop without the negotiated video profile.
 */
export async function macHub(
  onCommand: (message: HostIntegrationsOperation) => void,
  { legacy = false }: { legacy?: boolean } = {},
) {
  const app = Fastify();
  const sockets: WebSocket[] = [];
  const actors = new Map<string, ReturnType<typeof createId<"user">>>();
  const actorLabels = new Map<string, string>();
  const runnerId = createId("runner");
  const source = { kind: "owner-view" as const, viewId: `cvw_${randomUUID()}`, generation: 1 };
  const target = { kind: "mac-window" as const, bindingId: randomUUID() };
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
  const stream = {
    auxiliaryStreamId: fence.auxiliaryStreamId,
    fence,
    identity: {
      runnerId,
      modules: {
        integrations: {
          platform: "darwin",
          protocolVersion: 5,
          computerUseVersion: 2,
          ownerViewVersion: 3,
          macWindowVideoVersion: 1,
          ...(legacy ? {} : { displayProfile: 1 }),
        },
      },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  } as unknown as RunnerAuxiliaryStream;
  const authenticator = new RunnerAuthenticator({
    issuancePrivateKey: generateKeyPairSync("ed25519").privateKey,
    store: {} as never,
  });
  const apps = new ComputerAppHub({
    knownDefinitionIds: () => new Set(),
    onChanged: () => undefined,
    onRunnerDetached: (id, reason) => hub.forgetRunner(id, reason),
    onDisplayEvent: (id, event) => hub.handlePhoneEvent(id, event),
  });
  const hub = new DisplayStreamHub({
    authenticator,
    computerApps: apps,
    computerUse: {} as never,
    computerViews: {
      authorizeDisplay: async () => runnerId,
      authorizeInput: async () => runnerId,
      isDisplayLive: () => true,
      endDisplaySource: () => undefined,
    },
  });
  const peer = {
    id: "synthetic-mac",
    close: () => undefined,
    send: async (message: HostIntegrationsOperation) => {
      if (message.type === "host.integrations.display.resolve") {
        queueMicrotask(() => {
          void apps.handleMessage(peer, stream, {
            ...fence,
            type: "runner.integrations.display.resolved",
            requestId: message.requestId,
            target,
          });
        });
      } else onCommand(message);
    },
  };
  const close = async () => {
    hub.close();
    for (const socket of sockets) socket.terminate();
    await withTimeout(app.close(), 10_000, {
      timeoutError: () => new Error("Mac benchmark Host did not close"),
    });
  };
  try {
    await app.register(websocket);
    apps.attach(peer, stream);
    await apps.handleMessage(peer, stream, {
      ...fence,
      type: "runner.integrations.status",
      apps: [],
      displayAvailable: true,
      ownerViewVersion: 3,
    });
    registerComputerUseDisplayRoutes(app, {
      hub,
      authenticator: {
        authenticateSession: async (headers: { authorization?: string }) => {
          const label = headers.authorization ?? "benchmark";
          let actor = actors.get(label);
          if (!actor) {
            actor = createId("user");
            actors.set(label, actor);
            actorLabels.set(actor, label);
          }
          return {
            id: label,
            user: { id: actor },
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            absoluteExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          };
        },
      } as never,
    });
    await withTimeout(app.listen({ host: "127.0.0.1", port: 0 }), 10_000, {
      timeoutError: () => new Error("Mac benchmark Host did not listen"),
    });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No benchmark Host listener");
    return {
      hub,
      actorLabels,
      source,
      sockets,
      origin: `http://127.0.0.1:${address.port}`,
      close,
      state: (streamId: DisplayStreamId) =>
        apps.handleMessage(peer, stream, {
          ...fence,
          type: "runner.integrations.display.state",
          display: "main",
          streamId,
          state: "live",
          generation: 1,
          width: 1512,
          height: 982,
          rotation: 0,
        }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
