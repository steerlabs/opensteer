import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  HarnessIdSchema,
  MessageContentSchema,
  ModelSelectionSchema,
  OpensteerError,
  ThreadAccessModeSchema,
  createId,
  requestChoiceTextMaxLength,
  requestLabelMaxLength,
  requestTextMaxLength,
  requestTitleMaxLength,
  runFailureMessageMaxLength,
  toolArgumentsMaxSerializedBytes,
  toolOutputTextMaxBytes,
  utf8ByteLength,
  type HarnessInstanceId,
  type PendingRequest,
  type RequestId,
  type RequestResponse,
} from "@opensteer/core";
import {
  BoundedEventStream,
  HarnessSteerDeliveryUnknownError,
  HarnessRegistry,
  nativeUserHarnessRuntimeBoundary,
  SubagentNodes,
  threadTitlePrompt,
  threadTitleBudgetMs,
  threadTitleCleanupMs,
  type HarnessAdapter,
  type HarnessAuthenticationStart,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessInput,
  type HarnessSession,
  type HarnessProviderStoreScope,
  type HarnessSessionContext,
  type HarnessSourceDescriptor,
  type HarnessSteerInput,
  type HarnessRunInput,
} from "@opensteer/harness";
import {
  CorrelationIdSchema,
  pendingAgentEventMaxSerializedBytes,
  PendingAgentEventSchema,
  RunnerCommandSchema,
  RunnerConnectionFenceSchema,
  type HarnessInstanceCatalog,
  type RunnerCommand,
  type RunnerOperationalReport,
} from "@opensteer/protocol";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { z } from "zod";
import { delay } from "@opensteer/shared/delay";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCurrentTest } from "vitest/suite";
import { prepareHarnessProviderState } from "../harness/harness-provider-state.js";
import type { HarnessProcessSandbox, HarnessSandboxRunPlan } from "../sandbox/harness-sandbox.js";
import { ExecutionContainment, executionScopeVariable } from "./execution-containment.js";
import { RunnerRuntime, type RunnerMessageSink } from "./runtime.js";
import { providerContinuationIdentityProjector } from "@opensteer/runner-client";

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
const testDeploymentShape = {
  defaultWorkspaceBacking: "local-directory",
  kind: "server" as const,
} as const;
const testPersonalDeploymentShape = {
  defaultWorkspaceBacking: "local-directory",
  kind: "personal" as const,
} as const;
const testPortableDeploymentShape = {
  defaultWorkspaceBacking: "portablefs",
  kind: "server" as const,
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
const testApprovalRequestId = createId("request");
const testInputRequestId = createId("request");
const testBrowserHarnessExecutable = "/opt/opensteer/browser-harness";
const testPrivateStateRoot = mkdtempSync(join(tmpdir(), "opensteer-runner-runtime-test-"));

afterAll(async () => {
  await rm(testPrivateStateRoot, { force: true, recursive: true });
});

describe("RunnerRuntime", () => {
  describe("Thread naming", () => {
    it.each([
      [false, "Support migration\nplane", { title: "Support migration" }],
      [false, "Title: ** **\nplane", null],
      [true, "Support migration\nplane", { title: "Support migration", icon: "plane" }],
      [true, "Support migration\ninvalid", { title: "Support migration", icon: "document" }],
      [true, "Title: ** **\nplane", { icon: "plane" }],
      [true, "Support migration\nnone", { title: "Support migration", icon: "document" }],
      [true, "Title: ** **\ninvalid", { icon: "document" }],
      [true, "Support migration", { title: "Support migration", icon: "document" }],
      [true, "", null],
      [true, " \r\n ", null],
    ] as const)("negotiates icon=%s for %j", async (icon, reply, expected) => {
      const naming = vi.fn(async () => reply);
      const session = Object.assign(new ScriptedHarnessSession([]), { generateTitle: naming });
      const registry = new HarnessRegistry();
      registry.registerDriver(new FakeHarnessDriver("test-driver", () => session));
      const environmentId = createId("environment");
      const runtime = configuredRuntime({ environmentId, registry });
      const command = executeCommand(environmentId);
      command.context = {
        ...command.context,
        titleRequest: { request: "Migrate support", ...(icon ? { icon: true as const } : {}) },
      };
      const messages: RunnerOperationalReport[] = [];
      try {
        await reconcile(registry, command);
        await runtime.handleCommand(command, {
          send: async (message) => void messages.push(message),
        });
        await waitUntil(() => runtime.activeRunIds().length === 0);
        expect(naming).toHaveBeenCalledTimes(1);
        expect(naming).toHaveBeenCalledWith({
          prompt: threadTitlePrompt("Migrate support", { icon }),
          signal: expect.any(AbortSignal),
        });
        const reports = messages.filter((message) => message.type === "runner.thread-title");
        expect(reports).toEqual(
          expected
            ? [
                {
                  type: "runner.thread-title",
                  workspaceId: command.context.workspaceId,
                  runId: command.context.runId,
                  threadId: command.context.threadId,
                  bindingGeneration: command.context.bindingGeneration,
                  environmentId,
                  ...expected,
                },
              ]
            : [],
        );
        expect(hasEvent(messages, "run.completed")).toBe(true);
        expect(eventCount(messages, "run.usage")).toBe(0);
        expect(
          JSON.stringify(messages.filter((message) => message.type === "runner.event")),
        ).not.toContain("Support migration");
      } finally {
        await runtime.close();
      }
    });

    it.each([false, true])(
      "keeps Stop final when the engine completes after interruption (naming=%s)",
      async (naming) => {
        const session = new ScriptedHarnessSession([], "complete-on-interrupt");
        if (naming)
          Object.assign(session, { generateTitle: async () => "Support migration\nplane" });
        const registry = new HarnessRegistry();
        registry.registerDriver(new FakeHarnessDriver("test-driver", () => session));
        const environmentId = createId("environment");
        const runtime = configuredRuntime({ environmentId, registry });
        const command = executeCommand(environmentId);
        if (naming)
          command.context = {
            ...command.context,
            titleRequest: { request: "Migrate support", icon: true },
          };
        const messages: RunnerOperationalReport[] = [];
        const sink = {
          send: async (message: RunnerOperationalReport) => void messages.push(message),
        };
        try {
          await reconcile(registry, command);
          await runtime.handleCommand(command, sink);
          await waitUntil(() => hasEvent(messages, "run.started"));
          await runtime.handleCommand(
            {
              type: "run.interrupt",
              commandId: createId("command"),
              correlationId: command.correlationId,
              environmentId,
              runId: command.context.runId,
              threadId: command.context.threadId,
            },
            sink,
          );
          await waitUntil(() => runtime.activeRunIds().length === 0);
          expect(hasEvent(messages, "run.interrupted")).toBe(true);
          expect(hasEvent(messages, "run.completed")).toBe(false);
        } finally {
          await runtime.close();
        }
      },
    );

    it("stops a completed turn while its naming call is still settling", async () => {
      const session = new ScriptedHarnessSession([]);
      let namingSignal: AbortSignal | undefined;
      Object.assign(session, {
        generateTitle: async ({ signal }: { signal: AbortSignal }) => {
          namingSignal = signal;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return "Late name\nplane";
        },
      });
      const registry = new HarnessRegistry();
      registry.registerDriver(new FakeHarnessDriver("test-driver", () => session));
      const environmentId = createId("environment");
      const runtime = configuredRuntime({ environmentId, registry });
      const command = executeCommand(environmentId);
      command.context = {
        ...command.context,
        titleRequest: { request: "Migrate support", icon: true },
      };
      const messages: RunnerOperationalReport[] = [];
      const sink = {
        send: async (message: RunnerOperationalReport) => void messages.push(message),
      };
      try {
        await reconcile(registry, command);
        await runtime.handleCommand(command, sink);
        await waitUntil(() => !!namingSignal && hasEvent(messages, "run.started"));
        // Let the already-published terminal be consumed while naming stays held.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(runtime.activeRunIds()).toContain(command.context.runId);
        await runtime.handleCommand(
          {
            type: "run.interrupt",
            commandId: createId("command"),
            correlationId: command.correlationId,
            environmentId,
            runId: command.context.runId,
            threadId: command.context.threadId,
          },
          sink,
        );
        await waitUntil(() => runtime.activeRunIds().length === 0);
        expect(namingSignal?.aborted).toBe(true);
        expect(hasEvent(messages, "run.interrupted")).toBe(true);
        expect(hasEvent(messages, "run.completed")).toBe(false);
        expect(messages.filter((message) => message.type === "runner.thread-title")).toEqual([]);
      } finally {
        await runtime.close();
      }
    });

    it.each(["absent", "failure", "abort", "revoked", "budget"] as const)(
      "settles naming without failing the Run (%s)",
      async (mode) => {
        let namingSignal: AbortSignal | undefined;
        let settled = false;
        let eventsAtRevocation: RunnerOperationalReport[] = [];
        const naming = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
          namingSignal = signal;
          if (mode === "failure") throw new Error("Naming unavailable");
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                settled = true;
                resolve();
              },
              { once: true },
            ),
          );
          return "Late title\nplane";
        });
        const session = new ScriptedHarnessSession(
          [],
          mode === "abort" || mode === "revoked" ? "await-interrupt" : "complete",
        );
        if (mode !== "absent") Object.assign(session, { generateTitle: naming });
        const registry = new HarnessRegistry();
        registry.registerDriver(new FakeHarnessDriver("test-driver", () => session));
        const environmentId = createId("environment");
        const runtime = configuredRuntime({ environmentId, registry });
        const command = executeCommand(environmentId);
        command.context = {
          ...command.context,
          titleRequest: { request: "Migrate support", icon: true },
        };
        const messages: RunnerOperationalReport[] = [];
        try {
          await reconcile(registry, command);
          if (mode === "budget") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          await runtime.handleCommand(command, {
            send: async (message) => void messages.push(message),
          });
          if (mode === "budget" || mode === "abort" || mode === "revoked") {
            // setImmediate does not advance the naming timer.
            while (!namingSignal) await new Promise<void>((resolve) => setImmediate(resolve));
            expect(runtime.activeRunIds()).toContain(command.context.runId);
            if (mode === "budget") {
              await vi.advanceTimersByTimeAsync(threadTitleBudgetMs - threadTitleCleanupMs);
              vi.useRealTimers();
            } else if (mode === "revoked") {
              eventsAtRevocation = messages.filter((message) => message.type === "runner.event");
              runtime.revokeRuns([{ runId: command.context.runId, reason: "Binding replaced" }]);
            } else {
              await runtime.handleCommand(
                {
                  type: "run.interrupt",
                  commandId: createId("command"),
                  correlationId: command.correlationId,
                  environmentId,
                  runId: command.context.runId,
                  threadId: command.context.threadId,
                },
                { send: async (message) => void messages.push(message) },
              );
            }
          }
          await waitUntil(() => runtime.activeRunIds().length === 0);
          expect(messages.filter((message) => message.type === "runner.thread-title")).toEqual([]);
          if (mode === "revoked")
            expect(messages.filter((message) => message.type === "runner.event")).toEqual(
              eventsAtRevocation,
            );
          else
            expect(hasEvent(messages, mode === "abort" ? "run.interrupted" : "run.completed")).toBe(
              true,
            );
          if (mode === "absent") expect(naming).not.toHaveBeenCalled();
          if (mode === "abort" || mode === "revoked" || mode === "budget") {
            expect(namingSignal?.aborted).toBe(true);
            expect(settled).toBe(true);
          }
        } finally {
          vi.useRealTimers();
          await runtime.close();
        }
      },
    );
  });

  it.each(["missing", "expired", "heartbeat", "attach", "interrupted"] as const)(
    "waits for its first correlated lease before preparing or executing a Run (%s)",
    async (grant) => {
      const driver = new FakeHarnessDriver();
      const registry = new HarnessRegistry();
      registry.registerDriver(driver);
      const environmentId = createId("environment");
      const prepare = vi.fn(async () => ({ instructions: undefined, path: "/runner/workspace" }));
      const runtime = configuredRuntime({
        environmentId,
        manualLeaseGrants: true,
        registry,
        workspacePrepare: prepare,
      });
      const execute = executeCommand(environmentId);
      const messages: RunnerOperationalReport[] = [];
      const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };
      await reconcile(registry, execute);
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      try {
        await expect(runtime.handleCommand(execute, sink)).resolves.toEqual({ status: "accepted" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(prepare).not.toHaveBeenCalled();
        expect(driver.contexts).toHaveLength(0);
        expect(runtime.activeRunIds()).toEqual([execute.context.runId]);
        if (grant === "heartbeat") {
          grantRuntimeLease(runtime, execute);
        } else if (grant === "attach") {
          runtime.attachInventory();
          await runtime.attach(
            {
              ...testConnectionFence,
              leaseMs: execute.context.executionLeaseMs,
              results: [{ nextOrdinal: 0, runId: execute.context.runId, status: "attached" }],
              type: "host.executions.attached",
            },
            sink,
          );
        } else if (grant === "expired") {
          // A delayed grant whose correlated deadline passed must never open
          // a workspace in the interval before the next watchdog tick.
          grantRuntimeLease(
            runtime,
            execute,
            new Date(Date.now() - execute.context.executionLeaseMs).toISOString(),
          );
        } else if (grant === "interrupted") {
          await runtime.handleCommand(
            {
              commandId: createId("command"),
              correlationId: execute.correlationId,
              environmentId,
              runId: execute.context.runId,
              threadId: execute.context.threadId,
              type: "run.interrupt",
            },
            sink,
          );
          grantRuntimeLease(runtime, execute);
        } else {
          await vi.advanceTimersByTimeAsync(execute.context.executionLeaseMs);
        }
        await waitUntil(() => runtime.activeRunIds().length === 0);
        const started = grant === "heartbeat" || grant === "attach";
        expect(prepare).toHaveBeenCalledTimes(started ? 1 : 0);
        expect(driver.contexts).toHaveLength(started ? 1 : 0);
        const events = messages.flatMap((message) =>
          message.type === "runner.event" ? [message.event.type] : [],
        );
        if (started) {
          expect(events).toContain("run.started");
          expect(events.at(-1)).toBe("run.completed");
        } else {
          expect(events).toEqual(["run.interrupted"]);
        }
      } finally {
        await runtime.close();
        vi.useRealTimers();
      }
    },
  );

  it("starts the harness through the Runner sandbox's plan for this Run", async () => {
    const driver = new FakeHarnessDriver();
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const plans: HarnessSandboxRunPlan[] = [];
    const runtime = configuredRuntime({
      environmentId,
      harnessSandbox: {
        plan: async (plan) => {
          plans.push(plan);
          return (launch) => ({
            ...launch,
            executable: "bwrap",
            args: ["--", launch.executable, ...launch.args],
          });
        },
        planProgram: async () => (launch) => launch,
      },
      registry,
    });
    const execute = executeCommand(environmentId);
    try {
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, { send: async () => undefined });
      await waitUntil(() => driver.contexts.length === 1);
      const context = driver.context;
      expect(context?.threadStateDirectory).toBe(
        join(testPrivateStateRoot, "threads", execute.context.threadId),
      );
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({
        launchDirectory: undefined,
        threadStateDirectory: context?.threadStateDirectory,
        workspacePath: context?.workspacePath,
        writableRoots: context?.writableRoots,
      });
      expect(plans[0]?.providerState).toBe(context?.providerState);
      const wrapped = context?.wrapProcessLaunch({
        args: ["app-server"],
        cwd: "/runner/runs/control/workspace",
        environment: {},
        executable: "/opt/codex",
      });
      // Inside the sandbox the engine carries this Run's scope, by which the
      // Runner finds and ends whatever it starts.
      expect(wrapped).toEqual({
        args: ["--", "/opt/codex", "app-server"],
        cwd: "/runner/runs/control/workspace",
        environment: {
          [executionScopeVariable]: expect.stringMatching(
            new RegExp(`\\.${execute.context.runId}-${execute.context.bindingGeneration}$`, "u"),
          ),
        },
        executable: "bwrap",
      });
    } finally {
      await runtime.close();
    }
  });

  it("gives its engine a Run-local proxy, never a Host token, and cuts it on interrupt", async () => {
    const seenAuthorization: (string | undefined)[] = [];
    const host = createServer((request, response) => {
      // Developer tools probe local listeners; record only this fake Host's MCP traffic.
      if (ignoreForeignTestRequest(request, response, (path) => path === "/internal/v1/mcp"))
        return;
      seenAuthorization.push(request.headers.authorization);
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: open\n\n");
    });
    host.listen(0, "127.0.0.1");
    await once(host, "listening");
    const address = host.address();
    if (!address || typeof address === "string") throw new Error("No fake Host address");
    const driver = new FakeHarnessDriver("test-driver", () => new HeldHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const base = executeCommand(environmentId);
    const execute = {
      ...base,
      context: {
        ...base.context,
        agentTools: {
          ...base.context.agentTools,
          url: `http://127.0.0.1:${address.port}/internal/v1/mcp`,
        },
      },
    };
    const sink: RunnerMessageSink = { send: async () => undefined };
    try {
      await probeTestServer(host);
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, sink);
      await waitUntil(() => driver.contexts.length === 1);
      const context = driver.context!;
      expect(context.agentTools.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/agent-tools$/u);
      expect(context.integrationTools.url).toMatch(/\/integration-tools$/u);
      expect(context.agentTools.token).not.toBe(execute.context.agentTools.token);
      expect(context.integrationTools.token).not.toBe(execute.context.integrationTools.token);

      const stream = await fetch(context.agentTools.url, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${context.agentTools.token}`,
        },
      });
      const reader = stream.body!.getReader();
      await reader.read();
      expect(seenAuthorization).toEqual([`Bearer ${execute.context.agentTools.token}`]);

      await runtime.handleCommand(
        {
          commandId: createId("command"),
          correlationId: execute.correlationId,
          environmentId,
          runId: execute.context.runId,
          threadId: execute.context.threadId,
          type: "run.interrupt",
        },
        sink,
      );
      await expect(
        (async () => {
          for (;;) if ((await reader.read()).done) return "ended";
        })(),
      ).resolves.toBe("ended");
      const after = await fetch(context.agentTools.url, {
        body: "{}",
        headers: { authorization: `Bearer ${context.agentTools.token}` },
        method: "POST",
      }).then(
        (response) => response.status,
        () => "closed",
      );
      expect([403, "closed"]).toContain(after);
      expect(seenAuthorization).toHaveLength(1);
    } finally {
      await runtime.close();
      host.closeAllConnections();
      await new Promise<void>((resolve) => host.close(() => resolve()));
    }
  });

  it("advertises provider sign-in from driver capability on every supported profile", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-managed-authentication-test-"));
    const codexHome = join(temporaryRoot, "private", "codex");
    const codexSqliteHome = join(temporaryRoot, "cache", "codex-sqlite");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(codexSqliteHome, { recursive: true }),
    ]);
    const previousCodexHome = process.env.CODEX_HOME;
    const previousCodexSqliteHome = process.env.CODEX_SQLITE_HOME;
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_SQLITE_HOME = codexSqliteHome;
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("codex");
    const harnessInstanceId = createId("harnessInstance");
    const completed = deferred<{ readonly status: "ready" }>();
    registry.registerDriver({
      capabilities: fakeHarnessCapabilities,
      accessModes: fakeHarnessAccessModes,
      sources: fakeHarnessSources,
      authenticate: async (context) => {
        expect(context.workingDirectory).toBe(join(temporaryRoot, "private"));
        expect(context.environment.CODEX_HOME).toBe(codexHome);
        expect(context.environment.CODEX_SQLITE_HOME).toBe(codexSqliteHome);
        return {
          cancel: async () => undefined,
          challenge: {
            kind: "device-code",
            userCode: "OPEN-STEER",
            verificationUrl: "https://example.test/device",
          },
          result: completed.promise,
          status: "pending",
        };
      },
      configSchema: z.strictObject({}),
      create: async () => {
        throw new Error("Unexpected adapter creation");
      },
      environmentVariables: ["CODEX_HOME", "CODEX_SQLITE_HOME"],
      inspect: async () => ({
        detail: "Sign in to the test engine",
        status: "authentication-required",
      }),
      kind: driverKind,
    });
    const baseOptions = {
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      bootId: "boot-managed-authentication-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: testDeploymentShape,
      environmentId: createId("environment"),
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      integrationSkills: noIntegrationSkills,
      maxConcurrentRuns: 1,
      dataDirectory: temporaryRoot,
      privateStateDirectory: join(temporaryRoot, "private"),
      projectContinuationIdentity,
      workspaceManager: {
        writableRoots: () => ["/runner/workspaces"],
        prepare: async () => Promise.reject(new Error("Unexpected Workspace access")),
      },
    } as const;
    const localRuntime = runtimeWithLeaseGrants(baseOptions);
    const managedRuntime = runtimeWithLeaseGrants(baseOptions);
    const start = {
      action: "start" as const,
      methodId: "device-code",
      harness: {
        config: {},
        driverKind,
        id: harnessInstanceId,
        name: "Test engine",
        runtimeRevision: 1,
        sourceId: "test",
        stateKind: "ambient" as const,
      },
    };

    try {
      await expect(
        localRuntime.inspectHarnesses([start.harness], new AbortController().signal),
      ).resolves.toMatchObject([{ status: "authentication-required" }]);
      await expect(
        managedRuntime.inspectHarnesses([start.harness], new AbortController().signal),
      ).resolves.toMatchObject([{ status: "authentication-required" }]);
      await expect(
        managedRuntime.handleHarnessAuthentication({ ...start, methodId: "default" }),
      ).resolves.toMatchObject({
        harnessInstanceId,
        state: { status: "not-started" },
      });
      await vi.waitFor(async () => {
        await expect(
          managedRuntime.handleHarnessAuthentication({
            action: "read",
            driverKind,
            harnessInstanceId,
          }),
        ).resolves.toMatchObject({
          state: { challenge: { userCode: "OPEN-STEER" }, status: "pending" },
        });
      });
      completed.resolve({ status: "ready" });
      await vi.waitFor(
        async () => {
          const response = await managedRuntime.handleHarnessAuthentication({
            action: "read",
            driverKind,
            harnessInstanceId,
          });
          expect(response.state.status).toBe("ready");
        },
        { timeout: 5_000 },
      );
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = previousCodexSqliteHome;
      await Promise.all([localRuntime.close(), managedRuntime.close()]);
      await rm(temporaryRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 10 });
    }
  });

  it("projects provider state identities before publishing a harness catalog", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-catalog-privacy-test-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("private-catalog-test");
    const selection = ModelSelectionSchema.parse({
      modelId: "test-model",
      options: {},
      providerId: "test-provider",
    });
    registry.registerDriver({
      capabilities: fakeHarnessCapabilities,
      accessModes: fakeHarnessAccessModes,
      sources: fakeHarnessSources,
      configSchema: z.strictObject({}),
      create: async () => {
        throw new Error("Unexpected adapter creation");
      },
      inspect: async () => ({
        models: [
          {
            displayName: "Test model",
            isDefault: true,
            modelId: selection.modelId,
            options: [],
            providerId: selection.providerId,
          },
        ],
        status: "ready",
      }),
      kind: driverKind,
    });
    const runtime = runtimeWithLeaseGrants({
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      bootId: "boot-catalog-privacy-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: testDeploymentShape,
      environmentId: createId("environment"),
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      integrationSkills: noIntegrationSkills,
      maxConcurrentRuns: 1,
      dataDirectory: temporaryRoot,
      privateStateDirectory: join(temporaryRoot, "private"),
      projectContinuationIdentity,
      workspaceManager: {
        writableRoots: () => ["/runner/workspaces"],
        prepare: async () => Promise.reject(new Error("Unexpected Workspace access")),
      },
    });

    const harnessInstanceId = createId("harnessInstance");
    // A profile that answered under a per-profile identity before stores
    // existed publishes that identity's projection so the Host can move its
    // Threads, and never the raw key.
    const legacyProfile = join(temporaryRoot, "private", "harness-profiles", harnessInstanceId);
    await mkdir(legacyProfile, { mode: 0o700, recursive: true });
    await writeFile(
      join(legacyProfile, "profile.json"),
      JSON.stringify({ authenticationEpoch: 1, stateId: "legacy" }),
    );

    try {
      const catalogs = await runtime.inspectHarnesses(
        [
          {
            config: {},
            driverKind,
            id: harnessInstanceId,
            name: "Private catalog test",
            runtimeRevision: 1,
            sourceId: "test",
            stateKind: "ambient",
          },
        ],
        new AbortController().signal,
      );
      expect(catalogs).toHaveLength(1);
      expect(catalogs[0]).toMatchObject({
        continuationIdentity: {
          continuationKey: expect.stringMatching(/^runner:v1:/),
          driverKind,
        },
        status: "ready",
      });
      expect(JSON.stringify(catalogs)).not.toContain(temporaryRoot);
      expect(JSON.stringify(catalogs)).not.toContain("profile-state");
      expect(catalogs[0]).toMatchObject({
        supersededContinuationIdentities: [expect.stringMatching(/^runner:v1:/)],
      });
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("never infers authentication from a generic provider error", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-explicit-inspection-state-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("explicit-inspection-state-test");
    registry.registerDriver({
      capabilities: fakeHarnessCapabilities,
      accessModes: fakeHarnessAccessModes,
      sources: fakeHarnessSources,
      authenticate: async () => ({ status: "ready" }),
      configSchema: z.strictObject({}),
      create: async () => {
        throw new Error("Unexpected adapter creation");
      },
      inspect: async () => {
        throw new OpensteerError({ code: "forbidden", message: "Provider policy rejected access" });
      },
      kind: driverKind,
    });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });

    try {
      await expect(
        runtime.inspectHarnesses(
          [
            {
              config: {},
              driverKind,
              id: createId("harnessInstance"),
              name: "Explicit inspection state test",
              runtimeRevision: 1,
              sourceId: "test",
              stateKind: "ambient",
            },
          ],
          new AbortController().signal,
        ),
      ).resolves.toMatchObject([{ detail: "Provider policy rejected access", status: "error" }]);
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("keeps an authoritative reconciliation alive when one desired profile is refused", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-authoritative-reconcile-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("authoritative-reconcile-test");
    registry.registerDriver(catalogDriver(driverKind));
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const poison = harnessDefinition(driverKind, "Poisoned", 2);
    const healthy = harnessDefinition(driverKind, "Healthy", 1);

    try {
      await expect(
        runtime.inspectHarnesses([poison, healthy], new AbortController().signal, true),
      ).resolves.toMatchObject([{ status: "ready" }, { status: "ready" }]);

      // A Host database rollback replays an older revision for one profile.
      const catalogs = await runtime.inspectHarnesses(
        [{ ...poison, runtimeRevision: 1 }, healthy],
        new AbortController().signal,
        true,
      );

      expect(catalogs).toHaveLength(2);
      expect(registry.state(poison.id)).toMatchObject({
        reason: expect.stringContaining("stale runtime revision"),
        status: "unavailable",
      });
      expect(registry.state(healthy.id)).toMatchObject({ status: "available" });
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("reports a private-state preparation failure as error catalogs instead of throwing", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-private-state-failure-"));
    const blockedRoot = join(temporaryRoot, "private");
    await writeFile(blockedRoot, "not a directory\n");
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("private-state-failure-test");
    registry.registerDriver(catalogDriver(driverKind));
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: blockedRoot,
      registry,
    });

    try {
      await expect(
        runtime.inspectHarnesses(
          [harnessDefinition(driverKind, "Blocked", 1)],
          new AbortController().signal,
          true,
        ),
      ).resolves.toMatchObject([{ status: "error" }]);
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("keeps native preparation alive across catalog callers and inspects only after it is ready", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-native-preparation-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("native-preparation-test");
    const preparation = deferred<void>();
    const prepare = vi.fn(
      async (_context: Parameters<NonNullable<HarnessDriver["prepare"]>>[0]) => preparation.promise,
    );
    const inspect = vi.fn(async () => ({
      detail: "Sign in to continue",
      setupMethods: [{ kind: "device-code" as const, label: "Sign in", methodId: "login" }],
      status: "authentication-required" as const,
    }));
    registry.registerDriver({
      ...catalogDriver(driverKind),
      authenticate: async () => ({ status: "ready" }),
      inspect,
      prepare,
    });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const harness = harnessDefinition(driverKind, "Native preparation", 1);
    const shortCaller = new AbortController();

    try {
      await expect(runtime.inspectHarnesses([harness], shortCaller.signal, true)).resolves.toEqual([
        expect.objectContaining({
          harnessInstanceId: harness.id,
          models: [],
          setupMethods: [],
          status: "preparing",
        }),
      ]);
      shortCaller.abort(new Error("catalog caller expired"));

      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      expect(prepare.mock.calls[0]?.[0].signal.aborted).toBe(false);
      expect(inspect).not.toHaveBeenCalled();

      preparation.resolve();
      await preparation.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(
        runtime.inspectHarnesses([harness], new AbortController().signal),
      ).resolves.toMatchObject([
        {
          detail: "Sign in to continue",
          models: [],
          setupMethods: [{ kind: "device-code", methodId: "login" }],
          status: "authentication-required",
        },
      ]);
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("cancels native preparation through profile removal and runtime shutdown", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-native-preparation-cleanup-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("native-preparation-cleanup-test");
    const preparationSignals: AbortSignal[] = [];
    const cleaned = vi.fn();
    registry.registerDriver({
      ...catalogDriver(driverKind),
      prepare: async ({ signal }) => {
        preparationSignals.push(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        cleaned();
      },
    });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const removed = harnessDefinition(driverKind, "Removed preparation", 1);
    const shutdown = harnessDefinition(driverKind, "Shutdown preparation", 1);
    let runtimeClosed = false;

    try {
      await expect(
        runtime.inspectHarnesses([removed, shutdown], new AbortController().signal, true),
      ).resolves.toMatchObject([{ status: "preparing" }, { status: "preparing" }]);
      await vi.waitFor(() => expect(preparationSignals).toHaveLength(2));

      await expect(
        runtime.handleHarnessAuthentication({ action: "remove", harness: removed }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
      expect(preparationSignals.filter((signal) => signal.aborted)).toHaveLength(1);
      expect(cleaned).toHaveBeenCalledTimes(1);

      await runtime.close();
      runtimeClosed = true;
      expect(preparationSignals.every((signal) => signal.aborted)).toBe(true);
      expect(cleaned).toHaveBeenCalledTimes(2);
    } finally {
      if (!runtimeClosed) await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("logs private inspection stderr without publishing it in the harness catalog", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-inspection-diagnostic-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("inspection-diagnostic-test");
    const logged: {
      readonly details?: Readonly<Record<string, unknown>>;
      readonly message: string;
    }[] = [];
    registry.registerDriver({
      ...catalogDriver(driverKind),
      prepare: async () => {
        throw new OpensteerError({
          code: "timeout",
          details: { stderr: "Codex provider initialization stalled after loading configuration" },
          message: "Codex initialize timed out",
        });
      },
    });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      logger: {
        error: (message, details) => void logged.push({ ...(details ? { details } : {}), message }),
        info: () => undefined,
      },
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const harness = harnessDefinition(driverKind, "Inspection diagnostic", 1);

    try {
      await expect(
        runtime.inspectHarnesses([harness], new AbortController().signal, true),
      ).resolves.toMatchObject([{ status: "preparing" }]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const catalogs = await runtime.inspectHarnesses([harness], new AbortController().signal);
      expect(catalogs).toMatchObject([{ detail: "Codex initialize timed out", status: "error" }]);
      expect(JSON.stringify(catalogs)).not.toContain("provider initialization stalled");
      expect(logged).toEqual([
        {
          details: {
            detail: "Codex initialize timed out",
            driverKind,
            harnessInstanceId: harness.id,
            stderr: "Codex provider initialization stalled after loading configuration",
          },
          message: "AI engine inspection failed",
        },
      ]);
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("removes isolated provider state and leaves an ambient profile's provider files alone", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-profile-removal-"));
    const stateRoot = join(temporaryRoot, "private");
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("profile-removal-test");
    const removeProfile = vi.fn(async () => undefined);
    registry.registerDriver({ ...catalogDriver(driverKind), removeProfile });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: stateRoot,
      registry,
    });
    const isolated = {
      ...harnessDefinition(driverKind, "Isolated", 1),
      sourceId: "test",
      stateKind: "isolated" as const,
    };
    const ambient = harnessDefinition(driverKind, "Ambient", 1);
    const orphan = {
      ...harnessDefinition(driverKind, "Orphan", 1),
      sourceId: "test",
      stateKind: "isolated" as const,
    };

    try {
      await runtime.inspectHarnesses([isolated, ambient, orphan], new AbortController().signal);
      // The metadata write never landed for this profile.
      await rm(join(stateRoot, "harness-profiles", orphan.id, "profile.json"), { force: true });

      await expect(
        runtime.handleHarnessAuthentication({ action: "remove", harness: isolated }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
      await expect(
        runtime.handleHarnessAuthentication({ action: "remove", harness: ambient }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
      await expect(
        runtime.handleHarnessAuthentication({ action: "remove", harness: orphan }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });

      // Only the two isolated profiles own provider state a driver may clean up.
      expect(removeProfile).toHaveBeenCalledTimes(2);
      for (const profile of [isolated, ambient, orphan]) {
        await expect(stat(join(stateRoot, "harness-profiles", profile.id))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("keeps the store continuation identity across a logout and clears the entry", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-profile-logout-"));
    const stateRoot = join(temporaryRoot, "private");
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("profile-logout-test");
    registry.registerDriver({ ...catalogDriver(driverKind), logout: async () => undefined });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: stateRoot,
      registry,
    });
    const profile = harnessDefinition(driverKind, "Logout", 1);

    try {
      const [before] = await runtime.inspectHarnesses([profile], new AbortController().signal);
      await expect(
        runtime.handleHarnessAuthentication({ action: "logout", harness: profile }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
      const [after] = await runtime.inspectHarnesses([profile], new AbortController().signal);

      expect(before?.status).toBe("ready");
      expect(after?.status).toBe("ready");
      expect(continuationKeyOf(after)).toBeDefined();
      // Credentials are the profile's; the native session store is the
      // environment's. Signing out replaces the first and never the second, so
      // a Thread keeps the provider conversation it already owns.
      expect(continuationKeyOf(after)).toBe(continuationKeyOf(before));
      // The logout leaves no entry behind, so a status read is honest.
      await expect(
        runtime.handleHarnessAuthentication({
          action: "read",
          driverKind,
          harnessInstanceId: profile.id,
        }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
      await expect(stat(join(stateRoot, "harness-profiles", profile.id))).resolves.toBeDefined();
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("refuses to sign an AI engine out or remove it while a Run is executing on it", async () => {
    const driverKind = HarnessIdSchema.parse("profile-busy-test");
    const registry = new HarnessRegistry();
    registry.registerDriver({
      ...catalogDriver(driverKind),
      create: async ({ instanceId }) => ({
        capabilities: fakeHarnessCapabilities,
        accessModes: fakeHarnessAccessModes,
        sources: fakeHarnessSources,
        close: async () => undefined,
        instanceId,
        resumeSession: async () => new BlockingHarnessSession(),
        startSession: async () => new BlockingHarnessSession(),
      }),
      logout: async () => undefined,
    });
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const execute = executeCommand(environmentId, driverKind);
    const harness = { ...execute.context.harness, id: execute.context.harnessInstanceId };
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = {
      send: async (message) => {
        messages.push(message);
      },
    };

    try {
      await reconcile(registry, execute);
      await expect(runtime.handleCommand(execute, sink)).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => hasEvent(messages, "run.started"));

      // The Host refuses both of these too, but its answer is a durable read
      // taken before the request was sent. This Runner is the one that knows
      // what is executing here now, so it is the last line.
      for (const action of ["logout", "remove"] as const) {
        await expect(
          runtime.handleHarnessAuthentication({ action, harness }),
        ).rejects.toMatchObject({ code: "conflict", retryable: true });
      }
      // Only the busy profile is held: an idle one on the same driver is not.
      await expect(
        runtime.handleHarnessAuthentication({
          action: "logout",
          harness: harnessDefinition(driverKind, "Idle", 1),
        }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });

      const interruptId = createId("command");
      await expect(
        runtime.handleCommand(
          RunnerCommandSchema.parse({
            commandId: interruptId,
            correlationId: CorrelationIdSchema.parse(interruptId),
            environmentId,
            runId: execute.context.runId,
            threadId: execute.context.threadId,
            type: "run.interrupt",
          }),
          sink,
        ),
      ).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => runtime.activeRunIds().length === 0);

      await expect(
        runtime.handleHarnessAuthentication({ action: "logout", harness }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
    } finally {
      await runtime.close();
    }
  });

  it("refuses Run admission while profile maintenance is in progress", async () => {
    const driverKind = HarnessIdSchema.parse("profile-maintenance-fence-test");
    const maintenanceStarted = deferred<void>();
    const finishMaintenance = deferred<void>();
    const registry = new HarnessRegistry();
    registry.registerDriver({
      ...catalogDriver(driverKind),
      logout: async () => {
        maintenanceStarted.resolve(undefined);
        await finishMaintenance.promise;
      },
    });
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const execute = executeCommand(environmentId, driverKind);
    const harness = { ...execute.context.harness, id: execute.context.harnessInstanceId };
    await reconcile(registry, execute);
    const logout = runtime.handleHarnessAuthentication({ action: "logout", harness });

    try {
      await maintenanceStarted.promise;

      await expect(
        runtime.handleCommand(execute, { send: async () => undefined }),
      ).resolves.toMatchObject({
        error: { code: "conflict", retryable: true },
        status: "rejected",
      });

      finishMaintenance.resolve(undefined);
      await expect(logout).resolves.toMatchObject({ state: { status: "not-started" } });
    } finally {
      finishMaintenance.resolve(undefined);
      await logout.catch(() => undefined);
      await runtime.close();
    }
  });

  it("refuses an installed-engine update while an affected Run is active", async () => {
    const driverKind = HarnessIdSchema.parse("installed-update-busy-test");
    const driver = {
      ...catalogDriver(driverKind),
      create: async ({ instanceId }: { readonly instanceId: HarnessInstanceId }) => ({
        capabilities: fakeHarnessCapabilities,
        accessModes: fakeHarnessAccessModes,
        sources: fakeHarnessSources,
        close: async () => undefined,
        instanceId,
        resumeSession: async () => new BlockingHarnessSession(),
        startSession: async () => new BlockingHarnessSession(),
      }),
    };
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver,
      { status: "configured" },
      {
        create: () => driver,
        locate: () => "/bin/true",
        missing: "Engine missing",
        scope: "all",
        update: {
          executableName: "Test engine",
          minimumVersion: "1.0.0",
          native: { executableBasename: "true", updateArgs: ["--version"] },
          version: { args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
        },
      },
    );
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const execute = executeCommand(environmentId, driverKind);
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };
    try {
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, sink);
      await waitUntil(() => hasEvent(messages, "run.started"));
      const updateId = createId("command");
      await expect(
        runtime.handleCommand(
          RunnerCommandSchema.parse({
            commandId: updateId,
            correlationId: CorrelationIdSchema.parse(updateId),
            driverKind,
            environmentId,
            type: "harness.update",
          }),
          sink,
        ),
      ).resolves.toMatchObject({
        error: { code: "conflict", retryable: true },
        status: "rejected",
      });
    } finally {
      const interruptId = createId("command");
      await runtime.handleCommand(
        RunnerCommandSchema.parse({
          commandId: interruptId,
          correlationId: CorrelationIdSchema.parse(interruptId),
          environmentId,
          runId: execute.context.runId,
          threadId: execute.context.threadId,
          type: "run.interrupt",
        }),
        sink,
      );
      await waitUntil(() => runtime.activeRunIds().length === 0);
      await runtime.close();
    }
  });

  it("advertises installation inspection after connect without awaiting a slow probe", async () => {
    const driverKind = HarnessIdSchema.parse("installed-inspection-background-test");
    const driver = catalogDriver(driverKind);
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver,
      { status: "configured" },
      {
        create: () => driver,
        locate: () => "/test/engine",
        missing: "Engine missing",
        scope: "all",
        update: {
          executableName: "Test engine",
          minimumVersion: "1.0.0",
          version: { args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
        },
      },
    );
    const inspection = deferred<Awaited<ReturnType<HarnessRegistry["driverInstallation"]>>>();
    vi.spyOn(registry, "driverInstallation").mockImplementation(() => inspection.promise);
    const runtime = configuredRuntime({ environmentId: createId("environment"), registry });
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };

    try {
      await expect(runtime.harnessDrivers()).resolves.toMatchObject([
        { driverKind, readiness: "configured" },
      ]);
      await runtime.attach(
        { ...testConnectionFence, leaseMs: 60_000, results: [], type: "host.executions.attached" },
        sink,
      );
      inspection.resolve({
        descriptor: {
          latestVersion: "2.0.0",
          scope: "all",
          update: "available",
          version: "1.0.0",
        },
      });
      await waitUntil(() =>
        messages.some(
          (message) =>
            message.type === "runner.harness-installation" &&
            message.installation.latestVersion === "2.0.0",
        ),
      );
    } finally {
      inspection.resolve(undefined);
      await runtime.close();
    }
  });

  it("reserves an installed engine before resolving it and releases rejected reservations", async () => {
    const driverKind = HarnessIdSchema.parse("installed-update-reservation-test");
    const driver = catalogDriver(driverKind);
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver,
      { status: "configured" },
      {
        create: () => driver,
        locate: () => "/test/engine",
        missing: "Engine missing",
        scope: "all",
        update: {
          executableName: "Test engine",
          minimumVersion: "1.0.0",
          version: { args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
        },
      },
    );
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const execute = executeCommand(environmentId, driverKind);
    await reconcile(registry, execute);
    const inspectionStarted = deferred<void>();
    const inspection = deferred<Awaited<ReturnType<HarnessRegistry["driverInstallation"]>>>();
    vi.spyOn(registry, "driverInstallation").mockImplementation(() => {
      inspectionStarted.resolve(undefined);
      return inspection.promise;
    });
    const sink: RunnerMessageSink = { send: async () => undefined };
    const firstUpdate = runtime.handleCommand(updateCommand(environmentId, driverKind), sink);

    try {
      await inspectionStarted.promise;
      await expect(
        runtime.handleCommand(updateCommand(environmentId, driverKind), sink),
      ).resolves.toMatchObject({
        error: { code: "conflict", retryable: true },
        status: "rejected",
      });
      await expect(runtime.handleCommand(execute, sink)).resolves.toMatchObject({
        error: { code: "conflict", retryable: true },
        status: "rejected",
      });
      await expect(
        runtime.handleHarnessAuthentication({
          action: "start",
          harness: { ...execute.context.harness, id: execute.context.harnessInstanceId },
          methodId: "default",
        }),
      ).rejects.toMatchObject({ code: "conflict", retryable: true });

      inspection.resolve(undefined);
      await expect(firstUpdate).resolves.toMatchObject({
        error: { code: "not_found", retryable: false },
        status: "rejected",
      });
      await expect(
        runtime.handleCommand(updateCommand(environmentId, driverKind), sink),
      ).resolves.toMatchObject({ error: { code: "not_found" }, status: "rejected" });
    } finally {
      inspection.resolve(undefined);
      await firstUpdate.catch(() => undefined);
      await runtime.close();
    }
  });

  it("allows an installed-engine update after sign-in has finished", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-engine-update-auth-"));
    const executable = join(root, "test-engine");
    await writeFile(
      executable,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.0.0"; fi\nexit 0\n',
      { mode: 0o755 },
    );
    const driverKind = HarnessIdSchema.parse("installed-update-finished-auth-test");
    const authenticated = deferred<void>();
    const driver = {
      ...catalogDriver(driverKind),
      authenticate: async () => {
        authenticated.resolve(undefined);
        return { status: "ready" as const };
      },
    };
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver,
      { status: "configured" },
      {
        create: () => driver,
        locate: () => executable,
        missing: "Engine missing",
        scope: "all",
        update: {
          executableName: "Test engine",
          minimumVersion: "1.0.0",
          native: { executableBasename: "test-engine", updateArgs: ["update"] },
          version: { args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
        },
      },
    );
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const execute = executeCommand(environmentId, driverKind);
    const harness = { ...execute.context.harness, id: execute.context.harnessInstanceId };
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };
    await reconcile(registry, execute);

    try {
      await runtime.handleHarnessAuthentication({ action: "start", harness, methodId: "default" });
      await authenticated.promise;
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      await expect(
        runtime.handleHarnessAuthentication({
          action: "read",
          driverKind,
          harnessInstanceId: harness.id,
        }),
      ).resolves.toMatchObject({ state: { status: "ready" } });
      await expect(
        runtime.handleCommand(updateCommand(environmentId, driverKind), sink),
      ).resolves.toEqual({ status: "accepted" });
      await waitUntil(() =>
        messages.some(
          (message) =>
            message.type === "runner.harness-installation" &&
            message.installation.update === "succeeded",
        ),
      );
    } finally {
      await runtime.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("publishes shared updating and terminal status for a supervised update", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-engine-update-"));
    const executable = join(root, "test-engine");
    await writeFile(
      executable,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi\nexit 0\n',
      { mode: 0o755 },
    );
    const driverKind = HarnessIdSchema.parse("installed-update-status-test");
    const driver = catalogDriver(driverKind);
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver,
      { status: "configured" },
      {
        create: () => driver,
        locate: () => executable,
        missing: "Engine missing",
        scope: "all",
        update: {
          executableName: "Test engine",
          minimumVersion: "1.0.0",
          native: { executableBasename: "test-engine", updateArgs: ["update"] },
          version: { args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
        },
      },
    );
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };
    const updateId = createId("command");
    try {
      await expect(
        runtime.handleCommand(
          RunnerCommandSchema.parse({
            commandId: updateId,
            correlationId: CorrelationIdSchema.parse(updateId),
            driverKind,
            environmentId,
            type: "harness.update",
          }),
          sink,
        ),
      ).resolves.toEqual({ status: "accepted" });
      await waitUntil(() =>
        messages.some(
          (message) =>
            message.type === "runner.harness-installation" &&
            message.installation.update === "succeeded",
        ),
      );
      expect(
        messages.flatMap((message) =>
          message.type === "runner.harness-installation" ? [message.installation.update] : [],
        ),
      ).toEqual(["updating", "succeeded", "unknown"]);
      await expect(
        runtime.handleCommand(updateCommand(environmentId, driverKind), sink),
      ).resolves.toEqual({ status: "accepted" });
      await waitUntil(
        () =>
          messages.filter(
            (message) =>
              message.type === "runner.harness-installation" &&
              message.installation.update === "succeeded",
          ).length === 2,
      );
    } finally {
      await runtime.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("replaces a successful update status with a later installation inspection", async () => {
    const driverKind = HarnessIdSchema.parse("installed-update-refresh-test");
    const driver = catalogDriver(driverKind);
    const registry = new HarnessRegistry();
    registry.registerDriver(
      driver,
      { status: "configured" },
      {
        create: () => driver,
        locate: () => "/bin/true",
        missing: "Engine missing",
        scope: "all",
        update: {
          executableName: "Test engine",
          minimumVersion: "1.0.0",
          version: { args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
        },
      },
    );
    const initial = {
      descriptor: {
        latestVersion: "2.0.0",
        scope: "all" as const,
        update: "available" as const,
        version: "1.0.0",
      },
      plan: {
        args: ["-e", ""] as const,
        environment: {},
        executable: process.execPath,
        serializationKey: "test:update-refresh",
      },
    };
    const current = {
      descriptor: { ...initial.descriptor, update: "current" as const, version: "2.0.0" },
      plan: initial.plan,
    };
    const newer = {
      descriptor: {
        ...current.descriptor,
        latestVersion: "3.0.0",
        update: "available" as const,
      },
      plan: initial.plan,
    };
    vi.spyOn(registry, "driverInstallation")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(newer);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const messages: RunnerOperationalReport[] = [];
    const currentAdvertised = deferred<void>();
    const newerAdvertised = deferred<void>();
    const sink: RunnerMessageSink = {
      send: async (message) => {
        messages.push(message);
        if (message.type !== "runner.harness-installation") return;
        if (message.installation.update === "current") currentAdvertised.resolve(undefined);
        if (message.installation.latestVersion === "3.0.0") newerAdvertised.resolve(undefined);
      },
    };

    try {
      await runtime.attach(
        { ...testConnectionFence, leaseMs: 60_000, results: [], type: "host.executions.attached" },
        sink,
      );
      await expect(
        runtime.handleCommand(updateCommand(environmentId, driverKind), sink),
      ).resolves.toEqual({ status: "accepted" });
      await currentAdvertised.promise;
      await runtime.harnessDrivers();
      await newerAdvertised.promise;
      await expect(runtime.harnessDrivers()).resolves.toMatchObject([
        {
          driverKind,
          installation: { latestVersion: "3.0.0", update: "available" },
        },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("gives an ambient and an isolated Run of one driver the same store identity", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-run-provider-state-"));
    const stateRoot = join(temporaryRoot, "private");
    const driver = new FakeHarnessDriver();
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({
      environmentId,
      maxConcurrentRuns: 2,
      privateStateDirectory: stateRoot,
      registry,
      workspacePrepare: async () => ({ instructions: undefined, path: temporaryRoot }),
    });
    const ambient = executeCommand(environmentId);
    const isolated = isolatedExecuteCommand(executeCommand(environmentId));
    const sink: RunnerMessageSink = { send: async () => undefined };

    try {
      await reconcile(registry, ambient, isolated);
      await runtime.handleCommand(ambient, sink);
      await waitUntil(() => driver.contexts.length === 1);
      await runtime.handleCommand(isolated, sink);
      await waitUntil(() => driver.contexts.length === 2);

      const [ambientContext, isolatedContext] = driver.contexts;
      expect(ambientContext?.providerState).toMatchObject({
        kind: "ambient",
        privateStateRoot: dirname(stateRoot),
        providerHomeDirectory: undefined,
      });
      expect(isolatedContext?.providerState).toMatchObject({
        kind: "isolated",
        providerHomeDirectory: join(
          stateRoot,
          "harness-profiles",
          isolated.context.harnessInstanceId,
          "provider-home",
        ),
      });
      // The Run and an inspection of the same profile resolve one identity, and
      // both state kinds land on the one store their driver shares.
      for (const command of [ambient, isolated]) {
        const { providerState } = await prepareHarnessProviderState(
          { ...command.context.harness, id: command.context.harnessInstanceId },
          {
            environment: {},
            privateStateRoot: dirname(stateRoot),
            stateDirectory: stateRoot,
            runtimeBoundary: nativeUserHarnessRuntimeBoundary,
            storeScope: driver.providerStoreScope,
          },
        );
        expect(providerState.continuationKey).toMatch(/^test-driver:store:[^:]+$/u);
        expect(
          driver.contexts.find(
            (context) => context.harnessInstanceId === command.context.harnessInstanceId,
          )?.providerState.continuationKey,
        ).toBe(providerState.continuationKey);
      }
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("runs the next Run of a Thread on the profile it is bound to, not the last one", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-profile-switch-"));
    const stateRoot = join(temporaryRoot, "private");
    const driver = new FakeHarnessDriver();
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({
      environmentId,
      privateStateDirectory: stateRoot,
      registry,
      workspacePrepare: async () => ({ instructions: undefined, path: temporaryRoot }),
    });
    const first = isolatedExecuteCommand(executeCommand(environmentId));
    // The same Thread, bound to a second profile of the same driver, resuming
    // the native conversation the first profile left in the shared store.
    const second = RunnerCommandSchema.parse({
      ...first,
      commandId: createId("command"),
      context: {
        ...first.context,
        bindingGeneration: first.context.bindingGeneration + 1,
        harnessInstanceId: createId("harnessInstance"),
        providerSessionId: createId("providerSession"),
        providerSessionReference: "fake-provider-session",
        runId: createId("run"),
      },
    }) as Extract<RunnerCommand, { readonly type: "run.execute" }>;
    const sink: RunnerMessageSink = { send: async () => undefined };

    try {
      await reconcile(registry, first, second);
      await runtime.handleCommand(first, sink);
      await waitUntil(() => driver.contexts.length === 1);
      await waitUntil(() => runtime.activeRunIds().length === 0);
      await runtime.handleCommand(second, sink);
      await waitUntil(() => driver.contexts.length === 2);

      const [firstContext, secondContext] = driver.contexts;
      expect(firstContext?.harnessInstanceId).toBe(first.context.harnessInstanceId);
      expect(secondContext?.harnessInstanceId).toBe(second.context.harnessInstanceId);
      // A second Run never reuses the first profile's provider process: it opens
      // one under its own credentials and resumes through the shared store.
      expect(secondContext?.providerState.providerHomeDirectory).not.toBe(
        firstContext?.providerState.providerHomeDirectory,
      );
      expect(secondContext?.providerState.continuationKey).toBe(
        firstContext?.providerState.continuationKey,
      );
      expect(driver.resumedReferences).toEqual(["fake-provider-session"]);
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("bounds a sign-in attempt, restarts a completed one, and forgets a cancelled one", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-authentication-lifetime-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("authentication-lifetime-test");
    const cancel = vi.fn(async () => undefined);
    let starts = 0;
    let outcome: "pending" | "ready" = "pending";
    registry.registerDriver({
      ...catalogDriver(driverKind),
      authenticate: async () => {
        starts += 1;
        if (outcome === "ready") return { status: "ready" };
        return {
          cancel,
          challenge: {
            kind: "device-code",
            userCode: "OPEN-STEER",
            verificationUrl: "https://example.test/device",
          },
          result: new Promise<never>(() => undefined),
          status: "pending",
        };
      },
    });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const harness = harnessDefinition(driverKind, "Lifetime", 1);
    const start = { action: "start" as const, harness, methodId: "device-code" };

    vi.useFakeTimers();
    try {
      await expect(runtime.handleHarnessAuthentication(start)).resolves.toMatchObject({
        state: { status: "not-started" },
      });
      await runtime.handleHarnessAuthentication(start);
      await vi.waitFor(() => expect(starts).toBe(1));

      // An attempt that outlived the Host's bounded lifetime is not replayed.
      vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
      await expect(runtime.handleHarnessAuthentication(start)).resolves.toMatchObject({
        state: { status: "not-started" },
      });
      await vi.waitFor(() => expect(starts).toBe(2));
      expect(cancel).toHaveBeenCalledTimes(1);

      // Cancelling deletes the entry rather than leaving it to be replayed.
      await expect(
        runtime.handleHarnessAuthentication({
          action: "cancel",
          driverKind,
          harnessInstanceId: harness.id,
        }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
      expect(cancel).toHaveBeenCalledTimes(2);
      await expect(
        runtime.handleHarnessAuthentication({
          action: "read",
          driverKind,
          harnessInstanceId: harness.id,
        }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });

      // Re-authenticating a connected profile runs the provider's setup again.
      outcome = "ready";
      await expect(runtime.handleHarnessAuthentication(start)).resolves.toMatchObject({
        state: { status: "not-started" },
      });
      await vi.waitFor(async () => {
        await expect(
          runtime.handleHarnessAuthentication({
            action: "read",
            driverKind,
            harnessInstanceId: harness.id,
          }),
        ).resolves.toMatchObject({ state: { status: "ready" } });
      });
      await expect(runtime.handleHarnessAuthentication(start)).resolves.toMatchObject({
        state: { status: "not-started" },
      });
      await vi.waitFor(() => expect(starts).toBe(4));
    } finally {
      vi.useRealTimers();
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("cancels provider initialization before a sign-in challenge exists", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-authentication-startup-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("authentication-startup-test");
    let startupSignal: AbortSignal | undefined;
    let starts = 0;
    let finishStartup!: (result: HarnessAuthenticationStart) => void;
    const providerStartup = new Promise<HarnessAuthenticationStart>((resolve) => {
      finishStartup = resolve;
    });
    registry.registerDriver({
      ...catalogDriver(driverKind),
      authenticate: async (context) => {
        starts += 1;
        startupSignal = context.signal;
        return await providerStartup;
      },
    });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const harness = harnessDefinition(driverKind, "Cold sign-in", 1);
    const startRequest = { action: "start" as const, harness, methodId: "device-code" };
    const first = runtime.handleHarnessAuthentication(startRequest);
    const duplicate = runtime.handleHarnessAuthentication(startRequest);
    try {
      await expect(first).resolves.toMatchObject({ state: { status: "not-started" } });
      await expect(duplicate).resolves.toMatchObject({ state: { status: "not-started" } });
      await vi.waitFor(() => expect(startupSignal).toBeDefined());
      expect(starts).toBe(1);
      await expect(
        runtime.handleHarnessAuthentication({
          action: "cancel",
          driverKind,
          harnessInstanceId: harness.id,
        }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
      await vi.waitFor(() => expect(startupSignal?.aborted).toBe(true));
      const cancelLateChallenge = vi.fn(async () => undefined);
      finishStartup({
        cancel: cancelLateChallenge,
        challenge: {
          kind: "device-code",
          userCode: "TOO-LATE",
          verificationUrl: "https://example.test/device",
        },
        result: Promise.resolve({ status: "ready" }),
        status: "pending",
      });
      await vi.waitFor(() => expect(cancelLateChallenge).toHaveBeenCalledOnce());
      await expect(
        runtime.handleHarnessAuthentication({
          action: "read",
          driverKind,
          harnessInstanceId: harness.id,
        }),
      ).resolves.toMatchObject({ state: { status: "not-started" } });
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("claims sign-in startup before provider-state preparation can be canceled", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-authentication-claim-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("authentication-claim-test");
    const authenticate = vi.fn(async () => ({ status: "ready" as const }));
    registry.registerDriver({ ...catalogDriver(driverKind), authenticate });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const harness = harnessDefinition(driverKind, "Canceled while preparing", 1);
    const starting = runtime.handleHarnessAuthentication({
      action: "start",
      harness,
      methodId: "device-code",
    });
    const canceling = runtime.handleHarnessAuthentication({
      action: "cancel",
      driverKind,
      harnessInstanceId: harness.id,
    });
    try {
      await expect(starting).resolves.toMatchObject({ state: { status: "not-started" } });
      await expect(canceling).resolves.toMatchObject({ state: { status: "not-started" } });
      await Promise.resolve();
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("does not publish a late ready result after the Host connection ends", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-authentication-disconnect-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("authentication-disconnect-test");
    let finishStartup!: (result: HarnessAuthenticationStart) => void;
    const providerStartup = new Promise<HarnessAuthenticationStart>((resolve) => {
      finishStartup = resolve;
    });
    registry.registerDriver({
      ...catalogDriver(driverKind),
      authenticate: async () => await providerStartup,
    });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const harness = harnessDefinition(driverKind, "Disconnected startup", 1);
    const connection = new AbortController();
    try {
      await runtime.handleHarnessAuthentication(
        { action: "start", harness, methodId: "device-code" },
        connection.signal,
      );
      connection.abort(new Error("Host connection ended"));
      finishStartup({ status: "ready" });
      await vi.waitFor(async () => {
        await expect(
          runtime.handleHarnessAuthentication({
            action: "read",
            driverKind,
            harnessInstanceId: harness.id,
          }),
        ).resolves.toMatchObject({ state: { status: "failed" } });
      });
    } finally {
      finishStartup({ status: "ready" });
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("fences a replacement sign-in while the prior method is still canceling", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-authentication-replace-"));
    const registry = new HarnessRegistry();
    const driverKind = HarnessIdSchema.parse("authentication-replace-test");
    let starts = 0;
    let finishPriorCancel!: () => void;
    const priorCanceled = new Promise<void>((resolve) => {
      finishPriorCancel = resolve;
    });
    registry.registerDriver({
      ...catalogDriver(driverKind),
      authenticate: async () => {
        starts += 1;
        return {
          cancel: async () => await priorCanceled,
          challenge: {
            kind: "device-code",
            userCode: "FIRST",
            verificationUrl: "https://example.test/device",
          },
          result: new Promise<never>(() => undefined),
          status: "pending",
        };
      },
    });
    const runtime = configuredRuntime({
      environmentId: createId("environment"),
      privateStateDirectory: join(temporaryRoot, "private"),
      registry,
    });
    const harness = harnessDefinition(driverKind, "Replacement", 1);
    try {
      await runtime.handleHarnessAuthentication({ action: "start", harness, methodId: "first" });
      await vi.waitFor(() => expect(starts).toBe(1));
      const replacement = runtime.handleHarnessAuthentication({
        action: "start",
        harness,
        methodId: "second",
      });
      const canceling = runtime.handleHarnessAuthentication({
        action: "cancel",
        driverKind,
        harnessInstanceId: harness.id,
      });
      await expect(replacement).resolves.toMatchObject({ state: { status: "not-started" } });
      finishPriorCancel();
      await expect(canceling).resolves.toMatchObject({ state: { status: "not-started" } });
      await Promise.resolve();
      expect(starts).toBe(1);
    } finally {
      finishPriorCancel();
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("runs a Trigger program on its mounted Workspace without detaching it", async () => {
    const registry = new HarnessRegistry();
    const environmentId = createId("environment");
    const command = triggerCommand(environmentId);
    let executions = 0;
    const runtime = runtimeWithLeaseGrants({
      agentSkills: testAgentSkills,
      integrationSkills: noIntegrationSkills,
      bootId: "boot-trigger-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: testDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      maxConcurrentRuns: 1,
      dataDirectory: dirname(testPrivateStateRoot),
      privateStateDirectory: testPrivateStateRoot,
      projectContinuationIdentity,
      programExecutor: {
        execute: async ({ context, workspace }) => {
          executions += 1;
          expect(context).toEqual(command.context);
          expect(workspace.path).toBe("/runner/triggers/test/workspace");
          return {
            completedAt: new Date().toISOString(),
            error: null,
            exitCode: 0,
            occurrenceId: context.occurrenceId,
            result: { delivered: true },
            status: "succeeded",
            stderr: "",
            stdout: "done\n",
          };
        },
      },
      workspaceManager: {
        writableRoots: () => ["/runner/workspaces"],
        prepare: async () => {
          return {
            instructions: undefined,
            path: "/runner/triggers/test/workspace",
          };
        },
      },
    });
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = {
      send: async (message) => {
        messages.push(message);
      },
    };
    try {
      await expect(runtime.handleCommand(command, sink)).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => runtime.activeTriggerOccurrenceIds().length === 0);
      expect(executions).toBe(1);
      expect(messages).toEqual([
        expect.objectContaining({
          environmentId,
          executionGeneration: 1,
          output: expect.objectContaining({
            occurrenceId: command.context.occurrenceId,
            result: { delivered: true },
            status: "succeeded",
          }),
          type: "runner.trigger-result",
        }),
      ]);

      await expect(runtime.handleCommand(command, sink)).resolves.toEqual({ status: "accepted" });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      expect(executions).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("immediately aborts an active Trigger program when the Host revokes its authority", async () => {
    const registry = new HarnessRegistry();
    const environmentId = createId("environment");
    const seedCommand = triggerCommand(environmentId);
    const observedSignals: AbortSignal[] = [];
    const runtime = runtimeWithLeaseGrants({
      agentSkills: testAgentSkills,
      bootId: "boot-trigger-revocation-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: testDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      integrationSkills: noIntegrationSkills,
      maxConcurrentRuns: 1,
      dataDirectory: dirname(testPrivateStateRoot),
      privateStateDirectory: testPrivateStateRoot,
      programExecutor: {
        execute: async ({ context, signal }) => {
          observedSignals.push(signal);
          await new Promise<void>((resolvePromise) =>
            signal.addEventListener("abort", () => resolvePromise(), { once: true }),
          );
          return {
            completedAt: new Date().toISOString(),
            error: "Trigger program was canceled",
            exitCode: null,
            occurrenceId: context.occurrenceId,
            result: null,
            status: "canceled",
            stderr: "",
            stdout: "",
          };
        },
      },
      projectContinuationIdentity,
      workspaceManager: {
        writableRoots: () => ["/runner/workspaces"],
        prepare: async () => ({
          instructions: undefined,
          path: "/runner/triggers/test/workspace",
        }),
      },
    });
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };
    try {
      for (let index = 0; index < 3; index += 1) {
        const commandId = createId("command");
        const command =
          index === 0
            ? seedCommand
            : {
                ...seedCommand,
                commandId,
                correlationId: CorrelationIdSchema.parse(commandId),
              };
        await expect(runtime.handleCommand(command, sink)).resolves.toEqual({
          status: "accepted",
        });
        await waitUntil(() => observedSignals.length === index + 1);
        const interruptId = createId("command");
        await expect(
          runtime.handleCommand(
            RunnerCommandSchema.parse({
              commandId: interruptId,
              correlationId: CorrelationIdSchema.parse(interruptId),
              environmentId,
              occurrenceId: command.context.occurrenceId,
              type: "trigger.interrupt",
            }),
            sink,
          ),
        ).resolves.toEqual({ status: "accepted" });
        expect(observedSignals[index]?.aborted).toBe(true);
        await waitUntil(() => runtime.activeTriggerOccurrenceIds().length === 0);
      }
      expect(messages.filter((message) => message.type === "runner.trigger-result")).toHaveLength(
        3,
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          output: expect.objectContaining({ status: "canceled" }),
          type: "runner.trigger-result",
        }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("does not retain tombstones for missing execution interrupts", async () => {
    const registry = new HarnessRegistry();
    const environmentId = createId("environment");
    const run = executeCommand(environmentId);
    const trigger = triggerCommand(environmentId);
    let workspacePreparations = 0;
    let triggerExecutions = 0;
    const runtime = runtimeWithLeaseGrants({
      agentSkills: testAgentSkills,
      bootId: "boot-cancellation-reordering-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: testDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      integrationSkills: noIntegrationSkills,
      maxConcurrentRuns: 2,
      dataDirectory: dirname(testPrivateStateRoot),
      privateStateDirectory: testPrivateStateRoot,
      programExecutor: {
        execute: async () => {
          triggerExecutions += 1;
          throw new Error("Canceled Trigger must not execute");
        },
      },
      projectContinuationIdentity,
      workspaceManager: {
        writableRoots: () => ["/runner/workspaces"],
        prepare: async () => {
          workspacePreparations += 1;
          throw new Error("Canceled execution must not prepare a Workspace");
        },
      },
    });
    const sink: RunnerMessageSink = { send: async () => undefined };
    try {
      for (let index = 0; index < 100; index += 1) {
        const runInterruptId = createId("command");
        const triggerInterruptId = createId("command");
        await expect(
          runtime.handleCommand(
            RunnerCommandSchema.parse({
              commandId: runInterruptId,
              correlationId: CorrelationIdSchema.parse(runInterruptId),
              environmentId,
              runId: run.context.runId,
              threadId: run.context.threadId,
              type: "run.interrupt",
            }),
            sink,
          ),
        ).resolves.toEqual({ status: "accepted" });
        await expect(
          runtime.handleCommand(
            RunnerCommandSchema.parse({
              commandId: triggerInterruptId,
              correlationId: CorrelationIdSchema.parse(triggerInterruptId),
              environmentId,
              occurrenceId: trigger.context.occurrenceId,
              type: "trigger.interrupt",
            }),
            sink,
          ),
        ).resolves.toEqual({ status: "accepted" });
      }

      await expect(runtime.handleCommand(run, sink)).resolves.toMatchObject({
        error: { code: "not_found", message: expect.stringContaining("unavailable") },
        status: "rejected",
      });
      const triggerRetryId = createId("command");
      await expect(
        runtime.handleCommand(
          {
            ...trigger,
            commandId: triggerRetryId,
            context: {
              ...trigger.context,
              workspaceAccess: {
                ...trigger.context.workspaceAccess,
                workspaceId: createId("workspace"),
              },
            },
            correlationId: CorrelationIdSchema.parse(triggerRetryId),
          },
          sink,
        ),
      ).resolves.toMatchObject({
        error: {
          code: "forbidden",
          message: "Trigger Workspace access plan does not match its context",
        },
        status: "rejected",
      });
      expect(workspacePreparations).toBe(0);
      expect(triggerExecutions).toBe(0);
      expect(runtime.activeRunIds()).toEqual([]);
      expect(runtime.activeTriggerOccurrenceIds()).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("normalizes a run, fences its session, and emits terminal status", async () => {
    const driver = new FakeHarnessDriver();
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);

    let mounts = 0;
    const workspaceManager = {
      writableRoots: () => ["/runner/workspaces"],
      prepare: async () => {
        mounts += 1;
        return {
          instructions: "Be precise.",
          path: "/runner/runs/test/workspace",
        };
      },
    };
    const environmentId = createId("environment");
    const runtime = runtimeWithLeaseGrants({
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      integrationSkills: noIntegrationSkills,
      bootId: "boot-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: testDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      maxConcurrentRuns: 1,
      dataDirectory: dirname(testPrivateStateRoot),
      privateStateDirectory: testPrivateStateRoot,
      projectContinuationIdentity,
      workspaceManager,
    });
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = {
      send: async (message) => {
        messages.push(message);
      },
    };
    const command = executeCommand(environmentId);
    await reconcile(registry, command);

    await expect(runtime.handleCommand(command, sink)).resolves.toEqual({ status: "accepted" });
    await waitUntil(() => runtime.activeRunIds().length === 0);

    expect(mounts).toBe(1);
    expect(driver.context?.instructions).toBe("Be precise.");
    expect(command.context.workspaceAccess.kind).toBe("portablefs");
    const exchangeToken =
      command.context.workspaceAccess.kind === "portablefs"
        ? command.context.workspaceAccess.exchangeToken
        : "unexpected-local-plan";
    expect(Object.values(driver.context?.environment ?? {})).not.toContain(exchangeToken);
    expect(driver.context?.environment.OPENSTEER_AGENT_WORKSPACE).toBe(
      "/runner/runs/test/workspace",
    );
    expect(driver.context?.environment.OPENSTEER_BROWSER_CDP_WS).toMatch(
      /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9_-]+$/u,
    );
    expect(driver.context?.environment.OPENSTEER_BROWSER_HARNESS).toBe(
      testBrowserHarnessExecutable,
    );
    expect(driver.context?.environment.PATH).toBe(process.env.PATH);
    expect(messages[0]).toMatchObject({
      bindingGeneration: command.context.bindingGeneration,
      type: "runner.session-bound",
    });
    const events = messages.flatMap((message) =>
      message.type === "runner.event" ? [message.event] : [],
    );
    expect(events.map((event) => [event.ordinal, event.type])).toEqual([
      [0, "run.started"],
      [1, "assistant.message"],
      [2, "run.completed"],
    ]);

    await expect(runtime.handleCommand(command, sink)).resolves.toEqual({ status: "accepted" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(mounts).toBe(1);
    await runtime.close();
  });

  it.each([
    ["personal local-directory", testPersonalDeploymentShape],
    ["server local-directory", testDeploymentShape],
    ["server portablefs", testPortableDeploymentShape],
  ] as const)("binds an exact resumed provider session on %s", async (_name, deploymentShape) => {
    const reference = "existing-provider-session";
    const session = new ReferenceHarnessSession(reference);
    const driver = new FakeHarnessDriver("test-driver", () => session);
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ deploymentShape, environmentId, registry });
    const command = resumedExecuteCommand(executeCommand(environmentId), reference);
    const messages: RunnerOperationalReport[] = [];

    try {
      await reconcile(registry, command);
      await runtime.handleCommand(command, {
        send: async (message) => void messages.push(message),
      });
      await waitUntil(() => runtime.activeRunIds().length === 0);

      expect(driver.resumedReferences).toEqual([reference]);
      expect(session.executions).toBe(1);
      expect(messages).toContainEqual(
        expect.objectContaining({
          providerSessionReference: reference,
          type: "runner.session-bound",
        }),
      );
      expect(hasEvent(messages, "run.completed")).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it.each([
    ["personal local-directory", testPersonalDeploymentShape],
    ["server local-directory", testDeploymentShape],
    ["server portablefs", testPortableDeploymentShape],
  ] as const)(
    "rejects a changed resumed provider session without executing on %s",
    async (_name, deploymentShape) => {
      const requested = "existing-provider-session";
      const session = new ReferenceHarnessSession("different-provider-session");
      const driver = new FakeHarnessDriver("test-driver", () => session);
      const registry = new HarnessRegistry();
      registry.registerDriver(driver);
      const environmentId = createId("environment");
      const runtime = configuredRuntime({ deploymentShape, environmentId, registry });
      const command = resumedExecuteCommand(executeCommand(environmentId), requested);
      const messages: RunnerOperationalReport[] = [];

      try {
        await reconcile(registry, command);
        await runtime.handleCommand(command, {
          send: async (message) => void messages.push(message),
        });
        await waitUntil(() => runtime.activeRunIds().length === 0);

        expect(driver.resumedReferences).toEqual([requested]);
        expect(session.executions).toBe(0);
        expect(session.stopped).toBe(true);
        expect(messages.some((message) => message.type === "runner.session-bound")).toBe(false);
        const failures = messages.filter(
          (message) => message.type === "runner.event" && message.event.type === "run.failed",
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          event: { data: { message: "AI engine resumed a different provider session" } },
        });
      } finally {
        await runtime.close();
      }
    },
  );

  it("gives local Claude the shared local-authenticated, Opensteer-only runtime boundary", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-claude-state-test-"));
    const stateRoot = join(temporaryRoot, "private", "harness-state");
    const claudeConfigDirectory = join(temporaryRoot, "existing-claude-login");
    const previousClaudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    const previousExtraCaCertificates = process.env.NODE_EXTRA_CA_CERTS;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDirectory;
    process.env.NODE_EXTRA_CA_CERTS = "/control-ca/root.crt";
    const driver = new FakeHarnessDriver("claude", undefined, ["CLAUDE_CONFIG_DIR"]);
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = runtimeWithLeaseGrants({
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      integrationSkills: noIntegrationSkills,
      bootId: "boot-claude-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: testDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      maxConcurrentRuns: 1,
      dataDirectory: dirname(stateRoot),
      privateStateDirectory: stateRoot,
      projectContinuationIdentity,
      workspaceManager: {
        writableRoots: () => ["/runner/workspaces"],
        prepare: async () => ({
          instructions: undefined,
          path: "/runner/runs/claude/workspace",
        }),
      },
    });
    const command = executeCommand(environmentId, "claude");
    await reconcile(registry, command);
    const sink: RunnerMessageSink = { send: async () => undefined };
    try {
      await expect(runtime.handleCommand(command, sink)).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => runtime.activeRunIds().length === 0);
      expect(driver.context?.environment.OPENSTEER_RUNNER_STATE_DIR).toBeUndefined();
      expect(driver.context?.environment.CLAUDE_CONFIG_DIR).toBe(claudeConfigDirectory);
      expect(driver.context?.environment.NODE_EXTRA_CA_CERTS).toBe("/control-ca/root.crt");
      expect(driver.context?.runtimeBoundary).toEqual({ kind: "native-user" });
    } finally {
      if (previousClaudeConfigDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDirectory;
      if (previousExtraCaCertificates === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previousExtraCaCertificates;
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("resolves the bundled, integration, and Workspace Agent Skill layers into one plan", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opensteer-skill-layer-test-"));
    const workspacePath = join(temporaryRoot, "workspace");
    const stateRoot = join(temporaryRoot, "private", "harness-state");
    await writeWorkspaceSkill(workspacePath, "release-notes");
    await writeWorkspaceSkill(workspacePath, "research");
    await writeWorkspaceSkill(workspacePath, "opensteer-threads");
    const driver = new FakeHarnessDriver();
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const logged: string[] = [];
    const runtime = runtimeWithLeaseGrants({
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      bootId: "boot-skill-layer-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: testDeploymentShape,
      environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnesses: registry,
      integrationSkills: async () => ({
        cleanup: async () => undefined,
        digest: "example",
        directory: "/state/integration-skills/example",
        skills: [
          { name: "research", path: "/state/integration-skills/example/research" },
          { name: "example-helper", path: "/state/integration-skills/example/helper" },
        ],
      }),
      logger: {
        error: () => undefined,
        info: (message) => void logged.push(message),
      },
      maxConcurrentRuns: 1,
      dataDirectory: dirname(stateRoot),
      privateStateDirectory: stateRoot,
      projectContinuationIdentity,
      workspaceManager: {
        writableRoots: () => ["/runner/workspaces"],
        prepare: async () => ({
          instructions: undefined,
          path: workspacePath,
        }),
      },
    });
    const sink: RunnerMessageSink = { send: async () => undefined };
    try {
      const command = executeCommand(environmentId);
      await reconcile(registry, command);
      await expect(runtime.handleCommand(command, sink)).resolves.toEqual({
        status: "accepted",
      });
      await waitUntil(() => runtime.activeRunIds().length === 0);

      expect(driver.context?.providerState.privateStateRoot).toBe(dirname(stateRoot));
      expect(driver.context?.skills?.skills).toEqual([
        {
          name: "opensteer-specialization",
          path: "/runner/agent-skills/skills/opensteer-specialization",
        },
        {
          name: "opensteer-integrations",
          path: "/runner/agent-skills/skills/opensteer-integrations",
        },
        {
          name: "opensteer-computer-use",
          path: "/runner/agent-skills/skills/opensteer-computer-use",
        },
        { name: "opensteer-browser", path: "/runner/agent-skills/skills/opensteer-browser" },
        { name: "opensteer-computers", path: "/runner/agent-skills/skills/opensteer-computers" },
        { name: "opensteer-threads", path: "/runner/agent-skills/skills/opensteer-threads" },
        { name: "opensteer-triggers", path: "/runner/agent-skills/skills/opensteer-triggers" },
        {
          name: "example-helper",
          path: "/state/integration-skills/example/helper",
        },
        { name: "release-notes", path: join(workspacePath, "skills", "release-notes") },
        { name: "research", path: join(workspacePath, "skills", "research") },
      ]);
      expect(logged).toEqual([
        "Workspace skill opensteer-threads was skipped: the opensteer- prefix is reserved for the skills Opensteer ships",
      ]);
    } finally {
      await runtime.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("routes approval and structured input resolutions to the active harness session", async () => {
    const driver = new FakeHarnessDriver(
      "interactive-driver",
      (context) => new InteractiveHarnessSession(context),
    );
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({
      environmentId,
      registry,
    });
    const execute = executeCommand(environmentId, "interactive-driver");
    await reconcile(registry, execute);
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = {
      send: async (message) => {
        messages.push(message);
      },
    };
    try {
      await expect(runtime.handleCommand(execute, sink)).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => hasEvent(messages, "request.opened"));
      await expect(
        runtime.handleCommand(
          RunnerCommandSchema.parse({
            commandId: createId("command"),
            correlationId: CorrelationIdSchema.parse("approval-test"),
            environmentId,
            requestId: testApprovalRequestId,
            response: { kind: "choice", optionId: "allow" },
            runId: execute.context.runId,
            type: "request.resolve",
          }),
          sink,
        ),
      ).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => eventCount(messages, "request.opened") === 2);
      await expect(
        runtime.handleCommand(
          RunnerCommandSchema.parse({
            commandId: createId("command"),
            correlationId: CorrelationIdSchema.parse("input-test"),
            environmentId,
            requestId: testInputRequestId,
            response: { answers: { confirmation: ["yes"] }, kind: "form" },
            runId: execute.context.runId,
            type: "request.resolve",
          }),
          sink,
        ),
      ).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => runtime.activeRunIds().length === 0);
      expect(
        messages.flatMap((message) =>
          message.type === "runner.event" ? [message.event.type] : [],
        ),
      ).toEqual(["run.started", "request.opened", "request.opened", "run.completed"]);
    } finally {
      await runtime.close();
    }
  });

  it("reserves a terminal event when a harness exceeds the per-Run event budget", async () => {
    const driver = new FakeHarnessDriver("flood-driver", () => new FloodHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({
      environmentId,
      maxRunEvents: 4,
      registry,
    });
    const messages: RunnerOperationalReport[] = [];
    try {
      const execute = executeCommand(environmentId, "flood-driver");
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, {
        send: async (message) => {
          messages.push(message);
        },
      });
      await waitUntil(() => runtime.activeRunIds().length === 0);
      const events = messages.flatMap((message) =>
        message.type === "runner.event" ? [message.event] : [],
      );
      expect(events.map(({ ordinal, type }) => [ordinal, type])).toEqual([
        [0, "run.started"],
        [1, "run.status"],
        [2, "run.failed"],
      ]);
      expect(events.at(-1)).toMatchObject({
        data: { message: expect.stringContaining("per-Run event budget") },
      });
    } finally {
      await runtime.close();
    }
  });

  it("keeps room for a Run's usage statement beside its terminal event", async () => {
    // The reserve is two events, not one: a driver that reports usage does so
    // after its last ordinary event and before the terminal one, and the
    // budget must never turn that pair into a failure at its own edge.
    const driver = new FakeHarnessDriver("usage-edge-driver", () => new UsageEdgeHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, maxRunEvents: 4, registry });
    const messages: RunnerOperationalReport[] = [];
    try {
      const execute = executeCommand(environmentId, "usage-edge-driver");
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, {
        send: async (message) => {
          messages.push(message);
        },
      });
      await waitUntil(() => runtime.activeRunIds().length === 0);
      const events = messages.flatMap((message) =>
        message.type === "runner.event" ? [message.event] : [],
      );
      expect(events.map(({ ordinal, type }) => [ordinal, type])).toEqual([
        [0, "run.started"],
        [1, "run.status"],
        [2, "run.usage"],
        [3, "run.completed"],
      ]);
    } finally {
      await runtime.close();
    }
  });

  it(
    "bounds each tool's live deltas without dropping its authoritative completion",
    { timeout: 30_000 },
    async () => {
      const driver = new FakeHarnessDriver(
        "large-tool-output-driver",
        () => new LargeToolOutputHarnessSession(),
      );
      const registry = new HarnessRegistry();
      registry.registerDriver(driver);
      const environmentId = createId("environment");
      const runtime = configuredRuntime({ environmentId, registry });
      const messages: RunnerOperationalReport[] = [];
      try {
        const execute = executeCommand(environmentId, "large-tool-output-driver");
        await reconcile(registry, execute);
        await runtime.handleCommand(execute, {
          send: async (message) => void messages.push(message),
        });
        await waitUntil(() => runtime.activeRunIds().length === 0);
        const events = messages.flatMap((message) =>
          message.type === "runner.event" ? [message.event] : [],
        );
        // Live text and durable events share one ordered connection, so a tool's
        // progress is read from the frames sent before and after its completion.
        const firstCompletion = messages.findIndex(
          (message) =>
            message.type === "runner.event" &&
            message.event.type === "tool.completed" &&
            message.event.data.callId === "call-1",
        );
        const liveToolText = (sent: readonly RunnerOperationalReport[]) =>
          sent
            .flatMap((message) =>
              message.type === "runner.live"
                ? message.progress.items.flatMap((item) =>
                    item.stream === "tool" && item.callId === "call-1" && item.op === "append"
                      ? [item.text]
                      : [],
                  )
                : [],
            )
            .join("");
        const firstLiveText = liveToolText(messages.slice(0, firstCompletion));

        expect(utf8ByteLength(firstLiveText)).toBeLessThanOrEqual(toolOutputTextMaxBytes);
        expect(firstLiveText).toContain("additional live output omitted");
        expect(firstLiveText).not.toContain("NEVER-EMITTED");
        expect(messages[firstCompletion]).toMatchObject({
          event: {
            data: { callId: "call-1", output: { text: "authoritative final output" } },
            type: "tool.completed",
          },
        });
        expect(liveToolText(messages.slice(firstCompletion + 1))).toBe("fresh lifecycle");
        expect(events.map(({ ordinal }) => ordinal)).toEqual(events.map((_, index) => index));
        expect(events.at(-1)?.type).toBe("run.completed");
      } finally {
        await runtime.close();
      }
    },
  );

  it("keeps an interrupted answer in the durable record even when it is long in bytes", async () => {
    const driver = new FakeHarnessDriver("hangul-driver", () => new HangulStreamHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };
    try {
      const execute = executeCommand(environmentId, "hangul-driver");
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, sink);
      await waitUntil(() => messages.some((message) => message.type === "runner.live"));
      const interruptId = createId("command");
      await runtime.handleCommand(
        RunnerCommandSchema.parse({
          commandId: interruptId,
          correlationId: CorrelationIdSchema.parse(interruptId),
          environmentId,
          runId: execute.context.runId,
          threadId: execute.context.threadId,
          type: "run.interrupt",
        }),
        sink,
      );
      await waitUntil(() => runtime.activeRunIds().length === 0);
      const types = messages.flatMap((message) =>
        message.type === "runner.event" ? [message.event.type] : [],
      );
      // 120,000 Hangul characters are 360 KB of UTF-8, past a message's durable
      // limit; the answer is kept, cut to fit, rather than lost with no record.
      expect(types).toContain("assistant.message");
      expect(types.indexOf("assistant.message")).toBeLessThan(types.indexOf("run.interrupted"));
    } finally {
      await runtime.close();
    }
  });

  it("records an interrupted answer as well-formed text however its tail was cut", async () => {
    const driver = new FakeHarnessDriver("emoji-driver", () => new EmojiStreamHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };
    try {
      const execute = executeCommand(environmentId, "emoji-driver");
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, sink);
      await waitUntil(() => messages.some((message) => message.type === "runner.live"));
      const interruptId = createId("command");
      await runtime.handleCommand(
        RunnerCommandSchema.parse({
          commandId: interruptId,
          correlationId: CorrelationIdSchema.parse(interruptId),
          environmentId,
          runId: execute.context.runId,
          threadId: execute.context.threadId,
          type: "run.interrupt",
        }),
        sink,
      );
      await waitUntil(() => runtime.activeRunIds().length === 0);
      // PostgreSQL refuses half of a surrogate pair, so no durable text may hold one.
      const recorded = messages.flatMap((message) =>
        message.type === "runner.event" && message.event.type === "assistant.message"
          ? message.event.data.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.isWellFormed()).toBe(true);
      const streamed = messages.flatMap((message) =>
        message.type === "runner.live" ? message.progress.items.map((item) => item.text) : [],
      );
      expect(streamed.every((text) => text.isWellFormed())).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("completes a Run whose engine reports a reasoning block too long for one event", async () => {
    const driver = new FakeHarnessDriver(
      "long-reasoning-driver",
      () => new LongReasoningHarnessSession(),
    );
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const messages: RunnerOperationalReport[] = [];
    try {
      const execute = executeCommand(environmentId, "long-reasoning-driver");
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, {
        send: async (message) => void messages.push(message),
      });
      await waitUntil(() => runtime.activeRunIds().length === 0);
      const events = messages.flatMap((message) =>
        message.type === "runner.event" ? [message.event] : [],
      );
      expect(events.at(-1)?.type).toBe("run.completed");
      const reasoning = events.find((event) => event.type === "reasoning.completed");
      expect(reasoning).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(reasoning), "utf8")).toBeLessThanOrEqual(
        pendingAgentEventMaxSerializedBytes,
      );
    } finally {
      await runtime.close();
    }
  });

  /*
   * What an engine reports is fitted to the durable limits before it leaves:
   * - one text part longer than a part may be (256 Ki units) though small in bytes;
   * - many parts whose JSON structure is what pushes the whole past its bytes;
   * - an interrupted answer long in units, not bytes;
   * - reasoning cut for length, which must say it was cut.
   * Each would otherwise fail validation, and with it the whole Run.
   */
  it("fits whatever an engine reports to the durable limits and says what it cut", async () => {
    const reported: HarnessEvent[] = [
      {
        data: {
          content: [{ text: "a".repeat(300_000), type: "text" }],
          messageId: createId("message"),
        },
        type: "assistant.message",
      },
      {
        data: {
          messageId: createId("message"),
          content: Array.from({ length: 64 }, () => ({
            text: "b".repeat(6_000),
            type: "text" as const,
          })),
        },
        type: "assistant.message",
      },
      { data: { blockId: "thinking-1", text: "c".repeat(310_000) }, type: "reasoning.completed" },
    ];
    const events = await eventsOfScriptedRun(new ScriptedHarnessSession(reported));
    expect(events.at(-1)?.type).toBe("run.completed");
    const messages = events.filter((event) => event.type === "assistant.message");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(() => MessageContentSchema.parse(message.data.content)).not.toThrow();
    }
    expect(messages[0]!.data.content[0]).toMatchObject({ text: expect.stringMatching(/…$/) });
    const reasoning = events.find((event) => event.type === "reasoning.completed");
    expect(reasoning?.data.text).toMatch(/…$/);
    for (const event of events) expect(() => PendingAgentEventSchema.parse(event)).not.toThrow();
  });

  describe("durable engine event fitting edge cases", () => {
    /*
     * Fitting can fail by counting UTF-16/raw text instead of escaped JSON bytes;
     * cutting short routing/path siblings along with a huge command; flattening
     * nested edits unnecessarily or losing keys; splitting UTF-8 characters or
     * retaining lone surrogates; keeping bulk row/object structure too broad for
     * the budget; failing to fall back for broad top-level records/arrays;
     * changing already-small JSON values; taking too long on multi-MiB inputs;
     * dropping a restated call; rejecting oversized approval titles/details or
     * form prompts, or breaking their resolution; and dropping a terminal error
     * (engine-reported or Runner-generated) instead of fitting its message.
     */
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    const command = `python HEAD:${"x".repeat(1_024 * 1_024)}:TAIL`;
    const toolRef = `google-sheets.spreadsheets.values.batchUpdate.${"a".repeat(82)}`;
    const bulk = {
      spreadsheetId: "x",
      values: Array.from({ length: 5_000 }, (_, row) => [`row-${row}`, "short", "cell"]),
    };
    const unicode = `HEAD 漢😀\ud800:${"漢字😀".repeat(30_000)}:末尾😀 TAIL`;
    const escaped = `HEAD:${'"\\\n\u0001'.repeat(50_000)}:TAIL`;
    const edits = Array.from({ length: 40 }, () => ({
      old_string: `OLD:${"o".repeat(20_000)}:END-OLD`,
      new_string: `NEW:${"n".repeat(20_000)}:END-NEW`,
    }));
    const broadRecord = Object.fromEntries(
      Array.from({ length: 30_000 }, (_, index) => [`key-${index}`, index]),
    );
    const broadArray = Array.from({ length: 100_000 }, (_, index) => index);
    const eightMiB = `HEAD:${"x".repeat(8 * 1_024 * 1_024)}:TAIL`;
    const longRows = Array.from({ length: 1_000 }, (_, row) => `row-${row}:${"r".repeat(2_000)}`);

    function expectCut(value: unknown, original: string): void {
      const text = z.string().parse(value);
      const match = /^(.*?)\n… (\d+) bytes omitted …\n(.*?)$/s.exec(text);
      expect(match).not.toBeNull();
      const [, head, omitted, tail] = match!;
      expect(head!.length).toBeGreaterThan(0);
      expect(tail!.length).toBeGreaterThan(0);
      expect(original.toWellFormed().startsWith(head!)).toBe(true);
      expect(original.toWellFormed().endsWith(tail!)).toBe(true);
      expect(Number(omitted)).toBeGreaterThan(0);
      expect(Number(omitted)).toBe(
        utf8ByteLength(original) - utf8ByteLength(head!) - utf8ByteLength(tail!),
      );
      expect(text.isWellFormed()).toBe(true);
    }

    function expectDurableRun(
      events: Awaited<ReturnType<typeof eventsOfScriptedRun>>,
      terminal: "run.completed" | "run.failed" = "run.completed",
    ): void {
      expect(events.at(-1)?.type).toBe(terminal);
      expect(events.filter((event) => event.type === terminal)).toHaveLength(1);
      for (const event of events) {
        expect(() => PendingAgentEventSchema.parse(event)).not.toThrow();
        expect(bytes(event)).toBeLessThanOrEqual(pendingAgentEventMaxSerializedBytes);
      }
    }

    const cases: {
      readonly name: string;
      readonly arguments: unknown;
      readonly check: (value: unknown) => void;
      readonly integration?: true;
      readonly restated?: true;
      readonly timed?: true;
    }[] = [
      {
        name: "one MiB command preserves short siblings",
        arguments: { command, cwd: "/workspace", path: "/workspace/main.py" },
        check: (value) => {
          const fitted = z
            .object({ command: z.string(), cwd: z.string(), path: z.string() })
            .parse(value);
          expect(fitted.cwd).toBe("/workspace");
          expect(fitted.path).toBe("/workspace/main.py");
          expectCut(fitted.command, command);
        },
      },
      {
        name: "forty medium edits retain their nested shape",
        arguments: { file_path: "/workspace/main.ts", edits },
        check: (value) => {
          const fitted = z
            .object({
              file_path: z.string(),
              edits: z.array(z.strictObject({ old_string: z.string(), new_string: z.string() })),
            })
            .parse(value);
          expect(fitted.file_path).toBe("/workspace/main.ts");
          expect(fitted.edits).toHaveLength(edits.length);
          for (const [index, edit] of fitted.edits.entries()) {
            expectCut(edit.old_string, edits[index]!.old_string);
            expectCut(edit.new_string, edits[index]!.new_string);
          }
          expect(
            new Set(
              fitted.edits.flatMap((edit) => [edit.old_string.length, edit.new_string.length]),
            ).size,
          ).toBe(1);
        },
      },
      {
        name: "escaped text respects serialized JSON bytes",
        arguments: { command: escaped },
        check: (value) =>
          expectCut(z.object({ command: z.string() }).parse(value).command, escaped),
      },
      {
        name: "CJK emoji and a lone surrogate remain well formed",
        arguments: { command: unicode },
        check: (value) =>
          expectCut(z.object({ command: z.string() }).parse(value).command, unicode),
      },
      {
        name: "bulk integration preserves its 128 character toolRef",
        arguments: { toolRef, arguments: bulk },
        integration: true,
        check: (value) => {
          expect(toolRef).toHaveLength(128);
          const fitted = z.object({ toolRef: z.string(), arguments: z.string() }).parse(value);
          expect(fitted.toolRef).toBe(toolRef);
          expectCut(fitted.arguments, JSON.stringify(bulk));
        },
      },
      ...[
        { name: "thirty thousand top-level keys", arguments: broadRecord },
        { name: "one hundred thousand top-level numbers", arguments: broadArray },
      ].map((testCase) => ({
        ...testCase,
        check: (value: unknown) => expectCut(value, JSON.stringify(testCase.arguments)),
      })),
      ...[
        {
          name: "object",
          arguments: { command: "pwd", cwd: "/workspace", nested: { enabled: true } },
        },
        { name: "string", arguments: "pwd" },
        { name: "number", arguments: 42 },
        { name: "null", arguments: null },
        { name: "array", arguments: ["short", 42, null, { path: "/workspace" }] },
        { name: "empty object", arguments: {} },
      ].map((testCase) => ({
        ...testCase,
        name: `already fitting ${testCase.name} stays unchanged`,
        check: (value: unknown) => expect(value).toEqual(testCase.arguments),
      })),
      {
        name: "eight MiB command fits within five seconds",
        arguments: { command: eightMiB, cwd: "/workspace", path: "main.py" },
        timed: true,
        check: (value) => {
          const fitted = z
            .object({ command: z.string(), cwd: z.string(), path: z.string() })
            .parse(value);
          expect(fitted.cwd).toBe("/workspace");
          expect(fitted.path).toBe("main.py");
          expectCut(fitted.command, eightMiB);
        },
      },
      {
        name: "many long rows never cut a short toolRef",
        arguments: { toolRef, arguments: { rows: longRows } },
        integration: true,
        check: (value) => {
          const fitted = z.object({ toolRef: z.string(), arguments: z.string() }).parse(value);
          expect(fitted.toolRef).toBe(toolRef);
          expectCut(fitted.arguments, JSON.stringify({ rows: longRows }));
        },
      },
      {
        name: "restated call records both the empty and huge input",
        arguments: { command, cwd: "/workspace" },
        restated: true,
        check: (value) => {
          const fitted = z.object({ command: z.string(), cwd: z.string() }).parse(value);
          expect(fitted.cwd).toBe("/workspace");
          expectCut(fitted.command, command);
        },
      },
    ];

    it.each(cases)("fits tool arguments: $name", async (testCase) => {
      const tool = testCase.integration
        ? { namespace: "opensteer.integrations", name: "integration_call" }
        : { namespace: "test", name: "shell" };
      const started = (args: unknown): HarnessEvent => ({
        data: { arguments: args, callId: "same-call", tool },
        type: "tool.started",
      });
      const script = [...(testCase.restated ? [started({})] : []), started(testCase.arguments)];
      const start = performance.now();
      const events = await eventsOfScriptedRun(new ScriptedHarnessSession(script));
      const elapsedMs = performance.now() - start;
      if (testCase.timed) {
        console.info(`8 MiB scripted Runner Run: ${elapsedMs.toFixed(1)} ms`);
        expect(elapsedMs).toBeLessThan(5_000);
      }
      expectDurableRun(events);
      const calls = events.filter((event) => event.type === "tool.started");
      expect(calls).toHaveLength(script.length);
      if (testCase.restated) expect(calls[0]!.data.arguments).toEqual({});
      for (const call of calls) {
        expect(call.data.callId).toBe("same-call");
        expect(call.data.tool).toEqual(tool);
        expect(bytes(call.data.arguments)).toBeLessThanOrEqual(toolArgumentsMaxSerializedBytes);
      }
      testCase.check(calls.at(-1)!.data.arguments);
    });

    it("records a subagent whose title is long in UTF-16 units", async () => {
      const title = "😀".repeat(121);
      const renamed = "🙂".repeat(121);
      const reported: HarnessEvent[] = [];
      const nodes = new SubagentNodes((event) => void reported.push(event));
      nodes.open("child", { title });
      nodes.update("child", { title: renamed });
      nodes.complete("child", "completed");
      const events = await eventsOfScriptedRun(new ScriptedHarnessSession(reported));
      expectDurableRun(events);
      const titles = events.flatMap((event) =>
        event.type === "node.started" || event.type === "node.updated"
          ? [event.data.title ?? ""]
          : [],
      );
      expect(titles).toEqual([title.slice(0, 240), renamed.slice(0, 240)]);
      expect(titles.every((shown) => shown.isWellFormed())).toBe(true);
    });

    it("resolves fitted approvals and forms and records engine and Runner failures", async () => {
      const detail = `COMMAND-HEAD:${"c".repeat(300_000)}:COMMAND-TAIL`;
      const prompt = `PROMPT-HEAD:${"p".repeat(50_000)}:PROMPT-TAIL`;
      const title = "T".repeat(400);
      const label = "L".repeat(200);
      const choiceText = `CHOICE-HEAD:${"d".repeat(3_000)}:CHOICE-TAIL`;
      const base: PendingRequest = {
        callId: "approval-call",
        cancellationReason: null,
        createdAt: new Date().toISOString(),
        id: createId("request"),
        kind: "harness.approval",
        mode: "live",
        originatingOccurrenceId: null,
        originatingRunId: createId("run"),
        originatingThreadId: createId("thread"),
        originatingWorkspaceId: createId("workspace"),
        payload: { kind: "harness.approval" },
        presentation: {
          detail,
          kind: "choice",
          options: [
            { hint: "allow-once", id: "allow", label: "Allow" },
            { description: choiceText, hint: "other", id: "explain", label },
          ],
          title,
        },
        requestedBy: createId("user"),
        requiredActor: "requester",
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
        targetWorkspaceId: createId("workspace"),
      };
      const form: PendingRequest = {
        ...base,
        callId: "input-call",
        id: createId("request"),
        kind: "harness.input",
        payload: { kind: "harness.input" },
        presentation: {
          fields: [
            {
              choices: [{ description: choiceText, label: choiceText, value: "yes" }],
              id: "confirmation",
              label,
              multiSelect: false,
              prompt,
              secret: false,
            },
          ],
          kind: "form",
          title: "Confirm input",
        },
      };
      const session = new ScriptedHarnessSession(
        [base, form].map((request) => ({ data: { request }, type: "request.opened" })),
        "await-requests",
      );
      const resolveRequest = vi.spyOn(session, "resolveRequest");
      const responses: { requestId: RequestId; response: RequestResponse }[] = [
        { requestId: base.id, response: { kind: "choice", optionId: "allow" } },
        { requestId: form.id, response: { answers: { confirmation: ["yes"] }, kind: "form" } },
      ];
      const events = await eventsOfScriptedRun(session, { resolveRequests: responses });
      expectDurableRun(events);
      const requests = events.filter((event) => event.type === "request.opened");
      expect(requests).toHaveLength(2);
      const choice = requests[0]!.data.request;
      expect(choice.id).toBe(base.id);
      expect(choice.presentation.title.length).toBeLessThanOrEqual(requestTitleMaxLength);
      expect(choice.presentation.title).toBe(`${title.slice(0, requestTitleMaxLength - 1)}…`);
      expect(choice.presentation.detail!.length).toBeLessThanOrEqual(requestTextMaxLength);
      expectCut(choice.presentation.detail, detail);
      if (choice.presentation.kind !== "choice") throw new Error("Expected the fitted choice");
      const explain = choice.presentation.options[1]!;
      expect(explain.id).toBe("explain");
      expect(explain.label).toBe(`${label.slice(0, requestLabelMaxLength - 1)}…`);
      expectCut(explain.description, choiceText);
      expect(explain.description!.length).toBeLessThanOrEqual(requestChoiceTextMaxLength);
      const input = requests[1]!.data.request;
      expect(input.id).toBe(form.id);
      expect(input.presentation.kind).toBe("form");
      if (input.presentation.kind !== "form") throw new Error("Expected the fitted form");
      expect(input.presentation.fields).toHaveLength(1);
      expect(input.presentation.fields[0]!.prompt.length).toBeLessThanOrEqual(requestTextMaxLength);
      expectCut(input.presentation.fields[0]!.prompt, prompt);
      const field = input.presentation.fields[0]!;
      expect(field.label).toBe(`${label.slice(0, requestLabelMaxLength - 1)}…`);
      const offered = field.choices![0]!;
      expect(offered.value).toBe("yes");
      expect(offered.label).toBe(`${choiceText.slice(0, requestChoiceTextMaxLength - 1)}…`);
      expectCut(offered.description, choiceText);
      expect(resolveRequest.mock.calls).toEqual(
        responses.map(({ requestId, response }) => [requestId, response]),
      );

      const message = `FAILURE-HEAD:${"f".repeat(100_000)}:FAILURE-TAIL`;
      for (const source of ["engine", "Runner"] as const) {
        const failedSession = new ScriptedHarnessSession(
          source === "engine"
            ? [
                {
                  data: { code: "engine_error", message, retryable: false, status: "failed" },
                  type: "run.failed",
                },
              ]
            : [],
        );
        if (source === "Runner")
          vi.spyOn(failedSession, "execute").mockRejectedValue(new Error(message));
        const failedEvents = await eventsOfScriptedRun(failedSession);
        expectDurableRun(failedEvents, "run.failed");
        expect(
          failedEvents.some((event) => event.type === "run.completed"),
          source,
        ).toBe(false);
        const failure = failedEvents.find((event) => event.type === "run.failed")!;
        expect(failure.data.code, `${source}: ${JSON.stringify(failure.data)}`).toBe(
          source === "engine" ? "engine_error" : "runner_execution_error",
        );
        expect(failure.data.message.length, source).toBeLessThanOrEqual(runFailureMessageMaxLength);
        expectCut(failure.data.message, message);
      }
    });
  });

  it("keeps an interrupted answer that is long in units within a message's limits", async () => {
    const session = new ScriptedHarnessSession(
      Array.from({ length: 300 }, () => ({
        data: { text: "d".repeat(1_000) },
        type: "assistant.delta" as const,
      })),
      "await-interrupt",
    );
    const events = await eventsOfScriptedRun(session, { interrupt: true });
    const message = events.find((event) => event.type === "assistant.message");
    expect(message).toBeDefined();
    expect(() => MessageContentSchema.parse(message!.data.content)).not.toThrow();
    expect(events.at(-1)?.type).toBe("run.interrupted");
  });

  it("hands the engine the requester's time zone the Host stated for the Run", async () => {
    const session = new RecordingHarnessSession();
    const driver = new FakeHarnessDriver("recording-driver", () => session);
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({ environmentId, registry });
    const base = executeCommand(environmentId, "recording-driver");
    const execute = {
      ...base,
      context: { ...base.context, requesterTimeZone: "America/New_York" },
    };
    const sink: RunnerMessageSink = { send: async () => undefined };
    try {
      await reconcile(registry, execute);
      await runtime.handleCommand(execute, sink);
      await waitUntil(() => session.turns.length === 1 && runtime.activeRunIds().length === 0);
      expect(session.turns[0]?.context).toEqual({
        assignment: null,
        requesterTimeZone: "America/New_York",
        threadState: { previousAssignment: null, previousRun: null },
      });
    } finally {
      await runtime.close();
    }
  });

  it("interrupts the active harness turn without detaching the workspace", async () => {
    const driver = new FakeHarnessDriver("blocking-driver", () => new BlockingHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const commands = Array.from({ length: 3 }, () =>
      executeCommand(environmentId, "blocking-driver"),
    );
    const listProcesses = vi.fn(async () => []);
    const detach = vi.fn(async () => undefined);
    const options = {
      environmentId,
      registry,
      // This harness lives entirely in memory. Real process-tree discovery
      // belongs to execution-containment.test.ts, not this interruption case.
      containment: new ExecutionContainment({
        bootId: "boot-control-test",
        dataDirectory: testPrivateStateRoot,
        listProcesses,
      }),
      workspaceMountRegistry: {
        detach,
        detachAll: async () => undefined,
        inventory: () =>
          commands.map(({ context }) => ({
            enrollmentId: "enrollment-1",
            volumeId: "workspace_volume",
            workspaceId: context.workspaceId,
          })),
      },
    };
    const runtime = configuredRuntime(options);
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = {
      send: async (message) => {
        messages.push(message);
      },
    };
    try {
      for (const execute of commands) {
        await reconcile(registry, execute);
        await expect(runtime.handleCommand(execute, sink)).resolves.toEqual({
          status: "accepted",
        });
        await waitUntil(() =>
          messages.some(
            (message) =>
              message.type === "runner.event" &&
              message.event.runId === execute.context.runId &&
              message.event.type === "run.started",
          ),
        );
        const interruptId = createId("command");
        await expect(
          runtime.handleCommand(
            RunnerCommandSchema.parse({
              commandId: interruptId,
              correlationId: CorrelationIdSchema.parse(interruptId),
              environmentId,
              runId: execute.context.runId,
              threadId: execute.context.threadId,
              type: "run.interrupt",
            }),
            sink,
          ),
        ).resolves.toEqual({ status: "accepted" });
        await waitUntil(() => runtime.activeRunIds().length === 0);
      }
      expect(eventCount(messages, "run.interrupted")).toBe(3);
      expect(listProcesses).toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("interrupts active Workspace users before detaching the machine mount", async () => {
    const driver = new FakeHarnessDriver("blocking-driver", () => new BlockingHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const command = executeCommand(environmentId, "blocking-driver");
    await reconcile(registry, command);
    const detach = vi.fn(async () => undefined);
    const runtime = configuredRuntime({
      environmentId,
      registry,
      workspaceMountRegistry: {
        detach,
        detachAll: async () => undefined,
        inventory: () => [
          {
            enrollmentId: "enrollment-1",
            volumeId: "workspace_volume",
            workspaceId: command.context.workspaceId,
          },
        ],
      },
    });
    const sink: RunnerMessageSink = { send: async () => undefined };
    try {
      await expect(runtime.handleCommand(command, sink)).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => driver.context !== undefined);
      await expect(
        runtime.handleCommand(
          RunnerCommandSchema.parse({
            commandId: createId("command"),
            correlationId: CorrelationIdSchema.parse("detach-active-workspace"),
            environmentId,
            type: "workspace.detach",
            volumeId: "workspace_volume",
            workspaceId: command.context.workspaceId,
          }),
          sink,
        ),
      ).resolves.toEqual({ status: "accepted" });
      expect(runtime.activeRunIds()).toEqual([]);
      expect(detach).toHaveBeenCalledWith(command.context.workspaceId);
    } finally {
      await runtime.close();
    }
  });

  it("injects a steer into the active turn and reports it as one ordered event", async () => {
    const session = new SteerableHarnessSession();
    const driver = new FakeHarnessDriver("steerable-driver", () => session);
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({
      environmentId,
      registry,
    });
    const execute = executeCommand(environmentId, "steerable-driver");
    await reconcile(registry, execute);
    const messages: RunnerOperationalReport[] = [];
    let failInjectedReceipt = false;
    const sink: RunnerMessageSink = {
      send: async (message) => {
        if (
          failInjectedReceipt &&
          message.type === "runner.event" &&
          message.event.type === "message.injected"
        ) {
          throw new Error("Receipt transport failed");
        }
        messages.push(message);
      },
    };
    const messageId = createId("message");
    try {
      await runtime.handleCommand(execute, sink);
      await waitUntil(() => hasEvent(messages, "run.started"));

      await expect(
        runtime.handleCommand(
          steerCommand(environmentId, {
            messageId,
            runId: execute.context.runId,
            threadId: execute.context.threadId,
          }),
          sink,
        ),
      ).resolves.toEqual({ status: "accepted" });
      await waitUntil(() => hasEvent(messages, "message.injected"));

      expect(session.steered).toEqual([
        {
          author: {
            displayName: "User",
            kind: "human",
            principalId: "principal:test",
          },
          content: [{ text: "Steered message", type: "text" }],
          createdAt: expect.any(String),
          kind: "input",
          messageId,
        },
      ]);
      const injected = messages.flatMap((message) =>
        message.type === "runner.event" && message.event.type === "message.injected"
          ? [message.event]
          : [],
      );
      expect(injected).toHaveLength(1);
      expect(injected[0]).toMatchObject({
        data: { messageId },
        ordinal: 1,
        runId: execute.context.runId,
      });

      await expect(
        runtime.handleCommand(
          steerCommand(environmentId, {
            messageId: createId("message"),
            runId: execute.context.runId,
            threadId: createId("thread"),
          }),
          sink,
        ),
      ).resolves.toMatchObject({ error: { code: "forbidden" }, status: "rejected" });

      await expect(
        runtime.handleCommand(
          steerCommand(environmentId, {
            messageId: createId("message"),
            runId: createId("run"),
            threadId: execute.context.threadId,
          }),
          sink,
        ),
      ).resolves.toMatchObject({ error: { code: "not_found" }, status: "rejected" });

      session.rejectNextSteer = true;
      await expect(
        runtime.handleCommand(
          steerCommand(environmentId, {
            messageId: createId("message"),
            runId: execute.context.runId,
            threadId: execute.context.threadId,
          }),
          sink,
        ),
      ).resolves.toMatchObject({
        error: { code: "conflict", message: "No steerable turn is active", retryable: false },
        status: "rejected",
      });
      expect(eventCount(messages, "message.injected")).toBe(1);

      failInjectedReceipt = true;
      await expect(
        runtime.handleCommand(
          steerCommand(environmentId, {
            messageId: createId("message"),
            runId: execute.context.runId,
            threadId: execute.context.threadId,
          }),
          sink,
        ),
      ).resolves.toEqual({ status: "accepted" });
      failInjectedReceipt = false;
      expect(session.steered).toHaveLength(2);
      // A send that failed costs nothing durable: the receipt waits in the
      // Run's journal and goes out with what the Run reports next.
      expect(eventCount(messages, "message.injected")).toBe(1);

      session.unknownNextSteer = true;
      await expect(
        runtime.handleCommand(
          steerCommand(environmentId, {
            messageId: createId("message"),
            runId: execute.context.runId,
            threadId: execute.context.threadId,
          }),
          sink,
        ),
      ).resolves.toMatchObject({
        message: "Steer delivery could not be confirmed",
        status: "uncertain",
      });
      expect(eventCount(messages, "message.injected")).toBe(1);
      await runtime.close();
      expect(eventCount(messages, "message.injected")).toBe(2);
      const ordinals = messages.flatMap((message) =>
        message.type === "runner.event" ? [message.event.ordinal] : [],
      );
      expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right));
    } finally {
      await runtime.close();
    }
  });

  it("rejects a steer for a harness that does not advertise steering", async () => {
    const driver = new FakeHarnessDriver("blocking-driver", () => new BlockingHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const runtime = configuredRuntime({
      environmentId,
      registry,
    });
    const execute = executeCommand(environmentId, "blocking-driver");
    await reconcile(registry, execute);
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = {
      send: async (message) => {
        messages.push(message);
      },
    };
    try {
      await runtime.handleCommand(execute, sink);
      await waitUntil(() => hasEvent(messages, "run.started"));
      await expect(
        runtime.handleCommand(
          steerCommand(environmentId, {
            messageId: createId("message"),
            runId: execute.context.runId,
            threadId: execute.context.threadId,
          }),
          sink,
        ),
      ).resolves.toMatchObject({
        error: { code: "conflict", message: "Harness does not support steering" },
        status: "rejected",
      });
      expect(hasEvent(messages, "message.injected")).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("accepts a local specialized Workspace plan without PortableFS mount segments", async () => {
    const driver = new FakeHarnessDriver("blocking-driver", () => new BlockingHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const targetWorkspaceId = createId("workspace");
    const preparedPlans: RunnerCommand["type"][] = [];
    const runtime = configuredRuntime({
      environmentId,
      registry,
      workspacePrepare: async (input) => {
        preparedPlans.push(
          input.plan.kind === "local-directory" ? "workspace.mount" : "run.execute",
        );
        return {
          instructions: undefined,
          path:
            input.plan.kind === "local-directory"
              ? `/Users/test/Opensteer/Workspaces/${targetWorkspaceId}`
              : "/Users/test/Opensteer/Workspaces/main",
        };
      },
    });
    const base = executeCommand(environmentId, "blocking-driver");
    const execute = RunnerCommandSchema.parse({
      ...base,
      context: {
        ...base.context,
        workspaceAccess: {
          ...base.context.workspaceAccess,
          createdBy: base.context.requestedBy,
          workspaceKind: "main",
        },
        workspaceKind: "main",
      },
    }) as Extract<RunnerCommand, { type: "run.execute" }>;
    const sink: RunnerMessageSink = { send: async () => undefined };
    await reconcile(registry, execute);
    try {
      await runtime.handleCommand(execute, sink);
      await waitUntil(() => driver.context !== undefined);
      const decision = await runtime.handleCommand(
        RunnerCommandSchema.parse({
          commandId: createId("command"),
          correlationId: CorrelationIdSchema.parse("local-workspace-attachment"),
          environmentId,
          plan: {
            bindingId: createId("workspaceBinding"),
            generation: 1,
            kind: "local-directory",
            ownerEnvironmentId: environmentId,
            storageAuthorityId: createId("storageAuthority"),
            workspaceId: targetWorkspaceId,
          },
          runId: execute.context.runId,
          threadId: execute.context.threadId,
          type: "workspace.mount",
          workspaceId: targetWorkspaceId,
        }),
        sink,
      );

      expect(decision).toEqual({
        status: "accepted",
        workspacePath: `/Users/test/Opensteer/Workspaces/${targetWorkspaceId}`,
      });
      expect(preparedPlans).toEqual(["run.execute", "workspace.mount"]);
    } finally {
      await runtime.close();
    }
  });

  it("lets Main attach a specialized Workspace already used by a child Run", async () => {
    const driver = new FakeHarnessDriver("blocking-driver", () => new BlockingHarnessSession());
    const registry = new HarnessRegistry();
    registry.registerDriver(driver);
    const environmentId = createId("environment");
    const child = executeCommand(environmentId, "blocking-driver");
    const mainBase = executeCommand(environmentId, "blocking-driver");
    const main = RunnerCommandSchema.parse({
      ...mainBase,
      context: {
        ...mainBase.context,
        workspaceAccess: {
          ...mainBase.context.workspaceAccess,
          createdBy: mainBase.context.requestedBy,
          workspaceKind: "main",
        },
        workspaceKind: "main",
      },
    }) as Extract<RunnerCommand, { type: "run.execute" }>;
    const prepared: string[] = [];
    const runtime = configuredRuntime({
      environmentId,
      maxConcurrentRuns: 2,
      registry,
      workspacePrepare: async ({ plan }) => {
        prepared.push(plan.workspaceId);
        return { instructions: undefined, path: `/workspaces/${plan.workspaceId}` };
      },
    });
    const sink: RunnerMessageSink = { send: async () => undefined };
    await reconcile(registry, child, main);
    try {
      await runtime.handleCommand(child, sink);
      await runtime.handleCommand(main, sink);
      await waitUntil(() => driver.contexts.length === 2);
      await expect(
        runtime.handleCommand(
          RunnerCommandSchema.parse({
            commandId: createId("command"),
            correlationId: CorrelationIdSchema.parse("main-attach-child-workspace"),
            environmentId,
            plan: child.context.workspaceAccess,
            runId: main.context.runId,
            threadId: main.context.threadId,
            type: "workspace.mount",
            workspaceId: child.context.workspaceId,
          }),
          sink,
        ),
      ).resolves.toEqual({
        status: "accepted",
        workspacePath: `/workspaces/${child.context.workspaceId}`,
      });
      expect(
        prepared.filter((workspaceId) => workspaceId === child.context.workspaceId),
      ).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it(
    "runs a production Personal turn over its co-located loopback Host transports",
    { timeout: 30_000 },
    async () => {
      const driver = new FakeHarnessDriver();
      const registry = new HarnessRegistry();
      registry.registerDriver(driver);
      const environmentId = createId("environment");
      const runtime = configuredRuntime({
        deploymentShape: testPersonalDeploymentShape,
        environmentId,
        mode: "production",
        registry,
      });
      const base = executeCommand(environmentId, "test-driver", "http://127.0.0.1:4310");
      const command = RunnerCommandSchema.parse({
        ...base,
        context: {
          ...base.context,
          workspaceAccess: {
            bindingId: createId("workspaceBinding"),
            generation: 1,
            kind: "local-directory",
            ownerEnvironmentId: environmentId,
            storageAuthorityId: createId("storageAuthority"),
            workspaceId: base.context.workspaceId,
          },
        },
      }) as Extract<RunnerCommand, { type: "run.execute" }>;
      const messages: RunnerOperationalReport[] = [];
      await reconcile(registry, command);
      try {
        await expect(
          runtime.handleCommand(command, { send: async (message) => void messages.push(message) }),
        ).resolves.toEqual({ status: "accepted" });
        await waitUntil(() => runtime.activeRunIds().length === 0);
        expect(messages).toContainEqual(
          expect.objectContaining({ event: expect.objectContaining({ type: "run.completed" }) }),
        );
        expect(messages).not.toContainEqual(
          expect.objectContaining({ event: expect.objectContaining({ type: "run.failed" }) }),
        );
      } finally {
        await runtime.close();
      }
    },
  );
});

describe("Runner runtime test waits", () => {
  let outsideTest: Promise<unknown> | undefined;
  beforeAll(() => {
    outsideTest = waitUntil(() => true).then(
      () => "waited",
      (error: unknown) => error,
    );
  });

  it("refuses to wait outside a test, where no test budget bounds it", async () => {
    expect(String(await outsideTest)).toContain("outside a test");
  });

  it("keeps waiting past two seconds of the test's clock while its budget remains", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let checks = 0;
      await waitUntil(() => {
        checks += 1;
        vi.setSystemTime(Date.now() + 2_001);
        return checks === 3;
      });
      expect(checks).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  let abandoned: { readonly polls: () => number; readonly ended: Promise<unknown> } | undefined;

  it.fails("fails at its test's deadline and then polls no more", { timeout: 100 }, async () => {
    let polls = 0;
    const waiting = waitUntil(() => {
      polls += 1;
      return false;
    });
    abandoned = {
      polls: () => polls,
      ended: waiting.then(
        () => "condition met",
        (error: unknown) => error,
      ),
    };
    await waiting;
  });

  // The deadline ends that test before it can watch its own wait end, so the
  // suite checks the wait once the test is over, whenever the test ran.
  afterAll(async () => {
    if (!abandoned) return;
    expect(String(await abandoned.ended)).toContain("Test timed out in 100ms");
    // Settling alone would not show the loop stopped; ten poll intervals must add no check.
    const polls = abandoned.polls();
    await delay(50);
    expect(abandoned.polls()).toBe(polls);
  });
});

const fakeHarnessCapabilities: HarnessCapabilities = {
  approvals: true,
  attachments: false,
  interruption: true,
  mcpImageContent: false,
  resume: true,
  steering: false,
  toolCalls: true,
  userInput: true,
};

const fakeHarnessAccessModes = ThreadAccessModeSchema.options;

/** One first-party source, the shape every runnable driver must declare. */
const fakeHarnessSources = [
  {
    fields: [],
    kind: "first-party",
    label: "Test source",
    quota: "none",
    sourceId: "test",
    stateKinds: ["ambient", "isolated"],
  },
] as const satisfies readonly HarnessSourceDescriptor[];

class FakeHarnessDriver implements HarnessDriver {
  readonly kind;
  readonly capabilities = fakeHarnessCapabilities;
  readonly accessModes = fakeHarnessAccessModes;
  readonly sources = fakeHarnessSources;
  readonly configSchema = z.strictObject({});
  readonly environmentVariables: readonly string[];
  /** Mirrors Codex: one native session store for every profile of this driver. */
  readonly providerStoreScope: HarnessProviderStoreScope = {
    kind: "driver-shared",
    nativeUserHome: { environmentVariable: "TEST_DRIVER_HOME", relativeHomePath: ".test-driver" },
  };
  readonly #sessionFactory: (context: HarnessSessionContext) => HarnessSession;
  context: HarnessSessionContext | undefined;
  readonly contexts: HarnessSessionContext[] = [];
  readonly resumedReferences: string[] = [];

  constructor(
    kind = "test-driver",
    sessionFactory: (context: HarnessSessionContext) => HarnessSession = () =>
      new FakeHarnessSession(),
    environmentVariables: readonly string[] = [],
  ) {
    this.kind = HarnessIdSchema.parse(kind);
    this.#sessionFactory = sessionFactory;
    this.environmentVariables = environmentVariables;
  }

  async create(input: { readonly instanceId: HarnessInstanceId }): Promise<HarnessAdapter> {
    return {
      capabilities: fakeHarnessCapabilities,
      close: async () => undefined,
      instanceId: input.instanceId,
      resumeSession: async (reference, context) => {
        this.context = context;
        this.contexts.push(context);
        this.resumedReferences.push(reference);
        return this.#sessionFactory(context);
      },
      startSession: async (context) => {
        this.context = context;
        this.contexts.push(context);
        return this.#sessionFactory(context);
      },
    };
  }
}

class InteractiveHarnessSession implements HarnessSession {
  readonly providerSessionReference = "interactive-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;
  readonly #approval = deferred<boolean>();
  readonly #context: HarnessSessionContext;
  readonly #input = deferred<Readonly<Record<string, readonly string[]>>>();

  constructor(context: HarnessSessionContext) {
    this.#context = context;
  }

  async execute(turn: HarnessRunInput): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    publish(this.#stream, {
      data: {
        request: {
          callId: "approval-test",
          cancellationReason: null,
          createdAt: new Date().toISOString(),
          id: testApprovalRequestId,
          kind: "harness.approval",
          mode: "live",
          originatingOccurrenceId: null,
          originatingRunId: turn.runId,
          originatingThreadId: this.#context.threadId,
          originatingWorkspaceId: this.#context.workspaceId,
          payload: { kind: "harness.approval" },
          presentation: {
            detail: "Allow the test action?",
            kind: "choice",
            options: [
              { hint: "reject-once", id: "reject", label: "Reject" },
              { hint: "allow-once", id: "allow", label: "Allow" },
            ],
            risk: "low",
            title: "Test approval",
          },
          requestedBy: turn.requestedBy,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: this.#context.workspaceId,
        },
      },
      type: "request.opened",
    });
    if (!(await this.#approval.promise)) return;
    publish(this.#stream, {
      data: {
        request: {
          callId: "input-test",
          cancellationReason: null,
          createdAt: new Date().toISOString(),
          id: testInputRequestId,
          kind: "harness.input",
          mode: "live",
          originatingOccurrenceId: null,
          originatingRunId: turn.runId,
          originatingThreadId: this.#context.threadId,
          originatingWorkspaceId: this.#context.workspaceId,
          payload: { kind: "harness.input" },
          presentation: {
            fields: [
              {
                id: "confirmation",
                multiSelect: false,
                prompt: "Continue?",
                secret: false,
              },
            ],
            kind: "form",
            title: "Input needed",
          },
          requestedBy: turn.requestedBy,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: this.#context.workspaceId,
        },
      },
      type: "request.opened",
    });
    await this.#input.promise;
    publish(this.#stream, { data: { status: "completed" }, type: "run.completed" });
  }

  async interrupt(): Promise<void> {}

  async resolveRequest(requestId: RequestId, response: RequestResponse): Promise<void> {
    if (requestId === testApprovalRequestId && response.kind === "choice") {
      this.#approval.resolve(response.optionId === "allow");
      return;
    }
    if (requestId === testInputRequestId && response.kind === "form") {
      this.#input.resolve(response.answers);
      return;
    }
    throw new Error("Request not found");
  }

  async stop(): Promise<void> {
    this.#stream.close();
  }
}

class BlockingHarnessSession implements HarnessSession {
  readonly providerSessionReference = "blocking-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;
  readonly #interrupted = deferred<void>();

  async execute(_turn: HarnessRunInput): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    await this.#interrupted.promise;
    publish(this.#stream, { data: { status: "interrupted" }, type: "run.interrupted" });
  }

  async interrupt(): Promise<void> {
    this.#interrupted.resolve();
  }

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}

  async stop(): Promise<void> {
    this.#interrupted.resolve();
    this.#stream.close();
  }
}

/** Streams an answer long in UTF-8 bytes, then waits to be interrupted mid-answer. */
class HangulStreamHarnessSession implements HarnessSession {
  readonly providerSessionReference = "hangul-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({
    maxBytes: 64 * 1_024 * 1_024,
    maxItems: 10_000,
  });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;
  readonly #interrupted = deferred<void>();

  async execute(_turn: HarnessRunInput): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    for (let index = 0; index < 120; index += 1) {
      publish(this.#stream, { data: { text: "한".repeat(1_000) }, type: "assistant.delta" });
    }
    await this.#interrupted.promise;
    publish(this.#stream, { data: { status: "interrupted" }, type: "run.interrupted" });
  }

  async interrupt(): Promise<void> {
    this.#interrupted.resolve();
  }

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}

  async stop(): Promise<void> {
    this.#interrupted.resolve();
    this.#stream.close();
  }
}

/** Streams emoji past a stream's tail length, so the tail is cut between two halves of one. */
class EmojiStreamHarnessSession implements HarnessSession {
  readonly providerSessionReference = "emoji-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({
    maxBytes: 64 * 1_024 * 1_024,
    maxItems: 10_000,
  });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;
  readonly #interrupted = deferred<void>();

  async execute(_turn: HarnessRunInput): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    for (let index = 0; index < 60; index += 1) {
      publish(this.#stream, { data: { text: "😀".repeat(1_000) }, type: "assistant.delta" });
    }
    publish(this.#stream, { data: { text: "a" }, type: "assistant.delta" });
    await this.#interrupted.promise;
    publish(this.#stream, { data: { status: "interrupted" }, type: "run.interrupted" });
  }

  async interrupt(): Promise<void> {
    this.#interrupted.resolve();
  }

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}

  async stop(): Promise<void> {
    this.#interrupted.resolve();
    this.#stream.close();
  }
}

/** Reports one completed reasoning block longer in UTF-8 than a durable event may be. */
/** Reports the durable events it is given as one turn, then completes. */
class ScriptedHarnessSession implements HarnessSession {
  readonly providerSessionReference = "scripted-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({
    maxBytes: 64 * 1_024 * 1_024,
    maxItems: 10_000,
  });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;
  readonly #interrupted = deferred<void>();

  readonly #script: readonly HarnessEvent[];
  readonly #ending: "complete" | "await-interrupt" | "await-requests" | "complete-on-interrupt";
  #requestResolved = deferred<void>();

  constructor(
    script: readonly HarnessEvent[],
    ending:
      "complete" | "await-interrupt" | "await-requests" | "complete-on-interrupt" = "complete",
  ) {
    this.#script = script;
    this.#ending = ending;
  }

  async execute(_turn: HarnessRunInput): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    for (const event of this.#script) {
      this.#requestResolved = deferred<void>();
      publish(this.#stream, event);
      if (this.#ending === "await-requests" && event.type === "request.opened") {
        await this.#requestResolved.promise;
      }
    }
    if (this.#ending === "complete-on-interrupt") await this.#interrupted.promise;
    if (this.#ending === "await-interrupt") {
      await this.#interrupted.promise;
      publish(this.#stream, { data: { status: "interrupted" }, type: "run.interrupted" });
      return;
    }
    publish(this.#stream, { data: { status: "completed" }, type: "run.completed" });
  }

  async interrupt(): Promise<void> {
    this.#interrupted.resolve();
  }

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {
    this.#requestResolved.resolve();
  }

  async stop(): Promise<void> {
    this.#interrupted.resolve();
    this.#requestResolved.resolve();
    this.#stream.close();
  }
}

class LongReasoningHarnessSession implements HarnessSession {
  readonly providerSessionReference = "long-reasoning-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({
    maxBytes: 64 * 1_024 * 1_024,
    maxItems: 100,
  });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;

  async execute(_turn: HarnessRunInput): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    publish(this.#stream, {
      data: { blockId: "thinking-1", text: "한".repeat(170_000) },
      type: "reasoning.completed",
    });
    publish(this.#stream, { data: { status: "completed" }, type: "run.completed" });
  }

  async interrupt(): Promise<void> {}

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}

  async stop(): Promise<void> {
    this.#stream.close();
  }
}

class SteerableHarnessSession implements HarnessSession {
  readonly providerSessionReference = "steerable-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;
  readonly #interrupted = deferred<void>();
  readonly steered: HarnessInput[] = [];
  rejectNextSteer = false;
  unknownNextSteer = false;

  async execute(_turn: HarnessRunInput): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    await this.#interrupted.promise;
    publish(this.#stream, { data: { status: "interrupted" }, type: "run.interrupted" });
  }

  async steer(input: HarnessSteerInput): Promise<void> {
    if (this.unknownNextSteer) {
      this.unknownNextSteer = false;
      throw new HarnessSteerDeliveryUnknownError("Steer delivery could not be confirmed");
    }
    if (this.rejectNextSteer) {
      this.rejectNextSteer = false;
      throw new OpensteerError({ code: "conflict", message: "No steerable turn is active" });
    }
    this.steered.push(input.input);
  }

  async interrupt(): Promise<void> {
    this.#interrupted.resolve();
  }

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}

  async stop(): Promise<void> {
    this.#interrupted.resolve();
    this.#stream.close();
  }
}

class FloodHarnessSession implements HarnessSession {
  readonly providerSessionReference = "flood-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;

  async execute(): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    publish(this.#stream, { data: { status: "running" }, type: "run.status" });
    publish(this.#stream, { data: { status: "running" }, type: "run.status" });
    publish(this.#stream, { data: { status: "completed" }, type: "run.completed" });
  }

  async interrupt(): Promise<void> {}
  async resolveRequest(): Promise<void> {}
  async stop(): Promise<void> {
    this.#stream.close();
  }
}

class UsageEdgeHarnessSession implements HarnessSession {
  readonly providerSessionReference = "usage-edge-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;

  async execute(): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    publish(this.#stream, { data: { status: "running" }, type: "run.status" });
    publish(this.#stream, { data: { inputTokens: 10, outputTokens: 2 }, type: "run.usage" });
    publish(this.#stream, { data: { status: "completed" }, type: "run.completed" });
  }

  async interrupt(): Promise<void> {}
  async resolveRequest(): Promise<void> {}
  async stop(): Promise<void> {
    this.#stream.close();
  }
}

class LargeToolOutputHarnessSession implements HarnessSession {
  readonly providerSessionReference = "large-tool-output-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;

  async execute(): Promise<void> {
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    publish(this.#stream, {
      data: {
        arguments: { command: "produce output" },
        callId: "call-1",
        tool: { name: "shell", namespace: "test" },
      },
      type: "tool.started",
    });
    for (let index = 0; index < 6; index += 1) {
      const prefix = index === 5 ? "NEVER-EMITTED:" : `${index}:`;
      publish(this.#stream, {
        data: { callId: "call-1", text: prefix.padEnd(10 * 1_024, "x") },
        type: "tool.delta",
      });
    }
    publish(this.#stream, {
      data: {
        callId: "call-1",
        isError: false,
        output: { text: "authoritative final output" },
      },
      type: "tool.completed",
    });
    publish(this.#stream, {
      data: {
        arguments: { command: "reuse provider call id" },
        callId: "call-1",
        tool: { name: "shell", namespace: "test" },
      },
      type: "tool.started",
    });
    publish(this.#stream, {
      data: { callId: "call-1", text: "fresh lifecycle" },
      type: "tool.delta",
    });
    publish(this.#stream, {
      data: { callId: "call-1", isError: false, output: { text: "fresh final output" } },
      type: "tool.completed",
    });
    publish(this.#stream, { data: { status: "completed" }, type: "run.completed" });
  }

  async interrupt(): Promise<void> {}
  async resolveRequest(): Promise<void> {}
  async stop(): Promise<void> {
    this.#stream.close();
  }
}

class FakeHarnessSession implements HarnessSession {
  readonly providerSessionReference = "fake-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;

  async execute(_turn: HarnessRunInput): Promise<void> {
    const delivery = { delivery: "must-deliver" as const };
    this.#stream.publish({ data: { status: "running" }, type: "run.started" }, delivery);
    this.#stream.publish(
      {
        data: {
          content: [{ text: "Done", type: "text" }],
          messageId: createId("message"),
        },
        type: "assistant.message",
      },
      delivery,
    );
    this.#stream.publish({ data: { status: "completed" }, type: "run.completed" }, delivery);
  }

  async interrupt(): Promise<void> {}

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}

  async stop(): Promise<void> {
    this.#stream.close();
  }
}

/** Completes like FakeHarnessSession and keeps every turn it was handed. */
class RecordingHarnessSession extends FakeHarnessSession {
  readonly turns: HarnessRunInput[] = [];

  override async execute(turn: HarnessRunInput): Promise<void> {
    this.turns.push(turn);
    await super.execute(turn);
  }
}

/** Starts and then holds its turn until interrupted, like an engine mid-task. */
class HeldHarnessSession implements HarnessSession {
  readonly providerSessionReference = "held-provider-session";
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;
  readonly #released = deferred<void>();

  async execute(_turn: HarnessRunInput): Promise<void> {
    this.#stream.publish(
      { data: { status: "running" }, type: "run.started" },
      { delivery: "must-deliver" },
    );
    await this.#released.promise;
  }

  async interrupt(): Promise<void> {
    this.#released.resolve();
  }

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}

  async stop(): Promise<void> {
    this.#released.resolve();
    this.#stream.close();
  }
}

class ReferenceHarnessSession implements HarnessSession {
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 100_000, maxItems: 100 });
  readonly events: AsyncIterable<HarnessEvent> = this.#stream;
  readonly providerSessionReference: string;
  executions = 0;
  stopped = false;

  constructor(providerSessionReference: string) {
    this.providerSessionReference = providerSessionReference;
  }

  async execute(): Promise<void> {
    this.executions += 1;
    publish(this.#stream, { data: { status: "running" }, type: "run.started" });
    publish(this.#stream, { data: { status: "completed" }, type: "run.completed" });
  }

  async interrupt(): Promise<void> {}
  async resolveRequest(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopped = true;
    this.#stream.close();
  }
}

function steerCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
  input: {
    readonly messageId: ReturnType<typeof createId<"message">>;
    readonly runId: ReturnType<typeof createId<"run">>;
    readonly threadId: ReturnType<typeof createId<"thread">>;
  },
): RunnerCommand {
  return RunnerCommandSchema.parse({
    commandId: createId("command"),
    correlationId: CorrelationIdSchema.parse("steer-test"),
    environmentId,
    input: {
      author: {
        displayName: "User",
        kind: "human",
        principalId: "principal:test",
      },
      content: [{ text: "Steered message", type: "text" }],
      createdAt: new Date().toISOString(),
      kind: "input",
      messageId: input.messageId,
    },
    runId: input.runId,
    threadId: input.threadId,
    type: "run.steer",
  });
}

function executeCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
  driverKind = "test-driver",
  hostOrigin = "https://host.example",
): Extract<RunnerCommand, { type: "run.execute" }> {
  const workspaceId = createId("workspace");
  return RunnerCommandSchema.parse({
    commandId: createId("command"),
    context: {
      accessMode: "full-access",
      assignment: null,
      agentControl: {
        token: "opaque-agent-control-token",
        url: `${hostOrigin}/internal/v1/agent-control`,
      },
      agentTools: {
        capabilityProfileId: "workspace",
        token: "opaque-agent-tools-token",
        url: "https://host.example/internal/v1/mcp",
      },
      browserCdp: {
        token: "opaque-browser-cdp-token",
        url: `${hostOrigin}/internal/v1/browser-cdp`,
      },
      integrationTools: {
        token: "opaque-agent-tools-token",
        url: "https://host.example/internal/v1/integration-mcp",
      },
      integrationSkills: {
        token: "integration-skills-token",
        url: "https://host.example/internal/v1/integration-skills",
      },
      bindingGeneration: 3,
      executionLeaseMs: 90_000,
      membershipGeneration: 1,
      egress: {
        maxRequestBytes: 8 * 1024 * 1024,
        maxResponseBytes: 8 * 1024 * 1024,
        relayToken: "opaque-relay-token",
        relayUrl: "https://host.example/internal/v1/egress/relay",
      },
      environmentId,
      harness: {
        config: {},
        driverKind,
        name: "Test harness",
        runtimeRevision: 1,
        sourceId: "test",
        stateKind: "ambient",
      },
      harnessInstanceId: createId("harnessInstance"),
      history: [],
      historyWindow: { byteCount: 2, hasEarlier: false, itemCount: 0 },
      initialContext: null,
      modelSelection: {
        modelId: "test-model",
        options: {},
        providerId: "test-provider",
      },
      providerSessionId: createId("providerSession"),
      providerSessionStateLayout: "thread",
      providerSessionReference: null,
      requestedBy: createId("user"),
      requesterTimeZone: null,
      runId: createId("run"),
      threadId: createId("thread"),
      threadRole: "work",
      threadState: { previousAssignment: null, previousRun: null },
      workspaceId,
      workspaceKind: "specialized",
      machineAccess: { callerMachineName: "cloud-1", machines: [], omittedMachines: 0 },
      workspaceInstructionsPath: null,
      workspaceAccess: {
        createdBy: createId("user"),
        exchangeToken: "opaque-exchange-token",
        exchangeUrl: "https://host.example/internal/v1/mount-grants/exchange",
        generation: 1,
        kind: "portablefs",
        volumeId: "workspace_volume",
        workspaceId,
        workspaceKind: "specialized",
      },
    },
    correlationId: CorrelationIdSchema.parse("runtime-test"),
    environmentId,
    inputs: [
      {
        author: {
          displayName: "User",
          kind: "human",
          principalId: "principal:test",
        },
        content: [{ text: "Do the work", type: "text" }],
        createdAt: new Date().toISOString(),
        kind: "input",
        messageId: createId("message"),
      },
    ],
    reports: { messages: [], omittedCount: 0, throughSequence: null },
    type: "run.execute",
  }) as Extract<RunnerCommand, { type: "run.execute" }>;
}

function triggerCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
): Extract<RunnerCommand, { type: "trigger.execute" }> {
  const anchorThreadId = createId("thread");
  const occurrenceId = createId("triggerOccurrence");
  const revisionId = createId("triggerRevision");
  const triggerId = createId("trigger");
  const workspaceId = createId("workspace");
  return RunnerCommandSchema.parse({
    commandId: createId("command"),
    context: {
      anchorThreadId,
      browserCdp: null,
      event: {
        id: occurrenceId,
        payload: { action: "test" },
        receivedAt: new Date().toISOString(),
        source: { kind: "manual" },
        trigger: { anchorThreadId, id: triggerId, revisionId, workspaceId },
      },
      executionGeneration: 1,
      integrationMcp: {
        token: "trigger-integration-mcp-token",
        url: "https://host.example/internal/v1/integration-mcp",
      },
      mcp: { token: "trigger-mcp-token", url: "https://host.example/internal/v1/mcp" },
      occurrenceId,
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      revisionId,
      triggerId,
      workspaceId,
      workspaceAccess: {
        createdBy: createId("user"),
        exchangeToken: "trigger-mount-token",
        exchangeUrl: "https://host.example/internal/v1/mount-grants/exchange",
        generation: 1,
        kind: "portablefs",
        volumeId: "workspace_volume",
        workspaceId,
        workspaceKind: "specialized",
      },
    },
    correlationId: CorrelationIdSchema.parse("trigger-runtime-test"),
    environmentId,
    type: "trigger.execute",
  }) as Extract<RunnerCommand, { type: "trigger.execute" }>;
}

/**
 * Reconciles the profiles a Run command targets. A Run never creates a profile,
 * so every dispatching test must state the reconciled desired set first.
 */
async function reconcile(
  registry: HarnessRegistry,
  ...commands: readonly Extract<RunnerCommand, { readonly type: "run.execute" }>[]
): Promise<void> {
  await registry.reconcileInstances(
    commands.map(({ context }) => ({ ...context.harness, id: context.harnessInstanceId })),
  );
}

/** One desired profile definition in the shape the Host sends for inspection. */
function harnessDefinition(
  driverKind: ReturnType<typeof HarnessIdSchema.parse>,
  name: string,
  runtimeRevision: number,
) {
  return {
    config: {},
    driverKind,
    id: createId("harnessInstance"),
    name,
    runtimeRevision,
    sourceId: "test",
    stateKind: "ambient" as const,
  };
}

const catalogSelection = ModelSelectionSchema.parse({
  modelId: "test-model",
  options: {},
  providerId: "test-provider",
});

/** A driver whose inspection always succeeds, so tests can assert Runner behavior. */
function catalogDriver(driverKind: ReturnType<typeof HarnessIdSchema.parse>): HarnessDriver {
  return {
    capabilities: fakeHarnessCapabilities,
    configSchema: z.strictObject({}),
    accessModes: fakeHarnessAccessModes,
    sources: fakeHarnessSources,
    create: async (context) => ({
      capabilities: fakeHarnessCapabilities,
      close: async () => undefined,
      instanceId: context.instanceId,
      resumeSession: async () => new FakeHarnessSession(),
      startSession: async () => new FakeHarnessSession(),
    }),
    inspect: async () => ({
      models: [
        {
          displayName: "Test model",
          isDefault: true,
          modelId: catalogSelection.modelId,
          options: [],
          providerId: catalogSelection.providerId,
        },
      ],
      status: "ready" as const,
    }),
    kind: driverKind,
  };
}

function continuationKeyOf(catalog: HarnessInstanceCatalog | undefined): string | undefined {
  return catalog?.status === "ready" ? catalog.continuationIdentity.continuationKey : undefined;
}

function isolatedExecuteCommand(
  command: Extract<RunnerCommand, { readonly type: "run.execute" }>,
): Extract<RunnerCommand, { readonly type: "run.execute" }> {
  return RunnerCommandSchema.parse({
    ...command,
    context: {
      ...command.context,
      harness: { ...command.context.harness, stateKind: "isolated" },
    },
  }) as Extract<RunnerCommand, { readonly type: "run.execute" }>;
}

function updateCommand(
  environmentId: RunnerCommand["environmentId"],
  driverKind: ReturnType<typeof HarnessIdSchema.parse>,
): Extract<RunnerCommand, { readonly type: "harness.update" }> {
  const commandId = createId("command");
  return RunnerCommandSchema.parse({
    commandId,
    correlationId: CorrelationIdSchema.parse(commandId),
    driverKind,
    environmentId,
    type: "harness.update",
  }) as Extract<RunnerCommand, { readonly type: "harness.update" }>;
}

function resumedExecuteCommand(
  command: Extract<RunnerCommand, { readonly type: "run.execute" }>,
  providerSessionReference: string,
): Extract<RunnerCommand, { readonly type: "run.execute" }> {
  return RunnerCommandSchema.parse({
    ...command,
    context: {
      ...command.context,
      providerSessionId: createId("providerSession"),
      providerSessionReference,
    },
  }) as Extract<RunnerCommand, { readonly type: "run.execute" }>;
}

/** Runs one turn of `session` and returns the durable events the Runner reported. */
async function eventsOfScriptedRun(
  session: HarnessSession,
  options: {
    readonly interrupt?: true;
    readonly resolveRequests?: readonly { requestId: RequestId; response: RequestResponse }[];
  } = {},
) {
  const driver = new FakeHarnessDriver("scripted-driver", () => session);
  const registry = new HarnessRegistry();
  registry.registerDriver(driver);
  const environmentId = createId("environment");
  const runtime = configuredRuntime({ environmentId, registry });
  const messages: RunnerOperationalReport[] = [];
  const sink: RunnerMessageSink = { send: async (message) => void messages.push(message) };
  try {
    const execute = executeCommand(environmentId, "scripted-driver");
    await reconcile(registry, execute);
    await runtime.handleCommand(execute, sink);
    for (const { requestId, response } of options.resolveRequests ?? []) {
      await waitUntil(() =>
        messages.some(
          (message) =>
            message.type === "runner.event" &&
            message.event.type === "request.opened" &&
            message.event.data.request.id === requestId,
        ),
      );
      const commandId = createId("command");
      await expect(
        runtime.handleCommand(
          RunnerCommandSchema.parse({
            commandId,
            correlationId: CorrelationIdSchema.parse(commandId),
            environmentId,
            requestId,
            response,
            runId: execute.context.runId,
            type: "request.resolve",
          }),
          sink,
        ),
      ).resolves.toEqual({ status: "accepted" });
    }
    if (options.interrupt) {
      await waitUntil(() => messages.some((message) => message.type === "runner.live"));
      const interruptId = createId("command");
      await runtime.handleCommand(
        RunnerCommandSchema.parse({
          commandId: interruptId,
          correlationId: CorrelationIdSchema.parse(interruptId),
          environmentId,
          runId: execute.context.runId,
          threadId: execute.context.threadId,
          type: "run.interrupt",
        }),
        sink,
      );
    }
    await waitUntil(() => runtime.activeRunIds().length === 0);
    return messages.flatMap((message) => (message.type === "runner.event" ? [message.event] : []));
  } finally {
    await runtime.close();
  }
}

/**
 * The active test's budget and cancellation end this wait, not a deadline of
 * its own: a busy machine cannot fail a test that is still within budget, and
 * a test that fakes Date can neither stretch the wait nor cut it short.
 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const signal = getCurrentTest()?.context.signal;
  if (!signal) throw new Error("waitUntil was called outside a test, where no budget bounds it");
  for (;;) {
    signal.throwIfAborted();
    if (predicate()) return;
    await delay(5, signal);
  }
}

const testConnectionFence = RunnerConnectionFenceSchema.parse({
  bootId: `rbt_${randomUUID()}`,
  connectionGeneration: 1,
  connectionId: `rcn_${randomUUID()}`,
  connectionLeaseId: `rls_${randomUUID()}`,
  runnerId: createId("runner"),
});

function grantRuntimeLease(
  runtime: RunnerRuntime,
  command: Extract<RunnerCommand, { readonly type: "run.execute" }>,
  heartbeatSentAt = new Date().toISOString(),
): void {
  runtime.renewLeases({
    ...testConnectionFence,
    heartbeatSentAt,
    leaseMs: command.context.executionLeaseMs,
    runIds: [command.context.runId],
    type: "host.executions.renewed",
  });
}

function runtimeWithLeaseGrants(
  options: ConstructorParameters<typeof RunnerRuntime>[0],
  grantLeases = true,
): RunnerRuntime {
  const runtime = new RunnerRuntime(options);
  const handleCommand = runtime.handleCommand.bind(runtime);
  runtime.handleCommand = async (command, sink) => {
    const decision = await handleCommand(command, sink);
    if (grantLeases && command.type === "run.execute" && decision.status === "accepted") {
      grantRuntimeLease(runtime, command);
    }
    return decision;
  };
  return runtime;
}

function configuredRuntime(input: {
  readonly containment?: ConstructorParameters<typeof RunnerRuntime>[0]["containment"];
  readonly manualLeaseGrants?: boolean;
  readonly harnessSandbox?: HarnessProcessSandbox;
  readonly deploymentShape?: ConstructorParameters<typeof RunnerRuntime>[0]["deploymentShape"];
  readonly environmentId: ReturnType<typeof createId<"environment">>;
  readonly logger?: ConstructorParameters<typeof RunnerRuntime>[0]["logger"];
  readonly maxRunEvents?: number;
  readonly maxConcurrentRuns?: number;
  readonly mode?: ConstructorParameters<typeof RunnerRuntime>[0]["mode"];
  readonly privateStateDirectory?: string;
  readonly registry: HarnessRegistry;
  readonly workspacePrepare?: ConstructorParameters<
    typeof RunnerRuntime
  >[0]["workspaceManager"]["prepare"];
  readonly workspaceMountRegistry?: ConstructorParameters<
    typeof RunnerRuntime
  >[0]["workspaceMountRegistry"];
  readonly watchSupervisor?: ConstructorParameters<typeof RunnerRuntime>[0]["watchSupervisor"];
}): RunnerRuntime {
  return runtimeWithLeaseGrants(
    {
      nodeExecutable: process.execPath,
      agentSkills: testAgentSkills,
      integrationSkills: noIntegrationSkills,
      bootId: "boot-control-test",
      browserHarnessExecutable: testBrowserHarnessExecutable,
      deploymentShape: input.deploymentShape ?? testDeploymentShape,
      environmentId: input.environmentId,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      ...(input.harnessSandbox ? { harnessSandbox: input.harnessSandbox } : {}),
      harnesses: input.registry,
      ...(input.containment ? { containment: input.containment } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
      maxConcurrentRuns: input.maxConcurrentRuns ?? 1,
      ...(input.maxRunEvents === undefined ? {} : { maxRunEvents: input.maxRunEvents }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      dataDirectory: dirname(input.privateStateDirectory ?? testPrivateStateRoot),
      privateStateDirectory: input.privateStateDirectory ?? testPrivateStateRoot,
      projectContinuationIdentity,
      ...(input.watchSupervisor ? { watchSupervisor: input.watchSupervisor } : {}),
      ...(input.workspaceMountRegistry
        ? { workspaceMountRegistry: input.workspaceMountRegistry }
        : {}),
      workspaceManager: {
        writableRoots: () => ["/runner/workspaces"],
        prepare:
          input.workspacePrepare ??
          (async () => ({
            instructions: undefined,
            path: "/runner/runs/control/workspace",
          })),
      },
    },
    !input.manualLeaseGrants,
  );
}

async function writeWorkspaceSkill(workspacePath: string, name: string): Promise<void> {
  const directory = join(workspacePath, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Workspace skill.\n---\n`,
  );
}

function hasEvent(
  messages: readonly RunnerOperationalReport[],
  type: HarnessEvent["type"],
): boolean {
  return messages.some((message) => message.type === "runner.event" && message.event.type === type);
}

function eventCount(
  messages: readonly RunnerOperationalReport[],
  type: HarnessEvent["type"],
): number {
  return messages.filter(
    (message) => message.type === "runner.event" && message.event.type === type,
  ).length;
}

function publish(stream: BoundedEventStream<HarnessEvent>, event: HarnessEvent): void {
  stream.publish(event, { delivery: "must-deliver" });
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
