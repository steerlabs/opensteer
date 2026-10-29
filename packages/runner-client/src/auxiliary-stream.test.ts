import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import { createId } from "@opensteer/core";
import {
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerChallengeIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
} from "@opensteer/protocol";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openRunnerAuxiliaryStream, type OpenedAuxiliaryStream } from "./auxiliary-stream.js";

const servers: ReturnType<typeof createServer>[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe("openRunnerAuxiliaryStream", () => {
  it.each(["abort", "refuse"] as const)(
    "settles a held upgrade on %s without an unhandled socket error",
    async (action) => {
      const requested = Promise.withResolvers<Socket>();
      const disconnected = Promise.withResolvers<void>();
      const server = createServer((request, response) => {
        if (
          ignoreForeignTestRequest(request, response, (path) =>
            path.startsWith("/internal/v1/runners/auxiliary/"),
          )
        )
          return;
        expect.fail(`Expected a WebSocket upgrade on ${request.url}`);
      });
      server.on("upgrade", (request, transport) => {
        expect(request.url).toBe("/internal/v1/runners/auxiliary/shell");
        const socket = transport as Socket;
        // The raw fixture ended both halves when its client ended; HTTP upgrades default to half-open.
        socket.allowHalfOpen = false;
        socket.on("error", () => socket.destroy());
        sockets.add(socket);
        socket.once("close", () => disconnected.resolve());
        socket.resume();
        requested.resolve(socket);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      await probeTestServer(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind TCP");
      const shutdown = new AbortController();
      const opening = openRunnerAuxiliaryStream({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        hostOrigin: new URL(`http://127.0.0.1:${address.port}`),
        mode: "development",
        module: "shell",
        onFrame: async () => undefined,
        privateKey: generateKeyPairSync("ed25519").privateKey,
        runnerId: createId("runner"),
        signal: shutdown.signal,
        ticket: "aaaa.bbbb.cccc",
      });
      const rejected = expect(opening).rejects.toThrow(
        action === "abort" ? "The module stream was aborted" : "Unexpected server response: 403",
      );
      try {
        // Holding the HTTP upgrade guarantees cancellation happens in CONNECTING,
        // before either temporary handshake error listener can settle normally.
        const peer = await requested.promise;
        if (action === "abort") shutdown.abort();
        else peer.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        await rejected;
        await disconnected.promise;
      } finally {
        shutdown.abort();
        for (const socket of sockets) socket.destroy();
        await opening.catch(() => undefined);
      }
    },
  );

  it("exposes only the Passwords capabilities opted into by this welcome", async () => {
    const legacy = await openTestStream({ leaseMs: 60_000 });
    expect(legacy.stream).not.toHaveProperty("loginText");
    expect(legacy.stream).not.toHaveProperty("passwordSignIn");
    legacy.close();
    const modern = await openTestStream({ leaseMs: 60_000, passwords: true });
    expect(modern.stream).toMatchObject({ loginText: 1, passwordSignIn: 1 });
    modern.close();
  });

  it("invalidates immediately on lease expiry before forcing an unresponsive transport closed", async () => {
    let invalidatedAt = 0;
    const openedAt = Date.now();
    const stream = await openTestStream({
      leaseMs: 75,
      onInvalidated: () => {
        invalidatedAt = Date.now();
      },
    });

    await waitFor(() => invalidatedAt > 0);
    expect(invalidatedAt - openedAt).toBeLessThan(500);
    expect(sockets.size).toBe(1);
    await stream.closed;
    expect(Date.now() - invalidatedAt).toBeGreaterThanOrEqual(900);
  });

  it("rejects a heartbeat on an expired lease instead of throwing at the timer", async () => {
    // The Runner heartbeats every module on one timer. A lease that ran out
    // has to arrive there as a rejected promise the timer's own handler sees,
    // because a synchronous throw would escape the timer and end the process.
    let invalidated = false;
    const stream = await openTestStream({
      leaseMs: 40,
      onInvalidated: () => {
        invalidated = true;
      },
    });

    await waitFor(() => invalidated);

    let beat: Promise<void> | undefined;
    expect(() => {
      beat = stream.heartbeat();
    }).not.toThrow();
    await expect(beat).rejects.toThrow(/closed|expired/iu);
  });

  it("keeps heartbeating a stream whose lease is still good", async () => {
    const stream = await openTestStream({ leaseMs: 60_000 });

    await expect(stream.heartbeat()).resolves.toBeUndefined();

    stream.close();
  });
});

/**
 * A Host stub that completes the auxiliary handshake and then goes quiet.
 *
 * It answers over a raw TCP socket rather than a WebSocket server so the close
 * handshake is never completed: that is what makes an expiring lease visible
 * as its own event instead of as the transport closing.
 */
async function openTestStream(options: {
  readonly leaseMs: number;
  readonly passwords?: boolean;
  readonly onInvalidated?: () => void;
}): Promise<OpenedAuxiliaryStream> {
  const module = options.passwords ? ("integrations" as const) : ("shell" as const);
  const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
  const runnerId = createId("runner");
  const connectionId = RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`);
  const connectionLeaseId = RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`);
  const auxiliaryStreamId = RunnerAuxiliaryStreamIdSchema.parse(`rax_${randomUUID()}`);
  const server = createServer((request, response) => {
    if (
      ignoreForeignTestRequest(request, response, (path) =>
        path.startsWith("/internal/v1/runners/auxiliary/"),
      )
    )
      return;
    expect.fail(`Expected a WebSocket upgrade on ${request.url}`);
  });
  server.on("upgrade", (request, transport) => {
    expect(request.url).toBe(`/internal/v1/runners/auxiliary/${module}`);
    const socket = transport as Socket;
    // The raw fixture ended both halves when its client ended; HTTP upgrades default to half-open.
    socket.allowHalfOpen = false;
    socket.on("error", () => socket.destroy());
    sockets.add(socket);
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // Welcome acknowledges the Runner's proof. Two expired timers can send
    // challenge and welcome in one read, before a welcome listener exists.
    socket.once("data", () => {
      socket.write(
        webSocketTextFrame({
          auxiliaryStreamId,
          bootId,
          connectionGeneration: 1,
          connectionId,
          connectionLeaseId,
          heartbeatIntervalMs: 1_000,
          ...(options.passwords ? { loginText: 1, passwordSignIn: 1 } : {}),
          module,
          runnerId,
          serverTime: new Date().toISOString(),
          streamLeaseExpiresAt: new Date(Date.now() + options.leaseMs).toISOString(),
          type: "host.auxiliary.welcome",
        }),
      );
    });
    socket.write(
      webSocketTextFrame({
        challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        hostSessionId: "h".repeat(32),
        module,
        nonce: "n".repeat(32),
        type: "host.auxiliary.challenge",
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await probeTestServer(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP");
  return openRunnerAuxiliaryStream({
    bootId,
    hostOrigin: new URL(`http://127.0.0.1:${address.port}`),
    mode: "development",
    module,
    onFrame: async () => undefined,
    ...(options.onInvalidated ? { onInvalidated: options.onInvalidated } : {}),
    privateKey: generateKeyPairSync("ed25519").privateKey,
    runnerId,
    signal: new AbortController().signal,
    ticket: "aaaa.bbbb.cccc",
  });
}

function webSocketTextFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.byteLength < 126)
    return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.byteLength, 2);
  return Buffer.concat([header, payload]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for auxiliary stream state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
