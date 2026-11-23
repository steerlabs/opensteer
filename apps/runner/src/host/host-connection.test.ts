import { runnerCapabilities } from "./host-connection.js";
import { harnessMinimumVersion } from "@opensteer/core";
import type { RunnerHarnessDriver } from "@opensteer/protocol";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { parseRunnerConfig, type RunnerConfig } from "@opensteer/config";
import {
  createId,
  HarnessIdSchema,
  ThreadAccessModeSchema,
  type EnvironmentId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import {
  HarnessRegistry,
  nativeUserHarnessRuntimeBoundary,
  type HarnessDriver,
} from "@opensteer/harness";
import { z } from "zod";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { getDeviceDefinition } from "@opensteer/integration-catalog/devices";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import { computerAppOperationContract } from "@opensteer/integration-core/computer-app-tools";
import {
  CorrelationIdSchema,
  HarnessInstanceCatalogSchema,
  IntegrationsModuleEventSchema,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerChallengeIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  agentHomeFilesCapability,
  triggerStopGenerationCapability,
  runnerEnvironmentIds,
  RunnerToHostMessageSchema,
  type RunnerCommand,
  type RunnerConnectionFence,
  type RunnerAppResult,
  type RunnerOperationalReport,
  type RunnerToHostMessage,
} from "@opensteer/protocol";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  AgentsWorkSession,
  CausallyOrderedRunnerSink,
  WebSocketMessageSink,
  ReconnectingHostConnection,
  runnerWebSocketUrl,
  waitForRunnerReconnect,
} from "./host-connection.js";
import { LocalMcpServers } from "../computer-apps/local-mcp-servers.js";
import { RunnerRuntime } from "../runtime/runtime.js";
import { AgentHomeManager } from "../folders/agent-home.js";
import {
  providerContinuationIdentityProjector,
  RunnerConnectionFenceLedger,
} from "@opensteer/runner-client";

