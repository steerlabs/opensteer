import { parseRunnerConfig } from "@opensteer/config";
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
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ReconnectingHostConnection } from "./host-connection.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

async function startMockPowerHost(acceptsPowerState: boolean) {
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
              ...(acceptsPowerState &&
              parsed.descriptor.capabilities.includes(runnerPowerStateCapability)
                ? { acceptsPowerState: true }
                : {}),
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
  const events = new EventEmitter();
  const connection = new ReconnectingHostConnection({
    bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
    config: parseRunnerConfig({
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_URL: input.hostUrl,
      OPENSTEER_RUNNER_DATA_DIR: root,
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: randomBytes(24).toString("base64url"),
      OPENSTEER_MODE: "development",
      OPENSTEER_RUNNER_MODULES: "shell",
      OPENSTEER_RUNNER_NAME: "Test Computer",
      OPENSTEER_RUNNER_ID: identity.runnerId,
      OPENSTEER_RUNNER_KIND: "local",
    }),
    device: input.device,
    fullDiskAccessProbe: { probe: async () => false },
    identity,
    identityStore,
    logger: { error: () => undefined, info: () => undefined },
    onConnected: () => {
      events.emit("connected");
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
    connected: () => once(events, "connected"),
  };
}

describe("ReconnectingHostConnection power sleep notification", () => {
  it("sends one fenced notice per sleep and allows another after waking on the same connection", async () => {
    const host = await startMockPowerHost(true);
    const { connection, connected } = await createPowerConnection({
      device: { app: "opensteer", form: "laptop", platform: "macos" },
      hostUrl: host.url,
      platform: "darwin",
    });
    const ready = connected();
    const abort = new AbortController();
    const running = connection.run(abort.signal);
    const notices = () => host.received.filter((frame) => frame.type === "runner.power.sleeping");

    try {
      await ready;
      expect(host.descriptors[0]?.capabilities).toContain(runnerPowerStateCapability);
      await connection.notifySleeping();
      await connection.notifySleeping();
      await host.flushSocket(host.sockets[0]);
      expect(notices().map((notice) => notice.connectionGeneration)).toEqual([1]);

      connection.notifyAwake();
      await connection.notifySleeping();
      await host.flushSocket(host.sockets[0]);
      expect(notices().map((notice) => notice.connectionGeneration)).toEqual([1, 1]);

      const reconnected = connected();
      host.sockets[0]?.terminate();
      await reconnected;
      await connection.notifySleeping();
      await host.flushSocket(host.sockets[1]);
      expect(notices().map((notice) => notice.connectionGeneration)).toEqual([1, 1, 2]);
    } finally {
      abort.abort();
      await running;
      await host.close();
    }
  });

  it.each([
    {
      platform: "linux",
      device: { form: "server", platform: "linux" },
      accepts: true,
      advertises: false,
    },
    {
      platform: "darwin",
      device: { form: "laptop", platform: "macos" },
      accepts: false,
      advertises: true,
    },
  ] as const)(
    "avoids sending a notice with $platform and Host opt-in $accepts",
    async (fixture) => {
      const host = await startMockPowerHost(fixture.accepts);
      const { connection, connected } = await createPowerConnection({
        device: fixture.device,
        hostUrl: host.url,
        platform: fixture.platform,
      });
      const ready = connected();
      const abort = new AbortController();
      const running = connection.run(abort.signal);
      try {
        await ready;
        expect(host.descriptors[0]?.capabilities.includes(runnerPowerStateCapability)).toBe(
          fixture.advertises,
        );
        await connection.notifySleeping();
        await host.flushSocket(host.sockets[0]);
        expect(
          host.received.filter((frame) => frame.type === "runner.power.sleeping"),
        ).toHaveLength(0);
      } finally {
        abort.abort();
        await running;
        await host.close();
      }
    },
  );
});
