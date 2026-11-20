import type { RunnerConfig } from "@opensteer/config";
import {
  RunnerBootIdSchema,
  RunnerToHostMessageSchema,
  runnerPowerStateCapability,
  type RunnerDescriptor,
  type RunnerDevice,
  type RunnerToHostMessage,
} from "@opensteer/protocol";
import { FileRunnerIdentityStore } from "@opensteer/runner-client";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ReconnectingHostConnection } from "./host-connection.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

async function startMockPowerHost() {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const received: RunnerToHostMessage[] = [];
  const descriptors: RunnerDescriptor[] = [];
  const sockets: WebSocket[] = [];
  let generation = 0;

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/internal/v1/runners") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.push(ws);
      ws.send(
        JSON.stringify({
          challengeId: `rch_${randomUUID()}`,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      ws.on("message", (data) => {
        const parsed = RunnerToHostMessageSchema.parse(JSON.parse(String(data)));
        received.push(parsed);
        if (parsed.type === "runner.enroll" || parsed.type === "runner.authenticate") {
          descriptors.push(parsed.descriptor);
          generation += 1;
          ws.send(
            JSON.stringify({
              allowedModules: ["shell"],
              bootId: parsed.descriptor.bootId,
              connectionGeneration: generation,
              connectionId: `rcn_${randomUUID()}`,
              connectionLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              connectionLeaseId: `rls_${randomUUID()}`,
              environmentIds: [],
              heartbeatIntervalMs: 60_000,
              runnerId: parsed.descriptor.runnerId,
              serverTime: new Date().toISOString(),
              type: "host.welcome",
            }),
          );
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    await vi.waitFor(
      () => {
        if (!predicate()) throw new Error(`Waiting for ${label}`);
      },
      { interval: 10, timeout: 3_000 },
    );
  }

  async function flushSocket(socket: WebSocket | undefined): Promise<void> {
    if (!socket) throw new Error("Expected active WebSocket");
    const pong = once(socket, "pong");
    socket.ping();
    await pong;
  }

  return {
    descriptors,
    flushSocket,
    received,
    sockets,
    url: `http://127.0.0.1:${port}`,
    waitUntil,
    async close(): Promise<void> {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createPowerConnection(input: {
  readonly device: RunnerDevice;
  readonly hostUrl: string;
  readonly platform: "darwin" | "linux";
}) {
  const root = await mkdtemp(join(tmpdir(), "opensteer-runner-power-"));
  tempRoots.push(root);
  const identityStore = new FileRunnerIdentityStore({
    dataDirectory: root,
    environmentless: true,
  });
  const identity = await identityStore.loadOrCreate();
  let connectedCount = 0;
  const connection = new ReconnectingHostConnection({
    bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
    config: {
      browserBridge: undefined,
      controlCaPath: undefined,
      dataDirectory: root,
      deploymentShape: { kind: "personal" },
      enrollmentToken: randomBytes(24).toString("base64url"),
      hostUrl: new URL(input.hostUrl),
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 4,
      mode: "development",
      modules: ["shell"],
      name: "Test Computer",
      nodeExecutable: process.execPath,
      runnerId: identity.runnerId,
      runnerKind: "local",
    } as unknown as RunnerConfig,
    device: input.device,
    fullDiskAccessProbe: { probe: async () => false },
    identity,
    identityStore,
    logger: { error: () => undefined, info: () => undefined },
    onConnected: () => {
      connectedCount += 1;
    },
    platform: input.platform,
    runtimeVersion: "0.0.0",
    shellModule: {
      descriptor: {
        fullDiskAccess: false,
        hostPublicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
        platform: input.platform,
      },
      helperBinary: process.execPath,
      hostKeyPath: "/runner/shell_host_ed25519",
    },
  });
  return {
    connection,
    connectedCount: () => connectedCount,
  };
}

describe("ReconnectingHostConnection power sleep notification", () => {
  it("advertises runner-power-state-v1 on macOS and sends runner.power.sleeping once per connection", async () => {
    const host = await startMockPowerHost();
    const { connection, connectedCount } = await createPowerConnection({
      device: { app: "opensteer", form: "laptop", platform: "macos" },
      hostUrl: host.url,
      platform: "darwin",
    });
    const abort = new AbortController();
    const running = connection.run(abort.signal);

    try {
      await host.waitUntil(
        () => host.received.filter((m) => m.type === "runner.auxiliary.ticket-request").length >= 1,
        "first connect ready",
      );
      expect(host.descriptors[0]?.capabilities).toContain(runnerPowerStateCapability);

      // Calling notifySleeping twice on the same socket sends exactly one fenced frame.
      await connection.notifySleeping();
      await connection.notifySleeping();
      await host.waitUntil(
        () => host.received.filter((m) => m.type === "runner.power.sleeping").length === 1,
        "first runner.power.sleeping",
      );
      await host.flushSocket(host.sockets[0]);
      const firstBatch = host.received.filter((m) => m.type === "runner.power.sleeping");
      expect(firstBatch).toHaveLength(1);
      expect(firstBatch[0]?.connectionGeneration).toBe(1);

      // Drop the first socket; after reconnect on wake, a new sleep notifies again with the new fence.
      host.sockets[0]?.terminate();
      await host.waitUntil(
        () =>
          connectedCount() === 2 &&
          host.received.filter((m) => m.type === "runner.auxiliary.ticket-request").length >= 2,
        "reconnect after wake",
      );
      await connection.notifySleeping();
      await host.waitUntil(
        () => host.received.filter((m) => m.type === "runner.power.sleeping").length === 2,
        "second runner.power.sleeping",
      );
      const secondBatch = host.received.filter((m) => m.type === "runner.power.sleeping");
      expect(secondBatch).toHaveLength(2);
      expect(secondBatch[1]?.connectionGeneration).toBe(2);
    } finally {
      abort.abort();
      await running;
      await host.close();
    }
  });

  it("never advertises runner-power-state-v1 or sends runner.power.sleeping on Linux", async () => {
    const host = await startMockPowerHost();
    const { connection, connectedCount } = await createPowerConnection({
      device: { form: "server", platform: "linux" },
      hostUrl: host.url,
      platform: "linux",
    });
    const abort = new AbortController();
    const running = connection.run(abort.signal);

    try {
      await host.waitUntil(() => connectedCount() === 1, "linux connect");
      expect(host.descriptors[0]?.capabilities).not.toContain(runnerPowerStateCapability);

      await connection.notifySleeping();
      await host.flushSocket(host.sockets[0]);
      expect(host.received.filter((m) => m.type === "runner.power.sleeping")).toHaveLength(0);
    } finally {
      abort.abort();
      await running;
      await host.close();
    }
  });
});