const serverDeploymentShape = {
  kind: "personal" as const,
} as const;
const testNativeFsHelperBinary = fileURLToPath(
  new URL(
    `../../native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);
const testAgentSkills = {
  paths: {
    "opensteer:skills": "/runner/agent-skills/skills/skills",
    "opensteer:memory": "/runner/agent-skills/skills/memory",
    "opensteer:plugins": "/runner/agent-skills/skills/plugins",
    "opensteer:browser": "/runner/agent-skills/skills/browser",
    "opensteer:computer-use": "/runner/agent-skills/skills/computer-use",
    "opensteer:computers": "/runner/agent-skills/skills/computers",
    "opensteer:devices": "/runner/agent-skills/skills/devices",
    "opensteer:tasks": "/runner/agent-skills/skills/tasks",
    "opensteer:automations": "/runner/agent-skills/skills/automations",
    "opensteer:projects": "/runner/agent-skills/skills/projects",
  },
  rootPath: "/runner/agent-skills",
} as const;
const noPlugins = async () => ({
  cleanup: async () => undefined,
  digest: "none",
  directories: [],
  skills: [],
});
const projectContinuationIdentity = providerContinuationIdentityProjector(
  generateKeyPairSync("ed25519").privateKey,
);

async function connectedSocketPair() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let socket: WebSocket | undefined;
  try {
    await withTimeout(once(server, "listening"), 1_000, {
      timeoutError: () => new Error("Runner sink fixture never began listening"),
    });
    const connected = once(server, "connection");
    const address = server.address() as AddressInfo;
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const [[peer]] = await withTimeout(Promise.all([connected, once(socket, "open")]), 2_000, {
      timeoutError: () => new Error("Runner sink fixture never completed its WebSocket handshake"),
    });
    return { server, socket, peer: peer as WebSocket };
  } catch (error) {
    socket?.terminate();
    for (const client of server.clients) client.terminate();
    await withTimeout(new Promise<void>((resolve) => server.close(() => resolve())), 1_000, {
      timeoutError: () => new Error("Runner sink fixture did not close after failed setup"),
    });
    throw error;
  }
}

describe("AgentsWorkSession", () => {
  it.each(["interrupt", "revoke"] as const)(
    "%s overtakes an admitted steer but waits for execute admission",
    async (stop) => {
      const ids = {
        environmentId: createId("environment"),
        runId: createId("run"),
        threadId: createId("thread"),
      };
      const execution = Promise.withResolvers<void>();
      const steering = Promise.withResolvers<void>();
      const calls: string[] = [];
      const messages: Parameters<CausallyOrderedRunnerSink["send"]>[0][] = [];
      const sink = new CausallyOrderedRunnerSink({
        send: async (message) => void messages.push(message),
      });
      const runtime = {
        fenceRequestAnswers: vi.fn(),
        observeAgentHomeSkills: () => undefined,
        observeAgentHomeSettings: async () => undefined,
        setHostRunRetryEvents: () => undefined,
        subscribeHarnessPreparation: () => () => undefined,
        appServers: { observe: () => () => undefined },
        handleCommand: async (command: RunnerCommand) => {
          calls.push(command.type);
          if (command.type === "run.execute") await execution.promise;
          if (command.type === "run.steer") await steering.promise;
          if (command.type === "run.interrupt") {
            await sink.send(terminalEvent(ids));
            steering.resolve();
          }
          return { status: "accepted" as const };
        },
        revokeRuns: () => {
          calls.push("revoked");
          steering.resolve();
        },
      } as unknown as RunnerRuntime;
      const fail = vi.fn();
      const fence: RunnerConnectionFence = {
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        connectionGeneration: 1,
        connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
        connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
        runnerId: createId("runner"),
      };
      const work = new AgentsWorkSession({
        agents: { runtime },
        appTransport: {
          controlCaPath: undefined,
          hostUrl: new URL("http://localhost"),
          mode: "development",
        },
        environmentId: () => ids.environmentId,
        fail,
        fence: new RunnerConnectionFenceLedger(),
        heartbeatNow: () => undefined,
        signal: new AbortController().signal,
        sink,
      });
      const execute = {
        type: "run.execute",
        context: { runId: ids.runId },
      } as RunnerCommand;
      const steer = controlCommand("run.steer", ids);
      const interrupt = controlCommand("run.interrupt", ids);
      try {
        await work.handle({ ...fence, type: "host.command", command: execute });
        await work.handle({ ...fence, type: "host.command", command: steer });
        await work.handle(
          stop === "interrupt"
            ? { ...fence, type: "host.command", command: interrupt }
            : {
                ...fence,
                type: "host.runs.revoked",
                revocations: [{ reason: "Stopped", runId: ids.runId }],
              },
        );
        expect(calls).toEqual(["run.execute"]);
        expect(runtime.fenceRequestAnswers).toHaveBeenCalledExactlyOnceWith(
          ids.runId,
          ...(stop === "interrupt" ? [interrupt] : []),
        );
        expect(work.settled()).toBe(false);
        execution.resolve();
        await vi.waitFor(() =>
          expect([...calls], `${stop} never overtook the pending steer`).toEqual([
            "run.execute",
            "run.steer",
            stop === "interrupt" ? "run.interrupt" : "revoked",
          ]),
        );
        await vi.waitFor(() => expect(work.settled(), "Command receipts never settled").toBe(true));
        expect(fail).not.toHaveBeenCalled();
        if (stop === "interrupt") {
          const receipt = messages.findIndex(
            (message) => "commandId" in message && message.commandId === interrupt.commandId,
          );
          const event = messages.findIndex((message) => message.type === "runner.event");
          expect(receipt).toBeGreaterThanOrEqual(0);
          expect(event).toBeGreaterThan(receipt);
          expect(messages.at(-1)).toMatchObject({
            type: "runner.event",
            event: { runId: ids.runId, type: "run.interrupted" },
          });
        }
      } finally {
        execution.resolve();
        steering.resolve();
        await work.close();
        sink.close();
      }
    },
  );
});

describe("CausallyOrderedRunnerSink", () => {
  it("holds events until both a pending steer and its interrupt have receipts", async () => {
    const ids = {
      environmentId: createId("environment"),
      runId: createId("run"),
      threadId: createId("thread"),
    };
    const messages: Parameters<CausallyOrderedRunnerSink["send"]>[0][] = [];
    const sink = new CausallyOrderedRunnerSink({
      send: async (message) => void messages.push(message),
    });
    const steering = Promise.withResolvers<{ status: "accepted" }>();
    const steer = sink.applyCommand(controlCommand("run.steer", ids), () => steering.promise);
    try {
      await sink.applyCommand(controlCommand("run.interrupt", ids), async () => {
        await sink.send(terminalEvent(ids));
        return { status: "accepted" };
      });
      expect(messages.map((message) => message.type)).toEqual(["runner.command-accepted"]);
      steering.resolve({ status: "accepted" });
      await steer;
      expect(messages.map((message) => message.type)).toEqual([
        "runner.command-accepted",
        "runner.command-accepted",
        "runner.event",
      ]);
    } finally {
      steering.resolve({ status: "accepted" });
      await steer;
      sink.close();
    }
  });
  it("reports an uncertain steer without converting it to a refusal", async () => {
    const messages: Parameters<CausallyOrderedRunnerSink["send"]>[0][] = [];
    const sink = new CausallyOrderedRunnerSink({
      send: async (message) => void messages.push(message),
    });
    const command = controlCommand("run.steer", {
      environmentId: createId("environment"),
      runId: createId("run"),
      threadId: createId("thread"),
    });

    await sink.applyCommand(command, async () => ({
      message: "Provider acknowledgement was lost",
      status: "uncertain",
    }));

    expect(messages).toEqual([
      {
        commandId: command.commandId,
        correlationId: command.correlationId,
        message: "Provider acknowledgement was lost",
        type: "runner.command-uncertain",
      },
    ]);
  });

  it.each(["run.interrupt", "request.resolve", "run.steer"] as const)(
    "sends the %s acceptance before a synchronous terminal event",
    async (type) => {
      const runId = createId("run");
      const threadId = createId("thread");
      const environmentId = createId("environment");
      const messages: Parameters<CausallyOrderedRunnerSink["send"]>[0][] = [];
      const sink = new CausallyOrderedRunnerSink({
        send: async (message) => void messages.push(message),
      });
      const command = controlCommand(type, { environmentId, runId, threadId });
      const terminal = terminalEvent({ environmentId, runId, threadId });

      await sink.applyCommand(command, async () => {
        await sink.send(terminal);
        expect(messages).toEqual([]);
        return { status: "accepted" };
      });

      expect(messages.map((message) => message.type)).toEqual([
        "runner.command-accepted",
        "runner.event",
      ]);
      expect(messages[1]).toEqual(terminal);
    },
  );
});

describe("WebSocketMessageSink", () => {
  it("sends app replies with only their nested fence and keeps ordinary reports fenced", async () => {
    const { server, socket, peer } = await connectedSocketPair();
    const fence: RunnerConnectionFence = {
      bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      connectionGeneration: 1,
      connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
      connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
      runnerId: createId("runner"),
    };
    const ledger = new RunnerConnectionFenceLedger();
    ledger.adopt(fence, new Date(Date.now() + 60_000).toISOString());
    const sink = new WebSocketMessageSink(socket, ledger);
    const reply = {
      appId: `app_${randomUUID()}`,
      ok: false,
      error: "Test app failure",
      fence: {
        ...fence,
        bindingGeneration: 1,
        environmentId: createId("environment"),
      },

      generation: 1,
      requestId: randomUUID(),
      type: "runner.app.result",
    } satisfies RunnerAppResult;
    const receive = () =>
      withTimeout(
        new Promise<unknown>((resolve) =>
          peer.once("message", (frame) => resolve(JSON.parse(frame.toString()))),
        ),
        1_000,
        { timeoutError: () => new Error("Runner sink never delivered its fenced report") },
      );
    try {
      const storageReceived = receive();
      await sink.send(reply);
      expect(RunnerToHostMessageSchema.parse(await storageReceived)).toEqual(reply);
      const heartbeatReceived = receive();
      const heartbeat = {
        activeRunIds: [],
        activeTriggerOccurrenceIds: [],
        activeWatchActivationIds: [],
        sentAt: new Date().toISOString(),
        type: "runner.heartbeat" as const,
      };
      await sink.send(heartbeat);
      expect(RunnerToHostMessageSchema.parse(await heartbeatReceived)).toEqual({
        ...fence,
        ...heartbeat,
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      sink.close();
      socket.terminate();
      peer.terminate();
      await withTimeout(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        1_000,
        { timeoutError: () => new Error("Runner sink fixture did not close") },
      );
    }
  });

  it("turns oversized model catalogs into per-profile errors without closing the socket", async () => {
    const { server, socket, peer } = await connectedSocketPair();
    const fence: RunnerConnectionFence = {
      bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      connectionGeneration: 1,
      connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
      connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
      runnerId: createId("runner"),
    };
    const ledger = new RunnerConnectionFenceLedger();
    ledger.adopt(fence, new Date(Date.now() + 60_000).toISOString());
    const sink = new WebSocketMessageSink(socket, ledger);
    const smallId = createId("harnessInstance");
    const largeId = createId("harnessInstance");
    const model = (index: number) => ({
      displayName: `Model ${index} ${"d".repeat(100)}`,
      isDefault: index === 0,
      modelId: `model-${index}-${"m".repeat(80)}`,
      nativeModelId: `native-${index}-${"n".repeat(180)}`,
      options: [],
      providerId: "test",
    });
    const readyCatalog = (harnessInstanceId: typeof smallId, models: ReturnType<typeof model>[]) =>
      HarnessInstanceCatalogSchema.parse({
        continuationIdentity: {
          continuationKey: `runner:v1:${"a".repeat(43)}`,
          driverKind: "opencode",
        },
        driverKind: "opencode",
        harnessInstanceId,
        models,
        status: "ready",
      });
    const response = {
      catalogs: [
        readyCatalog(smallId, [model(0)]),
        readyCatalog(
          largeId,
          Array.from({ length: 8_192 }, (_, index) => model(index)),
        ),
      ],
      requestId: CorrelationIdSchema.parse("large-catalog"),
      type: "runner.harness-catalog",
    } satisfies RunnerOperationalReport;
    const received = new Promise<Buffer>((resolve) =>
      peer.once("message", (frame) => resolve(Buffer.from(frame.toString()))),
    );
    try {
      await sink.send(response);
      const frame = await withTimeout(received, 1_000, {
        timeoutError: () => new Error("Runner sink never delivered the bounded profile catalog"),
      });
      expect(frame.byteLength).toBeLessThanOrEqual(1_024 * 1_024);
      const parsed = RunnerToHostMessageSchema.parse(JSON.parse(frame.toString("utf8")));
      if (parsed.type !== "runner.harness-catalog") throw new Error("Expected catalog response");
      expect(parsed.catalogs).toEqual([
        expect.objectContaining({ harnessInstanceId: smallId, status: "ready" }),
        expect.objectContaining({
          detail: expect.stringContaining("could not fit"),
          harnessInstanceId: largeId,
          models: [],
          status: "error",
        }),
      ]);
      expect(socket.readyState).toBe(WebSocket.OPEN);

      const aggregateIds = Array.from({ length: 100 }, () => createId("harnessInstance"));
      const aggregate = {
        catalogs: aggregateIds.map((id) =>
          readyCatalog(
            id,
            Array.from({ length: 30 }, (_, index) => model(index)),
          ),
        ),
        requestId: CorrelationIdSchema.parse("aggregate-catalog"),
        type: "runner.harness-catalog",
      } satisfies RunnerOperationalReport;
      expect(Buffer.byteLength(JSON.stringify({ ...fence, ...aggregate }), "utf8")).toBeGreaterThan(
        1_024 * 1_024,
      );
      const aggregateReceived = new Promise<Buffer>((resolve) =>
        peer.once("message", (aggregateFrame) => resolve(Buffer.from(aggregateFrame.toString()))),
      );
      await sink.send(aggregate);
      const aggregateFrame = await withTimeout(aggregateReceived, 1_000, {
        timeoutError: () => new Error("Runner sink never delivered the bounded aggregate catalog"),
      });
      expect(aggregateFrame.byteLength).toBeLessThanOrEqual(1_024 * 1_024);
      const aggregateParsed = RunnerToHostMessageSchema.parse(
        JSON.parse(aggregateFrame.toString("utf8")),
      );
      if (aggregateParsed.type !== "runner.harness-catalog") {
        throw new Error("Expected aggregate catalog response");
      }
      expect(aggregateParsed.catalogs).toHaveLength(100);
      expect(new Set(aggregateParsed.catalogs.map((catalog) => catalog.harnessInstanceId))).toEqual(
        new Set(aggregateIds),
      );
      expect(aggregateParsed.catalogs.some((catalog) => catalog.status === "error")).toBe(true);
      expect(aggregateParsed.catalogs.some((catalog) => catalog.status === "ready")).toBe(true);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      sink.close();
      socket.terminate();
      peer.terminate();
      await withTimeout(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        1_000,
        { timeoutError: () => new Error("Runner sink fixture did not close") },
      );
    }
  });
});

describe("runnerWebSocketUrl", () => {
  it("rejects plaintext production connections", () => {
    expect(() =>
      runnerWebSocketUrl({
        hostUrl: new URL("http://host.example"),
        mode: "production",
      }),
    ).toThrow("HTTPS");
  });

  it("accepts plaintext production connections only on loopback", () => {
    expect(
      runnerWebSocketUrl({
        hostUrl: new URL("http://127.0.0.1:4310"),
        mode: "production",
      }).href,
    ).toBe("ws://127.0.0.1:4310/internal/v1/runners");
    expect(() =>
      runnerWebSocketUrl({
        hostUrl: new URL("http://personal.example"),
        mode: "production",
      }),
    ).toThrow("HTTPS");
  });

  it("keeps the daemon alive while waiting to reconnect", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let reconnectTimer: NodeJS.Timeout | undefined;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...arguments_: unknown[]) => void,
      timeout?: number,
    ) => {
      const timer = nativeSetTimeout(handler, timeout);
      reconnectTimer = timer;
      return timer;
    }) as typeof setTimeout);
    const abort = new AbortController();
    try {
      const waiting = waitForRunnerReconnect(60_000, abort.signal);
      expect(reconnectTimer?.hasRef()).toBe(true);
      abort.abort();
      await waiting;
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("announces a changed macOS grant on the fenced connection and restates it on reconnect", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({
      path: "/internal/v1/runners",
      perMessageDeflate: false,
      server,
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    const abort = new AbortController();
    const advertised: unknown[] = [];
    const announcements: RunnerToHostMessage[] = [];
    // The first probe happens on connect. A foreground refresh sees the grant.
    const answers = [false, true, true];
    let probes = 0;
    const probe = vi.fn(async () => answers[Math.min(probes++, answers.length - 1)] ?? true);
    let connections = 0;
    webSockets.on("connection", (socket) => {
      connections += 1;
      const generation = connections;
      socket.send(
        JSON.stringify({
          challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      socket.on("message", (raw) => {
        const message = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString("utf8")));
        if (message.type === "runner.enroll" || message.type === "runner.authenticate") {
          advertised.push(message.descriptor.modules.shell);
          if (generation > 1) {
            abort.abort(new Error("test complete"));
            return;
          }
          socket.send(
            JSON.stringify({
              allowedModules: ["shell"],
              bootId: message.descriptor.bootId,
              connectionGeneration: generation,
              connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
              connectionLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
              connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
              environmentIds: runnerEnvironmentIds(message.descriptor),
              heartbeatIntervalMs: 60_000,
              runnerId: message.descriptor.runnerId,
              serverTime: new Date().toISOString(),
              type: "host.welcome",
            }),
          );
          return;
        }
        if (message.type === "runner.executions.attach") {
          socket.send(
            JSON.stringify({
              bootId: message.bootId,
              connectionGeneration: message.connectionGeneration,
              connectionId: message.connectionId,
              connectionLeaseId: message.connectionLeaseId,
              runnerId: message.runnerId,
              type: "host.shell.probe-full-disk-access",
            }),
          );
          return;
        }
        if (message.type === "runner.shell.full-disk-access") {
          announcements.push(message);
          // Drop the connection so the next descriptor has to state the grant
          // this Runner just learned, rather than the one it booted with.
          socket.close(1001, "Host restarting");
          return;
        }
      });
    });
    const runnerId = createId("runner");
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const environmentId = createId("environment");
    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    const connection = new ReconnectingHostConnection({
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: "/tmp/opensteer-full-access-test",
        deploymentShape: { kind: "personal" },
        enrollmentToken: "f".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["shell"],

        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
      } as unknown as RunnerConfig,
      fullDiskAccessProbe: { probe },
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      logger: { error: () => undefined, info: () => undefined },
      runtimeVersion: "test",
      shellModule: {
        descriptor: {
          fullDiskAccess: false,
          hostPublicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
          platform: "darwin",
        },
        helperBinary: process.execPath,
        hostKeyPath: "/runner/shell_host_ed25519",
      },
    });
    try {
      await connection.run(abort.signal);

      // The flip is announced exactly once, fenced by the connection that
      // carried it, and the probes before it said nothing at all.
      expect(announcements).toHaveLength(1);
      expect(announcements[0]).toMatchObject({
        connectionGeneration: 1,
        fullDiskAccess: true,
        runnerId,
        type: "runner.shell.full-disk-access",
      });
      expect(probes).toBe(3);
      expect(advertised[0]).toEqual({
        fullDiskAccess: false,
        hostPublicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
        platform: "darwin",
      });
      expect(advertised[1]).toMatchObject({ fullDiskAccess: true });
    } finally {
      connection.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("keeps advertising execution and browser abilities together", async () => {
    const runtimeId = "browser-with-agents";
    const server = createServer((_request, response) => {
      response.end(JSON.stringify({ runtimeId, wireVersion: 1, state: "ready" }));
    });
    const webSockets = new WebSocketServer({ path: "/internal/v1/runners", server });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      runnerId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      version: 3 as const,
    };
    const descriptor = Promise.withResolvers<unknown>();
    const abort = new AbortController();
    webSockets.on("connection", (socket) => {
      socket.send(
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
      socket.once("message", (raw) => {
        const message = RunnerToHostMessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!message.success) {
          descriptor.reject(message.error);
          return;
        }
        if (message.data.type === "runner.enroll") descriptor.resolve(message.data.descriptor);
      });
    });
    const config = parseRunnerConfig({
      OPENSTEER_HOST_URL: `http://127.0.0.1:${address.port}`,
      OPENSTEER_RUNNER_MODULES: "agents,browser",
      OPENSTEER_MAX_CONCURRENT_RUNS: "1",
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "e".repeat(32),
      OPENSTEER_BROWSER_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
      OPENSTEER_BROWSER_BRIDGE_TOKEN: "b".repeat(32),
      OPENSTEER_BROWSER_RUNTIME_ID: runtimeId,
      OPENSTEER_BROWSER_SIGN_IN: "1",
    });
    const runtime = new RunnerRuntime({
      nativeFsHelperBinary: testNativeFsHelperBinary,
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      plugins: noPlugins,
      bootId,
      deploymentShape: serverDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: new HarnessRegistry(),
      maxConcurrentRuns: 1,
      dataDirectory: "/tmp/opensteer-browser-agents-test",
      privateStateDirectory: "/tmp/opensteer-browser-agents-test/state",
      browserHarnessExecutable: "/opt/opensteer/browser-harness",
      projectContinuationIdentity,
      agentHome: {
        folder: async ({ path }) => path,
        prepare: async () => {
          throw new Error("not used");
        },
      },
    });
    const connection = new ReconnectingHostConnection({
      bootId,
      config,
      identity,
      identityStore: { acceptHostConnection: async () => identity },
      logger: { info: () => {}, error: () => {} },
      runtimeVersion: "test",
      agents: {
        runtime,
      },
      browserBridge: config.browserBridge,
    });
    const running = connection.run(abort.signal);
    try {
      await expect(
        withTimeout(descriptor.promise, 2_000, {
          timeoutError: () => new Error("The combined Runner never advertised its modules"),
        }),
      ).resolves.toMatchObject({
        modules: {
          agents: { environmentIds: [environmentId], maxConcurrentRuns: 1 },
          browser: {
            runtimeId,
            wireVersion: 1,
            cdpBoundary: 1,
            sharedControl: 1,
            signIn: { version: 3 },
            cardFill: 1,
          },
        },
      });
    } finally {
      abort.abort();
      connection.close();
      await running;
      await runtime.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps processing control messages while a catalog lifecycle operation is pending", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({
      maxPayload: 1024 * 1024,
      path: "/internal/v1/runners",
      perMessageDeflate: false,
      server,
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address() as AddressInfo;
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const harness = {
      config: {} as unknown as RunnerConfig,
      driverKind: "native",
      id: createId("harnessInstance"),
      name: "Native",
      runtimeRevision: 1,
      sourceId: "test",
      stateKind: "isolated",
    } as const;
    const otherHarness = { ...harness, id: createId("harnessInstance"), name: "Other" } as const;
    const abort = new AbortController();
    let finishInspection!: () => void;
    const inspection = new Promise<readonly []>((resolve) => {
      finishInspection = () => resolve([]);
    });
    let catalogCanceled = false;
    let authorization: string | undefined;
    let completedCatalogs = 0;
    let fence!: RunnerConnectionFence;
    const received: unknown[] = [];
    webSockets.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      const challenge = {
        challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        hostSessionId: "host-session-with-at-least-thirty-two-characters",
        nonce: "runner-challenge-with-at-least-thirty-two-characters",
        proofFormatVersion: 2,
        runEventsVersion: 2,
        type: "host.challenge" as const,
      };
      socket.send(JSON.stringify(challenge));
      socket.on("message", (frame) => {
        const message = RunnerToHostMessageSchema.parse(JSON.parse(frame.toString("utf8")));
        received.push(message);
        if (message.type === "runner.enroll") {
          // Every post-authentication frame carries the same fence in both
          // directions, so the fake Host mints one and repeats it.
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
              allowedModules: ["agents"],
              connectionLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
              environmentIds: runnerEnvironmentIds(message.descriptor),
              heartbeatIntervalMs: 1_000,
              serverTime: new Date().toISOString(),
              type: "host.welcome",
            }),
          );
          socket.send(
            JSON.stringify({
              ...fence,
              harnesses: [harness],
              requestId: CorrelationIdSchema.parse("cold-catalog"),
              type: "host.reconcile-harnesses",
            }),
          );
          socket.send(
            JSON.stringify({
              ...fence,
              harnesses: [harness],
              requestId: CorrelationIdSchema.parse("joined-cold-catalog"),
              type: "host.reconcile-harnesses",
            }),
          );
          socket.send(
            JSON.stringify({
              ...fence,
              harnesses: [otherHarness],
              requestId: CorrelationIdSchema.parse("overtaking-catalog"),
              type: "host.inspect-harnesses",
            }),
          );
          socket.send(
            JSON.stringify({
              ...fence,
              command: {
                commandId: createId("command"),
                correlationId: CorrelationIdSchema.parse("connection-test"),
                environmentId: createId("environment"),
                runId: createId("run"),
                threadId: createId("thread"),
                type: "run.interrupt",
              },
              type: "host.command",
            }),
          );
        } else if (message.type === "runner.command-rejected") {
          finishInspection();
        } else if (message.type === "runner.harness-catalog") {
          if (message.requestId === "overtaking-catalog") return;
          completedCatalogs += 1;
          if (completedCatalogs < 2) return;
          socket.send(
            JSON.stringify({
              ...fence,
              harnesses: [harness],
              requestId: CorrelationIdSchema.parse("disconnected-catalog"),
              type: "host.inspect-harnesses",
            }),
          );
          setTimeout(() => {
            socket.close();
            setTimeout(() => abort.abort(new Error("test complete")), 20);
          }, 20);
        }
      });
    });

    const registry = new HarnessRegistry();
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const runtime = new RunnerRuntime({
      nativeFsHelperBinary: testNativeFsHelperBinary,
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      plugins: noPlugins,
      bootId,
      deploymentShape: serverDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      maxConcurrentRuns: 1,
      dataDirectory: dirname("/tmp/opensteer-runner-connection-test/state"),
      privateStateDirectory: "/tmp/opensteer-runner-connection-test/state",
      browserHarnessExecutable: "/opt/opensteer/browser-harness",
      projectContinuationIdentity,
      agentHome: {
        folder: async ({ path }) => path,
        prepare: async () => Promise.reject(new Error("not used")),
      },
    });
    // A reconcile no longer holds the connection, so calls arrive in the order
    // work becomes ready rather than the order messages were sent; each
    // answer is chosen by what it inspects.
    let nativeInspections = 0;
    vi.spyOn(runtime, "inspectHarnesses").mockImplementation((definitions, signal) => {
      if (definitions[0]?.id === otherHarness.id) return Promise.resolve([]);
      nativeInspections += 1;
      if (nativeInspections === 1) return inspection;
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            catalogCanceled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const config: RunnerConfig = {
      browserBridge: undefined,
      controlCaPath: undefined,
      dataDirectory: "/tmp/opensteer-runner-connection-test",
      deploymentShape: serverDeploymentShape,
      enrollmentToken: "x".repeat(32),
      environmentId,
      hostUrl: new URL(`http://127.0.0.1:${address.port}`),
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 4,
      mode: "development",
      modules: ["agents", "browser", "shell"],
      name: "Test runner",
      nodeExecutable: process.execPath,
      runnerId,
      runnerKind: "main",
    } as unknown as RunnerConfig;
    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    const connection = new ReconnectingHostConnection({
      agents: {
        runtime,
      },
      bootId,
      config,
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      logger: { error: () => undefined, info: () => undefined },
      runtimeVersion: "test",
    });

    try {
      await connection.run(abort.signal);
      expect(authorization).toBeUndefined();
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "runner.harness-catalog",
          requestId: "cold-catalog",
          catalogs: [],
        }),
      );
      const commandIndex = received.findIndex(
        (message) => (message as { type: string }).type === "runner.command-rejected",
      );
      const catalogIndex = received.findIndex((message) => {
        const parsed = RunnerToHostMessageSchema.parse(message);
        return parsed.type === "runner.harness-catalog" && parsed.requestId === "cold-catalog";
      });
      expect(commandIndex).toBeGreaterThanOrEqual(0);
      expect(catalogIndex).toBeGreaterThan(commandIndex);

      expect(received[0]).toMatchObject({
        descriptor: {
          // An agent-executing computer carries its work location, harnesses
          // and storage inside the agents module rather than at the top level.
          modules: {
            agents: {
              environmentIds: [environmentId],
              computerTool: 1,

              harnessDrivers: [],
            },
          },
          runnerId,
        },
        proofFormatVersion: 2,
        type: "runner.enroll",
      });
      // Readiness is reported once the modules answered, separately from the
      // welcome that only established the connection.
      expect(received[1]).toMatchObject({
        modules: [expect.objectContaining({ module: "agents", readiness: "ready" })],
        type: "runner.modules.report",
      });
      expect(received).toContainEqual(
        expect.objectContaining({
          error: { code: "forbidden", message: expect.any(String), retryable: false },
          type: "runner.command-rejected",
        }),
      );
      const catalogRequestIds = received.flatMap((message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "runner.harness-catalog" &&
        "requestId" in message
          ? [message.requestId]
          : [],
      );
      expect(catalogRequestIds).toEqual([
        "overtaking-catalog",
        "cold-catalog",
        "joined-cold-catalog",
      ]);
      expect(catalogCanceled).toBe(true);
      expect(runtime.inspectHarnesses).toHaveBeenCalledTimes(3);
    } finally {
      connection.close();
      await runtime.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolvePromise) => webSockets.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("serves shell alone on a computer that runs no agents", async () => {
    // A reach-only computer advertises one module, opens its stream, and has
    // nothing to run: a Run command that reaches it anyway is refused with a
    // sentence rather than by dropping the connection its sessions ride on.
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const abort = new AbortController();
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    const webSockets = new WebSocketServer({ perMessageDeflate: false, server });
    const received: RunnerToHostMessage[] = [];
    let descriptorModules: unknown;
    let descriptorCapabilities: readonly string[] = [];
    let fence: RunnerConnectionFence | undefined;
    webSockets.on("connection", (socket, request) => {
      if (request.url !== "/internal/v1/runners") {
        // The module stream attaches its reader after the socket opens, so a
        // frame written in the same breath as the handshake can be missed.
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
              hostSessionId: "h".repeat(32),
              module: "shell",
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
                module: "shell",
                serverTime: new Date().toISOString(),
                streamLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
                type: "host.auxiliary.welcome",
              }),
            );
          }, 5);
        });
        return;
      }
      socket.send(
        JSON.stringify({
          challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      socket.on("message", (raw) => {
        const message = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString("utf8")));
        received.push(message);
        if (message.type === "runner.enroll") {
          descriptorModules = message.descriptor.modules;
          descriptorCapabilities = message.descriptor.capabilities;
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
              allowedModules: ["shell"],
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
              ticket: "ticket.for.shell",
              type: "host.auxiliary.ticket",
            }),
          );
          return;
        }
        if (message.type === "runner.modules.report") {
          socket.send(
            JSON.stringify({
              ...fence,
              command: {
                commandId: createId("command"),
                correlationId: CorrelationIdSchema.parse("reach-only-command"),
                environmentId: createId("environment"),
                runId: createId("run"),
                threadId: createId("thread"),
                type: "run.interrupt",
              },
              type: "host.command",
            }),
          );
          return;
        }
        if (message.type === "runner.command-rejected") {
          abort.abort(new Error("test complete"));
        }
      });
    });

    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    const connection = new ReconnectingHostConnection({
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: "/tmp/opensteer-reach-only-test",
        deploymentShape: { kind: "personal" },
        enrollmentToken: "r".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["shell"],

        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
      } as unknown as RunnerConfig,
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      logger: { error: () => undefined, info: () => undefined },
      runtimeVersion: "test",
      shellModule: {
        descriptor: {
          hostPublicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
          platform: "darwin",
        },
        helperBinary: process.execPath,
        hostKeyPath: "/runner/shell_host_ed25519",
      },
    });

    try {
      await connection.run(abort.signal);
      expect(descriptorCapabilities).toEqual(expect.arrayContaining(["background-text-v1"]));
      expect(descriptorModules).toEqual({
        shell: {
          hostPublicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
          platform: "darwin",
        },
      });
      // Readiness names the running module and only that one.
      expect(
        received.flatMap((message) =>
          message.type === "runner.modules.report" ? [message.modules] : [],
        ),
      ).toEqual([[expect.objectContaining({ module: "shell", readiness: "ready" })]]);
      expect(received).toContainEqual(
        expect.objectContaining({
          error: {
            code: "forbidden",
            message: "This computer does not run agents.",
            retryable: false,
          },
          type: "runner.command-rejected",
        }),
      );
    } finally {
      connection.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolvePromise) => webSockets.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("keeps computer-app provider concurrency across a primary reconnect", async () => {
    const definition = getDeviceDefinition("apple-messages");
    if (!definition || !isComputerAppDefinition(definition)) throw new Error("Messages is missing");
    const operation = definition.config.operations.find(({ name }) => name === "query_messages");
    if (!operation) throw new Error("Messages query_messages is missing");

    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const abort = new AbortController();
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    const webSockets = new WebSocketServer({ perMessageDeflate: false, server });
    let primary: WebSocket | undefined;
    let primaryConnections = 0;
    let auxiliaryConnections = 0;
    let fence: RunnerConnectionFence | undefined;
    let fifthResult: unknown;

    const invoke = (auxiliaryStreamId: string, requestId: string) => ({
      ...fence,
      access: "read" as const,
      arguments: { sql: "SELECT 1" },
      auxiliaryStreamId,
      contract: computerAppOperationContract(operation),
      definitionId: definition.id,
      module: "integrations" as const,
      operation: operation.name,
      requestId,
      timeoutMs: 60_000,
      type: "host.integrations.invoke" as const,
    });

    webSockets.on("connection", (socket, request) => {
      if (request.url !== "/internal/v1/runners") {
        auxiliaryConnections += 1;
        const attempt = auxiliaryConnections;
        const auxiliaryStreamId = RunnerAuxiliaryStreamIdSchema.parse(`rax_${randomUUID()}`);
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
              hostSessionId: "h".repeat(32),
              module: "integrations",
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
                auxiliaryStreamId,
                heartbeatIntervalMs: 60_000,
                module: "integrations",
                serverTime: new Date().toISOString(),
                streamLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
                type: "host.auxiliary.welcome",
              }),
            );
          }, 5);
        });
        socket.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString("utf8")) as { readonly type?: unknown };
          if (
            parsed.type !== "runner.integrations.status" &&
            parsed.type !== "runner.integrations.result"
          ) {
            return;
          }
          const message = IntegrationsModuleEventSchema.parse(parsed);
          if (message.type === "runner.integrations.status") {
            if (attempt === 1) {
              for (let index = 0; index < 4; index += 1) {
                socket.send(JSON.stringify(invoke(auxiliaryStreamId, `first-${index}`)));
              }
            } else {
              socket.send(JSON.stringify(invoke(auxiliaryStreamId, "after-reconnect")));
            }
            return;
          }
          if (
            message.type === "runner.integrations.result" &&
            message.requestId === "after-reconnect"
          ) {
            fifthResult = message.result;
            abort.abort(new Error("test complete"));
          }
        });
        return;
      }

      primaryConnections += 1;
      const generation = primaryConnections;
      primary = socket;
      socket.send(
        JSON.stringify({
          challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      socket.on("message", (raw) => {
        const message = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString("utf8")));
        if (message.type === "runner.enroll" || message.type === "runner.authenticate") {
          fence = {
            bootId: message.descriptor.bootId,
            connectionGeneration: generation,
            connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
            connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
            runnerId: message.descriptor.runnerId,
          };
          socket.send(
            JSON.stringify({
              ...fence,
              allowedModules: ["integrations"],
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
              ticket: "ticket.for.integrations",
              type: "host.auxiliary.ticket",
            }),
          );
        }
      });
    });

    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    let invokes = 0;
    const providerInvoke = vi.fn(async () => {
      invokes += 1;
      if (invokes === 4) setTimeout(() => primary?.close(1001, "Host restarting"), 0);
      if (invokes > 4) abort.abort(new Error("reconnect admitted overlapping provider work"));
      return await new Promise<null>(() => undefined);
    });
    const connection = new ReconnectingHostConnection({
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: "/tmp/opensteer-integrations-reconnect-test",
        deploymentShape: { kind: "personal" },
        enrollmentToken: "i".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["integrations"],

        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
      } as unknown as RunnerConfig,
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      integrationsModule: {
        descriptor: { platform: "darwin" },
        localMcp: new LocalMcpServers(),
        providers: [
          {
            definitionId: definition.id,
            inspect: async () =>
              definition.config.operations.map(({ name }) => ({
                detail: null,
                operation: name,
                remedy: null,
                state: "ready" as const,
              })),
            invoke: providerInvoke,
            platforms: ["darwin"],
          },
        ],
      },
      logger: { error: () => undefined, info: () => undefined },
      runtimeVersion: "test",
    });

    try {
      await connection.run(abort.signal);
      expect(primaryConnections).toBe(2);
      expect(auxiliaryConnections).toBe(2);
      expect(providerInvoke).toHaveBeenCalledTimes(4);
      expect(fifthResult).toEqual(expect.objectContaining({ code: "busy", kind: "error" }));
    } finally {
      connection.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolvePromise) => webSockets.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }, 20_000);

  it("reopens a module stream whose lease expires without dropping the connection", async () => {
    // A helper runtime that cannot renew its stream lease is a helper runtime
    // that went away for a while. The stream it held ends, but the primary
    // connection that authorized it is untouched, so the Runner asks that same
    // connection for another ticket and comes back on a fresh stream. Nothing
    // reconnects, and nothing crashes on the heartbeat timer.
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const abort = new AbortController();
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    const webSockets = new WebSocketServer({ perMessageDeflate: false, server });
    const heartbeats: RunnerToHostMessage[] = [];
    const auxiliaryStreamIds: string[] = [];
    const readyModules: string[] = [];
    let primaryConnections = 0;
    let primaryClosed = false;
    let reopenedWithPrimaryUp = false;
    let fence: RunnerConnectionFence | undefined;
    webSockets.on("connection", (socket, request) => {
      if (request.url !== "/internal/v1/runners") {
        const attempt = auxiliaryStreamIds.length + 1;
        const auxiliaryStreamId = RunnerAuxiliaryStreamIdSchema.parse(`rax_${randomUUID()}`);
        auxiliaryStreamIds.push(auxiliaryStreamId);
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
              hostSessionId: "h".repeat(32),
              module: "shell",
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
                auxiliaryStreamId,
                heartbeatIntervalMs: 60_000,
                module: "shell",
                serverTime: new Date().toISOString(),
                // The first stream is never renewed, so its lease runs out
                // under a Runner that is otherwise perfectly healthy. The
                // replacement is a normal, healthy stream.
                streamLeaseExpiresAt: new Date(
                  Date.now() + (attempt === 1 ? 200 : 120_000),
                ).toISOString(),
                type: "host.auxiliary.welcome",
              }),
            );
          }, 5);
        });
        return;
      }
      primaryConnections += 1;
      socket.on("close", () => {
        primaryClosed = true;
      });
      socket.send(
        JSON.stringify({
          challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      socket.on("message", (raw) => {
        const message = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString("utf8")));
        if (message.type === "runner.enroll") {
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
              allowedModules: ["shell"],
              connectionLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
              environmentIds: runnerEnvironmentIds(message.descriptor),
              heartbeatIntervalMs: 1_000,
              serverTime: new Date().toISOString(),
              type: "host.welcome",
            }),
          );
          return;
        }
        // Every reopen asks this same primary connection for its own ticket.
        if (message.type === "runner.auxiliary.ticket-request") {
          socket.send(
            JSON.stringify({
              ...fence,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              module: message.module,
              requestId: message.requestId,
              ticket: "ticket.for.shell",
              type: "host.auxiliary.ticket",
            }),
          );
          return;
        }
        if (message.type === "runner.modules.report") {
          for (const report of message.modules) readyModules.push(report.module);
          if (readyModules.filter((module) => module === "shell").length >= 2 && !primaryClosed) {
            reopenedWithPrimaryUp = true;
          }
          return;
        }
        if (message.type === "runner.heartbeat") {
          heartbeats.push(message);
          // Stop on the first heartbeat after the module came back: the timer
          // is still running and the connection never went anywhere.
          if (readyModules.filter((module) => module === "shell").length >= 2) {
            abort.abort(new Error("test complete"));
          }
        }
      });
    });

    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    const loggedErrors: {
      message: string;
      details: Readonly<Record<string, unknown>> | undefined;
    }[] = [];
    const connection = new ReconnectingHostConnection({
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: "/tmp/opensteer-lease-expiry-test",
        deploymentShape: { kind: "personal" },
        enrollmentToken: "r".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["shell"],

        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
      } as unknown as RunnerConfig,
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      logger: {
        error: (message, details) => void loggedErrors.push({ details, message }),
        info: () => undefined,
      },
      runtimeVersion: "test",
      shellModule: {
        descriptor: {
          hostPublicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
          platform: "darwin",
        },
        helperBinary: process.execPath,
        hostKeyPath: "/runner/shell_host_ed25519",
      },
    });

    // The bug this guards was an exception thrown from a getter on the
    // heartbeat timer, which no caller could catch and which ended the
    // process. Capturing it here keeps the assertion about the Runner rather
    // than about how the test runner reports a crash.
    const uncaught: unknown[] = [];
    const captureUncaught = (error: unknown) => void uncaught.push(error);
    process.on("uncaughtException", captureUncaught);
    try {
      await connection.run(abort.signal);

      expect(uncaught).toEqual([]);
      // The module came back on a stream of its own, and said so again.
      expect(auxiliaryStreamIds).toHaveLength(2);
      expect(auxiliaryStreamIds[0]).not.toBe(auxiliaryStreamIds[1]);
      expect(readyModules.filter((module) => module === "shell")).toHaveLength(2);
      // ...without the connection underneath it going anywhere: it was still
      // open when the module came back, and it was never opened a second time.
      expect(reopenedWithPrimaryUp).toBe(true);
      expect(primaryConnections).toBe(1);
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
      expect(loggedErrors.map((entry) => entry.message)).not.toContain("Runner connection closed");
    } finally {
      process.off("uncaughtException", captureUncaught);
      connection.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolvePromise) => webSockets.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }, 20_000);

  it.each([
    {
      closeCodes: [4010],
      connections: 1,
      name: "stops the moment its identity is revoked",
      refusalFrame: false,
    },
    {
      closeCodes: [4003, 1001, 4010],
      connections: 3,
      name: "keeps reconnecting through every other refusal",
      refusalFrame: false,
    },
    {
      closeCodes: [4010],
      connections: 1,
      name: "stops when a refusal frame arrives before the revoked close",
      refusalFrame: true,
    },
    {
      closeCodes: [4003, 4010],
      connections: 2,
      name: "reconnects when a refusal frame arrives before any other close",
      refusalFrame: true,
    },
  ])("$name", async ({ closeCodes, connections, refusalFrame }) => {
    // 4003 carries lease expiry and ordinary authentication refusals — the
    // Personal "remote access is off" answer among them — so only the dedicated
    // revoked code may end a Runner that would otherwise keep trying.
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    const webSockets = new WebSocketServer({ path: "/internal/v1/runners", server });
    let attempts = 0;
    webSockets.on("connection", (socket) => {
      const code = closeCodes[attempts] ?? 1001;
      attempts += 1;
      const reason = code === 4010 ? "Runner identity was revoked" : "Runner refused";
      if (!refusalFrame) {
        socket.close(code, reason);
        return;
      }
      // The Host's other ordering: it answers the proof with an error frame and
      // closes immediately after, so the frame is read before the code lands.
      socket.send(
        JSON.stringify({
          challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            error: { code: "forbidden", message: "Runner authentication failed", retryable: false },
            type: "host.error",
          }),
        );
        socket.close(code, reason);
      });
    });

    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    let revocations = 0;
    const connection = new ReconnectingHostConnection({
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: "/tmp/opensteer-revoked-test",
        deploymentShape: { kind: "personal" },
        enrollmentToken: "v".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["shell"],

        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
      } as unknown as RunnerConfig,
      identity,
      identityStore: { acceptHostConnection: async () => identity },
      logger: { error: () => undefined, info: () => undefined },
      onRevoked: () => {
        revocations += 1;
      },
      runtimeVersion: "test",
      shellModule: {
        descriptor: {
          hostPublicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
          platform: "darwin",
        },
        helperBinary: process.execPath,
        hostKeyPath: "/runner/shell_host_ed25519",
      },
    });

    try {
      // The loop ends by itself: nothing aborts this signal.
      await connection.run(new AbortController().signal);
      expect(attempts).toBe(connections);
      expect(revocations).toBe(1);
    } finally {
      connection.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolvePromise) => webSockets.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("reports settings.json in the Agent home its welcome names before it attaches", async () => {
    const agentHome = await realpath(await mkdtemp(join(tmpdir(), "opensteer-settings-attach-")));
    const settings = { backgroundModels: { naming: [{ engine: "codex" }] } };
    await writeFile(join(agentHome, "settings.json"), JSON.stringify(settings));
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const abort = new AbortController();
    const received: RunnerToHostMessage[] = [];
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    const webSockets = new WebSocketServer({ server, path: "/internal/v1/runners" });
    webSockets.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      socket.on("message", (raw) => {
        const message = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString()));
        received.push(message);
        if (message.type === "runner.executions.attach") abort.abort(new Error("test complete"));
        if (message.type !== "runner.enroll") return;
        socket.send(
          JSON.stringify({
            agentHome: { computerId: runnerId, path: agentHome },
            allowedModules: ["agents"],
            bootId: message.descriptor.bootId,
            connectionGeneration: 1,
            connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
            connectionLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
            connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
            environmentIds: runnerEnvironmentIds(message.descriptor),
            heartbeatIntervalMs: 60_000,
            runnerId: message.descriptor.runnerId,
            serverTime: new Date().toISOString(),
            type: "host.welcome",
          }),
        );
      });
    });
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const runtime = new RunnerRuntime({
      nativeFsHelperBinary: testNativeFsHelperBinary,
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      plugins: noPlugins,
      bootId,
      deploymentShape: serverDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: new HarnessRegistry(),
      maxConcurrentRuns: 1,
      dataDirectory: join(agentHome, ".runner"),
      privateStateDirectory: join(agentHome, ".runner", "state"),
      browserHarnessExecutable: "/opt/opensteer/browser-harness",
      projectContinuationIdentity,
      agentHome: new AgentHomeManager(runnerId),
    });
    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    const connection = new ReconnectingHostConnection({
      agents: { runtime },
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: join(agentHome, ".runner"),
        deploymentShape: serverDeploymentShape,
        enrollmentToken: "s".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["agents"],
        name: "Hosting computer",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "main",
      } as unknown as RunnerConfig,
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      logger: { error: () => undefined, info: () => undefined },
      runtimeVersion: "test",
    });
    try {
      await connection.run(abort.signal);
      const enroll = received.find((message) => message.type === "runner.enroll");
      expect(enroll?.descriptor.capabilities).toContain("agent-home-settings-v1");
      const reported = received.filter(
        (message) =>
          message.type === "runner.settings.report" || message.type === "runner.executions.attach",
      );
      expect(reported.map((message) => message.type)).toEqual([
        "runner.settings.report",
        "runner.executions.attach",
      ]);
      expect(reported[0]).toMatchObject({ environmentId, result: { status: "valid", settings } });
    } finally {
      connection.close();
      await runtime.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolvePromise) => webSockets.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await rm(agentHome, { recursive: true, force: true });
    }
  });

  it("re-enrolls when the Host no longer knows this Runner's persisted key", async () => {
    // Resetting the Host database leaves a previously connected Runner holding
    // an identity file the Host has never seen. Retrying that key can never
    // succeed, so a Runner that also holds a fresh enrollment credential must
    // fall back to enrolling rather than looping on a rejected signature.
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const abort = new AbortController();
    const proofTypes: string[] = [];
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    const webSockets = new WebSocketServer({ server, path: "/internal/v1/runners" });
    webSockets.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: 2,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      socket.on("message", (raw) => {
        const message = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type !== "runner.enroll" && message.type !== "runner.authenticate") return;
        proofTypes.push(message.type);
        if (message.type === "runner.authenticate") {
          socket.send(
            JSON.stringify({
              error: {
                code: "forbidden",
                message: "Runner authentication failed",
                retryable: false,
              },
              type: "host.error",
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            allowedModules: ["agents"],
            bootId: message.descriptor.bootId,
            connectionGeneration: 1,
            connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
            connectionLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
            connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
            environmentIds: runnerEnvironmentIds(message.descriptor),
            heartbeatIntervalMs: 1_000,
            runnerId: message.descriptor.runnerId,
            serverTime: new Date().toISOString(),
            type: "host.welcome",
          }),
        );
        abort.abort(new Error("test complete"));
      });
    });

    const registry = new HarnessRegistry();
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const runtime = new RunnerRuntime({
      nativeFsHelperBinary: testNativeFsHelperBinary,
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      plugins: noPlugins,
      bootId,
      deploymentShape: serverDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      maxConcurrentRuns: 1,
      dataDirectory: dirname("/tmp/opensteer-runner-reenroll-test/state"),
      privateStateDirectory: "/tmp/opensteer-runner-reenroll-test/state",
      browserHarnessExecutable: "/opt/opensteer/browser-harness",
      projectContinuationIdentity,
      agentHome: {
        folder: async ({ path }) => path,
        prepare: async () => Promise.reject(new Error("not used")),
      },
    });
    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      // Previously connected, so the Runner would otherwise only ever sign.
      lastConnectionGeneration: 7,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    const connection = new ReconnectingHostConnection({
      agents: {
        runtime,
      },
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: "/tmp/opensteer-runner-reenroll-test",
        deploymentShape: serverDeploymentShape,
        enrollmentToken: "y".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["agents", "browser", "shell"],
        name: "Test runner",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "main",
      } as unknown as RunnerConfig,
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      logger: { error: () => undefined, info: () => undefined },
      runtimeVersion: "test",
    });

    try {
      await connection.run(abort.signal);
      expect(proofTypes).toEqual(["runner.authenticate", "runner.enroll"]);
    } finally {
      connection.close();
      await runtime.close();
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolvePromise) => webSockets.close(() => resolvePromise()));
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});

