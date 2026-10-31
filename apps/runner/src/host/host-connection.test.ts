import { dirname } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { RunnerConfig } from "@opensteer/config";
import { createId, type EnvironmentId, type RunId, type ThreadId } from "@opensteer/core";
import { HarnessRegistry, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { getIntegrationDefinition } from "@opensteer/integration-catalog";
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
  runnerEnvironmentIds,
  RunnerToHostMessageSchema,
  type RunnerCommand,
  type RunnerConnectionFence,
  type RunnerOperationalReport,
  type RunnerToHostMessage,
} from "@opensteer/protocol";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  CausallyOrderedRunnerSink,
  WebSocketMessageSink,
  ReconnectingHostConnection,
  runnerWebSocketUrl,
  waitForRunnerReconnect,
} from "./host-connection.js";
import { RunnerRuntime } from "../runtime/runtime.js";
import {
  providerContinuationIdentityProjector,
  RunnerConnectionFenceLedger,
} from "@opensteer/runner-client";

const cloudDeploymentShape = {
  defaultWorkspaceBacking: "portablefs",
  kind: "server" as const,
} as const;
const testAgentSkills = {
  paths: {
    "opensteer-specialization": "/runner/agent-skills/skills/opensteer-specialization",
    "opensteer-integrations": "/runner/agent-skills/skills/opensteer-integrations",
    "opensteer-browser": "/runner/agent-skills/skills/opensteer-browser",
    "opensteer-computer-use": "/runner/agent-skills/skills/opensteer-computer-use",
    "opensteer-computers": "/runner/agent-skills/skills/opensteer-computers",
    "opensteer-threads": "/runner/agent-skills/skills/opensteer-threads",
    "opensteer-triggers": "/runner/agent-skills/skills/opensteer-triggers",
    "opensteer-workspaces": "/runner/agent-skills/skills/opensteer-workspaces",
  },
  rootPath: "/runner/agent-skills",
} as const;
const noIntegrationSkills = async () => ({
  cleanup: async () => undefined,
  digest: "none",
  directory: undefined,
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

describe("CausallyOrderedRunnerSink", () => {
  it("reports an uncertain steer without converting it to a refusal", async () => {
    const messages: RunnerOperationalReport[] = [];
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
      const messages: RunnerOperationalReport[] = [];
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
  it("sends storage replies with only their nested fence and keeps ordinary reports fenced", async () => {
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
      error: { code: "configuration-invalid", message: "Test storage failure", retryable: false },
      fence: {
        ...fence,
        environmentId: createId("environment"),
        storageAuthorityId: createId("storageAuthority"),
      },
      operationId: "workspace:test:provision:v1:1",
      requestId: randomUUID(),
      type: "runner.workspace.local.error",
    } satisfies RunnerOperationalReport;
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
    // Two "denied" answers before the person turns the switch: the watch must
    // stay silent while the answer is what the descriptor already said.
    const answers = [false, false, true];
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
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
        enrollmentToken: "f".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        localWorkspaceRegistryPath: undefined,
        localWorkspaceRoot: undefined,
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["shell"],
        mountBinary: undefined,
        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
        workspaceBackings: [],
        workspaceNamespace: "single-owner",
        workspaceRoot: undefined,
      },
      fullDiskAccessProbe: { deniedIntervalMs: 5, grantedIntervalMs: 5, probe },
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
      expect(probes).toBeGreaterThanOrEqual(3);
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
      config: {},
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
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      integrationSkills: noIntegrationSkills,
      bootId,
      deploymentShape: cloudDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      maxConcurrentRuns: 1,
      dataDirectory: dirname("/tmp/opensteer-runner-connection-test/state"),
      privateStateDirectory: "/tmp/opensteer-runner-connection-test/state",
      browserHarnessExecutable: "/opt/opensteer/browser-harness",
      projectContinuationIdentity,
      workspaceManager: {
        prepare: async () => Promise.reject(new Error("not used")),
        writableRoots: () => ["/runner/workspaces"],
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
      deploymentShape: cloudDeploymentShape,
      enrollmentToken: "x".repeat(32),
      environmentId,
      hostUrl: new URL(`http://127.0.0.1:${address.port}`),
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 4,
      mode: "development",
      modules: ["agents", "browser", "shell"],
      mountBinary: "portablefs",
      localWorkspaceRegistryPath: undefined,
      localWorkspaceRoot: undefined,
      name: "Test runner",
      nodeExecutable: process.execPath,
      runnerId,
      runnerKind: "main",
      workspaceBackings: ["portablefs"],
      workspaceNamespace: "owner-scoped",
      workspaceRoot: "/workspaces",
    };
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
        workspaceBackings: ["portablefs"],
        workspaceMounts: () => [
          {
            enrollmentId: "enrollment-1",
            volumeId: "workspace_volume",
            workspaceId: createId("workspace"),
          },
        ],
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
      expect(received[0]).toMatchObject({
        descriptor: {
          // An agent-executing computer carries its work location, harnesses
          // and storage inside the agents module rather than at the top level.
          modules: {
            agents: {
              environmentIds: [environmentId],
              computerTool: 1,
              harnessDrivers: [],
              localStorage: null,
              workspaceBackings: ["portablefs"],
              workspaceMounts: [
                expect.objectContaining({
                  enrollmentId: "enrollment-1",
                  volumeId: "workspace_volume",
                }),
              ],
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
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
        enrollmentToken: "r".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        localWorkspaceRegistryPath: undefined,
        localWorkspaceRoot: undefined,
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["shell"],
        mountBinary: undefined,
        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
        workspaceBackings: [],
        workspaceNamespace: "single-owner",
        workspaceRoot: undefined,
      },
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
      expect(descriptorCapabilities).toEqual(
        expect.arrayContaining(["thread-title-v1", "thread-icon-v1", "screen-show-v1"]),
      );
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
    const definition = getIntegrationDefinition("apple-messages");
    if (!definition || !isComputerAppDefinition(definition)) throw new Error("Messages is missing");
    const operation = definition.config.operations.find(
      ({ name }) => name === "list_conversations",
    );
    if (!operation) throw new Error("Messages list_conversations is missing");

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
      arguments: {},
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
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
        enrollmentToken: "i".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        localWorkspaceRegistryPath: undefined,
        localWorkspaceRoot: undefined,
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["integrations"],
        mountBinary: undefined,
        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
        workspaceBackings: [],
        workspaceNamespace: "single-owner",
        workspaceRoot: undefined,
      },
      identity,
      identityStore: {
        acceptHostConnection: async ({ connectionGeneration }) => ({
          ...identity,
          lastConnectionGeneration: connectionGeneration,
        }),
      },
      integrationsModule: {
        descriptor: { platform: "darwin" },
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
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
        enrollmentToken: "r".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        localWorkspaceRegistryPath: undefined,
        localWorkspaceRoot: undefined,
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["shell"],
        mountBinary: undefined,
        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
        workspaceBackings: [],
        workspaceNamespace: "single-owner",
        workspaceRoot: undefined,
      },
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
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
        enrollmentToken: "v".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        localWorkspaceRegistryPath: undefined,
        localWorkspaceRoot: undefined,
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["shell"],
        mountBinary: undefined,
        name: "Reachable Mac",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "local",
        workspaceBackings: [],
        workspaceNamespace: "single-owner",
        workspaceRoot: undefined,
      },
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
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      integrationSkills: noIntegrationSkills,
      bootId,
      deploymentShape: cloudDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      maxConcurrentRuns: 1,
      dataDirectory: dirname("/tmp/opensteer-runner-reenroll-test/state"),
      privateStateDirectory: "/tmp/opensteer-runner-reenroll-test/state",
      browserHarnessExecutable: "/opt/opensteer/browser-harness",
      projectContinuationIdentity,
      workspaceManager: {
        prepare: async () => Promise.reject(new Error("not used")),
        writableRoots: () => ["/runner/workspaces"],
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
      agents: { runtime, workspaceBackings: ["portablefs"], workspaceMounts: () => [] },
      bootId,
      config: {
        browserBridge: undefined,
        controlCaPath: undefined,
        dataDirectory: "/tmp/opensteer-runner-reenroll-test",
        deploymentShape: cloudDeploymentShape,
        enrollmentToken: "y".repeat(32),
        environmentId,
        hostUrl: new URL(`http://127.0.0.1:${address.port}`),
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 4,
        mode: "development",
        modules: ["agents", "browser", "shell"],
        mountBinary: "portablefs",
        localWorkspaceRegistryPath: undefined,
        localWorkspaceRoot: undefined,
        name: "Test runner",
        nodeExecutable: process.execPath,
        runnerId,
        runnerKind: "main",
        workspaceBackings: ["portablefs"],
        workspaceNamespace: "owner-scoped",
        workspaceRoot: "/workspaces",
      },
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
      workspaceId: createId("workspace"),
    },
    type: "runner.event",
  };
}
