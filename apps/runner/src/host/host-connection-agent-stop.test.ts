import { parseRunnerConfig } from "@opensteer/config";
import {
  HostToRunnerMessageSchema,
  RunnerBootIdSchema,
  RunnerToHostMessageSchema,
  runnerAgentStopCapability,
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
import { ReconnectingHostConnection, stoppedWorkAllowed } from "./host-connection.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

async function startMockHost(acceptsAgentStop: boolean) {
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
              ...(acceptsAgentStop &&
              parsed.descriptor.capabilities.includes(runnerAgentStopCapability)
                ? { acceptsAgentStop: true }
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

async function createConnection(input: {
  readonly device: RunnerDevice;
  readonly hostUrl: string;
  readonly platform: "darwin" | "linux";
  readonly agentsStoppedSince?: string | null;
}) {
  const root = await mkdtemp(join(tmpdir(), "opensteer-runner-agent-stop-"));
  tempRoots.push(root);
  const identityStore = new FileRunnerIdentityStore({
    dataDirectory: root,
    environmentless: true,
  });
  const identity = await identityStore.loadOrCreate();
  const events = new EventEmitter();
  const connection = new ReconnectingHostConnection({
    ...(input.agentsStoppedSince === undefined
      ? {}
      : { agentsStoppedSince: input.agentsStoppedSince }),
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

const device = { app: "opensteer", form: "laptop", platform: "macos" } as const;
const notices = (received: readonly RunnerToHostMessage[]) =>
  received.flatMap((message) =>
    message.type === "runner.agents.stopped"
      ? [`stopped:${message.stoppedAt}`]
      : message.type === "runner.agents.resumed"
        ? ["resumed"]
        : [],
  );

it("makes an explicit stopped-mode decision for every primary work message", () => {
  const connectionMessages = new Set([
    "host.challenge",
    "host.error",
    "host.welcome",
    "host.connection.lease-renewed",
    "host.auxiliary.ticket",
    "host.grants.credentials",
    "host.shell.probe-full-disk-access",
  ]);
  const work = HostToRunnerMessageSchema.options
    .map((option) => option.shape.type.value)
    .filter((kind) => !connectionMessages.has(kind));
  expect(Object.keys(stoppedWorkAllowed).sort()).toEqual(work.sort());
  expect(
    Object.entries(stoppedWorkAllowed)
      .filter(([, allowed]) => allowed)
      .map(([kind]) => kind),
  ).toEqual([
    "host.discover-model-servers",
    "host.executions.acked",
    "host.executions.attached",
    "host.executions.renewed",
    "host.harness-authentication",
    "host.home-files.cancel",
    "host.home-files.download",
    "host.home-files.list",
    "host.home-files.read",
    "host.home-files.resolve",
    "host.inspect-harnesses",
    "host.reconcile-harnesses",
    "host.runs.revoked",
    "host.thread.stop.recheck",
  ]);
});

describe("ReconnectingHostConnection agent-stop notices", () => {
  it("states the boot mode in the signed descriptor and tells a legacy Home", async () => {
    const host = await startMockHost(true);
    const agentsStoppedSince = "2026-11-20T10:42:00.000Z";
    const { connection, connected } = await createConnection({
      agentsStoppedSince,
      device,
      hostUrl: host.url,
      platform: "darwin",
    });
    const ready = connected();
    const stop = new AbortController();
    const running = connection.run(stop.signal);
    try {
      await ready;
      expect(host.descriptors[0]?.capabilities).toContain(runnerAgentStopCapability);
      await host.flushSocket(host.sockets[0]);
      expect(notices(host.received)).toEqual(["stopped:2026-11-20T10:42:00.000Z"]);

      expect(host.descriptors[0]?.agentsStoppedSince).toBe(agentsStoppedSince);
    } finally {
      stop.abort();
      await running;
      await host.close();
    }
  });

  it("sends nothing to a Home that did not accept it, and advertises nothing without a Stop to tell", async () => {
    const host = await startMockHost(false);
    const agentsStoppedSince = "2026-11-20T10:42:00.000Z";
    const { connection, connected } = await createConnection({
      agentsStoppedSince,
      device,
      hostUrl: host.url,
      platform: "darwin",
    });
    const ready = connected();
    const stop = new AbortController();
    const running = connection.run(stop.signal);
    try {
      await ready;
      await host.flushSocket(host.sockets[0]);
      expect(notices(host.received)).toEqual([]);
    } finally {
      stop.abort();
      await running;
      await host.close();
    }

    const plain = await startMockHost(true);
    const without = await createConnection({ device, hostUrl: plain.url, platform: "darwin" });
    const readyPlain = without.connected();
    const stopPlain = new AbortController();
    const runningPlain = without.connection.run(stopPlain.signal);
    try {
      await readyPlain;
      expect(plain.descriptors[0]?.capabilities).not.toContain(runnerAgentStopCapability);
      await plain.flushSocket(plain.sockets[0]);
    } finally {
      stopPlain.abort();
      await runningPlain;
      await plain.close();
    }
  });
});