describe("ReconnectingHostConnection engine rechecks", () => {
  const driverKind = HarnessIdSchema.parse("engine-recheck-test");

  it.each([false, true])(
    "reconciles the complete set but answers only requested accounts (failure: %s)",
    async (failure) => {
      const host = await fakeAgentsHost();
      const runner = engineRecheckRunner(host.url, () => false);
      const first = {
        config: {} as unknown as RunnerConfig,
        driverKind,
        id: createId("harnessInstance"),
        name: "First",
        runtimeRevision: 1,
        sourceId: "test",
        stateKind: "ambient" as const,
      };
      const second = { ...first, id: createId("harnessInstance"), name: "Second" };
      const harnesses = [first, second];
      const catalogFor = (harness: typeof first) =>
        HarnessInstanceCatalogSchema.parse({
          detail: "Not installed",
          driverKind,
          harnessInstanceId: harness.id,
          models: [],
          status: "unavailable",
        });
      const full = Promise.withResolvers<readonly ReturnType<typeof catalogFor>[]>();
      const reconcile = vi
        .spyOn(runner.runtime, "reconcileHarnesses")
        .mockImplementation(async () => {
          if (failure) throw new Error("Cannot reconcile");
        });
      vi.spyOn(runner.runtime, "inspectHarnesses").mockImplementation(async (definitions) => {
        if (definitions.length === 2) return await full.promise;
        return definitions.map((definition) => catalogFor({ ...first, id: definition.id }));
      });
      const abort = new AbortController();
      const running = runner.connection.run(abort.signal);
      try {
        await host.until(() => host.attaches.length === 1, "the Runner attachment");
        expect(host.agentsModules[0]).toMatchObject({ reconcileHarnessInspection: 1 });
        host.send(1, { harnesses, requestId: "full", type: "host.reconcile-harnesses" });
        host.send(1, {
          harnesses,
          inspect: [second.id],
          requestId: "targeted",
          type: "host.reconcile-harnesses",
        });
        host.send(1, {
          harnesses: [second],
          inspect: [],
          requestId: "retire",
          type: "host.reconcile-harnesses",
        });
        await host.until(
          () =>
            host.catalogs.some((response) => response.requestId === "targeted") &&
            host.catalogs.some((response) => response.requestId === "retire"),
          "targeted and retirement catalog responses",
        );
        expect(
          host.catalogs.find((response) => response.requestId === "targeted")?.catalogs,
        ).toMatchObject([
          { harnessInstanceId: second.id, status: failure ? "error" : "unavailable" },
        ]);
        expect(host.catalogs.find((response) => response.requestId === "retire")?.catalogs).toEqual(
          [],
        );
        if (!failure)
          expect(host.catalogs.some((response) => response.requestId === "full")).toBe(false);
        full.resolve(harnesses.map(catalogFor));
        await host.until(
          () => host.catalogs.some((response) => response.requestId === "full"),
          "the full catalog response",
        );
        expect(
          host.catalogs.find((response) => response.requestId === "full")?.catalogs,
        ).toHaveLength(2);
        expect(reconcile.mock.calls.map(([desired]) => desired)).toEqual([
          harnesses,
          harnesses,
          [second],
        ]);
        expect(runner.errors).toEqual([]);
      } finally {
        full.resolve([]);
        abort.abort(new Error("test complete"));
        await running;
        await runner.runtime.close();
        await host.close();
      }
    },
  );

  it.each([false, true])(
    "gates usage window providerIds on Host challenge advertisement (%s)",
    async (usageWindowProviderIds) => {
      const host = await fakeAgentsHost(
        usageWindowProviderIds ? { usageWindowProviderIds: true } : {},
      );
      const runner = engineRecheckRunner(host.url, () => true);
      const driverKind = HarnessIdSchema.parse("antigravity");
      const harness = {
        config: {},
        driverKind,
        id: createId("harnessInstance"),
        name: "Antigravity",
        runtimeRevision: 1,
        sourceId: "oauth-personal",
        stateKind: "isolated" as const,
      };
      vi.spyOn(runner.runtime, "inspectHarnesses").mockResolvedValue([
        HarnessInstanceCatalogSchema.parse({
          connections: [
            {
              authKind: "subscription",
              connectionSlot: "primary",
              label: "Antigravity",
              status: "connected",
              usage: {
                limitReached: false,
                observedAt: "2026-11-01T00:00:00.000Z",
                windows: [
                  {
                    label: "Claude & GPT 5h",
                    providerIds: ["anthropic", "openai"],
                    resetsAt: "2026-11-01T05:00:00.000Z",
                    usedPercent: 100,
                  },
                ],
              },
            },
          ],
          continuationIdentity: {
            continuationKey: `runner:v1:${"a".repeat(43)}`,
            driverKind,
          },
          driverKind,
          harnessInstanceId: harness.id,
          models: [
            {
              acceptsImages: true,
              displayName: "Gemini 4 Neon",
              isDefault: true,
              modelId: "gemini-4-neon",
              options: [],
              providerId: "google",
            },
          ],
          setupMethods: [],
          status: "ready",
        }),
      ]);
      const abort = new AbortController();
      const running = runner.connection.run(abort.signal);
      try {
        await host.until(() => host.attaches.length === 1, "the Runner attachment");
        host.send(1, {
          harnesses: [harness],
          requestId: "usage-compat",
          type: "host.inspect-harnesses",
        });
        await host.until(
          () => host.catalogs.some((response) => response.requestId === "usage-compat"),
          "the catalog response",
        );
        const reply = host.catalogs.find((response) => response.requestId === "usage-compat")!;
        const connection = reply.catalogs[0]?.connections[0];
        if (usageWindowProviderIds) {
          expect(connection?.usage?.windows).toEqual([
            {
              label: "Claude & GPT 5h",
              providerIds: ["anthropic", "openai"],
              resetsAt: "2026-11-01T05:00:00.000Z",
              usedPercent: 100,
            },
          ]);
        } else {
          // Older Hosts cannot represent provider-pool scopes; drop pool windows
          // instead of turning a 3P pool into an account-wide limit.
          expect(connection?.usage).toBeUndefined();
        }
        expect(runner.errors).toEqual([]);
      } finally {
        abort.abort(new Error("test complete"));
        await running;
        await runner.runtime.close();
        await host.close();
      }
    },
  );

  it("never reconnects while its engines are unchanged, and re-advertises one installed since its hello with its Runs held", async () => {
    // Only the heartbeat's interval is faked, so each heartbeat is one the test sends.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const host = await fakeAgentsHost();
    let installed = false;
    const runner = engineRecheckRunner(host.url, () => installed);
    const heldRun = {
      bindingGeneration: 1,
      environmentId: runner.environmentId,
      nextOrdinal: 3,
      runId: createId("run"),
      terminal: false,
      threadId: createId("thread"),
    };
    vi.spyOn(runner.runtime, "attachInventory").mockReturnValue([heldRun]);
    const abort = new AbortController();
    const running = runner.connection.run(abort.signal);
    try {
      await host.until(() => host.attaches.length === 1, "the first connection");
      runner.connection.recheckEngines();
      // The heartbeat confirms the explicit recheck left this connection open.
      vi.advanceTimersByTime(1_000);
      await host.until(() => host.heartbeats(1) === 1, "a heartbeat on the first connection");
      expect(host.hellos).toHaveLength(1);
      expect(host.hellos[0]).toEqual([
        expect.objectContaining({ driverKind, readiness: "unavailable" }),
      ]);

      installed = true;
      runner.connection.recheckEngines();
      runner.connection.recheckEngines();
      await host.until(() => host.attaches.length === 2, "the recheck's reconnect");
      expect(host.hellos).toHaveLength(2);
      expect(host.hellos[1]).toEqual([
        expect.objectContaining({
          driverKind,
          readiness: "runtime-check",
          sources: [expect.objectContaining({ sourceId: "test", stateKinds: ["ambient"] })],
        }),
      ]);
      expect(host.attaches[1]).toEqual([heldRun]);
      runner.connection.recheckEngines();
      vi.advanceTimersByTime(1_000);
      await host.until(() => host.heartbeats(2) === 1, "a heartbeat on the second connection");
      expect(host.hellos).toHaveLength(2);
      expect(runner.errors).toEqual([]);
    } finally {
      abort.abort(new Error("test complete"));
      await running;
      await runner.runtime.close();
      await host.close();
      vi.useRealTimers();
    }
  });

  it("keeps the connection during trigger work and reconnects on an explicit recheck once idle", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const host = await fakeAgentsHost();
    let installed = false;
    const runner = engineRecheckRunner(host.url, () => installed);
    const abort = new AbortController();
    const running = runner.connection.run(abort.signal);
    try {
      await host.until(() => host.attaches.length === 1, "the first connection");
      const triggerWork = vi
        .spyOn(runner.runtime, "activeTriggerOccurrenceIds")
        .mockReturnValue([createId("triggerOccurrence")]);
      installed = true;
      runner.connection.recheckEngines();
      vi.advanceTimersByTime(1_000);
      await host.until(() => host.heartbeats(1) === 1, "a heartbeat during trigger work");
      expect(host.hellos).toHaveLength(1);

      triggerWork.mockReturnValue([]);
      vi.advanceTimersByTime(1_000);
      await host.until(() => host.heartbeats(1) === 2, "a heartbeat after trigger work ended");
      expect(host.hellos).toHaveLength(1);
      runner.connection.recheckEngines();
      await host.until(() => host.hellos.length === 2, "the reconnect once trigger work ended");
      expect(host.hellos[1]).toEqual([
        expect.objectContaining({ driverKind, readiness: "runtime-check" }),
      ]);
    } finally {
      abort.abort(new Error("test complete"));
      await running;
      await runner.runtime.close();
      await host.close();
      vi.useRealTimers();
    }
  });

  it("waits while a command the Host sent is still queued, so nothing admitted is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const host = await fakeAgentsHost();
    let installed = false;
    const runner = engineRecheckRunner(host.url, () => installed);
    const abort = new AbortController();
    const running = runner.connection.run(abort.signal);
    const reconcile = Promise.withResolvers<void>();
    try {
      await host.until(() => host.attaches.length === 1, "the first connection");
      const reconciling = Promise.withResolvers<void>();
      vi.spyOn(runner.runtime, "reconcileHarnesses").mockImplementation(async () => {
        reconciling.resolve();
        await reconcile.promise;
      });
      const requestId = randomUUID();
      host.send(1, { harnesses: [], requestId, type: "host.reconcile-harnesses" });
      await withTimeout(reconciling.promise, 2_000, {
        timeoutError: () => new Error("the reconcile never started"),
      });
      installed = true;
      runner.connection.recheckEngines();
      vi.advanceTimersByTime(1_000);
      await host.until(() => host.heartbeats(1) === 1, "a heartbeat while the queue is busy");
      expect(host.hellos).toHaveLength(1);

      reconcile.resolve();
      await host.until(
        () => host.catalogs.some((catalog) => catalog.requestId === requestId),
        "the queued reconcile response",
      );
      runner.connection.recheckEngines();
      await host.until(() => host.hellos.length === 2, "the reconnect once the queue drained");
    } finally {
      reconcile.resolve();
      abort.abort(new Error("test complete"));
      await running;
      await runner.runtime.close();
      await host.close();
      vi.useRealTimers();
    }
  });

  it("keeps a socket to a strict older Home open without sending home-files reports", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "runner-legacy-home-")));
    const host = await fakeAgentsHost(home);
    const runner = engineRecheckRunner(host.url, () => false, home);
    const outgoing = vi.spyOn(CausallyOrderedRunnerSink.prototype, "send");
    const handled = Promise.withResolvers<void>();
    const handle = AgentsWorkSession.prototype.handle;
    const incoming = vi
      .spyOn(AgentsWorkSession.prototype, "handle")
      .mockImplementation(async function (this: AgentsWorkSession, message) {
        await handle.call(this, message);
        if (message.type === "host.home-files.list") handled.resolve();
      });
    const abort = new AbortController();
    const running = runner.connection.run(abort.signal);
    try {
      const hello = await Promise.race([host.firstAttach, host.rejected]);
      expect(hello).toContain(agentHomeFilesCapability);
      expect(hello).toContain(triggerStopGenerationCapability);
      const sink = outgoing.mock.contexts.find(
        (context) => context instanceof CausallyOrderedRunnerSink,
      );
      if (!(sink instanceof CausallyOrderedRunnerSink)) throw new Error("Runner did not attach");
      const imagePath = join(home, `${"a".repeat(64)}.png`);
      await writeFile(imagePath, "image");
      await Promise.race([
        sink.publishOutputImage({ path: imagePath, mediaType: "image/png" }, abort.signal),
        host.rejected,
      ]);
      host.send(1, {
        limit: 1,
        offset: 0,
        pathSegmentsBase64: [],
        requestId: randomUUID(),
        type: "host.home-files.list",
      });
      await Promise.race([handled.promise, host.rejected]);
      expect(outgoing.mock.calls.map(([message]) => message.type)).not.toContain(
        "runner.home-files.result",
      );
      expect(runner.errors).toEqual([]);
    } finally {
      abort.abort();
      await running;
      outgoing.mockRestore();
      incoming.mockRestore();
      await runner.runtime.close();
      await host.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  function engineRecheckRunner(hostUrl: URL, installed: () => boolean, home?: string) {
    const registry = new HarnessRegistry();
    const driver: HarnessDriver = {
      accessModes: ThreadAccessModeSchema.options,
      capabilities: {
        approvals: false,
        attachments: false,
        interruption: false,
        mcpImageContent: false,
        resume: false,
        steering: false,
        toolCalls: false,
        userInput: false,
      },
      configSchema: z.strictObject({}),
      create: async () => Promise.reject(new Error("not used")),
      kind: driverKind,
      sources: [
        {
          fields: [],
          kind: "first-party",
          label: "Test source",
          quota: "none",
          sourceId: "test",
          stateKinds: ["ambient"],
        },
      ],
    };
    registry.registerDriver(
      driver,
      { status: "runtime-check" },
      {
        create: () => driver,
        locate: () => (installed() ? "/opt/engine-recheck-test/bin/engine" : undefined),
        missing: "The test engine is not installed.",
        scope: "all",
      },
    );
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const runtime = new RunnerRuntime({
      nativeFsHelperBinary: testNativeFsHelperBinary,
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      plugins: noPlugins,
      bootId,
      deploymentShape: serverDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      maxConcurrentRuns: 1,
      dataDirectory: home ?? "/tmp/opensteer-engine-recheck-test",
      privateStateDirectory: home
        ? join(home, "state")
        : "/tmp/opensteer-engine-recheck-test/state",
      browserHarnessExecutable: "/opt/opensteer/browser-harness",
      projectContinuationIdentity,
      agentHome: home
        ? new AgentHomeManager(runnerId)
        : {
            folder: async ({ path }) => path,
            prepare: async () => Promise.reject(new Error("not used")),
          },
    });
    const pair = generateKeyPairSync("ed25519");
    const identity = {
      createdAt: new Date().toISOString(),
      environmentId,
      lastConnectionGeneration: 0,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      runnerId,
      version: 3 as const,
    };
    const errors: string[] = [];
    const connection = new ReconnectingHostConnection({
      agents: {
        runtime,
      },
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: "/tmp/opensteer-engine-recheck-test",
        deploymentShape: serverDeploymentShape,
        enrollmentToken: "e".repeat(32),
        environmentId,
        hostUrl,
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["agents"],
        name: "Engine recheck runner",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "main",
      } as unknown as RunnerConfig,
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      logger: { error: (message) => void errors.push(message), info: () => undefined },
      runtimeVersion: "test",
    });
    return { connection, environmentId, errors, runtime };
  }
});

