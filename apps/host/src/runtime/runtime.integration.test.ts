import {
  connectCallerMachine,
  type CallerMachine,
  type MachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";
import { initializePersonalState } from "./personal-state.js";
import { describe } from "vitest";
import { sealOAuthBrokerPayload } from "@opensteer/integration-auth";

import { parseHostConfig, type HostConfig } from "@opensteer/config";
import {
  ControlPlaneAccountIdSchema,
  CompletePersonalHostAccountLinkResponseSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  personalHostAccountLinkCompletionContext,
  PublishHostAuthorityRequestSchema,
  personalHostAccessRouteEnvelopeSha256,
} from "@opensteer/control-plane-protocol";
import {
  EnvironmentIdSchema,
  HarnessIdSchema,
  ModelSelectionSchema,
  createId,
  zeroSequence,
  type EnvironmentId,
} from "@opensteer/core";
import { AccountDirectoryStore, OpensteerStore, createDatabase } from "@opensteer/database";
import { HostDescriptorSchema, hostApiVersion } from "@opensteer/deployment-authority";
import {
  HarnessInstanceCatalogSchema,
  IssuePersonalPairingCodeResponseSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  PersonalRemoteAccessStatusSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerBootIdSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  RunnerEnrollmentCredentialSchema,
  SessionExchangeResponseSchema,
  createBrowserSessionId,
  hostApiVersionHeader,
  sessionExchangePath,
  type HostToRunnerMessage,
  type RunnerAuxiliaryChallenge,
  type RunnerConnectionFence,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import {
  canonicalRunnerPublicKeyPem,
  createRunnerAuthenticationSignature,
  createRunnerAuxiliarySignature,
  createRunnerEnrollmentSignature,
  hashRunnerEnrollmentToken,
  runnerPublicKeyFingerprint,
} from "@opensteer/runner-auth";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { gate } from "@opensteer/shared/test-support/observation";
import { SignJWT, exportJWK } from "jose";
import { sql } from "kysely";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { fetchWithExplicitHost } from "../access/session-exchange.test-support.js";
import {
  advanceExecutionClock,
  executionLeaseExpiresAt,
} from "../agents/execution-clock.test-support.js";
import {
  runnerReady,
  type RunnerReadinessSnapshot,
} from "../agents/runner-readiness.test-support.js";
import { loadOrCreateHostInstance } from "../identity/host-instance.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import {
  createHostRuntime as productionHostRuntime,
  ensureDefaultHarnesses,
  type PersonalHostRuntime,
  type HostRuntimeOptions,
} from "./runtime.js";
import {
  resetMachineAccessDatabase,
  connectPrimary,
} from "./machine-access-protocol.test-support.js";
import { personalSettings } from "@opensteer/database";
async function createHostRuntime(config: HostConfig, options: HostRuntimeOptions = {}) {
  const host = await productionHostRuntime(config, options);
  if (host.kind !== "personal") throw new Error("Expected a personal Host");
  return host;
}
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const evidenceRoot = join(
  process.env.OPENSTEER_TASK_MARKS_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-task-marks"),
  "runtime",
  randomUUID(),
);
const accessToken = "access-".padEnd(40, "a");
const testModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
let ownerSessionHeaders: Record<string, string> | undefined;
let runnerToken = "";
let hostingEnvironmentId = createId("environment");

/** The one source the Codex driver in these cases declares it can drive. */
const openAiSource = {
  fields: [],
  kind: "first-party",
  label: "OpenAI",
  quota: "windows",
  sourceId: "openai",
  stateKinds: ["ambient", "isolated"],
} as const;
/** What the Claude driver declares, for the cases that advertise both engines. */
const anthropicSource = {
  fields: [],
  kind: "first-party",
  label: "Anthropic",
  quota: "windows",
  sourceId: "anthropic",
  stateKinds: ["ambient", "isolated"],
} as const;

integration("Host vertical slice", () => {
  let runtime: PersonalHostRuntime | undefined;
  let runnerSocket: WebSocket | undefined;
  let auxiliarySocket: WebSocket | undefined;
  let realtimeSocket: WebSocket | undefined;
  let dataDirectory: string | undefined;

  beforeAll(async () => {
    await mkdir(evidenceRoot, { recursive: true });
    console.info(`Task mark runtime receipts: ${evidenceRoot}`);
  });

  let accountCaller: CallerMachine | undefined;
  beforeEach(async () => {
    ownerSessionHeaders = undefined;
    runnerToken = "";
    hostingEnvironmentId = createId("environment");
    await resetMachineAccessDatabase(databaseUrl ?? "postgres://unconfigured");
  });

  afterEach(async () => {
    await accountCaller?.close();
    accountCaller = undefined;
    runnerSocket?.close();
    runnerSocket = undefined;
    auxiliarySocket?.close();
    auxiliarySocket = undefined;
    realtimeSocket?.close();
    realtimeSocket = undefined;
    await runtime?.close();
    runtime = undefined;
    if (dataDirectory) await rm(dataDirectory, { force: true, recursive: true });
    dataDirectory = undefined;
  });

  it("runs in a chosen folder and carries a Runner turn through durable projection", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-host-integration-"));
    const hostPort = await freePort();
    const config = testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9"));
    runtime = await createHostRuntime(config, {});
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    await initializeOwnerSession(origin);

    const unauthorized = await testRpcRequest(origin, "bootstrap.get", {});
    expect(unauthorized.status).toBe(401);

    const runnerId = createId("runner");
    const environmentId = hostingEnvironmentId;
    const runnerConnection = await openRunnerSocket(
      `ws://127.0.0.1:${hostPort}/internal/v1/runners`,
    );
    runnerSocket = runnerConnection.socket;
    respondToHarnessInspections(runnerSocket, readyCodexCatalog);
    const runnerEnrollment = await enrollRunnerSocket(
      runnerSocket,
      agentsRunnerDescriptor({
        bootId: `rbt_${randomUUID()}`,
        capabilities: ["filesystem", "network-egress"],
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [openAiSource],
          },
        ],
        // What the computer says it is travels in the signed hello, so this
        // enrollment also proves a descriptor carrying it verifies.
        device: { form: "laptop", platform: "macos" },
        maxConcurrentRuns: 2,
        name: "Local runner",
        providerStateModes: ["ambient", "isolated"],
        runnerId,
        runnerKind: "main",
        runtimeVersion: "integration",
        workspaceBackings: ["local-directory"],
        localStorage: null,
      }),
      runnerToken,
      runnerConnection.challenge,
    );
    runnerSocket.send(
      JSON.stringify({
        ...runnerEnrollment.fence,
        modules: [
          {
            checkedAt: new Date().toISOString(),
            detail: null,
            module: "agents",
            readiness: "ready",
          },
        ],
        type: "runner.modules.report",
      }),
    );
    const bootstrap = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      {
        headers: authorization(accessToken),
      },
    );
    expect(bootstrap.user.displayName).toBe("You");
    // This Host names no apex portal, so the config every client reads on boot
    // reports none and the web UI renders no way "up" out of a self-hosted
    // Deployment.
    expect(bootstrap.identityConfig).toMatchObject({
      deployment: { kind: "personal", name: null },
      portalOrigin: null,
    });
    const folderPath = await realpath(await mkdtemp(join(dataDirectory, "chosen-")));
    let harnessInstanceId = "";
    await waitForCondition(async () => {
      const connectedBootstrap = await testRpcData(
        origin,
        "bootstrap.get",
        {},
        {
          headers: authorization(accessToken),
        },
      );
      harnessInstanceId =
        (connectedBootstrap.harnesses.find(
          (harness: { driverKind: string }) => harness.driverKind === "codex",
        )?.id as string | undefined) ?? "";
      return harnessInstanceId.length > 0;
    });

    const threadResult = await testRpcData(
      origin,
      "commands.dispatch",
      {
        environmentId,
        harnessInstanceId,
        idempotencyKey: "thread-1",
        modelSelection: testModelSelection,
        title: "Do the work",
        type: "thread.create",
        folder: { computerId: runnerId, path: folderPath },
      },
      { headers: authorization(accessToken) },
    );
    if (threadResult.type !== "thread.create") throw new Error("Thread command mismatch.");
    const threadId = threadResult.thread.id as string;
    expect(threadResult.thread.accessMode).toBe("full-access");
    const accessModeUpdate = await testRpcData(
      origin,
      "commands.dispatch",
      {
        accessMode: "auto",
        idempotencyKey: "thread-access-1",
        threadId,
        type: "thread.access.update",
      },
      { headers: authorization(accessToken) },
    );
    if (accessModeUpdate.type !== "thread.access.update")
      throw new Error("Access command mismatch.");
    expect(accessModeUpdate.thread.accessMode).toBe("auto");

    realtimeSocket = await openWebSocket(`ws://127.0.0.1:${hostPort}/v1/realtime`, accessToken);
    realtimeSocket.send(
      JSON.stringify({
        apiVersion: hostApiVersion,
        threadId: null,
        type: "client.subscribe",
        cursor: {
          deploymentId: runtime.deployment.id,
          apiVersion: hostApiVersion,
          afterSequence: zeroSequence,
        },
      }),
    );
    await waitForMessage(realtimeSocket, (message) => message.type === "host.synchronized");

    const terminalEvents = new Promise<unknown[]>((resolve, reject) => {
      const collected: unknown[] = [];
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for terminal event; received ${JSON.stringify(collected)}`,
            ),
          ),
        10_000,
      );
      realtimeSocket?.on("message", (frame) => {
        const message = JSON.parse(frame.toString()) as {
          type: string;
          events?: Array<{
            sequence: string;
            type: string;
            data?: { status?: string };
          }>;
        };
        if (message.type !== "host.events" || !message.events) return;
        collected.push(...message.events);
        const latest = message.events.at(-1);
        if (latest) {
          realtimeSocket?.send(
            JSON.stringify({
              sequence: latest.sequence,
              type: "client.ack",
            }),
          );
        }
        if (
          message.events.some(
            (event) => event.type === "thread.state-changed" && event.data?.status === "idle",
          )
        ) {
          clearTimeout(timeout);
          resolve(collected);
        }
      });
    });

    let resolveRunnerCommand!: () => void;
    let rejectRunnerCommand!: (error: unknown) => void;
    const runnerCommandHandled = new Promise<void>((resolve, reject) => {
      resolveRunnerCommand = resolve;
      rejectRunnerCommand = reject;
    });
    runnerSocket.on("message", (frame) => {
      const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
      if (message.type !== "host.command" || message.command.type !== "run.execute") return;
      const command = message.command;
      const fence = runnerFence(message);
      void (async () => {
        expect(command.context.accessMode).toBe("auto");
        runnerSocket?.send(
          JSON.stringify({
            ...fence,
            commandId: command.commandId,
            correlationId: command.correlationId,
            type: "runner.command-accepted",
          }),
        );
        expect(command.location.folder).toEqual({ computerId: runnerId, path: folderPath });
        runnerSocket?.send(
          JSON.stringify({
            ...fence,
            bindingGeneration: command.context.bindingGeneration,
            harnessInstanceId: command.context.harnessInstanceId,
            providerSessionId: command.context.providerSessionId,
            providerSessionReference: "codex:00000000-0000-4000-8000-000000000001",
            runId: command.context.runId,
            threadId: command.context.threadId,
            type: "runner.session-bound",
          }),
        );
        const base = {
          bindingGeneration: command.context.bindingGeneration,
          emittedAt: new Date().toISOString(),
          environmentId,
          runId: command.context.runId,
          threadId: command.context.threadId,
        };
        const events = [
          { ...base, data: { status: "running" }, ordinal: 0, type: "run.started" },
          {
            ...base,
            data: {
              content: [{ text: "Finished through the Runner.", type: "text" }],
              messageId: createId("message"),
            },
            ordinal: 1,
            type: "assistant.message",
          },
          { ...base, data: { status: "completed" }, ordinal: 2, type: "run.completed" },
        ];
        for (const event of events) {
          runnerSocket?.send(JSON.stringify({ ...fence, event, type: "runner.event" }));
        }
        resolveRunnerCommand();
      })().catch(rejectRunnerCommand);
    });

    const turn = await testRpcData(
      origin,
      "commands.dispatch",
      {
        content: [{ text: "Please do the work", type: "text" }],
        idempotencyKey: "message-1",
        threadId,
        type: "thread.sendMessage",
      },
      { headers: authorization(accessToken) },
    );
    if (turn.type !== "thread.sendMessage" || !turn.run)
      throw new Error("Message command mismatch.");
    expect(turn.run.status).toBe("queued");
    expect(turn.run.accessMode).toBe("auto");
    await Promise.race([
      runnerCommandHandled,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Runner never handled host.command")),
          5_000,
        );
        timeout.unref();
      }),
    ]);
    const events = (await terminalEvents) as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "message.created",
      "message.placed",
      "run.queued",
      "thread.state-changed",
      "thread-input.updated",
      "run.status",
      "thread.continuation-established",
      "run.started",
      "thread-input.updated",
      "assistant.message",
      "message.created",
      "run.completed",
      "thread.state-changed",
    ]);
    const snapshot = await runtime.store.deploymentSnapshot();
    expect(snapshot.messages.at(-1)?.content).toEqual([
      { text: "Finished through the Runner.", type: "text" },
    ]);
    expect(snapshot.threads[0]?.status).toBe("idle");
    const inventory = await testRpcData(
      origin,
      "machines.list",
      {},
      { headers: authorization(accessToken) },
    );
    expect(inventory.machines).toContainEqual(
      expect.objectContaining({
        // A Machine is the Runner: no prefix, no kind, and its modules carry
        // the readiness the machine itself reported.
        device: { form: "laptop", platform: "macos" },
        id: runnerId,
        modules: { agents: expect.objectContaining({ readiness: "ready" }) },
        ownership: "deployment",
        status: "online",
      }),
    );
    const revoked = await testRpcRequest(
      origin,
      "commands.dispatch",
      { idempotencyKey: "revoke-hosting-runner", machineId: runnerId, type: "machine.revoke" },
      { headers: authorization(accessToken) },
    );
    expect(revoked.status).toBe(403);
    expect(runnerConnection.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      await runtime.store.database
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revokedAt: null });
  });

  it("starts the control plane without a Main Runner", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-missing-runner-token-"));
    const hostPort = await freePort();

    runtime = await createHostRuntime({
      ...testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9")),
    });
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${hostPort}`);

    const bootstrap = await testRpcData(
      `http://127.0.0.1:${hostPort}`,
      "bootstrap.get",
      {},
      {
        headers: authorization(accessToken),
      },
    );
    expect(bootstrap.environments).toEqual([]);
    expect(bootstrap.personalSettings).toBeNull();
    expect(bootstrap.can).toMatchObject({ createTasks: false, useVoice: false });
  });

  it("restarts Host and local Runner identity without the enrollment token", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-token-removal-"));
    const firstPort = await freePort();
    runtime = await createHostRuntime(
      testHostConfig(firstPort, dataDirectory, new URL("http://127.0.0.1:9")),
    );
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${firstPort}`);
    const runnerId = createId("runner");
    const environmentId = hostingEnvironmentId;
    const connection = await openRunnerSocket(`ws://127.0.0.1:${firstPort}/internal/v1/runners`);
    runnerSocket = connection.socket;
    const firstDescriptor = agentsRunnerDescriptor({
      bootId: `rbt_${randomUUID()}`,
      capabilities: ["filesystem"],
      environmentIds: [environmentId],
      harnessDrivers: [
        {
          accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
          driverKind: "codex",
          readiness: "configured",
          sources: [openAiSource],
        },
      ],
      maxConcurrentRuns: 1,
      name: "Local Runner",
      providerStateModes: ["ambient", "isolated"],
      runnerId,
      runnerKind: "main",
      runtimeVersion: "integration",

      workspaceBackings: ["local-directory"],
      localStorage: null,
    });
    const runnerKeys = await enrollRunnerSocket(
      connection.socket,
      firstDescriptor,
      runnerToken,
      connection.challenge,
    );
    const closed = waitForClose(connection.socket);
    connection.socket.close();
    await closed;
    runnerSocket = undefined;
    await runtime.close();
    runtime = undefined;

    const secondPort = firstPort;
    runtime = await createHostRuntime(
      withoutInitialOwner(testHostConfig(secondPort, dataDirectory, new URL("http://127.0.0.1:9"))),
    );
    await runtime.listen();
    await expect(runtime.store.runnerForAuthentication(runnerId)).resolves.toMatchObject({
      runnerId,
      runnerKind: "main",
    });

    const reconnect = await openRunnerSocket(`ws://127.0.0.1:${secondPort}/internal/v1/runners`);
    runnerSocket = reconnect.socket;
    const challenge = RunnerChallengeSchema.parse(reconnect.challenge);
    // The same computer on a new boot: its modules are unchanged, so only the
    // boot identity moves.
    const reconnectDescriptor = RunnerDescriptorSchema.parse({
      ...firstDescriptor,
      bootId: `rbt_${randomUUID()}`,
    });
    reconnect.socket.send(
      JSON.stringify({
        challengeId: challenge.challengeId,
        descriptor: reconnectDescriptor,
        signature: createRunnerAuthenticationSignature(runnerKeys.privateKey, {
          challenge,
          descriptor: reconnectDescriptor,
        }),
        proofFormatVersion: 2,
        type: "runner.authenticate",
      }),
    );
    const welcome = await waitForMessage(
      reconnect.socket,
      (message) => message.type === "host.welcome",
    );
    expect(welcome).toMatchObject({ connectionGeneration: 2, runnerId, type: "host.welcome" });
  });

  it("converges after Runner invalidation's first catalog recapture fails", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-invalidation-recovery-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(
      testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9")),
    );
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${hostPort}`);
    const environmentId = hostingEnvironmentId;
    const connection = await openRunnerSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
    runnerSocket = connection.socket;
    let signedIn = false;
    let fence: RunnerConnectionFence | undefined;
    runnerSocket.on("message", (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
      if (message.type === "host.command") {
        // An idle Runner still acknowledges profile/watch reconciliation.
        connection.socket.send(
          JSON.stringify({
            ...runnerFence(message),
            commandId: message.command.commandId,
            correlationId: message.command.correlationId,
            type: "runner.command-accepted",
          }),
        );
      }
      if (
        message.type === "host.reconcile-harnesses" ||
        message.type === "host.inspect-harnesses"
      ) {
        fence = runnerFence(message);
      }
    });
    const stopCatalogResponder = respondToHarnessInspections(runnerSocket, (harness) =>
      signedIn
        ? readyCodexCatalog(harness)
        : HarnessInstanceCatalogSchema.parse({
            detail: "Sign in externally",
            driverKind: harness.driverKind,
            harnessInstanceId: harness.id,
            models: [],
            setupMethods: [],
            status: "authentication-required",
          }),
    );
    await enrollRunnerSocket(
      runnerSocket,
      agentsRunnerDescriptor({
        bootId: `rbt_${randomUUID()}`,
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [openAiSource],
          },
        ],
        name: "Invalidation recovery Runner",
        providerStateModes: ["ambient", "isolated"],
        runnerId: createId("runner"),
        runnerKind: "main",
        runtimeVersion: "integration",
        workspaceBackings: ["local-directory"],
        localStorage: null,
      }),
      runnerToken,
      connection.challenge,
    );
    const store = runtime.store;
    const catalogs = () => store.listHarnessCatalogs([environmentId]);
    await expect
      .poll(async () => (await catalogs())[0]?.catalog.status, { timeout: 10_000 })
      .toBe("authentication-required");
    const stored = (await catalogs())[0]!;
    expect(fence).toBeDefined();
    runnerSocket.send(
      JSON.stringify({
        ...fence,
        modules: [
          {
            checkedAt: new Date().toISOString(),
            detail: null,
            module: "agents",
            readiness: "ready",
          },
        ],
        type: "runner.modules.report",
      }),
    );
    const capture = vi
      .spyOn(store, "recordHarnessCatalogs")
      .mockRejectedValueOnce(new Error("Injected invalidation capture failure"));
    signedIn = true;
    runnerSocket.send(
      JSON.stringify({
        ...fence,
        harnessInstanceId: stored.harnessInstanceId,
        type: "runner.harness-catalog-invalidated",
      }),
    );
    await expect.poll(() => capture.mock.calls.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await catalogs()).toEqual([]);
    const heartbeat = setInterval(
      () =>
        runnerSocket?.send(
          JSON.stringify({
            ...fence,
            activeRunIds: [],
            activeTriggerOccurrenceIds: [],
            activeWatchActivationIds: [],
            sentAt: new Date().toISOString(),
            type: "runner.heartbeat",
          }),
        ),
      5_000,
    );
    try {
      await expect
        .poll(async () => (await catalogs())[0]?.catalog.status, { interval: 250, timeout: 45_000 })
        .toBe("ready");
    } finally {
      clearInterval(heartbeat);
      stopCatalogResponder();
    }
    const artifactDirectory =
      process.env.OPENSTEER_ENGINE_INSPECTION_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-invalidation-evidence-")));
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "recapture-runner-invalidation.json"),
      JSON.stringify(
        {
          before: stored,
          after: await catalogs(),
          captureAttempts: capture.mock.calls.length,
        },
        null,
        2,
      ) + "\n",
    );
  }, 75_000);

  it("returns a structured authentication rejection before closing a Runner socket", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-auth-rejection-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(
      testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9")),
    );
    await runtime.listen();

    const connection = await openRunnerSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
    runnerSocket = connection.socket;
    const challenge = RunnerChallengeSchema.parse(connection.challenge);
    const descriptor = agentsRunnerDescriptor({
      bootId: `rbt_${randomUUID()}`,
      capabilities: ["filesystem"],
      environmentIds: [createId("environment")],
      harnessDrivers: [
        {
          accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
          driverKind: "codex",
          readiness: "configured",
          sources: [openAiSource],
        },
      ],
      maxConcurrentRuns: 1,
      name: "Unknown persisted Runner",
      providerStateModes: ["ambient", "isolated"],
      runnerId: createId("runner"),
      runnerKind: "main",
      runtimeVersion: "integration",

      workspaceBackings: ["local-directory"],
      localStorage: null,
    });
    const pair = generateKeyPairSync("ed25519");
    const rejected = waitForMessage(connection.socket, (message) => message.type === "host.error");
    connection.socket.send(
      JSON.stringify({
        challengeId: challenge.challengeId,
        descriptor,
        signature: createRunnerAuthenticationSignature(pair.privateKey, {
          challenge,
          descriptor,
        }),
        proofFormatVersion: 2,
        type: "runner.authenticate",
      }),
    );

    await expect(rejected).resolves.toMatchObject({
      error: {
        code: "forbidden",
        message: "Runner authentication failed",
        retryable: false,
      },
      type: "host.error",
    });
  });

  it("advertises AI-engine readiness and admits only compatible new Thread placements", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-placement-integration-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(
      testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9")),
    );
    await runtime.listen();
    const origin = `http://127.0.0.1:${hostPort}`;
    await initializeOwnerSession(origin);

    const runnerId = createId("runner");
    const environmentId = hostingEnvironmentId;
    const runnerConnection = await openRunnerSocket(
      `ws://127.0.0.1:${hostPort}/internal/v1/runners`,
    );
    runnerSocket = runnerConnection.socket;
    // A real Runner can answer for its AI engines from the moment it connects,
    // which is exactly when the Host captures the catalog it will serve after
    // the Runner goes away.
    const stopCatalogResponder = respondToHarnessInspections(runnerSocket, (harness) =>
      HarnessInstanceCatalogSchema.parse(
        harness.driverKind === "claude"
          ? {
              continuationIdentity: {
                continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
                driverKind: harness.driverKind,
              },
              driverKind: harness.driverKind,
              harnessInstanceId: harness.id,
              models: [
                {
                  displayName: "Claude Sonnet",
                  isDefault: true,
                  modelId: "sonnet",
                  options: [],
                  providerId: "anthropic",
                },
              ],
              status: "ready" as const,
            }
          : {
              detail: "Codex is not signed in",
              driverKind: harness.driverKind,
              harnessInstanceId: harness.id,
              models: [],
              setupMethods: [],
              status: "authentication-required" as const,
            },
      ),
    );
    await enrollRunnerSocket(
      runnerSocket,
      agentsRunnerDescriptor({
        bootId: `rbt_${randomUUID()}`,
        capabilities: ["filesystem"],
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            driverKind: "codex",
            readiness: "unavailable",
            reason: "Codex is not signed in",
          },
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "claude",
            note: "Checked when work starts",
            readiness: "runtime-check",
            sources: [anthropicSource],
          },
        ],
        maxConcurrentRuns: 1,
        name: "Local work location",
        runnerId,
        runnerKind: "main",
        runtimeVersion: "integration",

        workspaceBackings: ["local-directory"],
        localStorage: null,
      }),
      runnerToken,
      runnerConnection.challenge,
    );
    const ownerId = await administratorId(runtime.store);
    const folder = (
      await vi.waitFor(() => personalSettings(runtime!.store.database), {
        timeout: 5_000,
        interval: 25,
      })
    ).agentHome;
    // A driver the Runner reports as unavailable is not seeded a default
    // profile, and adding one is refused: an engine the Runner cannot run has
    // no source to validate against. This case's unavailable account is one
    // that existed before the Runner stopped offering the engine, which is
    // the only way such an account comes to be.
    const seeded = await vi.waitFor(
      async () => {
        const rows = await runtime!.store.listHarnessInstances();
        expect(rows.map(({ driverKind }) => driverKind)).toEqual(["claude"]);
        return rows;
      },
      { timeout: 5_000, interval: 25 },
    );
    expect(seeded.map(({ driverKind }) => driverKind)).toEqual(["claude"]);
    const claudeHarness = seeded.find((harness) => harness.driverKind === "claude");
    if (!claudeHarness) throw new Error("Built-in AI engines are missing");
    const refused = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        driverKind: "codex",
        environmentId,
        idempotencyKey: "placement-codex-profile-refused",
        name: "Codex",
        sourceId: "openai",
        stateKind: "ambient",
        type: "harness.create",
      },
      { headers: authorization(accessToken) },
    );
    expect(refused.status).toBe(409);
    const codexHarness = await runtime.store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId: EnvironmentIdSchema.parse(environmentId),
      name: "Codex",
      sourceId: "openai",
      stateKind: "ambient",
    });

    await waitForCondition(async () => {
      const candidate = await testRpcData(
        origin,
        "bootstrap.get",
        {},
        {
          headers: authorization(accessToken),
        },
      );
      // Only the seeded Claude account is ever inspected: the Codex driver is
      // unavailable, so its account has no catalog to wait for.
      return candidate.environments.some(
        (environment: { harnessCatalogs: unknown[]; id: string }) =>
          environment.id === environmentId && environment.harnessCatalogs.length === 1,
      );
    });
    const bootstrap = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      {
        headers: authorization(accessToken),
      },
    );
    expect(bootstrap.environments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connected: true,
          harnessDrivers: [
            {
              driverKind: "codex",
              readiness: "unavailable",
              reason: "Codex is not signed in",
            },
            {
              accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
              driverKind: "claude",
              note: "Checked when work starts",
              readiness: "runtime-check",
              sources: [anthropicSource],
            },
          ],
          id: environmentId,
        }),
      ]),
    );

    const selfHostedAuthentication = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        environmentId,
        harnessInstanceId: codexHarness.id,
        idempotencyKey: "self-hosted-unavailable-authentication",
        methodId: "codex-subscription",
        type: "harness.authentication.begin",
      },
      { headers: authorization(accessToken) },
    );
    expect(selfHostedAuthentication.status).toBe(409);

    const unavailableResponse = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        environmentId,
        harnessInstanceId: codexHarness.id,
        idempotencyKey: "placement-codex-unavailable",
        modelSelection: testModelSelection,
        title: "Must not be created",
        type: "thread.create",
        folder,
      },
      { headers: authorization(accessToken) },
    );
    expect(unavailableResponse.status).toBe(409);
    await expect(unavailableResponse.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("AI engine") },
    });

    const selectedBrowserId = createBrowserSessionId();
    await runtime.store.createBrowserSession({
      id: selectedBrowserId,
      origin: "agent",
      placementKey: `runner:${runnerId}:browser`,
      profileId: null,
      runnerId,
      runtimeId: "browser",
      ownerId,
    });
    const hiddenBrowserId = createBrowserSessionId();
    const createBody = {
      environmentId,
      harnessInstanceId: claudeHarness.id,
      modelSelection: { modelId: "sonnet", options: {}, providerId: "anthropic" },
      title: "Pinned to Claude on Main",
    };
    const created = await testRpcData(
      origin,
      "commands.dispatch",
      {
        ...createBody,
        idempotencyKey: "placement-claude",
        type: "thread.create",
        folder,
      },
      { headers: authorization(accessToken) },
    );
    if (created.type !== "thread.create") throw new Error("Thread command mismatch.");
    expect(created).toMatchObject({
      thread: { environmentId, harnessInstanceId: claudeHarness.id },
      wasDuplicate: false,
    });
    const page = (sessionId: string) => ({
      sessionId,
      tabId: "page-chosen",
      title: "Chosen page",
      type: "browser-page" as const,
      url: "https://shop.example/cart?item=42",
    });
    // A page names only a browser its sender can see; otherwise nothing is sent.
    const hiddenPage = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        content: [page(hiddenBrowserId), { text: "Compare with this", type: "text" }],
        idempotencyKey: "first-message-hidden-page",
        threadId: created.thread.id,
        type: "thread.sendMessage",
      },
      { headers: authorization(accessToken) },
    );
    expect(hiddenPage.status).toBe(403);
    await expect(hiddenPage.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("which you can no longer see") },
    });
    expect(
      (await runtime.store.readThreadForOwner(created.thread.id, ownerId, 10))?.messages,
    ).toEqual([]);
    const sent = await testRpcData(
      origin,
      "commands.dispatch",
      {
        content: [page(selectedBrowserId), { text: "Compare with this", type: "text" }],
        idempotencyKey: "first-message-page",
        threadId: created.thread.id,
        type: "thread.sendMessage",
      },
      { headers: authorization(accessToken) },
    );
    if (sent.type !== "thread.sendMessage") throw new Error("Send command mismatch.");
    expect(sent.message.content[0]).toEqual(page(selectedBrowserId));
    const associated = await testRpcData(
      origin,
      "thread.browserUsage.get",
      {
        threadId: created.thread.id,
        runIds: [],
      },
      { headers: authorization(accessToken) },
    );
    // The first message credits the new conversation with that exact page and
    // what it showed, keeping only the page's site.
    expect(associated.uses).toEqual([
      expect.objectContaining({
        sessionId: selectedBrowserId,
        threadId: created.thread.id,
        runId: null,
        tabId: null,
      }),
      expect.objectContaining({
        sessionId: selectedBrowserId,
        threadId: created.thread.id,
        runId: null,
        tabId: "page-chosen",
        pageTitle: "Chosen page",
        pageSite: "https://shop.example",
      }),
    ]);

    runnerSocket.close();
    await waitForCondition(async () => {
      const refreshed = await testRpcData(
        origin,
        "bootstrap.get",
        {},
        {
          headers: authorization(accessToken),
        },
      );
      return refreshed.environments.some(
        (environment: { connected: boolean; id: string }) =>
          environment.id === environmentId && !environment.connected,
      );
    });
    const exactRetry = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        ...createBody,
        idempotencyKey: "placement-claude",
        type: "thread.create",
        folder,
      },
      { headers: authorization(accessToken) },
    );
    expect(exactRetry.status).toBe(200);
    await expect(exactRetry.json()).resolves.toMatchObject({
      data: { thread: { id: created.thread.id }, wasDuplicate: true },
      ok: true,
    });
    const artifactDirectory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
    if (artifactDirectory) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, "browser-first-send-association.json"),
        JSON.stringify(
          {
            hiddenPageStatus: hiddenPage.status,
            hiddenPageSentNoMessage: true,
            selectedBrowserId,
            hiddenBrowserId,
            firstMessageContent: sent.message.content,
            exactReplayAfterRunnerDisconnectStatus: exactRetry.status,
            conversation: associated,
          },
          null,
          2,
        ),
      );
    }
    stopCatalogResponder();
  });

  it("keeps a removed existing-CLI profile removed across the next Runner connect", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-ambient-removal-integration-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(
      testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9")),
    );
    await runtime.listen();
    const origin = `http://127.0.0.1:${hostPort}`;
    await initializeOwnerSession(origin);

    const environmentId = hostingEnvironmentId;
    const runnerConnection = await openRunnerSocket(
      `ws://127.0.0.1:${hostPort}/internal/v1/runners`,
    );
    runnerSocket = runnerConnection.socket;
    const stopCatalogResponder = respondToHarnessInspections(runnerSocket, readyCodexCatalog);
    const stopAuthenticationResponder = respondToHarnessAuthentication(runnerSocket);
    await enrollRunnerSocket(
      runnerSocket,
      agentsRunnerDescriptor({
        bootId: `rbt_${randomUUID()}`,
        capabilities: ["filesystem"],
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [openAiSource],
          },
        ],
        maxConcurrentRuns: 1,
        name: "Laptop",
        runnerId: createId("runner"),
        runnerKind: "main",
        runtimeVersion: "integration",
        workspaceBackings: ["local-directory"],
        localStorage: null,
      }),
      runnerToken,
      runnerConnection.challenge,
    );
    await waitForCondition(async () => {
      const seeded = await runtime?.store.listHarnessInstances({
        environmentIds: [environmentId],
      });
      return (seeded?.length ?? 0) === 1;
    });
    const [seeded] = await runtime.store.listHarnessInstances({ environmentIds: [environmentId] });
    if (!seeded) throw new Error("The default AI engine profile was not seeded");
    // Attaching a computer seeds its existing CLI. The Opensteer record is
    // removable even though the machine's own provider files are never touched.
    expect(seeded).toMatchObject({ driverKind: "codex", stateKind: "ambient" });

    const removed = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        environmentId,
        harnessInstanceId: seeded.id,
        idempotencyKey: "ambient-removal",
        type: "harness.delete",
      },
      { headers: authorization(accessToken) },
    );
    expect(removed.status).toBe(200);
    expect(await runtime.store.listHarnessInstances({ environmentIds: [environmentId] })).toEqual(
      [],
    );

    // The next connect runs the same seeding pass. The tombstone is the durable
    // record of the removal, so the profile must not come back.
    await ensureDefaultHarnesses(runtime.store, environmentId, {
      harnessDrivers: [
        {
          driverKind: "codex",
          readiness: "configured",
          sources: [{ sourceId: "openai", stateKinds: ["ambient", "isolated"] }],
        },
      ],
      providerStateModes: ["ambient", "isolated"],
    });
    expect(await runtime.store.listHarnessInstances({ environmentIds: [environmentId] })).toEqual(
      [],
    );
    stopAuthenticationResponder();
    stopCatalogResponder();
  });

  it("projects and broadcasts a non-retryable Runner dispatch rejection", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-rejection-integration-"));
    const hostPort = await freePort();
    const bootId = `rbt_${randomUUID()}`;
    const committed = new EventEmitter();
    let snapshot: RunnerReadinessSnapshot | undefined;
    runtime = await createHostRuntime(
      testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9")),
      {
        onRunnerCatalogsCommitted: (identity, environmentId, catalogs) => {
          snapshot = {
            bootId: identity.bootId,
            connectionId: identity.connectionId,
            currentConnectionId: identity.connectionId,
            environmentId,
            connected: true,
            catalogs,
          };
          committed.emit("update");
        },
      },
    );
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${hostPort}`);

    const runnerId = createId("runner");
    const environmentId = hostingEnvironmentId;
    const runnerConnection = await openRunnerSocket(
      `ws://127.0.0.1:${hostPort}/internal/v1/runners`,
    );
    runnerSocket = runnerConnection.socket;
    await enrollRunnerSocket(
      runnerSocket,
      agentsRunnerDescriptor({
        bootId,
        capabilities: ["filesystem"],
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [openAiSource],
          },
        ],
        maxConcurrentRuns: 1,
        name: "Rejecting runner",
        runnerId,
        runnerKind: "main",
        runtimeVersion: "integration",

        workspaceBackings: ["local-directory"],
        localStorage: null,
      }),
      runnerToken,
      runnerConnection.challenge,
    );
    // Enrollment has completed, but publication is deliberately held until the wait is installed.
    const publication = gate({ label: "rejection catalog publication", deadlineMs: 5_000 });
    const stopCatalogResponder = respondToHarnessInspections(
      runnerSocket,
      readyCodexCatalog,
      publication.enter,
    );

    try {
      const ownerId = await administratorId(runtime.store);
      const folder = (
        await vi.waitFor(() => personalSettings(runtime!.store.database), {
          timeout: 5_000,
          interval: 25,
        })
      ).agentHome;

      await publication.entered;
      const harnesses = await runtime.store.listHarnessInstances({
        environmentIds: [environmentId],
      });
      expect(harnesses.length).toBeGreaterThan(0);
      const ready = runnerReady({
        bootId,
        environmentId,
        harnessInstanceIds: harnesses.map((harness) => harness.id),
        deadlineMs: 5_000,
        read: () => {
          if (runnerConnection.socket.readyState !== WebSocket.OPEN)
            throw new Error(`Runner boot ${bootId} disconnected before readiness`);
          return snapshot;
        },
        subscribe: (notify) => {
          const socket = runnerConnection.socket;
          const disconnected = () => {
            if (snapshot)
              snapshot = { ...snapshot, connected: false, currentConnectionId: undefined };
            notify();
          };
          socket.on("close", disconnected);
          committed.on("update", notify);
          return () => {
            socket.off("close", disconnected);
            committed.off("update", notify);
          };
        },
      });
      try {
        await publication.entered;
        expect(snapshot?.catalogs.some((catalog) => catalog.status === "ready") ?? false).toBe(
          false,
        );
        publication.release();
        await ready.promise;
      } finally {
        publication.abort();
        ready.dispose();
      }
      const harness = await seededHarness(runtime.store, environmentId);
      const { thread } = await runtime.store.createThread({
        createdBy: ownerId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: "rejection-runtime-thread",
        modelSelection: testModelSelection,
        title: "Reject this dispatch",
        folder,
      });

      realtimeSocket = await openWebSocket(`ws://127.0.0.1:${hostPort}/v1/realtime`, accessToken);
      realtimeSocket.send(
        JSON.stringify({
          apiVersion: hostApiVersion,
          threadId: thread.id,
          type: "client.subscribe",
          cursor: {
            deploymentId: runtime.deployment.id,
            apiVersion: hostApiVersion,
            afterSequence: zeroSequence,
          },
        }),
      );
      await waitForMessage(realtimeSocket, (message) => message.type === "host.synchronized");
      const terminalEvent = waitForDeploymentEvent(realtimeSocket, "run.failed");
      const commandPromise = waitForRunnerExecution(runnerSocket);
      const turn = await runtime.store.enqueueThreadInput({
        content: [{ text: "This must fail durably", type: "text" }],
        idempotencyKey: "rejection-runtime-turn",
        policy: "queue",
        requestedBy: ownerId,
        source: { kind: "human" },
        threadId: thread.id,
      });
      if (!turn.command || !turn.run) throw new Error("Queued input did not schedule a Run");
      const admittedCommand = turn.command;
      const admittedRun = turn.run;
      const dispatched = await commandPromise;
      const command = dispatched.command;
      const privateProviderError = "provider-token-must-not-be-persisted";
      runnerSocket.send(
        JSON.stringify({
          ...runnerFence(dispatched),
          commandId: command.commandId,
          correlationId: command.correlationId,
          error: {
            code: "internal",
            message: privateProviderError,
            retryable: false,
          },
          type: "runner.command-rejected",
        }),
      );

      await expect(terminalEvent).resolves.toMatchObject({
        data: {
          code: "dispatch_failed",
          message: "The AI engine could not be started.",
          retryable: false,
          status: "failed",
        },
        runId: admittedRun.id,
        type: "run.failed",
      });
      await waitForCondition(async () => {
        const row = await runtime?.store.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", admittedRun.id)
          .executeTakeFirst();
        return row?.status === "failed";
      });
      await expect(
        runtime.store.database
          .selectFrom("commands")
          .select(["lastError", "status"])
          .where("id", "=", admittedCommand.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({
        lastError: { code: "dispatch_failed", status: "failed" },
        status: "failed",
      });
      await expect(
        runtime.store.database
          .selectFrom("threads")
          .select("status")
          .where("id", "=", thread.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: "failed" });
      const persistedEvents = await runtime.store.database
        .selectFrom("deploymentEvents")
        .select(["data", "runnerOrdinal", "type"])
        .where("runId", "=", admittedRun.id)
        .where("type", "=", "run.failed")
        .execute();
      expect(persistedEvents).toHaveLength(1);
      expect(persistedEvents[0]).toMatchObject({ runnerOrdinal: null, type: "run.failed" });
      expect(JSON.stringify(persistedEvents)).not.toContain(privateProviderError);
    } finally {
      publication.abort();
      stopCatalogResponder();
    }
  });

  it("keeps an active Run through its Runner's disconnect until its lease runs out", async () => {
    const clock = new ManualClock();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-disconnect-integration-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(
      {
        ...testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9")),
        executionLeaseMs: 10_000,
      },
      { executionClock: clock },
    );
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${hostPort}`);

    const runnerId = createId("runner");
    const environmentId = hostingEnvironmentId;
    const runnerBootId = `rbt_${randomUUID()}`;
    const runnerConnection = await openRunnerSocket(
      `ws://127.0.0.1:${hostPort}/internal/v1/runners`,
    );
    runnerSocket = runnerConnection.socket;
    await enrollRunnerSocket(
      runnerSocket,
      agentsRunnerDescriptor({
        bootId: runnerBootId,
        capabilities: ["filesystem"],
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [openAiSource],
          },
        ],
        maxConcurrentRuns: 1,
        name: "Disconnecting runner",
        runnerId,
        runnerKind: "main",
        runtimeVersion: "integration",

        workspaceBackings: ["local-directory"],
        localStorage: null,
      }),
      runnerToken,
      runnerConnection.challenge,
    );
    const stopCatalogResponder = respondToHarnessInspections(runnerSocket, readyCodexCatalog);

    const ownerId = await administratorId(runtime.store);
    const folder = (
      await vi.waitFor(() => personalSettings(runtime!.store.database), {
        timeout: 5_000,
        interval: 25,
      })
    ).agentHome;

    const harness = await seededHarness(runtime.store, environmentId);
    const { thread } = await runtime.store.createThread({
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "disconnect-runtime-thread",
      modelSelection: testModelSelection,
      title: "Disconnect me",
      folder,
    });
    const commandPromise = waitForRunnerExecution(runnerSocket);
    const turn = await runtime.store.enqueueThreadInput({
      content: [{ text: "Keep running until disconnected", type: "text" }],
      idempotencyKey: "disconnect-runtime-turn",
      policy: "queue",
      requestedBy: ownerId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    if (!turn.command || !turn.run) throw new Error("Queued input did not schedule a Run");
    const admittedCommand = turn.command;
    const admittedRun = turn.run;
    const dispatched = await commandPromise;
    const command = dispatched.command;
    runnerSocket.send(
      JSON.stringify({
        ...runnerFence(dispatched),
        commandId: command.commandId,
        correlationId: command.correlationId,
        type: "runner.command-accepted",
      }),
    );
    runnerSocket.send(
      JSON.stringify({
        ...runnerFence(dispatched),
        event: {
          bindingGeneration: command.context.bindingGeneration,
          data: { status: "running" },
          emittedAt: new Date().toISOString(),
          environmentId,
          ordinal: 0,
          runId: command.context.runId,
          threadId: command.context.threadId,
          type: "run.started",
        },
        type: "runner.event",
      }),
    );
    await waitForCondition(async () => {
      const row = await runtime?.store.database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", admittedRun.id)
        .executeTakeFirst();
      return row?.status === "running";
    });

    const disconnectRecovery = vi.spyOn(runtime.store, "failActiveRunsForRunnerDisconnect");
    stopCatalogResponder();
    runnerSocket.terminate();
    await waitForCondition(async () => {
      const read = await testRpcData(
        `http://127.0.0.1:${hostPort}`,
        "bootstrap.get",
        {},
        { headers: authorization(accessToken) },
      );
      return read.environments.some(
        (environment) => environment.id === environmentId && !environment.connected,
      );
    });
    const runStatus = async () =>
      (
        await runtime?.store.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", admittedRun.id)
          .executeTakeFirst()
      )?.status;
    // A lost connection costs the Run nothing while its lease lasts.
    const expiry = await executionLeaseExpiresAt(runtime, admittedRun.id);
    const disconnectedAt = clock.now();
    const priorPasses = await runtime.settleExecutionLeases();
    await advanceExecutionClock(clock, runtime, 2_000);
    // A healthy sweep is jittered up to 3.75 s; observe its completion while
    // retaining the entire original 2 s pre-expiry interval.
    for (
      let extra = 0;
      extra < 4 && (await runtime.settleExecutionLeases()) === priorPasses;
      extra += 1
    )
      await advanceExecutionClock(clock, runtime, 500);
    const preExpiryPasses = await runtime.settleExecutionLeases();
    expect(preExpiryPasses).toBeGreaterThan(priorPasses);
    expect(clock.now() - disconnectedAt).toBeGreaterThanOrEqual(2_000);
    expect(clock.now()).toBeLessThan(expiry.getTime());
    expect(await runStatus()).toBe("running");
    expect(disconnectRecovery).not.toHaveBeenCalled();
    const preExpiry = {
      domainNow: clock.now(),
      status: await runStatus(),
      completedPasses: preExpiryPasses,
      disconnectRecoveryCalls: disconnectRecovery.mock.calls.length,
    };
    // Settle at expiry before spending the post-expiry interval: a sweep samples
    // time before its async query, and reschedules from the end of the clock step.
    // Straddling expiry could otherwise put its next jittered pass past our stop.
    await advanceExecutionClock(clock, runtime, expiry.getTime() - clock.now());
    await advanceExecutionClock(clock, runtime, 4_000);
    await waitForCondition(async () => (await runStatus()) === "failed", 30_000);
    const evidence = await mkdtemp(join(tmpdir(), "opensteer-disconnect-clock-"));
    await writeFile(
      join(evidence, "lease.json"),
      JSON.stringify(
        {
          disconnectedAt,
          expiry,
          preExpiry,
          afterExpiry: {
            domainNow: clock.now(),
            status: await runStatus(),
            completedPasses: await runtime.settleExecutionLeases(),
          },
        },
        null,
        2,
      ) + "\n",
    );
    console.info(`Disconnect lease clock evidence: ${evidence}`);
    await expect(
      runtime.store.database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", admittedCommand.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "succeeded" });
    await expect(
      runtime.store.database
        .selectFrom("deploymentEvents")
        .select(["data", "runnerOrdinal", "type"])
        .where("runId", "=", admittedRun.id)
        .where("type", "=", "run.failed")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      data: { code: "execution_binding_expired", status: "failed" },
      runnerOrdinal: null,
      type: "run.failed",
    });
  }, 60_000);

  it("cancels a Browser Request whose session a Host restart ended, and keeps its Run", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-restart-integration-"));
    const hostPort = await freePort();
    const hostInstance = await loadOrCreateHostInstance(dataDirectory);
    const seedDatabase = createDatabase({
      connectionString: databaseUrl ?? "postgres://unconfigured",
    });
    const seedStore = new OpensteerStore(seedDatabase);
    const ownerId = await seedStore.createUser("Alex");
    await seedStore.ensureDeployment({
      canonicalOrigin: `http://127.0.0.1:${hostPort}`,
      deploymentId: createId("deployment"),
      hostInstanceId: hostInstance.hostInstanceId,
      deploymentShape: {
        kind: "personal" as const,
      },
    });
    const runnerId = createId("runner");
    const environmentId = hostingEnvironmentId;
    const seedKeys = generateKeyPairSync("ed25519");
    const seedEnrollmentTokenHash = hashRunnerEnrollmentToken("restart-runner-enrollment-token");
    await seedStore.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "restart-runner-enrollment",
      mainEnrollmentPurpose: "initial",
      name: "Restart runner",
      requestFingerprint: "sha256:restart-runner-enrollment",
      runnerKind: "main",
      tokenHash: seedEnrollmentTokenHash,
    });
    await seedStore.enrollRunnerConnection({
      descriptor: agentsRunnerDescriptor({
        bootId: `rbt_${randomUUID()}`,
        capabilities: ["filesystem"],
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [openAiSource],
          },
        ],
        maxConcurrentRuns: 1,
        name: "Restarted runner",
        providerStateModes: ["ambient", "isolated"],
        runnerId,
        runnerKind: "main",
        runtimeVersion: "integration",

        workspaceBackings: ["local-directory"],
        localStorage: null,
      }),
      enrollmentTokenHash: seedEnrollmentTokenHash,
      publicKeyFingerprint: runnerPublicKeyFingerprint(seedKeys.publicKey),
      publicKeyPem: canonicalRunnerPublicKeyPem(seedKeys.publicKey),
    });
    await initializePersonalState(
      seedStore.database,
      {
        environmentId,
        agentHome: join(dataDirectory, "home"),
      },
      { sendToUsers: () => undefined },
    );
    const folder = (await personalSettings(seedStore.database)).agentHome;
    const harness = await seedStore.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      sourceId: "native",
      stateKind: "isolated",
    });
    const { thread } = await seedStore.createThread({
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "restart-runtime-thread",
      modelSelection: testModelSelection,
      title: "Recover me",
      folder,
    });
    const turn = await seedStore.enqueueThreadInput({
      content: [{ text: "The Host will restart after claiming this", type: "text" }],
      idempotencyKey: "restart-runtime-turn",
      policy: "queue",
      requestedBy: ownerId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    if (!turn.command || !turn.run) throw new Error("Queued input did not schedule a Run");
    const admittedCommand = turn.command;
    const admittedRun = turn.run;
    await seedStore.claimCommand(admittedCommand.id, "old-host");
    // A Run its Runner was executing: bound, leased well past the restart.
    await seedStore.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
        driverKind: harness.driverKind,
      },
      harnessInstanceId: harness.id,
      leaseTokenHash: "restart-runtime-lease",

      runnerBootId: "restart-runtime-boot",
      runnerId,
      runId: admittedRun.id,
      threadId: thread.id,
    });
    await seedDatabase
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", admittedRun.id)
      .executeTakeFirstOrThrow();
    const browserSessionId = createBrowserSessionId();
    await seedStore.createBrowserSession({
      id: browserSessionId,
      origin: "agent",
      placementKey: `runner:${runnerId}:restart-runtime`,
      profileId: null,
      runnerId,
      runtimeId: "restart-runtime",
      ownerId,
    });
    await seedStore.transitionBrowserSession({
      from: ["starting"],
      sessionId: browserSessionId,
      state: "ready",
    });
    const { thread: idleThread } = await seedStore.createThread({
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: thread.harnessInstanceId,
      idempotencyKey: "stranded-thread-state",
      modelSelection: testModelSelection,
      title: "Stranded projection",
      folder,
    });
    await seedDatabase
      .updateTable("threads")
      .set({ pendingRequestCount: 7 })
      .where("id", "=", idleThread.id)
      .execute();
    await sql`insert into thread_state_pending (thread_id, requested_at) values (${idleThread.id}, now())`.execute(
      seedDatabase,
    );
    await seedDatabase.destroy();

    runtime = await createHostRuntime(
      testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9")),
    );
    await expect(runtime.store.getThreadForOwner(idleThread.id, ownerId)).resolves.toMatchObject({
      pendingRequests: 0,
    });
    expect(
      (
        await sql`select * from thread_state_pending where thread_id = ${idleThread.id}`.execute(
          runtime.store.database,
        )
      ).rows,
    ).toEqual([]);
    await runtime.store.database
      .updateTable("threads")
      .set({ pendingRequestCount: 9 })
      .where("id", "=", idleThread.id)
      .execute();
    await sql`insert into thread_state_pending (thread_id, requested_at) values (${idleThread.id}, now())`.execute(
      runtime.store.database,
    );
    await vi.waitFor(
      async () => {
        expect(
          (await runtime!.store.getThreadForOwner(idleThread.id, ownerId))?.pendingRequests,
        ).toBe(0);
      },
      { timeout: 5000 },
    );
    const repaired = await runtime.store.database
      .selectFrom("deploymentEvents")
      .select("data")
      .where("threadId", "=", idleThread.id)
      .where("type", "=", "thread.state-changed")
      .execute();
    expect(repaired).toEqual([
      {
        data: {
          pendingRequests: 0,
          inputQueuePaused: false,
          status: "idle",
          title: idleThread.title,
          icon: idleThread.icon,
          doneAt: null,
          doneReason: null,
        },
      },
      {
        data: {
          pendingRequests: 0,
          inputQueuePaused: false,
          status: "idle",
          title: idleThread.title,
          icon: idleThread.icon,
          doneAt: null,
          doneReason: null,
        },
      },
    ]);
    await expect(
      runtime.store.database
        .selectFrom("browserSessions")
        .select("state")
        .where("id", "=", browserSessionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "failed" });
    // The browser session is gone with the Host that held it, but the Run is
    // not: it keeps its lease and continues when its Runner reattaches.
    await expect(
      runtime.store.database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", admittedRun.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "running" });
    await expect(
      runtime.store.database
        .selectFrom("deploymentEvents")
        .select("type")
        .where("runId", "=", admittedRun.id)
        .where("type", "=", "run.failed")
        .execute(),
    ).resolves.toEqual([]);
  });

  it("opens a browser module stream beside the primary connection, once per ticket", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-browser-module-"));
    const hostPort = await freePort();
    const config = testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9"));
    runtime = await createHostRuntime(config);
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    await initializeOwnerSession(origin);

    accountCaller = await attachHostingComputer(runtime, config, ownerSessionHeaders!, true);
    const enrollment = await testRpcData(
      origin,
      "commands.dispatch",
      {
        allowedModules: ["browser"],
        idempotencyKey: "enroll-browser-computer",
        name: "Browser computer",
        type: "runner.enrollment.createLocal",
      },
      { headers: authorization(accessToken) },
    );
    if (enrollment.type !== "runner.enrollment.createLocal") {
      throw new Error("Runner enrollment command mismatch.");
    }

    const runnerId = createId("runner");
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const primary = await openRunnerSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
    runnerSocket = primary.socket;
    // A browser-only computer advertises no work location, so it never invents
    // an environment it could not execute in.
    const descriptor = RunnerDescriptorSchema.parse({
      bootId,
      capabilities: [],
      modules: { browser: { wireVersion: 2, runtimeId: "relay-browser" } },
      name: "Browser computer",
      runnerId,
      runnerKind: "local",
      runtimeVersion: "integration",
    });
    const runnerKeys = await enrollRunnerSocket(
      primary.socket,
      descriptor,
      enrollment.token,
      primary.challenge,
    );

    const ticketed = waitForMessage(
      primary.socket,
      (message) => message.type === "host.auxiliary.ticket",
    );
    primary.socket.send(
      JSON.stringify({
        ...runnerKeys.fence,
        module: "browser",
        requestId: "browser-stream-1",
        type: "runner.auxiliary.ticket-request",
      }),
    );
    const issued = (await ticketed) as unknown as { readonly ticket: string };

    const auxiliary = await openAuxiliarySocket(
      `ws://127.0.0.1:${hostPort}/internal/v1/runners/auxiliary/browser`,
    );
    auxiliarySocket = auxiliary.socket;
    const welcomed = waitForMessage(
      auxiliary.socket,
      (message) => message.type === "host.auxiliary.welcome",
    );
    auxiliary.socket.send(
      JSON.stringify({
        bootId,
        challengeId: auxiliary.challenge.challengeId,
        module: "browser",
        runnerId,
        signature: createRunnerAuxiliarySignature(runnerKeys.privateKey, {
          bootId,
          challenge: auxiliary.challenge,
          module: "browser",
          runnerId,
          ticket: issued.ticket,
        }),
        ticket: issued.ticket,
        type: "runner.auxiliary.authenticate",
      }),
    );
    const welcome = RunnerAuxiliaryWelcomeSchema.parse(await welcomed);
    // The stream repeats the primary connection's fence, so a frame on it can
    // never be replayed onto a later boot of the same computer.
    expect(welcome).toMatchObject({
      ...runnerKeys.fence,
      module: "browser",
    });
    expect(welcome.browserAttachPublicKeys).toEqual([
      expect.objectContaining({ keyId: "host-v1" }),
    ]);

    // The ticket is one-use: a second stream presenting it is refused before it
    // carries anything.
    const replay = await openAuxiliarySocket(
      `ws://127.0.0.1:${hostPort}/internal/v1/runners/auxiliary/browser`,
    );
    const rejected = waitForMessage(
      replay.socket,
      (message) => message.type === "host.auxiliary.rejected",
    );
    replay.socket.send(
      JSON.stringify({
        bootId,
        challengeId: replay.challenge.challengeId,
        module: "browser",
        runnerId,
        signature: createRunnerAuxiliarySignature(runnerKeys.privateKey, {
          bootId,
          challenge: replay.challenge,
          module: "browser",
          runnerId,
          ticket: issued.ticket,
        }),
        ticket: issued.ticket,
        type: "runner.auxiliary.authenticate",
      }),
    );
    await expect(rejected).resolves.toMatchObject({
      error: { code: "forbidden", retryable: false },
    });
    await waitForClose(replay.socket);

    const inventory = await testRpcData(
      origin,
      "machines.list",
      {},
      { headers: authorization(accessToken) },
    );
    expect(inventory.machines).toContainEqual(
      expect.objectContaining({ id: runnerId, modules: { browser: expect.any(Object) } }),
    );

    // Revocation is the identity's, so it closes the primary connection and
    // every stream that was granted beside it.
    const primaryClosed = waitForClose(primary.socket);
    const auxiliaryClosed = waitForClose(auxiliary.socket);
    await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "revoke-browser-computer",
        machineId: runnerId,
        type: "machine.revoke",
      },
      { headers: authorization(accessToken) },
    );
    expect(await primaryClosed).toMatchObject({ code: 4010 });
    await auxiliaryClosed;
    runnerSocket = undefined;
    auxiliarySocket = undefined;
  });

  it("stands a Personal Host up passwordlessly with its one owner and agent home", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-local-bootstrap-"));
    // The native filesystem authority rejects symlinked parents. macOS exposes
    // `tmpdir()` through `/var`, which is itself a symlink to `/private/var`, so
    // canonicalize the completed fixture path before handing it to the helper.
    dataDirectory = await realpath(dataDirectory);
    const hostPort = await freePort();
    const ownerEnvironmentId = createId("environment");
    const accountIssuer = new URL("https://accounts.opensteer.test");
    const accountSigningKeys = generateKeyPairSync("ed25519");
    const accountSigningKeyId = "personal-account-test-key";
    const accountJwk = await exportJWK(accountSigningKeys.publicKey);
    let activationExpectation: {
      readonly challengeId: string;
      readonly deploymentId: string;
      readonly hostCredential: string;
      readonly linkGeneration: string;
    } | null = null;
    const hostAuthorityPublications: {
      readonly authorization: string;
      readonly deploymentId: string;
      readonly method: string;
    }[] = [];
    const personalAccountGrantFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input.toString());
      if (url.href === `${accountIssuer.origin}/v1/host/authority`) {
        const body: unknown = JSON.parse(String(init?.body));
        const deploymentId =
          PublishHostAuthorityRequestSchema.parse(body).authorityEnvelope.document.deploymentId;
        hostAuthorityPublications.push({
          authorization: String(
            (init?.headers as Record<string, string> | undefined)?.authorization,
          ),
          deploymentId,
          method: String(init?.method),
        });
        return Response.json({ deploymentId, published: true });
      }
      if (url.href === `${accountIssuer.origin}/api/auth/jwks`) {
        expect(init?.redirect).toBe("manual");
        return Response.json({
          keys: [
            {
              ...accountJwk,
              alg: "EdDSA",
              kid: accountSigningKeyId,
              use: "sig",
            },
          ],
        });
      }
      if (url.href === `${accountIssuer.origin}/v1/host/personal-account-link/activate`) {
        if (!activationExpectation) throw new Error("Unexpected Account-link activation");
        return Response.json({
          activated: true,
          deploymentId: activationExpectation.deploymentId,
          linkGeneration: activationExpectation.linkGeneration,
        });
      }
      throw new Error(`Unexpected Personal Account request: ${url.href}`);
    });
    const baseConfig = testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9"));
    const config: HostConfig = {
      ...baseConfig,
      // A Personal Deployment is single-user and loopback-only: nobody lends it
      // a machine from outside its own network.
      identity: {
        initialOwnerEnrollment: undefined,
        localPasswordEnabled: false,
        localOwnerClaimToken: "personal-owner-claim".padEnd(32, "x"),
        oidcConfigPath: undefined,
        signupPolicy: "invite-only",
      },
      exposure: "loopback",
      personalAccountIssuer: accountIssuer,
      canonicalOrigin: new URL(`http://localhost:${hostPort}`),
      runtimeOrigin: new URL(`http://localhost:${hostPort}`),
      deploymentShape: { kind: "personal" },
      personal: { environmentId: ownerEnvironmentId, agentHome: join(dataDirectory, "home") },
    };
    runtime = await createHostRuntime(config, {
      accountDirectoryFetch: personalAccountGrantFetch,
      personalAccountGrantFetch,
    });
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    const bootstrapUrl = `http://127.0.0.1:${hostPort}/v1/local-bootstrap`;
    const localSupervisorHeaders = {
      authorization: `Bearer ${"personal-owner-claim".padEnd(32, "x")}`,
    };
    const deniedBootstrap = await fetch(bootstrapUrl);
    expect(deniedBootstrap.status).toBe(404);
    const wrongBootstrap = await fetch(bootstrapUrl, {
      headers: { authorization: `Bearer ${"wrong-owner-claim".padEnd(32, "x")}` },
    });
    expect(wrongBootstrap.status).toBe(403);
    const offered = await jsonFetch(bootstrapUrl, { headers: localSupervisorHeaders });
    expect(offered.runnerEnrollmentToken).toEqual(expect.any(String));
    expect(offered.setupUrl).toEqual(expect.any(String));
    // The Main Runner is the only computer a same-machine supervisor is owed
    // an enrollment for; any further token here is a pending computer that
    // nothing will ever redeem.
    expect(Object.keys(offered).sort()).toEqual(["runnerEnrollmentToken", "setupUrl"]);

    // Repeating the call reuses the same unconsumed Runner enrollment.
    await expect(
      jsonFetch(bootstrapUrl, { headers: localSupervisorHeaders }),
    ).resolves.toMatchObject({
      runnerEnrollmentToken: offered.runnerEnrollmentToken,
    });

    // A browser announcing another origin is refused.
    const foreignOrigin = await fetch(bootstrapUrl, {
      headers: { ...localSupervisorHeaders, origin: "http://evil.example" },
    });
    expect(foreignOrigin.status).toBe(403);

    // A Personal stack is a Host and the Main Runner on the same computer. That
    // Runner holds the local directories, so it has to be attached before any
    // Workspace can exist — including Main.
    const mainRunner = await connectPrimary(
      hostPort,
      RunnerDescriptorSchema.parse({
        runnerId: createId("runner"),
        bootId: `rbt_${randomUUID()}`,
        name: "Hosting computer",
        runnerKind: "main",
        runtimeVersion: "integration",
        capabilities: [],
        modules: {
          agents: {
            environmentIds: [ownerEnvironmentId],
            harnessDrivers: [],
            maxConcurrentRuns: 1,
            providerStateModes: ["isolated"],
          },
        },
      }),
      { token: offered.runnerEnrollmentToken },
    );
    runnerSocket = mainRunner.socket;

    // The Desktop-held loopback proof asks the person for no password or
    // identity form. It atomically creates the sole machine owner and session.
    const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
      body: JSON.stringify({
        kind: "local-machine-owner",
        token: "personal-owner-claim".padEnd(32, "x"),
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            [hostApiVersionHeader]: String(hostApiVersion),
            "content-type": "application/json",
            origin,
          }),
        ),
      },
      method: "POST",
    });
    expect(claimed.status).toBe(200);
    const sessionHeaders = {
      [hostApiVersionHeader]: String(hostApiVersion),
      cookie: responseCookies(claimed).join("; "),
      origin,
    };
    const bootstrap = await testRpcData(origin, "bootstrap.get", {}, { headers: sessionHeaders });
    expect(bootstrap.user.displayName).toBe("You");
    expect(bootstrap.sessionSurface).toBe("canonical");
    expect(bootstrap.sessionId).toMatch(/^ses_/u);
    expect(bootstrap.personalSettings?.agentHome).toEqual({
      computerId: mainRunner.fence.runnerId,
      path: await realpath(join(dataDirectory, "home")),
    });
    // Setup is spent. The Main Runner enrollment stays replayable so a
    // supervisor that restarts mid-handshake can finish against the same
    // record instead of minting a second one.
    await expect(
      jsonFetch(bootstrapUrl, { headers: localSupervisorHeaders }),
    ).resolves.toMatchObject({
      runnerEnrollmentToken: offered.runnerEnrollmentToken,
      setupUrl: null,
    });

    // A supervisor retry restores the same local owner instead of creating a
    // second identity or asking for recovery credentials.
    const enrollmentBeforeRecovery = await runtime.store.database
      .selectFrom("ownerEnrollments")
      .selectAll()
      .executeTakeFirstOrThrow();
    const restored = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
      body: JSON.stringify({
        kind: "local-machine-owner",
        token: "personal-owner-claim".padEnd(32, "x"),
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            [hostApiVersionHeader]: String(hostApiVersion),
            "content-type": "application/json",
            origin,
          }),
        ),
      },
      method: "POST",
    });
    expect(restored.status).toBe(200);
    expect((await restored.json()) as object).toMatchObject({
      data: {
        session: expect.objectContaining({
          user: expect.objectContaining({ id: bootstrap.user.id }),
        }),
      },
      ok: true,
    });
    await expect(
      runtime.store.database.selectFrom("ownerEnrollments").selectAll().executeTakeFirstOrThrow(),
    ).resolves.toEqual(enrollmentBeforeRecovery);

    // Private network access is a separately signed HTTPS route. A wrong
    // reverse-proxy Origin cannot consume the code, while the exact route can.
    const privateOrigin = "https://personal.tailnet.example";
    const configuredPrivate = await fetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({ mode: "private", routeOrigin: privateOrigin, schemaVersion: 1 }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            ...sessionHeaders,
            [hostApiVersionHeader]: String(hostApiVersion),
            "content-type": "application/json",
          }),
        ),
      },
      method: "PUT",
    });
    expect(configuredPrivate.status).toBe(200);
    const privateStatus = PersonalRemoteAccessStatusSchema.parse(await configuredPrivate.json());
    expect(privateStatus).toMatchObject({ generation: 1, mode: "private" });
    const accessRoute = PersonalHostAccessRouteEnvelopeSchema.parse(
      await jsonFetch(`${origin}/.well-known/opensteer/personal-access-route`),
    );
    expect(accessRoute.document).toMatchObject({
      authority: expect.objectContaining({ canonicalOrigin: origin }),
      route: { generation: 1, kind: "private", origin: privateOrigin },
    });
    const pairing = await jsonFetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
      body: "{}",
      headers: {
        ...sessionHeaders,
        [hostApiVersionHeader]: String(hostApiVersion),
        "content-type": "application/json",
      },
      method: "POST",
    });
    const pairingCredential = {
      code: pairing.code,
      expectedRoute: accessRoute.document,
      kind: "personal-pairing-code",
    };
    const pairingBody = JSON.stringify({
      credential: pairingCredential,
      credentialDelivery: "cookie",
      schemaVersion: 2,
    });
    // The exchange must match the signed route coordinates; an Origin header
    // alone cannot supply them.
    const exchangeIngress = {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      host: new URL(privateOrigin).host,
      "x-forwarded-proto": "https",
    };
    const wrongRoute = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: pairingBody,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers({ ...exchangeIngress, host: "wrong.example" })),
      },
      method: "POST",
    });
    expect(wrongRoute.status).toBe(403);
    const claimedOrigin = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: pairingBody,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            [hostApiVersionHeader]: String(hostApiVersion),
            "content-type": "application/json",
            origin: privateOrigin,
          }),
        ),
      },
      method: "POST",
    });
    expect(claimedOrigin.status).toBe(403);
    const paired = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: pairingBody,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(exchangeIngress)),
      },
      method: "POST",
    });
    expect(paired.status, await paired.clone().text()).toBe(200);
    const remoteCookies = responseCookies(paired);
    const remoteCookie = paired.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-opensteer.session="));
    expect(remoteCookie).toContain("Path=/");
    expect(remoteCookie).toContain("HttpOnly");
    expect(remoteCookie).toContain("Secure");
    expect(remoteCookie).toContain("SameSite=Lax");
    expect(remoteCookie).not.toContain("Domain=");
    const replay = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: pairingBody,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(exchangeIngress)),
      },
      method: "POST",
    });
    expect(replay.status).toBe(403);
    const remoteHeaders = {
      [hostApiVersionHeader]: String(hostApiVersion),
      cookie: remoteCookies.join("; "),
      origin: privateOrigin,
    };
    const remoteBootstrap = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      { headers: remoteHeaders },
    );
    expect(remoteBootstrap).toMatchObject({
      sessionSurface: "personal-remote",
      user: expect.objectContaining({ id: bootstrap.user.id }),
    });
    const remoteMinted = await fetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
      body: "{}",
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({ ...remoteHeaders, "content-type": "application/json" }),
        ),
      },
      method: "POST",
    });
    expect(remoteMinted.status, await remoteMinted.clone().text()).toBe(200);
    expect(remoteMinted.headers.get("cache-control")).toBe("no-store");
    const nativePairing = IssuePersonalPairingCodeResponseSchema.parse(await remoteMinted.json());
    expect(nativePairing.generation).toBe(privateStatus.generation);

    // A code minted by a remote owner bootstraps another device with the same
    // owner authority. Header delivery sets no cookie.
    const nativePaired = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: JSON.stringify({
        credential: {
          code: nativePairing.code,
          expectedRoute: accessRoute.document,
          kind: "personal-pairing-code",
        },
        credentialDelivery: "header",
        schemaVersion: 2,
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(exchangeIngress)),
      },
      method: "POST",
    });
    expect(nativePaired.status, await nativePaired.clone().text()).toBe(200);
    expect(nativePaired.headers.getSetCookie()).toEqual([]);
    expect(nativePaired.headers.get("cache-control")).toBe("no-store");
    const nativeSession = SessionExchangeResponseSchema.parse(await nativePaired.json());
    if (nativeSession.credentialDelivery !== "header") {
      throw new Error("Expected header delivery");
    }
    const nativeHeaders = {
      authorization: `PersonalRemote ${nativeSession.credential.token}`,
    };
    await expect(
      testRpcData(origin, "bootstrap.get", {}, { headers: nativeHeaders }),
    ).resolves.toMatchObject({
      sessionSurface: "personal-remote",
      user: expect.objectContaining({ id: bootstrap.user.id }),
    });

    const nativeMinted = await fetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
      body: "{}",
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({ ...nativeHeaders, "content-type": "application/json" }),
        ),
      },
      method: "POST",
    });
    expect(nativeMinted.status, await nativeMinted.clone().text()).toBe(200);
    expect(nativeMinted.headers.get("cache-control")).toBe("no-store");
    expect(IssuePersonalPairingCodeResponseSchema.parse(await nativeMinted.json())).toMatchObject({
      generation: privateStatus.generation,
    });

    // Owner sessions can request Connect work, but cannot read executor credentials.
    for (const action of ["provision", "rotate"]) {
      for (const privateExecutor of [false, true]) {
        const response = await fetch(
          `${origin}/v1/personal-remote-access/${privateExecutor ? "executor/" : ""}connect-${action}`,
          {
            body: JSON.stringify({
              hostInstanceId: accessRoute.document.authority.hostInstanceId,
              operationId: `cop_${crypto.randomUUID()}`,
              ...(action === "provision" ? { localOrigin: origin } : {}),
            }),
            headers: {
              [hostApiVersionHeader]: String(hostApiVersion),
              ...Object.fromEntries(
                new Headers({ ...nativeHeaders, "content-type": "application/json" }),
              ),
            },
            method: "POST",
          },
        );
        expect(response.status).toBe(privateExecutor ? 403 : 404);
        expect(await response.text()).not.toContain("tunnelToken");
      }
    }
    // Session delivery is still reported independently of owner authority.
    await expect(
      testRpcData(origin, "integrations.get", {}, { headers: nativeHeaders }),
    ).resolves.toMatchObject({ authorizationSurface: "personal-remote" });

    // A header credential presented as a cookie is not that session, and an
    // authorization header the Host cannot read never reaches the cookie arm.
    const wrongFamily = await testRpcRequest(
      origin,
      "bootstrap.get",
      {},
      {
        headers: {
          cookie: `__Host-opensteer.session=${encodeURIComponent(nativeSession.credential.token)}`,
          origin: privateOrigin,
        },
      },
    );
    expect(wrongFamily.status).toBe(401);
    const remoteCredential = decodeURIComponent(remoteCookies[0]?.split("=", 2)[1] ?? "");
    const cookieAsHeader = await testRpcRequest(
      origin,
      "bootstrap.get",
      {},
      { headers: { authorization: `PersonalRemote ${remoteCredential}` } },
    );
    expect(cookieAsHeader.status).toBe(401);
    // Cookie names cannot change a credential's pinned delivery family or
    // turn a routed cookie into a canonical one.
    for (const [label, cookie] of [
      [
        "header token, canonical name",
        `opensteer.session=${encodeURIComponent(nativeSession.credential.token)}`,
      ],
      [
        "header token, remote name",
        `__Host-opensteer.session=${encodeURIComponent(nativeSession.credential.token)}`,
      ],
      ["cookie token, canonical name", `opensteer.session=${encodeURIComponent(remoteCredential)}`],
    ] as const) {
      const renamed = await testRpcRequest(
        origin,
        "bootstrap.get",
        {},
        { headers: { cookie, origin } },
      );
      expect(renamed.status, label).toBe(401);
    }
    for (const authorization of ["Foo x", "PersonalRemote"]) {
      const unreadable = await testRpcRequest(
        origin,
        "bootstrap.get",
        {},
        { headers: { ...sessionHeaders, authorization } },
      );
      expect(unreadable.status, authorization).toBe(401);
    }

    // A remote owner can turn access Off. The generation advances and both
    // remote delivery families are revoked in the same database transaction.
    const disabled = await fetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({ mode: "off", routeOrigin: null, schemaVersion: 1 }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({ ...remoteHeaders, "content-type": "application/json" }),
        ),
      },
      method: "PUT",
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      generation: 2,
      mode: "off",
      route: null,
    });
    const revokedBootstrap = await testRpcRequest(
      origin,
      "bootstrap.get",
      {},
      {
        headers: remoteHeaders,
      },
    );
    expect(revokedBootstrap.status).toBe(401);
    // Rotation is delivery-blind: the phone's credential dies with the cookie.
    const revokedNative = await testRpcRequest(
      origin,
      "bootstrap.get",
      {},
      { headers: nativeHeaders },
    );
    expect(revokedNative.status).toBe(401);

    // Link the existing loopback authority to the pinned Account issuer. The
    // completion JWT audience is the loopback canonical origin; it does not
    // replace that authority with the future Connect route.
    const authority = HostDescriptorSchema.parse(await jsonFetch(`${origin}/.well-known/opensteer`))
      .authority.document;
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const accountIdentity = { issuer: accountIssuer.origin, subject: accountId };
    const issuedAt = Math.floor(Date.now() / 1_000);
    const challengeId = `phc_${crypto.randomUUID()}`;
    const completionGrantId = `phg_${crypto.randomUUID()}`;
    const linkGeneration = "l".repeat(43);
    const hostCredential = `osc_${"h".repeat(43)}`;
    activationExpectation = {
      challengeId,
      deploymentId: authority.deploymentId,
      hostCredential,
      linkGeneration,
    };
    const completionGrant = await new SignJWT({
      account: accountIdentity,
      authority,
      challengeId,
      linkGeneration,
      tokenUse: "opensteer-personal-host-account-link",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: accountSigningKeyId })
      .setAudience(origin)
      .setExpirationTime(issuedAt + 120)
      .setIssuedAt(issuedAt)
      .setIssuer(accountIssuer.origin)
      .setJti(completionGrantId)
      .setSubject(accountId)
      .sign(accountSigningKeys.privateKey);
    const linked = await fetch(`${origin}/v1/personal-remote-access/account-link/consume`, {
      body: JSON.stringify(
        await sealedLinkCompletion(
          origin,
          sessionHeaders,
          accountIdentity,
          challengeId,
          completionGrant,
          hostCredential,
          linkGeneration,
        ),
      ),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            ...sessionHeaders,
            [hostApiVersionHeader]: String(hostApiVersion),
            "content-type": "application/json",
          }),
        ),
      },
      method: "POST",
    });
    expect(linked.status, await linked.clone().text()).toBe(200);
    const activationCall = personalAccountGrantFetch.mock.calls.find(
      ([input]) =>
        input.toString() === `${accountIssuer.origin}/v1/host/personal-account-link/activate`,
    );
    expect(activationCall?.[1]).toMatchObject({
      headers: expect.objectContaining({ authorization: `Bearer ${hostCredential}` }),
      method: "POST",
      redirect: "manual",
    });
    expect(JSON.parse(String(activationCall?.[1]?.body))).toEqual({
      challengeId,
      linkGeneration,
    });
    await expect(linked.json()).resolves.toMatchObject({
      accountLink: { generation: linkGeneration, ...accountIdentity },
      mode: "off",
      schemaVersion: 2,
    });
    const connectOrigin = "https://personal.connect.opensteer.test";
    const configuredConnect = await fetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({ mode: "connect", routeOrigin: connectOrigin, schemaVersion: 1 }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            ...sessionHeaders,
            [hostApiVersionHeader]: String(hostApiVersion),
            "content-type": "application/json",
          }),
        ),
      },
      method: "PUT",
    });
    expect(configuredConnect.status).toBe(200);
    const connectStatus = PersonalRemoteAccessStatusSchema.parse(await configuredConnect.json());
    expect(connectStatus).toMatchObject({
      accountLink: { generation: linkGeneration, ...accountIdentity },
      generation: 3,
      mode: "connect",
      schemaVersion: 2,
    });
    const connectRoute = PersonalHostAccessRouteEnvelopeSchema.parse(connectStatus.route);
    const oldGrantId = `ahs_${crypto.randomUUID()}`;
    await runtime.store.database
      .insertInto("personalRemoteSessionGrantUses")
      .values({
        consumedAt: new Date(Date.now() - 11 * 60_000),
        generation: connectStatus.generation,
        grantId: oldGrantId,
      })
      .executeTakeFirstOrThrow();
    const sessionGrantId = `ahs_${crypto.randomUUID()}`;
    const sessionGrant = await new SignJWT({
      account: accountIdentity,
      authority,
      clientSurface: "desktop",
      deploymentId: authority.deploymentId,
      personalHostAccessRouteEnvelopeSha256: personalHostAccessRouteEnvelopeSha256(connectRoute),
      route: connectRoute.document,
      routeGeneration: connectRoute.document.route.generation,
      targetKind: "personal-connect",
      tokenUse: "opensteer-account-host-session",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: accountSigningKeyId })
      .setAudience(origin)
      .setExpirationTime(issuedAt + 120)
      .setIssuedAt(issuedAt)
      .setIssuer(accountIssuer.origin)
      .setJti(sessionGrantId)
      .setSubject(accountId)
      .sign(accountSigningKeys.privateKey);
    const sessionCredential = {
      expectedRoute: connectRoute,
      grant: sessionGrant,
      kind: "account-connect-grant",
    };
    const sessionBody = JSON.stringify({
      credential: sessionCredential,
      credentialDelivery: "cookie",
      schemaVersion: 2,
    });
    const connectIngress = {
      "content-type": "application/json",
      host: new URL(connectOrigin).host,
      "x-forwarded-proto": "https",
    };
    const missingRouteOrigin = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: sessionBody,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers({ "content-type": "application/json" })),
      },
      method: "POST",
    });
    expect(missingRouteOrigin.status).toBe(403);
    // A desktop grant is signed for cookie delivery. Asking for the header
    // family names the native surface, which this grant is not.
    const wrongDelivery = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: JSON.stringify({
        credential: sessionCredential,
        credentialDelivery: "header",
        schemaVersion: 2,
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(connectIngress)),
      },
      method: "POST",
    });
    expect(wrongDelivery.status).toBe(403);
    const connected = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: sessionBody,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(connectIngress)),
      },
      method: "POST",
    });
    expect(connected.status).toBe(200);
    const connectRemoteCookie = connected.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-opensteer.session="));
    expect(connectRemoteCookie).toContain("HttpOnly");
    expect(connectRemoteCookie).toContain("Secure");
    expect(connectRemoteCookie).toContain("SameSite=Lax");
    expect(connectRemoteCookie).not.toContain("Domain=");
    await expect(
      runtime.store.database
        .selectFrom("personalRemoteSessionGrantUses")
        .select("grantId")
        .where("grantId", "=", oldGrantId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      runtime.store.database
        .selectFrom("personalRemoteSessionGrantUses")
        .select("grantId")
        .where("grantId", "=", sessionGrantId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ grantId: sessionGrantId });
    const replayedGrant = await fetch(`${origin}${sessionExchangePath}`, {
      body: sessionBody,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({ "content-type": "application/json", origin: connectOrigin }),
        ),
      },
      method: "POST",
    });
    expect(replayedGrant.status).toBe(403);
    const portalOrigin = "https://portal.opensteer.test";
    const browserIssuedAt = Math.floor(Date.now() / 1_000);
    const browserGrantId = `ahs_${crypto.randomUUID()}`;
    const browserGrant = await new SignJWT({
      account: accountIdentity,
      authority,
      clientSurface: "browser",
      deploymentId: authority.deploymentId,
      personalHostAccessRouteEnvelopeSha256: personalHostAccessRouteEnvelopeSha256(connectRoute),
      portalOrigin,
      route: connectRoute.document,
      routeGeneration: connectRoute.document.route.generation,
      targetKind: "personal-connect",
      tokenUse: "opensteer-account-host-session",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: accountSigningKeyId })
      .setAudience(origin)
      .setExpirationTime(browserIssuedAt + 120)
      .setIssuedAt(browserIssuedAt)
      .setIssuer(accountIssuer.origin)
      .setJti(browserGrantId)
      .setSubject(accountId)
      .sign(accountSigningKeys.privateKey);
    const browserExchangeHeaders = {
      "content-type": "application/x-www-form-urlencoded",
      host: new URL(connectOrigin).host,
      origin: portalOrigin,
      "x-forwarded-proto": "https",
    };
    const wrongPortal = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: new URLSearchParams({ grant: browserGrant }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({ ...browserExchangeHeaders, origin: "https://other-portal.example" }),
        ),
      },
      method: "POST",
      redirect: "manual",
    });
    expect(wrongPortal.status).toBe(403);
    const browserConnected = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: new URLSearchParams({ grant: browserGrant }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(browserExchangeHeaders)),
      },
      method: "POST",
      redirect: "manual",
    });
    expect(browserConnected.status, await browserConnected.clone().text()).toBe(303);
    expect(browserConnected.headers.get("location")).toBe("/");
    const browserCookie = browserConnected.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-opensteer.session="));
    expect(browserCookie).toContain("HttpOnly");
    expect(browserCookie).toContain("Secure");
    expect(browserCookie).toContain("SameSite=Lax");
    const browserCookiePair = browserCookie?.split(";", 1)[0] ?? "";
    const routeSocket = new WebSocket(
      `ws://127.0.0.1:${hostPort}/v1/realtime?opensteer_api_version=${hostApiVersion}`,
      {
        headers: { cookie: browserCookiePair, origin: connectOrigin },
      },
    );
    await new Promise<void>((resolve, reject) => {
      routeSocket.once("open", resolve);
      routeSocket.once("error", reject);
    });
    routeSocket.close();
    const refusedPortalSocket = new WebSocket(
      `ws://127.0.0.1:${hostPort}/v1/realtime?opensteer_api_version=${hostApiVersion}`,
      {
        headers: { cookie: browserCookiePair, origin: portalOrigin },
      },
    );
    await new Promise<void>((resolve, reject) => {
      refusedPortalSocket.once("unexpected-response", (_request, response) => {
        try {
          expect(response.statusCode).toBe(403);
          response.resume();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      refusedPortalSocket.once("open", () => reject(new Error("Portal-origin socket opened")));
      refusedPortalSocket.once("error", () => undefined);
    });
    const portalCannotMutate = await fetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            cookie: browserCookiePair,
            origin: portalOrigin,
          }),
        ),
      },
      method: "POST",
    });
    expect(portalCannotMutate.status).toBe(403);
    const tamperedParts = browserGrant.split(".");
    const signature = tamperedParts[2]!;
    tamperedParts[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const tampered = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: new URLSearchParams({ grant: tamperedParts.join(".") }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(browserExchangeHeaders)),
      },
      method: "POST",
      redirect: "manual",
    });
    expect(tampered.status).toBe(403);
    const wrongMediaType = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: new URLSearchParams({ grant: browserGrant }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({ ...browserExchangeHeaders, "content-type": "text/plain" }),
        ),
      },
      method: "POST",
      redirect: "manual",
    });
    expect(wrongMediaType.status).toBe(400);
    const staleRouteGrant = await new SignJWT({
      account: accountIdentity,
      authority,
      clientSurface: "browser",
      deploymentId: authority.deploymentId,
      personalHostAccessRouteEnvelopeSha256: personalHostAccessRouteEnvelopeSha256(connectRoute),
      portalOrigin,
      route: connectRoute.document,
      routeGeneration: connectRoute.document.route.generation,
      targetKind: "personal-connect",
      tokenUse: "opensteer-account-host-session",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: accountSigningKeyId })
      .setAudience(origin)
      .setExpirationTime(browserIssuedAt + 120)
      .setIssuedAt(browserIssuedAt)
      .setIssuer(accountIssuer.origin)
      .setJti(`ahs_${crypto.randomUUID()}`)
      .setSubject(accountId)
      .sign(accountSigningKeys.privateKey);
    // JWKS, activation, and the identity publication that activation ends with.
    expect(personalAccountGrantFetch).toHaveBeenCalledTimes(3);
    expect(hostAuthorityPublications).toHaveLength(1);
    const connectDisabled = await fetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({ mode: "off", routeOrigin: null, schemaVersion: 1 }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            ...sessionHeaders,
            [hostApiVersionHeader]: String(hostApiVersion),
            "content-type": "application/json",
          }),
        ),
      },
      method: "PUT",
    });
    expect(connectDisabled.status).toBe(200);
    await expect(connectDisabled.json()).resolves.toMatchObject({
      generation: 4,
      mode: "off",
      route: null,
    });
    const staleRouteExchange = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: new URLSearchParams({ grant: staleRouteGrant }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(browserExchangeHeaders)),
      },
      method: "POST",
      redirect: "manual",
    });
    expect(staleRouteExchange.status).toBe(403);
    const connectCookieHeader = connectRemoteCookie?.split(";", 1)[0];
    expect(connectCookieHeader).toBeDefined();
    const revokedConnect = await testRpcRequest(
      origin,
      "bootstrap.get",
      {},
      {
        headers: { cookie: connectCookieHeader!, origin: connectOrigin },
      },
    );
    expect(revokedConnect.status).toBe(401);
    const directory = new AccountDirectoryStore(runtime.store.database);
    const directoryProviderId = "oidc:opensteer-account";
    await directory.configureProvider({
      issuer: accountIssuer.origin,
      providerId: directoryProviderId,
    });
    await runtime.store.database
      .insertInto("authAccounts")
      .values({
        accessToken: null,
        accessTokenExpiresAt: null,
        accountId,
        createdAt: new Date(),
        id: createId("authAccount"),
        idToken: null,
        password: null,
        providerId: directoryProviderId,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        scope: "openid",
        updatedAt: new Date(),
        userId: bootstrap.user.id,
      })
      .executeTakeFirstOrThrow();
    await runtime.store.database
      .updateTable("accountDirectoryProjections")
      .set({ publishedGeneration: sql`generation` })
      .where("providerId", "=", directoryProviderId)
      .executeTakeFirstOrThrow();
    const publishedProjection = await runtime.store.database
      .selectFrom("accountDirectoryProjections")
      .select(["generation", "publishedGeneration"])
      .where("accountId", "=", accountId)
      .executeTakeFirstOrThrow();
    await runtime.close();
    hostAuthorityPublications.length = 0;
    runtime = await createHostRuntime(config, {
      accountDirectoryFetch: personalAccountGrantFetch,
      personalAccountGrantFetch,
    });

    // Identity now travels on its own path, so a restart re-asserts the signed
    // discovery envelope to the linked Account and leaves every already
    // published membership projection exactly where it was.
    await vi.waitFor(() => expect(hostAuthorityPublications).toHaveLength(1));
    expect(hostAuthorityPublications[0]).toEqual({
      authorization: `Bearer ${hostCredential}`,
      deploymentId: authority.deploymentId,
      method: "PUT",
    });
    await expect(
      runtime.store.database
        .selectFrom("accountDirectoryProjections")
        .select(["generation", "publishedGeneration"])
        .where("accountId", "=", accountId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual(publishedProjection);
  });

  it("fences every Account-derived capability behind an activated link and cancels from activating", async () => {
    dataDirectory = await realpath(await mkdtemp(join(tmpdir(), "opensteer-activating-link-")));
    const hostPort = await freePort();
    const ownerEnvironmentId = createId("environment");
    const accountIssuer = new URL("https://accounts.opensteer.test");
    const accountSigningKeys = generateKeyPairSync("ed25519");
    const accountSigningKeyId = "personal-account-fence-key";
    const accountJwk = await exportJWK(accountSigningKeys.publicKey);
    // The Account accepts the completion grant but never activates. That is
    // exactly the half-linked state a lost response leaves behind, and the one
    // this Host must refuse to treat as a link.
    let activationOutcome: "expired" | "not-found" = "expired";
    const accountCalls: string[] = [];
    const accountFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(input.toString());
      accountCalls.push(`${url.pathname}`);
      if (url.href === `${accountIssuer.origin}/api/auth/jwks`) {
        return Response.json({
          keys: [{ ...accountJwk, alg: "EdDSA", kid: accountSigningKeyId, use: "sig" }],
        });
      }
      if (url.href === `${accountIssuer.origin}/v1/host/personal-account-link/activate`) {
        return Response.json(
          {
            error: {
              code: "conflict",
              message: "reservation expired",
              reason: "personal-account-link-reservation-expired",
            },
          },
          { status: 409 },
        );
      }
      if (url.href === `${accountIssuer.origin}/v1/host/personal-account-link`) {
        if (activationOutcome === "not-found") {
          return Response.json(
            {
              error: {
                code: "not_found",
                message: "no link",
                reason: "personal-account-link-not-found",
              },
            },
            { status: 404 },
          );
        }
        return Response.json({
          deploymentId: HostDescriptorSchema.parse(
            await (await fetch(`http://localhost:${hostPort}/.well-known/opensteer`)).json(),
          ).authority.document.deploymentId,
          unlinked: true,
        });
      }
      throw new Error(`Unexpected Personal Account request: ${url.href}`);
    });
    const baseConfig = testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9"));
    const config: HostConfig = {
      ...baseConfig,
      // A Personal Deployment is single-user and loopback-only: nobody lends it
      // a machine from outside its own network.
      identity: {
        initialOwnerEnrollment: undefined,
        localPasswordEnabled: false,
        localOwnerClaimToken: "personal-owner-claim".padEnd(32, "x"),
        oidcConfigPath: undefined,
        signupPolicy: "invite-only",
      },
      exposure: "loopback",
      personalAccountIssuer: accountIssuer,
      canonicalOrigin: new URL(`http://localhost:${hostPort}`),
      runtimeOrigin: new URL(`http://localhost:${hostPort}`),
      deploymentShape: { kind: "personal" },
      personal: { environmentId: ownerEnvironmentId, agentHome: join(dataDirectory, "home") },
    };
    runtime = await createHostRuntime(config, {
      accountDirectoryFetch: accountFetch,
      personalAccountGrantFetch: accountFetch,
    });
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
      body: JSON.stringify({
        kind: "local-machine-owner",
        token: "personal-owner-claim".padEnd(32, "x"),
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            [hostApiVersionHeader]: String(hostApiVersion),
            "content-type": "application/json",
            origin,
          }),
        ),
      },
      method: "POST",
    });
    expect(claimed.status).toBe(200);
    const sessionHeaders = {
      [hostApiVersionHeader]: String(hostApiVersion),
      cookie: responseCookies(claimed).join("; "),
      origin,
    };
    accountCaller = await attachHostingComputer(runtime, config, sessionHeaders);
    const jsonHeaders = {
      ...sessionHeaders,
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
    };

    const authority = HostDescriptorSchema.parse(await jsonFetch(`${origin}/.well-known/opensteer`))
      .authority.document;
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const accountIdentity = { issuer: accountIssuer.origin, subject: accountId };
    const issuedAt = Math.floor(Date.now() / 1_000);
    const challengeId = `phc_${crypto.randomUUID()}`;
    const linkGeneration = "l".repeat(43);
    const hostCredential = `osc_${"h".repeat(43)}`;
    const completionGrant = await new SignJWT({
      account: accountIdentity,
      authority,
      challengeId,
      linkGeneration,
      tokenUse: "opensteer-personal-host-account-link",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: accountSigningKeyId })
      .setAudience(origin)
      .setExpirationTime(issuedAt + 120)
      .setIssuedAt(issuedAt)
      .setIssuer(accountIssuer.origin)
      .setJti(`phg_${crypto.randomUUID()}`)
      .setSubject(accountId)
      .sign(accountSigningKeys.privateKey);

    // The grant is valid, so the Host durably owns the link — but the Account
    // refuses to activate it, and the refusal is named rather than described.
    const consumed = await fetch(`${origin}/v1/personal-remote-access/account-link/consume`, {
      body: JSON.stringify(
        await sealedLinkCompletion(
          origin,
          sessionHeaders,
          accountIdentity,
          challengeId,
          completionGrant,
          hostCredential,
          linkGeneration,
        ),
      ),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(jsonHeaders)),
      },
      method: "POST",
    });
    expect(consumed.status).toBe(409);
    expect(await consumed.json()).toMatchObject({
      error: { code: "conflict", reason: "personal-account-link-reservation-expired" },
    });
    await expect(
      runtime.store.database
        .selectFrom("personalRemoteAccountLink")
        .select("state")
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "activating" });

    // A second challenge cannot be approved while that row holds the one slot.
    const secondProof = await fetch(`${origin}/v1/personal-remote-access/account-link/proof`, {
      body: JSON.stringify({
        account: accountIdentity,
        authorityEnvelope: HostDescriptorSchema.parse(
          await jsonFetch(`${origin}/.well-known/opensteer`),
        ).authority,
        completionFormat: "sealed-v1",
        challengeCredential: `olc_${"a".repeat(43)}`,
        challengeId: `phc_${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(jsonHeaders)),
      },
      method: "POST",
    });
    expect(secondProof.status).toBe(409);

    // Connect is the capability the link grants, and every door to it is shut.
    const connectRefused = await fetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({
        mode: "connect",
        routeOrigin: "https://personal.connect.opensteer.test",
        schemaVersion: 1,
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(jsonHeaders)),
      },
      method: "PUT",
    });
    expect(connectRefused.status).toBe(409);
    expect(await connectRefused.json()).toMatchObject({
      error: { message: "Link an Opensteer Account before enabling Connect" },
    });
    const projectionRefused = await fetch(
      `${origin}/v1/personal-remote-access/connect-projection`,
      {
        body: JSON.stringify({ expectedAccessRoute: null, schemaVersion: 2, state: "disabled" }),
        headers: {
          [hostApiVersionHeader]: String(hostApiVersion),
          ...Object.fromEntries(new Headers(jsonHeaders)),
        },
        method: "PUT",
      },
    );
    expect(projectionRefused.status).toBe(403);
    const revokeRefused = await fetch(`${origin}/v1/personal-remote-access/connect-resource`, {
      body: JSON.stringify({
        hostInstanceId: authority.hostInstanceId,
        operationId: `cop_${crypto.randomUUID()}`,
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(jsonHeaders)),
      },
      method: "DELETE",
    });
    expect(revokeRefused.status).toBe(409);
    // No Connect route exists, so no Account session grant can be exchanged
    // for one either: the exchange is fenced by the same unreachable state.
    expect(
      await jsonFetch(`${origin}/v1/personal-remote-access`, { headers: sessionHeaders }),
    ).toMatchObject({ mode: "off", route: null });

    // Every owner device sees the same complete link and its activation state;
    // Account execution credentials remain on the Host.
    const privateOrigin = "https://personal.tailnet.example";
    const configuredPrivate = await jsonFetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({ mode: "private", routeOrigin: privateOrigin, schemaVersion: 1 }),
      headers: jsonHeaders,
      method: "PUT",
    });
    expect(configuredPrivate).toMatchObject({
      accountLink: { ...accountIdentity, generation: linkGeneration, state: "activating" },
    });
    const accessRoute = PersonalHostAccessRouteEnvelopeSchema.parse(
      await jsonFetch(`${origin}/.well-known/opensteer/personal-access-route`),
    );
    const pairing = await jsonFetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
      body: "{}",
      headers: jsonHeaders,
      method: "POST",
    });
    const paired = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: JSON.stringify({
        credential: {
          code: pairing.code,
          expectedRoute: accessRoute.document,
          kind: "personal-pairing-code",
        },
        credentialDelivery: "cookie",
        schemaVersion: 2,
      }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(
          new Headers({
            "content-type": "application/json",
            host: new URL(privateOrigin).host,
            "x-forwarded-proto": "https",
          }),
        ),
      },
      method: "POST",
    });
    expect(paired.status, await paired.clone().text()).toBe(200);
    const remoteHeaders = { cookie: responseCookies(paired).join("; "), origin: privateOrigin };
    const remoteStatus = await jsonFetch(`${origin}/v1/personal-remote-access`, {
      headers: remoteHeaders,
    });
    expect(remoteStatus).toEqual(configuredPrivate);
    expect(remoteStatus.accountLink).toEqual({
      ...accountIdentity,
      generation: linkGeneration,
      state: "activating",
    });
    const remoteAdministration = await testRpcData(
      origin,
      "personal.remoteAccess.get",
      {},
      {
        headers: remoteHeaders,
      },
    );
    expect(remoteAdministration.access).toEqual(remoteStatus);
    for (const status of [remoteStatus, remoteAdministration]) {
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain(hostCredential);
      expect(serialized).not.toContain(completionGrant);
      expect(serialized).not.toContain("tunnelToken");
    }

    // Cancelling an activating link is one call, and the Account answering
    // "no such link" is a durable answer that completes it rather than a
    // failure that strands the owner half-linked.
    activationOutcome = "not-found";
    await fetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({ mode: "off", routeOrigin: null, schemaVersion: 1 }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(jsonHeaders)),
      },
      method: "PUT",
    });
    const removed = await fetch(`${origin}/v1/personal-remote-access/account-unlink/remove-link`, {
      body: JSON.stringify({ schemaVersion: 1 }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        ...Object.fromEntries(new Headers(jsonHeaders)),
      },
      method: "POST",
    });
    expect(removed.status, await removed.clone().text()).toBe(204);
    await expect(
      runtime.store.database
        .selectFrom("personalRemoteAccountLink")
        .select("state")
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    expect(
      await jsonFetch(`${origin}/v1/personal-remote-access`, { headers: sessionHeaders }),
    ).toMatchObject({ accountLink: null });
    expect(accountCalls).toContain("/v1/host/personal-account-link");
  });

  it("does not expose the local bootstrap route on a reachable Host", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-hosted-bootstrap-"));
    const hostPort = await freePort();
    const config = testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9"));
    runtime = await createHostRuntime(config);
    await runtime.listen();

    const response = await fetch(`${config.runtimeOrigin.origin}/v1/local-bootstrap`);
    expect(response.status).toBe(404);
  });
});

function testHostConfig(hostPort: number, hostDataDirectory: string, _storageUrl: URL): HostConfig {
  return parseHostConfig({
    OPENSTEER_MODE: "development",
    OPENSTEER_DEPLOYMENT_KIND: "personal",
    OPENSTEER_DATABASE_URL: databaseUrl ?? "postgres://unconfigured",
    OPENSTEER_AUTH_SECRET: "runtime-auth-secret".padEnd(40, "x"),
    OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: accessToken,
    OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
    OPENSTEER_HOST_DATA_DIR: hostDataDirectory,
    OPENSTEER_PORT: String(hostPort),
    OPENSTEER_BIND_ADDRESS: "127.0.0.1",
    OPENSTEER_CANONICAL_ORIGIN: `http://127.0.0.1:${hostPort}`,
    OPENSTEER_HOSTING_ENVIRONMENT_ID: hostingEnvironmentId,
    OPENSTEER_AGENT_HOME: join(hostDataDirectory, "home"),
  });
}

function withoutInitialOwner(config: HostConfig): HostConfig {
  return {
    ...config,
    identity: { ...config.identity, initialOwnerEnrollment: undefined },
  };
}

async function attachHostingComputer(
  runtime: PersonalHostRuntime,
  config: HostConfig,
  ownerHeaders: Record<string, string>,
  remoteAccess = false,
) {
  const local = await jsonFetch(`${config.runtimeOrigin.origin}/v1/local-bootstrap`, {
    headers: {
      authorization: `Bearer ${config.identity.localOwnerClaimToken}`,
      [hostApiVersionHeader]: String(hostApiVersion),
    },
  });
  const ownerId = (
    await runtime.store.database
      .selectFrom("ownerEnrollments")
      .select("consumedBy")
      .where("consumedBy", "is not", null)
      .executeTakeFirstOrThrow()
  ).consumedBy!;
  const computerId = createId("runner");
  return connectCallerMachine(
    {
      runtime,
      store: runtime.store,
      config,
      hostPort: config.port,
      origin: config.runtimeOrigin,
      ownerId,
      ownerHeaders,
      hostingComputerId: computerId,
      ownerEnvironmentId: config.personal!.environmentId,
      agentHome: { computerId, path: config.personal!.agentHome },
      remoteAccess,
    } as unknown as MachineAccessWireHost,
    { name: "Hosting computer", token: local.runnerEnrollmentToken },
  );
}

async function initializeOwnerSession(origin: string): Promise<void> {
  const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
    method: "POST",
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      ...Object.fromEntries(
        new Headers({
          [hostApiVersionHeader]: String(hostApiVersion),
          "content-type": "application/json",
          origin,
        }),
      ),
    },
    body: JSON.stringify({ kind: "local-machine-owner", token: accessToken }),
  });
  if (!claimed.ok) throw new Error(`Owner claim failed: ${claimed.status}`);
  ownerSessionHeaders = { cookie: responseCookies(claimed).join("; "), origin };
  const bootstrap = await fetch(`${origin}/v1/local-bootstrap`, {
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      ...Object.fromEntries(new Headers({ authorization: `Bearer ${accessToken}` })),
    },
  });
  runnerToken = ((await bootstrap.json()) as { runnerEnrollmentToken: string })
    .runnerEnrollmentToken;
}

function responseCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value));
}

async function administratorId(store: OpensteerStore) {
  const user = await store.firstUser();
  const full = user ? await store.userById(user.id) : null;
  if (!full) {
    throw new Error("Test administrator has not been initialized");
  }
  return full.id;
}

function waitForRunnerExecution(socket: WebSocket): Promise<
  Extract<HostToRunnerMessage, { type: "host.command" }> & {
    readonly command: Extract<
      Extract<HostToRunnerMessage, { type: "host.command" }>["command"],
      { type: "run.execute" }
    >;
  }
> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for run.execute")),
      10_000,
    );
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
      if (message.type !== "host.command" || message.command.type !== "run.execute") return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(message as Parameters<typeof resolve>[0]);
    };
    socket.on("message", receive);
  });
}

function waitForDeploymentEvent(
  socket: WebSocket,
  eventType: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for deployment event ${eventType}`)),
      10_000,
    );
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as {
        events?: Array<Record<string, unknown> & { type?: string }>;
        type: string;
      };
      if (message.type !== "host.events") return;
      const event = message.events?.find((candidate) => candidate.type === eventType);
      if (!event) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(event);
    };
    socket.on("message", receive);
  });
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for durable state");
}

// The Host seeds an Environment's default harness in its post-registration work,
// which can finish after enrollment has already answered the Runner.
async function seededHarness(store: PersonalHostRuntime["store"], environmentId: EnvironmentId) {
  await waitForCondition(
    async () => (await store.listHarnessInstances({ environmentIds: [environmentId] })).length > 0,
  );
  const [harness] = await store.listHarnessInstances({ environmentIds: [environmentId] });
  if (!harness) throw new Error("Default harness is missing");
  return harness;
}

function authorization(token: string): Record<string, string> {
  if (token === accessToken) {
    if (!ownerSessionHeaders) throw new Error("Test owner session has not been initialized");
    return ownerSessionHeaders;
  }
  return { authorization: `Bearer ${token}` };
}

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      ...Object.fromEntries(new Headers(init?.headers)),
    },
  });
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function openWebSocket(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      url + (url.includes("?") ? "&" : "?") + "opensteer_api_version=" + hostApiVersion,
      token ? { headers: authorization(token) } : undefined,
    );
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

/**
 * An agent-executing computer's descriptor from the flat fixtures these tests
 * write. The agent facts belong to one module now; nothing else about these
 * Runners changed, so the fixtures stay flat and this assembles the shape.
 */
function agentsRunnerDescriptor(input: {
  readonly bootId: string;
  readonly capabilities?: readonly string[];
  readonly device?: unknown;
  readonly environmentIds: readonly string[];
  readonly harnessDrivers: readonly unknown[];
  readonly localStorage?: unknown;
  readonly maxConcurrentRuns?: number;
  readonly name: string;
  readonly providerStateModes?: readonly string[];
  readonly runnerId: string;
  readonly runnerKind: string;
  readonly runtimeVersion: string;
  readonly workspaceBackings?: readonly string[];
  readonly workspaceMounts?: readonly unknown[];
}): RunnerDescriptor {
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: input.bootId,
    capabilities: [
      ...new Set([
        ...(input.capabilities ?? []),
        "native-session-continuation-v1",
        "assignments-v1",
        "steer-answer-v1",
        "browser-page-input-v1",
        "thread-state-v1",
        "requester-time-zone-v1",
        "agent-tools-plan-v1",
        "execution-plane-v2",
      ]),
    ],
    ...(input.device === undefined ? {} : { device: input.device }),
    modules: {
      agents: {
        environmentIds: input.environmentIds,
        harnessDrivers: input.harnessDrivers,
        maxConcurrentRuns: input.maxConcurrentRuns ?? 1,
        providerStateModes: input.providerStateModes ?? ["ambient", "isolated"],
        workspaceBackings: input.workspaceBackings ?? ["local-directory"],
        workspaceMounts: input.workspaceMounts ?? [],
      },
    },
    name: input.name,
    runnerId: input.runnerId,
    runnerKind: "main",
    runtimeVersion: input.runtimeVersion,
  });
  return descriptor;
}

async function enrollRunnerSocket(
  socket: WebSocket,
  descriptor: RunnerDescriptor,
  enrollmentToken: string,
  challengeInput: unknown,
): Promise<{
  readonly fence: RunnerConnectionFence;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}> {
  const challenge = RunnerChallengeSchema.parse(challengeInput);
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const credential = RunnerEnrollmentCredentialSchema.parse({
    enrollmentToken,
    kind: "host-enrollment-token",
  });
  socket.send(
    JSON.stringify({
      challengeId: challenge.challengeId,
      credential,
      descriptor,
      publicKeyPem,
      signature: createRunnerEnrollmentSignature(pair.privateKey, {
        challenge,
        credential,
        descriptor,
        publicKeyPem,
      }),
      proofFormatVersion: 2,
      type: "runner.enroll",
    }),
  );
  const welcome = (await waitForMessage(
    socket,
    (message) => message.type === "host.welcome",
  )) as unknown as RunnerConnectionFence;
  // A Runner states the Runs it holds before the Host sends it any work.
  if (descriptor.modules.agents)
    socket.send(
      JSON.stringify({
        ...runnerFence(welcome),
        complete: true,
        executions: [],
        type: "runner.executions.attach",
      }),
    );
  return { fence: runnerFence(welcome), privateKey: pair.privateKey, publicKey: pair.publicKey };
}

async function openRunnerSocket(url: string): Promise<{
  readonly challenge: { readonly type: string };
  readonly socket: WebSocket;
}> {
  const socket = new WebSocket(url);
  const challenge = waitForMessage(socket, (message) => message.type === "host.challenge");
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { challenge: await challenge, socket };
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: { type: string }) => boolean,
): Promise<{ type: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket message")),
      10_000,
    );
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as { type: string };
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
}

/**
 * The fence the Host stamped on the frame being answered. Every frame in both
 * directions repeats it after authentication, so echoing the one that arrived
 * is exactly what a real Runner does.
 */
function runnerFence(message: RunnerConnectionFence): RunnerConnectionFence {
  return {
    bootId: message.bootId,
    connectionGeneration: message.connectionGeneration,
    connectionId: message.connectionId,
    connectionLeaseId: message.connectionLeaseId,
    runnerId: message.runnerId,
  };
}

/** Answers every AI-engine sign-in request the way an idle Runner would. */
function respondToHarnessAuthentication(socket: WebSocket): () => void {
  const receive = (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
    if (message.type !== "host.harness-authentication") return;
    const request = message.request;
    socket.send(
      JSON.stringify({
        ...runnerFence(message),
        driverKind: "harness" in request ? request.harness.driverKind : request.driverKind,
        harnessInstanceId: "harness" in request ? request.harness.id : request.harnessInstanceId,
        requestId: message.requestId,
        state: { status: "not-started" },
        type: "runner.harness-authentication",
      }),
    );
  };
  socket.on("message", receive);
  return () => socket.off("message", receive);
}

function respondToHarnessInspections(
  socket: WebSocket,
  catalogFor: (
    harness: Extract<
      HostToRunnerMessage,
      { type: "host.reconcile-harnesses" }
    >["harnesses"][number],
  ) => Extract<
    import("@opensteer/protocol").RunnerOperationalMessage,
    { type: "runner.harness-catalog" }
  >["catalogs"][number],
  beforePublish?: () => Promise<void>,
): () => void {
  const receive = (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
    if (message.type !== "host.inspect-harnesses" && message.type !== "host.reconcile-harnesses") {
      return;
    }
    const publish = () =>
      socket.send(
        JSON.stringify({
          ...runnerFence(message),
          catalogs: message.harnesses
            .filter(
              (harness) =>
                message.type !== "host.reconcile-harnesses" ||
                message.inspect === undefined ||
                message.inspect.includes(harness.id),
            )
            .map(catalogFor),
          requestId: message.requestId,
          type: "runner.harness-catalog",
        }),
      );
    if (beforePublish) void beforePublish().then(publish);
    else publish();
  };
  socket.on("message", receive);
  return () => socket.off("message", receive);
}

function readyCodexCatalog(
  harness: Extract<HostToRunnerMessage, { type: "host.reconcile-harnesses" }>["harnesses"][number],
) {
  return HarnessInstanceCatalogSchema.parse({
    continuationIdentity: {
      continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
      driverKind: harness.driverKind,
    },
    driverKind: harness.driverKind,
    harnessInstanceId: harness.id,
    models: [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        options: [
          {
            defaultValue: "low",
            id: "effort",
            label: "Reasoning effort",
            type: "select",
            values: [
              { label: "Low", value: "low" },
              { label: "Medium", value: "medium" },
            ],
          },
        ],
        providerId: "openai",
      },
    ],
    status: "ready",
  });
}

async function openAuxiliarySocket(url: string): Promise<{
  readonly challenge: RunnerAuxiliaryChallenge;
  readonly socket: WebSocket;
}> {
  const socket = new WebSocket(url);
  const challenge = waitForMessage(
    socket,
    (message) => message.type === "host.auxiliary.challenge",
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { challenge: RunnerAuxiliaryChallengeSchema.parse(await challenge), socket };
}

function waitForClose(
  socket: WebSocket,
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

async function sealedLinkCompletion(
  origin: string,
  headers: Record<string, string>,
  account: {
    issuer: string;
    subject: import("@opensteer/control-plane-protocol").ControlPlaneAccountId;
  },
  challengeId: string,
  completionGrant: string,
  hostCredential: string,
  linkGeneration: string,
) {
  const envelope = HostDescriptorSchema.parse(
    await jsonFetch(`${origin}/.well-known/opensteer`),
  ).authority;
  const response = await fetch(`${origin}/v1/personal-remote-access/account-link/proof`, {
    method: "POST",
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      ...Object.fromEntries(
        new Headers({
          ...headers,
          [hostApiVersionHeader]: String(hostApiVersion),
          "content-type": "application/json",
        }),
      ),
    },
    body: JSON.stringify({
      account,
      authorityEnvelope: envelope,
      challengeId,
      completionFormat: "sealed-v1",
      challengeCredential: `olc_${"a".repeat(43)}`,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    }),
  });
  expect(response.status).toBe(200);
  const proof = PersonalHostAccountLinkProofEnvelopeSchema.parse(await response.json());
  const metadata = CompletePersonalHostAccountLinkResponseSchema.omit({
    sealedCompletion: true,
  }).parse({
    challengeId,
    linkGeneration,
    resultExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    schemaVersion: 2,
  });
  return {
    ...metadata,
    sealedCompletion: sealOAuthBrokerPayload(
      {
        completionGrant,
        hostCredential,
        linkGeneration,
        resultExpiresAt: metadata.resultExpiresAt,
      },
      proof.document.completionPublicKey,
      personalHostAccountLinkCompletionContext(
        proof.document.authority,
        metadata.challengeId,
        metadata.linkGeneration,
      ),
    ),
  };
}
