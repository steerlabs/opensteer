import { createId } from "@opensteer/core";
import {
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerChallengeIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  runnerEnvironmentIds,
  RunnerToHostMessageSchema,
  type RunnerConnectionFence,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { moduleReadiness } from "./fence-ledger.js";
import { RunnerModuleConnection, type RunnerModuleStream } from "./module-connection.js";

const stopping: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stopping.splice(0).reverse()) await stop();
});

describe("RunnerModuleConnection", () => {
  it("reconnects the module stream after its lease runs out", async () => {
    // The Host stops renewing the stream lease while the module runtime is
    // down. That must read as a disconnect: the stream closes, the run loop
    // backs off, and the next stream the Host offers is adopted normally.
    const auxiliaryCloseCodes: number[] = [];
    const streams: RunnerModuleStream[] = [];
    let streamsClosed = 0;
    const host = await startHostStub({
      // The first stream's lease is already nearly gone; the second is healthy.
      streamLeaseMs: (attempt) => (attempt === 1 ? 60 : 120_000),
      onAuxiliaryClose: (code) => auxiliaryCloseCodes.push(code),
    });
    const errors: string[] = [];
    const connection = moduleConnection(host.url, {
      logger: {
        error: (message) => errors.push(message),
        info: () => undefined,
      },
      onStream: (stream) => void streams.push(stream),
      onStreamClosed: () => {
        streamsClosed += 1;
      },
    });
    const stop = new AbortController();
    const run = connection.run(stop.signal);
    stopping.push(async () => {
      stop.abort();
      await run;
    });

    await waitFor(() => streams.length >= 2, 10_000);

    // The expired stream was closed with its own reason rather than dragged
    // down by a failure, and the replacement fences a different stream.
    expect(auxiliaryCloseCodes[0]).toBe(4000);
    expect(streamsClosed).toBeGreaterThanOrEqual(1);
    expect(streams[1]?.fence.auxiliaryStreamId).not.toBe(streams[0]?.fence.auxiliaryStreamId);
    expect(errors).toContain("Runner module connection closed");
  }, 20_000);
});

function moduleConnection(
  hostOrigin: URL,
  overrides: Pick<
    ConstructorParameters<typeof RunnerModuleConnection>[0],
    "logger" | "onStream" | "onStreamClosed"
  >,
): RunnerModuleConnection {
  const pair = generateKeyPairSync("ed25519");
  const runnerId = createId("runner");
  const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
  const identity = {
    createdAt: new Date().toISOString(),
    environmentId: createId("environment"),
    lastConnectionGeneration: 0,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    runnerId,
    version: 3 as const,
  };
  return new RunnerModuleConnection({
    bootId,
    descriptor: (current): RunnerDescriptor => ({
      bootId,
      capabilities: [],
      modules: { browser: { profileSnapshotVersion: 2, runtimeId: "browser-runtime-test" } },
      name: "Browser runtime",
      runnerId: current.runnerId,
      runnerKind: "managed",
      runtimeVersion: "0.0.0",
    }),
    enrollmentToken: "r".repeat(32),
    hostOrigin,
    identity,
    identityStore: {
      acceptHostConnection: async ({ connectionGeneration }) => ({
        ...identity,
        lastConnectionGeneration: connectionGeneration,
      }),
    },
    module: "browser",
    mode: "development",
    onStreamFrame: async () => undefined,
    readiness: () => moduleReadiness("browser", "ready"),
    ...overrides,
  });
}

/**
 * A Host that welcomes the Runner and hands it one module stream per attempt.
 *
 * The lease it puts on each stream is the whole point: the first one runs out
 * under the Runner, and the Runner has to come back for the second.
 */
async function startHostStub(options: {
  readonly onAuxiliaryClose: (code: number) => void;
  readonly streamLeaseMs: (attempt: number) => number;
}): Promise<{ readonly url: URL }> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address() as AddressInfo;
  const webSockets = new WebSocketServer({ perMessageDeflate: false, server });
  let attempts = 0;
  let fence: RunnerConnectionFence | undefined;
  webSockets.on("connection", (socket, request) => {
    if (request.url !== "/internal/v1/runners") {
      const attempt = (attempts += 1);
      socket.on("close", (code) => options.onAuxiliaryClose(code));
      // The stream attaches its reader after the socket opens, so a frame sent
      // in the same breath as the handshake can be missed.
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            hostSessionId: "h".repeat(32),
            module: "browser",
            nonce: "n".repeat(32),
            type: "host.auxiliary.challenge",
          }),
        );
      }, 5);
      socket.once("message", () => {
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              ...fence,
              auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(`rax_${randomUUID()}`),
              heartbeatIntervalMs: 60_000,
              module: "browser",
              serverTime: new Date().toISOString(),
              streamLeaseExpiresAt: new Date(
                Date.now() + options.streamLeaseMs(attempt),
              ).toISOString(),
              type: "host.auxiliary.welcome",
            }),
          );
        }, 5);
      });
      return;
    }
    // The Runner attaches its reader after the socket opens, so a challenge
    // written in the same breath as the handshake would be missed.
    setTimeout(() => {
      socket.send(
        JSON.stringify({
          challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          type: "host.challenge",
        }),
      );
    }, 5);
    socket.on("message", (raw) => {
      const message = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString("utf8")));
      if (message.type === "runner.enroll" || message.type === "runner.authenticate") {
        fence = {
          bootId: message.descriptor.bootId,
          connectionGeneration: 1,
          connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
          connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
          runnerId: message.descriptor.runnerId,
        };
        socket.send(
          JSON.stringify({
            ...fence,
            allowedModules: ["browser"],
            connectionLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
            environmentIds: runnerEnvironmentIds(message.descriptor),
            heartbeatIntervalMs: 60_000,
            serverTime: new Date().toISOString(),
            type: "host.welcome",
          }),
        );
        return;
      }
      if (message.type === "runner.auxiliary.ticket-request") {
        socket.send(
          JSON.stringify({
            ...fence,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            module: message.module,
            requestId: message.requestId,
            ticket: "ticket.for.browser",
            type: "host.auxiliary.ticket",
          }),
        );
      }
    });
  });
  stopping.push(async () => {
    for (const client of webSockets.clients) client.terminate();
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: new URL(`http://127.0.0.1:${address.port}`) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the module connection");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