/**
 * A Host that welcomes every hello and records, per connection, the engines it
 * advertised, the Runs it attached and how many heartbeats it sent.
 */
async function fakeAgentsHost(
  arg?: string | { readonly legacyAgentHome?: string; readonly usageWindowProviderIds?: true },
) {
  const legacyAgentHome = typeof arg === "string" ? arg : arg?.legacyAgentHome;
  const options = typeof arg === "object" && arg !== null ? arg : {};
  const unsupportedLegacyFrames = new Set([
    "runner.agent-home.report",
    "runner.output-image.publish",
    "runner.home-files.result",
  ]);
  const firstAttach = Promise.withResolvers<readonly string[]>();
  const rejected = Promise.withResolvers<never>();
  void rejected.promise.catch(() => undefined);
  const server = createServer();
  const webSockets = new WebSocketServer({
    path: "/internal/v1/runners",
    perMessageDeflate: false,
    server,
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address() as AddressInfo;
  const hellos: unknown[] = [];
  const agentsModules: unknown[] = [];
  const catalogs: Extract<RunnerToHostMessage, { type: "runner.harness-catalog" }>[] = [];
  const attaches: unknown[] = [];
  const heartbeats = new Map<number, number>();
  const connections = new Map<
    number,
    { readonly fence: Record<string, unknown>; readonly socket: import("ws").WebSocket }
  >();
  const waiters = new Set<{ readonly check: () => boolean; readonly resolve: () => void }>();
  const observed = () => {
    for (const waiter of waiters) {
      if (!waiter.check()) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  };
  webSockets.on("connection", (socket) => {
    const generation = hellos.length + 1;
    socket.send(
      JSON.stringify({
        challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        hostSessionId: randomUUID(),
        nonce: randomUUID(),
        proofFormatVersion: 2,
        runEventsVersion: 2,
        ...(options.usageWindowProviderIds ? { usageWindowProviderIds: true } : {}),
        type: "host.challenge",
      }),
    );
    let capabilities: readonly string[] = [];
    socket.on("message", (raw) => {
      const decoded = RunnerToHostMessageSchema.safeParse(JSON.parse(raw.toString("utf8")));
      if (!decoded.success) {
        rejected.reject(decoded.error);
        socket.close(1002, "Unsupported Runner frame");
        return;
      }
      const message = decoded.data;
      if (legacyAgentHome && unsupportedLegacyFrames.has(message.type)) {
        rejected.reject(new Error(`Older Home cannot parse ${message.type}`));
        socket.close(1002, "Unsupported Runner frame");
        return;
      }
      if (message.type === "runner.enroll" || message.type === "runner.authenticate") {
        capabilities = message.descriptor.capabilities;
        hellos.push(message.descriptor.modules.agents?.harnessDrivers);
        agentsModules.push(message.descriptor.modules.agents);
        const fence = {
          bootId: message.descriptor.bootId,
          connectionGeneration: generation,
          connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
          connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
          runnerId: message.descriptor.runnerId,
        };
        connections.set(generation, { fence, socket });
        socket.send(
          JSON.stringify({
            ...fence,
            allowedModules: ["agents"],
            ...(legacyAgentHome
              ? { agentHome: { computerId: fence.runnerId, path: legacyAgentHome } }
              : {}),
            connectionLeaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
            environmentIds: runnerEnvironmentIds(message.descriptor),
            heartbeatIntervalMs: 1_000,
            serverTime: new Date().toISOString(),
            type: "host.welcome",
          }),
        );
      } else if (message.type === "runner.executions.attach") {
        attaches.push(message.executions);
        firstAttach.resolve(capabilities);
      } else if (message.type === "runner.heartbeat") {
        heartbeats.set(generation, (heartbeats.get(generation) ?? 0) + 1);
      } else if (message.type === "runner.harness-catalog") {
        catalogs.push(message);
      }
      observed();
    });
  });
  return {
    firstAttach: firstAttach.promise,
    rejected: rejected.promise,
    agentsModules,
    catalogs,
    attaches,
    heartbeats: (generation: number) => heartbeats.get(generation) ?? 0,
    hellos,
    /** Sends a fenced Host message on one connection. */
    send: (generation: number, message: Record<string, unknown>) => {
      const connection = connections.get(generation);
      if (!connection) throw new Error(`No connection ${generation}`);
      connection.socket.send(JSON.stringify({ ...connection.fence, ...message }));
    },
    /** Resolves once `check` holds after a frame, or fails naming what never happened. */
    until: (check: () => boolean, what: string): Promise<void> => {
      if (check()) return Promise.resolve();
      const reached = Promise.withResolvers<void>();
      waiters.add({ check, resolve: reached.resolve });
      return withTimeout(reached.promise, 2_000, {
        timeoutError: () => new Error(`${what} never happened`),
      });
    },
    url: new URL(`http://127.0.0.1:${address.port}`),
    close: async () => {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function controlCommand(
  type: "request.resolve" | "run.interrupt" | "run.steer",
  ids: {
    readonly environmentId: EnvironmentId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  },
): RunnerCommand {
  const base = {
    commandId: createId("command"),
    correlationId: CorrelationIdSchema.parse(randomUUID()),
    environmentId: ids.environmentId,
  };
  switch (type) {
    case "run.interrupt":
      return { ...base, runId: ids.runId, threadId: ids.threadId, type };
    case "request.resolve":
      return {
        ...base,
        requestId: createId("request"),
        response: { kind: "choice", optionId: "allow" },
        runId: ids.runId,
        type,
      };
    case "run.steer":
      return {
        ...base,
        input: {
          author: { displayName: "User", kind: "human", principalId: "principal:test" },
          content: [{ text: "Please finish now", type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
        runId: ids.runId,
        threadId: ids.threadId,
        type,
      };
  }
}

function terminalEvent(ids: {
  readonly environmentId: EnvironmentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}): RunnerOperationalReport {
  // The connection fence belongs to the socket, so what the sink orders is the
  // unfenced report the Runtime produced.
  return {
    event: {
      bindingGeneration: 1,
      data: { status: "interrupted" },
      emittedAt: new Date().toISOString(),
      environmentId: ids.environmentId,
      ordinal: 1,
      runId: ids.runId,
      threadId: ids.threadId,
      type: "run.interrupted",
    },
    type: "runner.event",
  };
}

it("advertises compaction only for a qualifying installed Claude CLI", () => {
  const driver = (version?: string, readiness = "configured", kind = "claude") =>
    ({
      driverKind: kind,
      readiness,
      ...(version ? { installation: { version } } : {}),
    }) as unknown as RunnerHarnessDriver;
  for (const drivers of [
    [],
    [driver()],
    [driver("1.0.0")],
    [driver("99.0.0", "unavailable")],
    [driver("99.0.0", "configured", "codex")],
  ])
    expect(runnerCapabilities(drivers)).not.toContain("claude-compaction-v1");
  expect(runnerCapabilities([driver(harnessMinimumVersion("claude"))])).toContain(
    "claude-compaction-v1",
  );
});
