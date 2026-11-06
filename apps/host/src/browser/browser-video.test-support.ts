import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createId } from "@opensteer/core";
import {
  RunnerAuxiliaryFrameFenceSchema,
  createBrowserSessionId,
  encodeBrowserVideoFrame,
  decodeBrowserVideoFrame,
  type BrowserServerMessage,
  type BrowserVideoBudget,
  type BrowserVideoFrameHeader,
} from "@opensteer/protocol";
import {
  BrowserCapabilityReferenceSchema,
  BrowserChannelIdSchema,
  type BrowserVideoOperation,
} from "@opensteer/protocol/browser-relay";
import { BrowserVideoHub, type BrowserVideoViewer } from "./browser-video-hub.js";
import { registerBrowserVideoRoutes } from "./browser-video-routes.js";
import { RunnerAuthenticator } from "../agents/runner-authenticator.js";

export const browserKeyFixture = readFileSync(
  new URL(
    "../../../mobile/modules/phone-display/tests/native/fixtures/lime-key-128x128.h264",
    import.meta.url,
  ),
);
export const browserDeltaFixture = readFileSync(
  new URL(
    "../../../mobile/modules/phone-display/tests/native/fixtures/blue-delta-128x128.h264",
    import.meta.url,
  ),
);
export async function browserVideoFixture(
  realTime = false,
  authenticate: (request: import("node:http").IncomingMessage) => Promise<unknown> = async () =>
    undefined,
) {
  let now = 100000;
  let live = true;
  const clock = realTime ? Date.now : () => now;
  const authenticator = new RunnerAuthenticator({
    issuancePrivateKey: generateKeyPairSync("ed25519").privateKey,
    store: {} as never,
    now: clock,
  });
  const hub = new BrowserVideoHub(authenticator, clock);
  const app = Fastify();
  await app.register(websocket);
  registerBrowserVideoRoutes(app, hub, authenticate);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No browser media test listener");
  const origin = `ws://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  const operations: BrowserVideoOperation[] = [];
  const fence = RunnerAuxiliaryFrameFenceSchema.parse({
    auxiliaryStreamId: `rax_${randomUUID()}`,
    bootId: `rbt_${randomUUID()}`,
    connectionGeneration: 1,
    connectionId: `rcn_${randomUUID()}`,
    connectionLeaseId: `rls_${randomUUID()}`,
    module: "browser",
    runnerId: createId("runner"),
  });
  const capability = BrowserCapabilityReferenceSchema.parse({
    capabilityGeneration: 1,
    capabilityLeaseId: `bcl_${randomUUID()}`,
    runtimeId: "browser-test",
  });
  const binding = {
    channelId: BrowserChannelIdSchema.parse(`bch_${randomUUID()}`),
    fence: () => fence,
    capability: () => capability,
    current: () => live,
    send: async (operation: BrowserVideoOperation) => {
      operations.push(operation);
    },
  };
  const connect = async (path: string, ticket?: string, token?: string) => {
    const socket = new WebSocket(`${origin}${path}`, token ? [`opensteer-video.${token}`] : [], {
      headers: ticket ? { authorization: `Bearer ${ticket}` } : {},
      perMessageDeflate: false,
    });
    sockets.push(socket);
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    return socket;
  };
  const target = {
    kind: "browser-tab" as const,
    sessionId: createBrowserSessionId(),
    surfaceId: "tab" as import("@opensteer/core").BrowserSurfaceId,
  };
  const admit = async (
    input: boolean,
    budget: BrowserVideoBudget = { maxWidth: 128, maxHeight: 128, maxFps: 15, maxBitrate: 1000000 },
  ) => {
    let allowed = true;
    const messages: BrowserServerMessage[] = [];
    const releases: string[] = [];
    const owner: BrowserVideoViewer = {
      id: randomUUID(),
      input,
      target,
      budget,
      authorized: async () => allowed,
      send: async (m) => {
        messages.push(m);
      },
    };
    await hub.add(binding, owner);
    const attach = messages.find((m) => m.type === "browser.video.attached");
    if (!attach || attach.type !== "browser.video.attached") throw new Error("No media admission");
    return {
      owner,
      messages,
      releases,
      attach,
      deny: () => {
        allowed = false;
      },
    };
  };
  const add = async (input: boolean, budget?: BrowserVideoBudget) => {
    const admitted = await admit(input, budget);
    const { owner, messages, releases, attach } = admitted;
    const socket = await connect("/v1/browser/video", undefined, attach.mediaToken);
    const media: { header: BrowserVideoFrameHeader; payload: Uint8Array }[] = [];
    const states: unknown[] = messages.filter((m) => m.type === "browser.video.state");
    socket.on("message", (raw, binary) => {
      if (binary) media.push(decodeBrowserVideoFrame(Buffer.from(raw as Buffer)));
      else states.push(JSON.parse(String(raw)));
    });
    return {
      owner,
      messages,
      releases,
      socket,
      media,
      states,
      attach,
      deny: admitted.deny,
      ack: async (sequence: number) => {
        const pong = once(socket, "pong", { signal: AbortSignal.timeout(3000) });
        socket.send(JSON.stringify({ type: "video.ack", streamId: attach.streamId, sequence }));
        socket.ping();
        await pong;
      },
    };
  };
  const start = () => {
    const operation = operations.find((o) => o.type === "browser.video.start");
    if (!operation || operation.type !== "browser.video.start")
      throw new Error("No browser producer start");
    return operation;
  };
  const header = (sequence: number, key = sequence === 1): BrowserVideoFrameHeader => ({
    streamId: start().streamId,
    generation: 1,
    sequence,
    ptsUs: sequence,
    geometryRevision: 1,
    key,
    ...(key ? { codec: "avc1.420015" } : {}),
    width: 128,
    height: 128,
    presentation: {
      producerStreamId: "00000000-0000-4000-8000-000000000002",
      documentGeneration: "document",
      authorityEpoch: "epoch",
      drawnRevision: `certificate-${sequence}`,

      rootCssWidth: 128,
      rootCssHeight: 128,

      rasterCrop: { x: 0, y: 0, width: 128, height: 128 },
    },
  });
  const source = async (sourceOrigin = origin) => {
    const socket = new WebSocket(`${sourceOrigin}/internal/v1/browser/video`, {
      headers: { authorization: `Bearer ${start().dataTicket}` },
      perMessageDeflate: false,
    });
    sockets.push(socket);
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    const acks: unknown[] = [];
    socket.on("message", (raw) => acks.push(JSON.parse(String(raw))));
    return {
      socket,
      acks,
      send: (seq: number, key = seq === 1) =>
        socket.send(
          encodeBrowserVideoFrame(header(seq, key), key ? browserKeyFixture : browserDeltaFixture),
        ),
    };
  };
  return {
    hub,
    authenticator,
    binding,
    fence,
    capability,
    operations,
    origin,
    admit,
    add,
    start,
    source,
    header,
    advance: (ms: number) => {
      now += ms;
      hub.sweep();
    },
    end: () => {
      live = false;
      hub.sweep();
    },
    close: async () => {
      hub.close();
      for (const socket of sockets) socket.terminate();
      await app.close();
    },
  };
}
