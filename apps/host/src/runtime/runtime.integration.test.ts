import { EventEmitter } from "node:events";
import {
  runnerReady,
  type RunnerReadinessSnapshot,
} from "../agents/runner-readiness.test-support.js";
import { gate } from "@opensteer/shared/test-support/observation";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import {
  advanceExecutionClock,
  executionLeaseExpiresAt,
} from "../agents/execution-clock.test-support.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEventSchema,
  HarnessIdSchema,
  ThreadAccessModeSchema,
  ModelSelectionSchema,
  WorkspaceIdSchema,
  createId,
  zeroSequence,
  type MessageId,
  type EnvironmentId,
  type WorkspaceIconName,
  EnvironmentIdSchema,
} from "@opensteer/core";
import type { HostConfig } from "@opensteer/config";
import {
  ControlPlaneAccountIdSchema,
  DirectoryProjectionRequestSchema,
  PublishHostAuthorityRequestSchema,
  personalHostAccessRouteEnvelopeSha256,
} from "@opensteer/control-plane-protocol";
import { slackChannelProviderManifest } from "@opensteer/channel-core";
import {
  HostDescriptorSchema,
  hostApiVersion,
  hostKeyFingerprint,
} from "@opensteer/deployment-authority";
import {
  createBrowserSessionId,
  PersonalHostAccessRouteEnvelopeSchema,
  PersonalRemoteAccessStatusSchema,
  HarnessInstanceCatalogSchema,
  PendingAgentEventSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerBootIdSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  RunnerEnrollmentCredentialSchema,
  SessionExchangeResponseSchema,
  sessionExchangePath,
  type HostToRunnerMessage,
  type RunnerAuxiliaryChallenge,
  type RunnerConnectionFence,
  type RunnerDescriptor,
  hostApiVersionHeader,
} from "@opensteer/protocol";
import {
  canonicalRunnerPublicKeyPem,
  createRunnerAuthenticationSignature,
  createRunnerAuxiliarySignature,
  createRunnerEnrollmentSignature,
  hashRunnerEnrollmentToken,
  runnerPublicKeyFingerprint,
} from "@opensteer/runner-auth";
import { exportJWK, SignJWT } from "jose";
import { sql } from "kysely";
import WebSocket from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountDirectoryStore,
  createDatabase,
  migrateToLatest,
  OpensteerStore,
} from "@opensteer/database";
import { createHostRuntime, ensureDefaultHarnesses, type HostRuntime } from "./runtime.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { fetchWithExplicitHost } from "../access/session-exchange.test-support.js";
import { loadOrCreateHostInstance } from "../identity/host-instance.js";
import { loadOrCreateHostKeys } from "../identity/host-keys.js";
import { startPortableFsManagerFake as startPortableFsController } from "./portablefs-manager.test-support.js";
import { connectLocalWorkspaceRunner } from "../workspace/runner-local-workspace.test-support.js";

const portableFsTestCsrPem = `-----BEGIN CERTIFICATE REQUEST-----
MIGOMEICAQAwDzENMAsGA1UEAwwEdGVzdDAqMAUGAytlcAMhAAYGrSfAi57mfReG
R2aFY+3K8yYGH4DbIXXJcl5SkdT5oAAwBQYDK2VwA0EAGrT0jM/3L4H0b3NNmPWi
y8bGphvw7IH69FOsfMn8nAJYBRlR9UD0j4soZYoYkT+zjZ/iO4FIwasapMoVchkt
Cw==
-----END CERTIFICATE REQUEST-----
`;

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
  let runtime: HostRuntime | undefined;
  let runnerSocket: WebSocket | undefined;
  let auxiliarySocket: WebSocket | undefined;
  let realtimeSocket: WebSocket | undefined;
  let portableFs: Awaited<ReturnType<typeof startPortableFsController>> | undefined;
  let dataDirectory: string | undefined;

  beforeAll(async () => {
    await mkdir(evidenceRoot, { recursive: true });
    console.info(`Task mark runtime receipts: ${evidenceRoot}`);
  });

  beforeEach(async () => {
    ownerSessionHeaders = undefined;
    runnerToken = "";
    const database = createDatabase({ connectionString: databaseUrl ?? "postgres://unconfigured" });
    await migrateToLatest(database);
    await sql`
      truncate table
        personal_remote_session_grant_uses,
        personal_remote_sessions,
        personal_remote_pairing_codes,
        personal_remote_account_link,
        account_directory_provider,
        account_directory_projections,
        auth_rate_limits,
        auth_verifications,
        auth_admissions,
        auth_sso_providers,
        owner_enrollments,
        security_effects,
        security_audit,
        credential_access_audit,
        credential_vault_canaries,
        browser_profile_grants,
        browser_sessions,
        browser_profile_revisions,
        browser_profiles,
        credentials,
        workspace_events,
        commands,
        provider_sessions,
        messages,
        runs,
        threads,
        harness_instances,
        workspaces,
        execution_environments,
        runners,
        deployments,
        users
      restart identity cascade
    `.execute(database);
    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 0, mode: "off", routeOrigin: null, updatedAt: new Date() })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
    await database.destroy();
  });

  afterEach(async () => {
    runnerSocket?.close();
    runnerSocket = undefined;
    auxiliarySocket?.close();
    auxiliarySocket = undefined;
    realtimeSocket?.close();
    realtimeSocket = undefined;
    await runtime?.close();
    runtime = undefined;
    await portableFs?.close();
    portableFs = undefined;
    if (dataDirectory) await rm(dataDirectory, { force: true, recursive: true });
    dataDirectory = undefined;
  });

  it.each(["neither", "title", "both"] as const)(
    "gates name requests for Runner capabilities %s, fences reports and publishes marks",
    async (capabilities) => {
      const capable = capabilities !== "neither";
      const icons = capabilities === "both";
      portableFs = await startPortableFsController();
      dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-title-runtime-"));
      const hostPort = await freePort();
      const config = testHostConfig(hostPort, dataDirectory, portableFs.url);
      runtime = await createHostRuntime(config, {
        portableFsMountManagerEndpoint: portableFs.mountEndpoint,
      });
      await runtime.listen();
      const origin = config.runtimeOrigin.origin;
      await initializeOwnerSession(origin);
      const bootstrap = await testRpcData(
        origin,
        "bootstrap.get",
        {},
        { headers: authorization(accessToken) },
      );
      if (!bootstrap.homeWorkspace) throw new Error("Missing Main Workspace");
      const workspaceId = bootstrap.homeWorkspace.id;
      expect(bootstrap.homeWorkspace.color).toBeDefined();
      expect(bootstrap.workspaces.find((workspace) => workspace.id === workspaceId)?.color).toBe(
        bootstrap.homeWorkspace.color,
      );
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      const connection = await openRunnerSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
      runnerSocket = connection.socket;
      respondToHarnessInspections(runnerSocket, readyCodexCatalog);
      const enrollment = await enrollRunnerSocket(
        runnerSocket,
        agentsRunnerDescriptor({
          bootId: `rbt_${randomUUID()}`,
          capabilities: icons
            ? ["filesystem", "thread-title-v1", "thread-icon-v1"]
            : capable
              ? ["filesystem", "thread-title-v1"]
              : ["filesystem"],
          environmentIds: [environmentId],
          harnessDrivers: [
            {
              accessModes: ThreadAccessModeSchema.options,
              driverKind: "codex",
              readiness: "configured",
              sources: [openAiSource],
            },
          ],
          name: "Title Runner",
          runnerId,
          runnerKind: "local",
          runtimeVersion: "test",
        }),
        runnerToken,
        connection.challenge,
      );
      runnerSocket.send(
        JSON.stringify({
          ...enrollment.fence,
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
      let harnessInstanceId = "";
      await waitForCondition(async () => {
        const connected = await testRpcData(
          origin,
          "bootstrap.get",
          {},
          { headers: authorization(accessToken) },
        );
        harnessInstanceId =
          connected.harnesses.find((harness) => harness.driverKind === "codex")?.id ?? "";
        return harnessInstanceId.length > 0;
      });
      const created = await testRpcData(
        origin,
        "commands.dispatch",
        {
          environmentId,
          harnessInstanceId,
          idempotencyKey: "title-create",
          modelSelection: testModelSelection,
          generateTitle: true,
          title: "Seed title",
          type: "thread.create",
          workspaceId,
        },
        { headers: authorization(accessToken) },
      );
      if (created.type !== "thread.create") throw new Error("Expected Thread creation");
      const threadId = created.thread.id;
      realtimeSocket = await openWebSocket(`ws://127.0.0.1:${hostPort}/v1/realtime`, accessToken);
      realtimeSocket.send(
        JSON.stringify({
          afterSequence: created.asOfSequence,
          apiVersion: hostApiVersion,
          threadId: null,
          type: "client.subscribe",
          workspaceId,
        }),
      );
      await waitForMessage(realtimeSocket, (message) => message.type === "host.synchronized");
      const observed: unknown[] = [];
      realtimeSocket.on("message", (frame) => {
        const parsed: unknown = JSON.parse(frame.toString());
        observed.push(parsed);
      });
      const executing = waitForRunnerExecution(runnerSocket);
      const turn = await testRpcData(
        origin,
        "commands.dispatch",
        {
          content: [{ type: "text", text: "Please summarize the quarterly report" }],
          idempotencyKey: "title-input",
          threadId,
          type: "thread.sendMessage",
        },
        { headers: authorization(accessToken) },
      );
      if (turn.type !== "thread.sendMessage" || !turn.run) throw new Error("Expected Run");
      const execution = await executing;
      const context = execution.command.context;
      expect(context.titleRequest).toEqual(
        capable
          ? { request: "Please summarize the quarterly report", ...(icons ? { icon: true } : {}) }
          : undefined,
      );
      runnerSocket.send(
        JSON.stringify({
          ...enrollment.fence,
          commandId: execution.command.commandId,
          correlationId: execution.command.correlationId,
          type: "runner.command-accepted",
        }),
      );
      const report = {
        ...enrollment.fence,
        bindingGeneration: context.bindingGeneration,
        environmentId,
        runId: context.runId,
        threadId,
        workspaceId,
        title: "Quarterly report review",
        ...(icons ? { icon: "plane" } : {}),
        type: "runner.thread-title",
      };
      if (capable) {
        for (const override of [
          { bindingGeneration: context.bindingGeneration + 1 },
          { threadId: createId("thread") },
          { workspaceId: createId("workspace") },
          { environmentId: createId("environment") },
          { runId: createId("run") },
        ]) {
          runnerSocket.send(JSON.stringify({ ...report, ...override, title: "Invalid binding" }));
        }
        runnerSocket.send(JSON.stringify(report));
        runnerSocket.send(JSON.stringify({ ...report, title: "Duplicate candidate" }));
        await waitForCondition(
          async () =>
            (await runtime!.store.getThreadForOwner(threadId, bootstrap.user.id))?.title ===
            report.title,
        );
        expect(
          await runtime.store.database
            .selectFrom("threads")
            .select("titleSource")
            .where("id", "=", threadId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ titleSource: "generated" });
      }
      const renamed = await testRpcData(
        origin,
        "commands.dispatch",
        {
          type: "thread.rename",
          threadId,
          title: "My quarterly report",
          idempotencyKey: "title-rename",
        },
        { headers: authorization(accessToken) },
      );
      if (renamed.type !== "thread.rename") throw new Error("Expected rename");
      expect(renamed.thread.title).toBe("My quarterly report");
      runnerSocket.send(JSON.stringify({ ...report, title: "Late title after rename" }));
      runnerSocket.send(
        JSON.stringify({
          ...enrollment.fence,
          type: "runner.event",
          event: {
            bindingGeneration: context.bindingGeneration,
            emittedAt: new Date().toISOString(),
            environmentId,
            ordinal: 0,
            runId: context.runId,
            threadId,
            workspaceId,
            type: "run.failed",
            data: {
              code: "test-startup",
              message: "Simulated failed first Run",
              retryable: false,
              status: "failed",
            },
          },
        }),
      );
      await waitForCondition(
        async () =>
          (
            await runtime!.store.database
              .selectFrom("runs")
              .select("status")
              .where("id", "=", context.runId)
              .executeTakeFirst()
          )?.status === "failed",
      );
      const titleEvents = await runtime.store.database
        .selectFrom("workspaceEvents")
        .selectAll()
        .where("threadId", "=", threadId)
        .where("type", "=", "thread.state-changed")
        .orderBy("sequence")
        .execute();
      expect(
        titleEvents.map((event) => {
          const parsed = AgentEventSchema.parse({
            ...event,
            createdAt: event.createdAt.toISOString(),
          });
          if (parsed.type !== "thread.state-changed") throw new Error("Expected a state event");
          return parsed.data.title;
        }),
      ).toEqual(
        capable
          ? ["Seed title", "Quarterly report review", "My quarterly report", "My quarterly report"]
          : ["Seed title", "My quarterly report", "My quarterly report"],
      );
      await waitForCondition(async () =>
        JSON.stringify(observed).includes('"title":"My quarterly report"'),
      );
      if (capable) expect(JSON.stringify(observed)).toContain('"title":"Quarterly report review"');
      const after = await runtime.store.getThreadForOwner(threadId, bootstrap.user.id);
      expect(after?.title).toBe("My quarterly report");
      expect(
        titleEvents.every((event) =>
          Object.hasOwn(
            AgentEventSchema.parse({ ...event, createdAt: event.createdAt.toISOString() }).data,
            "icon",
          ),
        ),
      ).toBe(true);
      expect(after?.icon).toBe(icons ? "plane" : null);
      const edited = await testRpcData(
        origin,
        "commands.dispatch",
        {
          type: "thread.icon.set",
          threadId,
          icon: null,
          idempotencyKey: "pick-default",
        },
        { headers: authorization(accessToken) },
      );
      expect(edited).toMatchObject({
        type: "thread.icon.set",
        thread: { icon: "document", color: created.thread.color },
      });
      const named = await testRpcData(
        origin,
        "commands.dispatch",
        {
          type: "thread.create",
          environmentId,
          harnessInstanceId,
          idempotencyKey: "chosen-name-create",
          modelSelection: testModelSelection,
          title: "Chosen name",
          workspaceId,
        },
        { headers: authorization(accessToken) },
      );
      if (named.type !== "thread.create") throw new Error("Expected named Thread");
      const iconExecution = waitForRunnerExecution(runnerSocket);
      await testRpcData(
        origin,
        "commands.dispatch",
        {
          type: "thread.sendMessage",
          threadId: named.thread.id,
          idempotencyKey: "chosen-name-input",
          content: [{ type: "text", text: "Book a flight" }],
        },
        { headers: authorization(accessToken) },
      );
      const iconContext = (await iconExecution).command.context;
      expect(iconContext.titleRequest).toEqual(
        icons ? { request: "Book a flight", icon: true } : undefined,
      );
      if (icons) {
        runnerSocket.send(
          JSON.stringify({
            ...enrollment.fence,
            type: "runner.thread-title",
            bindingGeneration: iconContext.bindingGeneration,
            environmentId,
            runId: iconContext.runId,
            threadId: named.thread.id,
            workspaceId,
            icon: "plane",
          }),
        );
        await waitForCondition(
          async () =>
            (await runtime!.store.getThreadForOwner(named.thread.id, bootstrap.user.id))?.icon ===
            "plane",
        );
        expect(
          (await runtime.store.getThreadForOwner(named.thread.id, bootstrap.user.id))?.title,
        ).toBe("Chosen name");
      }
      const evidence = join(evidenceRoot, `host-runtime-${capabilities}-${randomUUID()}.json`);
      await writeFile(
        evidence,
        JSON.stringify(
          {
            capable,
            titleRequest: context.titleRequest ?? null,
            titleEvents,
            observed,
            thread: after,
          },
          null,
          2,
        ),
      );
      console.info(`Title runtime receipt: ${evidence}`);
    },
  );

  it("provisions a workspace and carries a Runner turn through durable projection", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-host-integration-"));
    const hostPort = await freePort();
    const config = testHostConfig(hostPort, dataDirectory, portableFs.url);
    runtime = await createHostRuntime(config, {
      portableFsMountManagerEndpoint: portableFs.mountEndpoint,
    });
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    await initializeOwnerSession(origin);

    const unauthorized = await testRpcRequest(origin, "bootstrap.get", {});
    expect(unauthorized.status).toBe(401);
    const bootstrap = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      {
        headers: authorization(accessToken),
      },
    );
    expect(bootstrap.user.displayName).toBe("Alex");
    // This Host names no apex portal, so the config every client reads on boot
    // reports none and the web UI renders no way "up" out of a self-hosted
    // Deployment.
    expect(bootstrap.identityConfig).toMatchObject({
      deployment: { cloud: false, kind: "self-hosted", name: null },
      portalOrigin: null,
    });
    expect(bootstrap.harnesses).toEqual([]);
    expect(bootstrap.homeWorkspace).toMatchObject({ kind: "main" });
    if (!bootstrap.homeWorkspace) throw new Error("Main Workspace is missing.");
    const homeWorkspaceId = bootstrap.homeWorkspace.id;
    let harnessInstanceId = "";

    const localEnrollment = await testRpcData(
      origin,
      "commands.dispatch",
      {
        allowedModules: ["agents"],
        idempotencyKey: "enroll-example-mac-1",
        name: "Alex's Mac",
        type: "runner.enrollment.createLocal",
      },
      { headers: authorization(accessToken) },
    );
    const localEnrollmentReplay = await testRpcData(
      origin,
      "commands.dispatch",
      {
        allowedModules: ["agents"],
        idempotencyKey: "enroll-example-mac-1",
        name: "Alex's Mac",
        type: "runner.enrollment.createLocal",
      },
      { headers: authorization(accessToken) },
    );
    if (
      localEnrollment.type !== "runner.enrollment.createLocal" ||
      localEnrollmentReplay.type !== "runner.enrollment.createLocal"
    ) {
      throw new Error("Runner enrollment command mismatch.");
    }
    expect(localEnrollmentReplay).toEqual(localEnrollment);
    expect(localEnrollment.token).toHaveLength(86);
    const created = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "workspace-1",
        name: "Client workspace",
        type: "workspace.create",
      },
      { headers: authorization(accessToken) },
    );
    if (created.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    expect(created.workspace.status).toBe("ready");
    // Main was provisioned by the first bootstrap; this is the second volume.
    expect(created.workspace.kind).toBe("specialized");
    expect(portableFs.createCalls).toBe(2);
    const bootstrapAfterSpecializedWorkspace = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      {
        headers: authorization(accessToken),
      },
    );
    expect(bootstrapAfterSpecializedWorkspace.workspaces[0]?.id).toBe(created.workspace.id);
    expect(bootstrapAfterSpecializedWorkspace.homeWorkspace?.id).toBe(homeWorkspaceId);
    const duplicate = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "workspace-1",
        name: "Client workspace",
        type: "workspace.create",
      },
      { headers: authorization(accessToken) },
    );
    if (duplicate.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    expect(duplicate.workspace.id).toBe(created.workspace.id);
    expect(portableFs.createCalls).toBe(2);
    const conflictingWorkspaceRetry = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "workspace-1",
        name: "Different workspace",
        type: "workspace.create",
      },
      { headers: authorization(accessToken) },
    );
    expect(conflictingWorkspaceRetry.status).toBe(409);

    const runnerId = createId("runner");
    const environmentId = createId("environment");
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
        runnerKind: "local",
        runtimeVersion: "integration",
        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
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
        workspaceId: created.workspace.id,
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
        afterSequence: zeroSequence,
        apiVersion: hostApiVersion,
        threadId: null,
        type: "client.subscribe",
        workspaceId: created.workspace.id,
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
            workspaceId: string;
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
              workspaceId: latest.workspaceId,
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
        const workspaceAccess = command.context.workspaceAccess;
        if (workspaceAccess.kind !== "portablefs") {
          throw new Error("Expected an explicit PortableFS access plan");
        }
        const grant = await jsonFetch(workspaceAccess.exchangeUrl, {
          body: JSON.stringify({
            clientCertificateRequestPem: portableFsTestCsrPem,
          }),
          headers: {
            authorization: `Bearer ${workspaceAccess.exchangeToken}`,
            "content-type": "application/json",
          },
          method: "POST",
        });
        expect(grant.volumeId).toBe(workspaceAccess.volumeId);
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
          workspaceId: command.context.workspaceId,
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
    const snapshot = await runtime.store.workspaceSnapshot(created.workspace.id);
    expect(snapshot.messages.at(-1)?.content).toEqual([
      { text: "Finished through the Runner.", type: "text" },
    ]);
    expect(snapshot.threads[0]?.status).toBe("idle");
    expect(portableFs.grantCalls).toBe(1);
    const portableFsController = portableFs;
    if (!portableFsController) {
      throw new Error("PortableFS test controller was not initialized");
    }
    expect(
      portableFsController.requests.some(
        (request) => request.method === "PUT" && request.path.endsWith("/revocation"),
      ),
    ).toBe(false);
    await expect(
      runtime.store.database
        .selectFrom("workspaceMounts")
        .select(["status", "workspaceId"])
        .where("workspaceId", "=", created.workspace.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "active", workspaceId: created.workspace.id });

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
        ownerName: null,
        ownership: "mine",
        status: "online",
      }),
    );
    const runnerClosed = waitForClose(runnerConnection.socket);
    const revoked = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "revoke-main-runner",
        machineId: runnerId,
        type: "machine.revoke",
      },
      { headers: authorization(accessToken) },
    );
    expect(revoked).toEqual({ type: "machine.revoke" });
    // The terminal code, distinct from every refusal a Runner should retry.
    expect(await runnerClosed).toMatchObject({
      code: 4010,
      reason: "Runner identity was revoked",
    });
    // Machines is an inventory of what a person still owns, so a revoked Runner
    // leaves the projection entirely; the durable row is where the revocation
    // itself is observable.
    const afterRevocation = await testRpcData(
      origin,
      "machines.list",
      {},
      { headers: authorization(accessToken) },
    );
    expect(afterRevocation.machines.map((machine) => machine.id)).not.toContain(runnerId);
    await expect(
      runtime.store.database
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ revokedAt: expect.any(Date) });

    const replacementEnrollment = await testRpcData(
      origin,
      "commands.dispatch",
      {
        allowedModules: ["agents"],
        idempotencyKey: "runner-after-main-revoke",
        name: "Replacement computer",
        type: "runner.enrollment.createLocal",
      },
      { headers: authorization(accessToken) },
    );
    if (replacementEnrollment.type !== "runner.enrollment.createLocal") {
      throw new Error("Runner enrollment command mismatch.");
    }
    expect(
      await testRpcData(
        origin,
        "commands.dispatch",
        {
          allowedModules: ["agents"],
          idempotencyKey: "runner-after-main-revoke",
          name: "Replacement computer",
          type: "runner.enrollment.createLocal",
        },
        { headers: authorization(accessToken) },
      ),
    ).toEqual(replacementEnrollment);
    const replacementRunnerId = createId("runner");
    const replacementEnvironmentId = createId("environment");
    const replacementConnection = await openRunnerSocket(
      `ws://127.0.0.1:${hostPort}/internal/v1/runners`,
    );
    runnerSocket = replacementConnection.socket;
    await enrollRunnerSocket(
      replacementConnection.socket,
      agentsRunnerDescriptor({
        bootId: `rbt_${randomUUID()}`,
        capabilities: ["filesystem"],
        environmentIds: [replacementEnvironmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [openAiSource],
          },
        ],
        maxConcurrentRuns: 1,
        name: "Replacement Runner",
        runnerId: replacementRunnerId,
        runnerKind: "local",
        runtimeVersion: "integration",

        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
      }),
      replacementEnrollment.token,
      replacementConnection.challenge,
    );
    respondToHarnessInspections(replacementConnection.socket, readyCodexCatalog);
    const recoveredBootstrap = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      {
        headers: authorization(accessToken),
      },
    );
    expect(recoveredBootstrap.environments).toEqual([
      expect.objectContaining({ connected: true, id: replacementEnvironmentId }),
    ]);
  });

  it("starts the control plane without a Main Runner", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-missing-runner-token-"));
    const hostPort = await freePort();

    runtime = await createHostRuntime({
      ...testHostConfig(hostPort, dataDirectory, portableFs.url),
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
  });

  it("shares the entire Workspace through a browser-bound invitation and revokes it", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-sharing-integration-"));
    const hostPort = await freePort();
    const config = testHostConfig(hostPort, dataDirectory, portableFs.url);
    runtime = await createHostRuntime(config, { logger: true });
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    await initializeOwnerSession(origin);
    const workspaceResult = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "sharing-workspace",
        name: "Shared with a client",
        type: "workspace.create",
      },
      { headers: authorization(accessToken) },
    );
    if (workspaceResult.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    const workspaceId = WorkspaceIdSchema.parse(workspaceResult.workspace.id);
    const invitationResult = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "sharing-invitation",
        role: "collaborator",
        type: "workspace.invitation.create",
        workspaceId,
      },
      { headers: authorization(accessToken) },
    );
    if (invitationResult.type !== "workspace.invitation.create")
      throw new Error("Invitation command mismatch.");
    const invitationUrl = new URL(invitationResult.invitationUrl as string);
    const selector = invitationUrl.pathname.split("/").at(-1);
    const verifier = invitationUrl.hash.slice(1);
    if (!selector || !verifier) throw new Error("Invitation URL is incomplete");
    const listedInvitations = await testRpcData(
      origin,
      "workspace.invitations.list",
      {
        workspaceId,
      },
      { headers: authorization(accessToken) },
    );
    expect(JSON.stringify(listedInvitations)).not.toContain(verifier);

    const exchanged = await testRpcRequest(
      origin,
      "auth.invitation.exchange",
      {
        selector,
        verifier,
      },
      { headers: { origin } },
    );
    expect(exchanged.status).toBe(200);
    await expect(exchanged.clone().json()).resolves.toMatchObject({
      data: { preview: { role: "collaborator", workspaceName: "Shared with a client" } },
      ok: true,
    });
    const admissionCookies = responseCookies(exchanged);
    const signedUp = await testRpcRequest(
      origin,
      "auth.password.signUp",
      {
        // No display name: signup asks for an address and a password, nothing else.
        email: "client@example.com",
        password: "client integration password",
      },
      {
        headers: {
          cookie: admissionCookies.join("; "),
          origin,
        },
      },
    );
    expect(signedUp.status).toBe(200);
    const clientCookies = responseCookies(signedUp);
    const accepted = await testRpcRequest(
      origin,
      "auth.invitation.accept",
      {},
      {
        headers: {
          cookie: [...admissionCookies, ...clientCookies].join("; "),
          origin,
        },
      },
    );
    expect(accepted.status).toBe(200);
    const membership = (await accepted.json()) as {
      readonly data: { readonly membership: { readonly userId: string } };
    };
    const clientHeaders = { cookie: clientCookies.join("; "), origin };
    const clientBootstrap = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      { headers: clientHeaders },
    );
    // Accepting an invitation does not stand in for having a home of your own:
    // the invited account still gets its own Main alongside the shared
    // Workspace, and Main is scoped to its creator rather than to membership.
    const clientWorkspaces = clientBootstrap.workspaces as ReadonlyArray<{
      readonly id: string;
      readonly kind: string;
    }>;
    expect(clientWorkspaces.map((workspace) => workspace.id)).toContain(workspaceId);
    const clientMain = clientWorkspaces.find((workspace) => workspace.kind === "main");
    expect(clientMain).toBeDefined();
    expect(clientMain).not.toHaveProperty("createdBy");
    expect(clientWorkspaces).toHaveLength(2);
    const members = await testRpcData(
      origin,
      "workspace.members.list",
      { workspaceId },
      {
        headers: authorization(accessToken),
      },
    );
    expect(members.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: "Client", role: "collaborator", state: "active" }),
      ]),
    );

    // A computer the invited person adds is theirs. An administrator sees it
    // among teammates' computers, named with its owner and drawn as the
    // device it says it is — and is told nothing about what it shares.
    const clientEnrollment = await testRpcData(
      origin,
      "commands.dispatch",
      {
        allowedModules: ["agents"],
        idempotencyKey: "enroll-client-laptop",
        name: "Client laptop",
        type: "runner.enrollment.createLocal",
      },
      { headers: clientHeaders },
    );
    if (clientEnrollment.type !== "runner.enrollment.createLocal") {
      throw new Error("Runner enrollment command mismatch.");
    }
    const clientRunnerId = createId("runner");
    const clientRunner = await openRunnerSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
    try {
      await enrollRunnerSocket(
        clientRunner.socket,
        agentsRunnerDescriptor({
          bootId: `rbt_${randomUUID()}`,
          device: { form: "laptop", platform: "linux" },
          environmentIds: [createId("environment")],
          harnessDrivers: [],
          name: "Client laptop",
          runnerId: clientRunnerId,
          runnerKind: "local",
          runtimeVersion: "integration",
        }),
        clientEnrollment.token,
        clientRunner.challenge,
      );
      const administratorView = await testRpcData(
        origin,
        "machines.list",
        {},
        { headers: authorization(accessToken) },
      );
      expect(
        administratorView.machines.find((machine) => machine.id === clientRunnerId),
      ).toMatchObject({
        access: null,
        device: { form: "laptop", platform: "linux" },
        ownerName: "Client",
        ownership: "other",
      });
      const ownerView = await testRpcData(origin, "machines.list", {}, { headers: clientHeaders });
      expect(ownerView.machines.find((machine) => machine.id === clientRunnerId)).toMatchObject({
        ownerName: null,
        ownership: "mine",
      });
    } finally {
      clientRunner.socket.close();
    }

    // A Workspace's icon is the Workspace's own: every member sees it, only an
    // owner changes it, Main keeps the product mark, and the catalog is the
    // only vocabulary the Host accepts.
    expect(workspaceResult.workspace.icon).toBeNull();
    const setIcon = (
      icon: WorkspaceIconName | null,
      headers: Record<string, string>,
      key: string,
    ) =>
      testRpcRequest(
        origin,
        "commands.dispatch",
        { icon, idempotencyKey: key, type: "workspace.icon.set", workspaceId },
        { headers },
      );
    expect((await setIcon("plane", clientHeaders, "icon-by-collaborator")).status).toBe(403);
    const ownerSet = await setIcon("plane", authorization(accessToken), "icon-by-owner");
    expect(ownerSet.status).toBe(200);
    await expect(ownerSet.json()).resolves.toMatchObject({
      data: { type: "workspace.icon.set", workspace: { icon: "plane", id: workspaceId } },
    });
    // A retry is a replay, not a second write: the same key with the same icon
    // answers without changing anything, the same key with another icon is a
    // conflict, and a late retry of an older choice cannot undo a newer one.
    expect((await setIcon("plane", authorization(accessToken), "icon-by-owner")).status).toBe(200);
    expect((await setIcon("mail", authorization(accessToken), "icon-by-owner")).status).toBe(409);
    expect((await setIcon("mail", authorization(accessToken), "icon-a")).status).toBe(200);
    expect((await setIcon("plane", authorization(accessToken), "icon-b")).status).toBe(200);
    const lateRetry = await setIcon("mail", authorization(accessToken), "icon-a");
    await expect(lateRetry.json()).resolves.toMatchObject({
      data: { workspace: { icon: "plane" } },
    });
    const memberSees = await testRpcData(origin, "bootstrap.get", {}, { headers: clientHeaders });
    expect(
      (
        memberSees.workspaces as ReadonlyArray<{ readonly icon?: unknown; readonly id: string }>
      ).find((workspace) => workspace.id === workspaceId)?.icon,
    ).toBe("plane");
    const setColor = (color: "teal" | "purple", headers: Record<string, string>, key: string) =>
      testRpcRequest(
        origin,
        "commands.dispatch",
        { color, idempotencyKey: key, type: "workspace.color.set", workspaceId },
        { headers },
      );
    expect((await setColor("teal", clientHeaders, "color-collaborator")).status).toBe(403);
    expect((await setColor("teal", authorization(accessToken), "color-a")).status).toBe(200);
    expect((await setColor("purple", authorization(accessToken), "color-a")).status).toBe(409);
    expect((await setColor("purple", authorization(accessToken), "color-b")).status).toBe(200);
    await expect(
      (await setColor("teal", authorization(accessToken), "color-a")).json(),
    ).resolves.toMatchObject({
      data: { type: "workspace.color.set", workspace: { color: "purple" } },
    });
    const coloredBootstrap = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      { headers: clientHeaders },
    );
    expect(
      coloredBootstrap.workspaces.find((workspace) => workspace.id === workspaceId)?.color,
    ).toBe("purple");
    expect(coloredBootstrap.homeWorkspace?.color).toBeDefined();
    // Sent raw: the test helper would refuse the name before the Host could.
    const unknownIcon = await fetch(`${origin}/v1/rpc/commands.dispatch`, {
      body: JSON.stringify({
        icon: "not-an-icon",
        idempotencyKey: "icon-unknown",
        type: "workspace.icon.set",
        workspaceId,
      }),
      headers: {
        ...authorization(accessToken),
        [hostApiVersionHeader]: String(hostApiVersion),
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(unknownIcon.status).toBe(400);
    const ownerMain = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      { headers: authorization(accessToken) },
    );
    if (!ownerMain.homeWorkspace) throw new Error("Main Workspace is missing.");
    expect(ownerMain.homeWorkspace.icon).toBeNull();
    const mainIcon = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        icon: "star",
        idempotencyKey: "icon-main",
        type: "workspace.icon.set",
        workspaceId: ownerMain.homeWorkspace.id,
      },
      { headers: authorization(accessToken) },
    );
    expect(mainIcon.status).toBe(400);
    const cleared = await setIcon(null, authorization(accessToken), "icon-clear");
    await expect(cleared.json()).resolves.toMatchObject({
      data: { workspace: { icon: null, id: workspaceId } },
    });
    const withIcon = await testRpcData(
      origin,
      "commands.dispatch",
      {
        icon: "mail",
        idempotencyKey: "workspace-with-icon",
        name: "Morning Email Summarizer",
        type: "workspace.create",
      },
      { headers: authorization(accessToken) },
    );
    if (withIcon.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    expect(withIcon.workspace.icon).toBe("mail");
    const replayedWithAnotherIcon = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        icon: "plane",
        idempotencyKey: "workspace-with-icon",
        name: "Morning Email Summarizer",
        type: "workspace.create",
      },
      { headers: authorization(accessToken) },
    );
    expect(replayedWithAnotherIcon.status).toBe(409);

    const revoked = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "sharing-member-revoke",
        state: "revoked",
        type: "workspace.member.update",
        userId: membership.data.membership.userId,
        workspaceId,
      },
      { headers: authorization(accessToken) },
    );
    expect(revoked.status).toBe(200);
    await waitForCondition(async () => {
      const effects = await runtime?.store.database
        .selectFrom("securityEffects")
        .select("status")
        .where("workspaceId", "=", workspaceId)
        .execute();
      return effects?.length === 6 && effects.every((effect) => effect.status === "completed");
    });
    // Revoking the share removes the shared Workspace and nothing else: the
    // invited account keeps its own Main.
    const afterRevocation = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      { headers: clientHeaders },
    );
    expect(afterRevocation.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      clientMain?.id,
    ]);
  });

  it("persists the fixed initial-owner enrollment deadline across Host restarts", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-bootstrap-expiry-"));
    const firstPort = await freePort();
    const firstConfig = {
      ...testHostConfig(firstPort, dataDirectory, portableFs.url),
    } satisfies HostConfig;
    runtime = await createHostRuntime(firstConfig);
    const firstRow = await initialOwnerEnrollmentDeadline(runtime.store);
    expect(firstRow.expiresAt.getTime() - firstRow.createdAt.getTime()).toBeGreaterThanOrEqual(
      3_599_000,
    );
    await runtime.close();
    runtime = undefined;

    const secondPort = firstPort;
    runtime = await createHostRuntime({
      ...firstConfig,
      port: secondPort,
      runtimeOrigin: new URL(`http://127.0.0.1:${secondPort}`),
    });
    expect(await initialOwnerEnrollmentDeadline(runtime.store)).toEqual(firstRow);
  });

  it("restarts Host and local Runner identity without the enrollment token", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-token-removal-"));
    const firstPort = await freePort();
    runtime = await createHostRuntime(testHostConfig(firstPort, dataDirectory, portableFs.url));
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${firstPort}`);
    const runnerId = createId("runner");
    const environmentId = createId("environment");
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
      runnerKind: "local",
      runtimeVersion: "integration",

      workspaceBackings: ["portablefs"],
      localStorage: null,
      workspaceMounts: [],
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
      withoutInitialOwner(testHostConfig(secondPort, dataDirectory, portableFs.url)),
    );
    await runtime.listen();
    await expect(runtime.store.runnerForAuthentication(runnerId)).resolves.toMatchObject({
      runnerId,
      runnerKind: "local",
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
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-invalidation-recovery-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(testHostConfig(hostPort, dataDirectory, portableFs.url));
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${hostPort}`);
    const environmentId = createId("environment");
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
        runnerKind: "local",
        runtimeVersion: "integration",
        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
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
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-auth-rejection-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(testHostConfig(hostPort, dataDirectory, portableFs.url));
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

      workspaceBackings: ["portablefs"],
      localStorage: null,
      workspaceMounts: [],
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
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-placement-integration-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(testHostConfig(hostPort, dataDirectory, portableFs.url));
    await runtime.listen();
    const origin = `http://127.0.0.1:${hostPort}`;
    await initializeOwnerSession(origin);

    const runnerId = createId("runner");
    const environmentId = createId("environment");
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
        runnerKind: "local",
        runtimeVersion: "integration",

        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
      }),
      runnerToken,
      runnerConnection.challenge,
    );
    const ownerId = await administratorId(runtime.store);
    const portableFsVolumeId = randomUUID();
    portableFs.seedReadyVolume({ id: portableFsVolumeId, owner: ownerId });
    const workspace = await runtime.store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: portableFsVolumeId,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "placement-runtime-workspace",
      name: "Placement workspace",
      status: "ready",
    });
    // A driver the Runner reports as unavailable is not seeded a default
    // profile, and adding one is refused: an engine the Runner cannot run has
    // no source to validate against. This case's unavailable account is one
    // that existed before the Runner stopped offering the engine, which is
    // the only way such an account comes to be.
    const seeded = await runtime.store.listHarnessInstances();
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
        workspaceId: workspace.id,
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
      leaseGeneration: 1,
      leaseTokenHash: null,
      origin: "workspace",
      placementKey: `runner:${runnerId}:browser`,
      profileId: null,
      runnerId,
      runtimeId: "browser",
      workspaceId: workspace.id,
    });
    // Somebody else's signed-in browser in the same Workspace: its owner's alone.
    const stranger = await runtime.store.createUser("Browser stranger");
    const strangerProfile = await runtime.store.createBrowserProfile({
      idempotencyKey: "runtime.integration.test-browser-profile-1",
      name: "Stranger's bank",
      ownerId: stranger,
    });
    const hiddenBrowserId = createBrowserSessionId();
    await runtime.store.createBrowserSession({
      id: hiddenBrowserId,
      leaseGeneration: 1,
      leaseTokenHash: "stranger-lease",
      origin: "workspace",
      placementKey: `runner:${runnerId}:browser`,
      profileId: strangerProfile.id,
      runnerId,
      runtimeId: "browser",
      workspaceId: workspace.id,
    });
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
        workspaceId: workspace.id,
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
        workspaceId: workspace.id,
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
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-ambient-removal-integration-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(testHostConfig(hostPort, dataDirectory, portableFs.url));
    await runtime.listen();
    const origin = `http://127.0.0.1:${hostPort}`;
    await initializeOwnerSession(origin);

    const environmentId = createId("environment");
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
        runnerKind: "local",
        runtimeVersion: "integration",
        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
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
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-rejection-integration-"));
    const hostPort = await freePort();
    const bootId = `rbt_${randomUUID()}`;
    const committed = new EventEmitter();
    let snapshot: RunnerReadinessSnapshot | undefined;
    runtime = await createHostRuntime(testHostConfig(hostPort, dataDirectory, portableFs.url), {
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
    });
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${hostPort}`);

    const runnerId = createId("runner");
    const environmentId = createId("environment");
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
        runnerKind: "local",
        runtimeVersion: "integration",

        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
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
      const portableFsVolumeId = randomUUID();
      portableFs.seedReadyVolume({ id: portableFsVolumeId, owner: ownerId });
      const workspace = await runtime.store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: portableFsVolumeId,
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: ownerId,
        idempotencyKey: "rejection-runtime-workspace",
        name: "Rejected dispatch workspace",
        status: "ready",
      });
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
        workspaceId: workspace.id,
      });

      realtimeSocket = await openWebSocket(`ws://127.0.0.1:${hostPort}/v1/realtime`, accessToken);
      realtimeSocket.send(
        JSON.stringify({
          afterSequence: zeroSequence,
          apiVersion: hostApiVersion,
          threadId: thread.id,
          type: "client.subscribe",
          workspaceId: workspace.id,
        }),
      );
      await waitForMessage(realtimeSocket, (message) => message.type === "host.synchronized");
      const terminalEvent = waitForWorkspaceEvent(realtimeSocket, "run.failed");
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
        .selectFrom("workspaceEvents")
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
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-disconnect-integration-"));
    const hostPort = await freePort();
    runtime = await createHostRuntime(
      {
        ...testHostConfig(hostPort, dataDirectory, portableFs.url),
        executionLeaseMs: 10_000,
      },
      { executionClock: clock },
    );
    await runtime.listen();
    await initializeOwnerSession(`http://127.0.0.1:${hostPort}`);

    const runnerId = createId("runner");
    const environmentId = createId("environment");
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
        runnerKind: "local",
        runtimeVersion: "integration",

        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
      }),
      runnerToken,
      runnerConnection.challenge,
    );
    const stopCatalogResponder = respondToHarnessInspections(runnerSocket, readyCodexCatalog);

    const ownerId = await administratorId(runtime.store);
    const portableFsVolumeId = randomUUID();
    portableFs.seedReadyVolume({ id: portableFsVolumeId, owner: ownerId });
    const workspace = await runtime.store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: portableFsVolumeId,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "disconnect-runtime-workspace",
      name: "Disconnect workspace",
      status: "ready",
    });
    const harness = await seededHarness(runtime.store, environmentId);
    const { thread } = await runtime.store.createThread({
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "disconnect-runtime-thread",
      modelSelection: testModelSelection,
      title: "Disconnect me",
      workspaceId: workspace.id,
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
          workspaceId: command.context.workspaceId,
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
        .selectFrom("workspaceEvents")
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
    portableFs = await startPortableFsController();
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
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
    });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
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

        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
      }),
      enrollmentTokenHash: seedEnrollmentTokenHash,
      publicKeyFingerprint: runnerPublicKeyFingerprint(seedKeys.publicKey),
      publicKeyPem: canonicalRunnerPublicKeyPem(seedKeys.publicKey),
    });
    const workspace = await seedStore.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_restart_runtime",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "restart-runtime-workspace",
      name: "Restart workspace",
      status: "ready",
    });
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
      workspaceId: workspace.id,
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
      membershipGeneration: 1,
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
      leaseGeneration: 1,
      leaseTokenHash: null,
      origin: "agent",
      placementKey: `runner:${runnerId}:restart-runtime`,
      profileId: null,
      runnerId,
      runtimeId: "restart-runtime",
      workspaceId: workspace.id,
    });
    await seedStore.transitionBrowserSession({
      from: ["starting"],
      sessionId: browserSessionId,
      state: "ready",
    });
    const profileSaveRequest = await seedStore.requests.create({
      callId: "restart-runtime-browser-profile-save",
      kind: "browser.profile.save",
      mode: "durable",
      originatingRunId: admittedRun.id,
      originatingThreadId: thread.id,
      originatingWorkspaceId: workspace.id,
      payload: {
        kind: "browser.profile.save",
        reason: "Keep this signed-in browser state",
        sessionId: browserSessionId,
        suggestedName: "Restarted profile",
      },
      presentation: {
        kind: "external",
        subject: { id: browserSessionId, kind: "browser-session" },
        title: "Save browser profile",
      },
      requestedBy: ownerId,
      requiredActor: "requester",
      targetWorkspaceId: workspace.id,
    });
    const { thread: idleThread } = await seedStore.createThread({
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: thread.harnessInstanceId,
      idempotencyKey: "stranded-thread-state",
      modelSelection: testModelSelection,
      title: "Stranded projection",
      workspaceId: workspace.id,
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

    runtime = await createHostRuntime(testHostConfig(hostPort, dataDirectory, portableFs.url));
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
      .selectFrom("workspaceEvents")
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
    await expect(runtime.store.requests.get(profileSaveRequest.request.id)).resolves.toMatchObject({
      cancellationReason: "resource-deleted",
      status: "cancelled",
    });
    await expect(
      runtime.store.database
        .selectFrom("workspaceEvents")
        .select(["data", "type"])
        .where("type", "=", "request.cancelled")
        .where("runId", "=", admittedRun.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      data: { reason: "resource-deleted", requestId: profileSaveRequest.request.id },
      type: "request.cancelled",
    });
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
        .selectFrom("workspaceEvents")
        .select("type")
        .where("runId", "=", admittedRun.id)
        .where("type", "=", "run.failed")
        .execute(),
    ).resolves.toEqual([]);
  });

  it("keeps Chat follow-ups from an older reattached Runner and in order when a Runner refuses one", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-steer-answer-integration-"));
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
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" as const },
    });
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const runnerKeys = generateKeyPairSync("ed25519");
    const enrollmentTokenHash = hashRunnerEnrollmentToken("steer-answer-runner-enrollment-token");
    await seedStore.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "steer-answer-runner-enrollment",
      mainEnrollmentPurpose: "initial",
      name: "Steer answer runner",
      requestFingerprint: "sha256:steer-answer-runner-enrollment",
      runnerKind: "main",
      tokenHash: enrollmentTokenHash,
    });
    const descriptorFor = (bootId: string, steerAnswer: boolean): RunnerDescriptor => {
      const current = agentsRunnerDescriptor({
        bootId,
        capabilities: ["filesystem"],
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [openAiSource],
            steering: true,
          },
        ],
        maxConcurrentRuns: 1,
        name: "Steer answer runner",
        runnerId,
        runnerKind: "main",
        runtimeVersion: "integration",
        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
      });
      return RunnerDescriptorSchema.parse({
        ...current,
        capabilities: current.capabilities.filter(
          (capability) => steerAnswer || capability !== "steer-answer-v1",
        ),
      });
    };
    // A Runner from before `steer-answer-v1`, executing a Chat reply an
    // earlier Host dispatched to it.
    const olderBoot = `rbt_${randomUUID()}`;
    const older = descriptorFor(olderBoot, false);
    await seedStore.enrollRunnerConnection({
      descriptor: older,
      enrollmentTokenHash,
      publicKeyFingerprint: runnerPublicKeyFingerprint(runnerKeys.publicKey),
      publicKeyPem: canonicalRunnerPublicKeyPem(runnerKeys.publicKey),
    });
    const volumeId = randomUUID();
    portableFs.seedReadyVolume({ id: volumeId, owner: ownerId });
    const workspace = await seedStore.createWorkspace({
      backing: { generation: 1, kind: "portablefs", serviceId: "test-portablefs", volumeId },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "steer-answer-workspace",
      name: "Steer answer workspace",
      status: "ready",
    });
    const harness = await seedStore.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId,
      name: "Codex",
      sourceId: "openai",
      stateKind: "isolated",
    });
    const { thread } = await seedStore.createThread({
      createdBy: ownerId,
      environmentId,
      harnessInstanceId: harness.id,
      home: true,
      idempotencyKey: "steer-answer-chat",
      modelSelection: testModelSelection,
      title: "Chat",
      workspaceId: workspace.id,
    });
    const say = (key: string, text: string) =>
      runtime!.store.enqueueThreadInput({
        content: [{ text, type: "text" }],
        idempotencyKey: key,
        policy: "queue",
        requestedBy: ownerId,
        source: { kind: "human" },
        threadId: thread.id,
      });
    const first = await seedStore.enqueueThreadInput({
      content: [{ text: "Plan the offsite", type: "text" }],
      idempotencyKey: "steer-answer-first",
      policy: "queue",
      requestedBy: ownerId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    if (!first.command || !first.run) throw new Error("The first message did not start a reply");
    const firstRunId = first.run.id;
    await seedStore.claimCommand(first.command.id, "earlier-host");
    const binding = await seedStore.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
        driverKind: harness.driverKind,
      },
      harnessInstanceId: harness.id,
      leaseTokenHash: "steer-answer-lease",
      membershipGeneration: 1,
      runnerBootId: olderBoot,
      runnerId,
      runId: firstRunId,
      threadId: thread.id,
    });
    const event = (
      runId: string,
      bindingGeneration: number,
      ordinal: number,
      type: string,
      data: unknown,
    ) => ({
      bindingGeneration,
      data,
      emittedAt: new Date().toISOString(),
      environmentId,
      ordinal,
      runId,
      threadId: thread.id,
      type,
      workspaceId: workspace.id,
    });
    await seedStore.commitRunnerEvent({
      environmentId,
      event: PendingAgentEventSchema.parse(
        event(firstRunId, binding.bindingGeneration, 0, "run.started", { status: "running" }),
      ),
      runnerBootId: olderBoot,
      runnerId,
    });
    // As the engine does once it holds a native session, so later replies continue it.
    const { providerSessionId } = await seedDatabase
      .selectFrom("runs")
      .select("providerSessionId")
      .where("id", "=", firstRunId)
      .executeTakeFirstOrThrow();
    if (!providerSessionId) throw new Error("The reply has no provider session");
    await seedStore.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: harness.id,
      providerSessionId,
      providerSessionReference: `codex-thread-${thread.id}`,
      runId: firstRunId,
      runnerBootId: olderBoot,
      runnerId,
      threadId: thread.id,
    });
    await seedDatabase.destroy();

    // The Host is upgraded; the same Runner boot reconnects and states its reply.
    runtime = await createHostRuntime(testHostConfig(hostPort, dataDirectory, portableFs.url));
    await runtime.listen();
    const connect = async (descriptor: RunnerDescriptor) => {
      const connection = await openRunnerSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
      const challenge = RunnerChallengeSchema.parse(connection.challenge);
      const frames: HostToRunnerMessage[] = [];
      connection.socket.on("message", (frame) => {
        frames.push(JSON.parse(frame.toString()) as HostToRunnerMessage);
      });
      connection.socket.send(
        JSON.stringify({
          challengeId: challenge.challengeId,
          descriptor,
          signature: createRunnerAuthenticationSignature(runnerKeys.privateKey, {
            challenge,
            descriptor,
          }),
          proofFormatVersion: 2,
          type: "runner.authenticate",
        }),
      );
      const welcome = runnerFence(
        (await waitForMessage(
          connection.socket,
          (message) => message.type === "host.welcome",
        )) as unknown as RunnerConnectionFence,
      );
      respondToHarnessInspections(connection.socket, readyCodexCatalog);
      return { frames, socket: connection.socket, welcome };
    };
    const commandsOf = (frames: readonly HostToRunnerMessage[], type: string) =>
      frames.flatMap((frame) =>
        frame.type === "host.command" && frame.command.type === type ? [frame.command] : [],
      );
    const inputOf = (messageId: MessageId) =>
      runtime!.store.database
        .selectFrom("threadInputs")
        .leftJoin("commands", "commands.id", "threadInputs.steerCommandId")
        .select([
          "commands.status as commandStatus",
          "threadInputs.runId",
          "threadInputs.state",
          "threadInputs.steerCommandId",
        ])
        .where("threadInputs.messageId", "=", messageId)
        .executeTakeFirstOrThrow();
    const runOf = (seedInputId: MessageId) =>
      runtime!.store.database
        .selectFrom("runs")
        .select(["bindingGeneration", "id", "status"])
        .where("seedInputId", "=", seedInputId)
        .executeTakeFirst();

    const olderRunner = await connect(older);
    runnerSocket = olderRunner.socket;
    const attached = waitForMessage(
      olderRunner.socket,
      (message) => message.type === "host.executions.attached",
    );
    olderRunner.socket.send(
      JSON.stringify({
        ...olderRunner.welcome,
        complete: true,
        executions: [
          {
            bindingGeneration: binding.bindingGeneration,
            environmentId,
            nextOrdinal: 1,
            runId: firstRunId,
            terminal: false,
            threadId: thread.id,
            workspaceId: workspace.id,
          },
        ],
        type: "runner.executions.attach",
      }),
    );
    await expect(attached).resolves.toMatchObject({
      results: [{ runId: firstRunId, status: "attached" }],
    });
    // The person writes while that reply is under way: accepted, and kept
    // for the next reply rather than steered into a driver that may leave it
    // unanswered.
    const waiting = await say("steer-answer-follow-up", "Add a dinner option");
    expect(waiting).toMatchObject({ disposition: "pending", run: null });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(commandsOf(olderRunner.frames, "run.steer")).toEqual([]);
    olderRunner.socket.send(
      JSON.stringify({
        ...olderRunner.welcome,
        event: event(firstRunId, binding.bindingGeneration, 1, "assistant.message", {
          content: [{ text: "Here is the offsite plan.", type: "text" }],
          messageId: createId("message"),
        }),
        type: "runner.event",
      }),
    );
    olderRunner.socket.send(
      JSON.stringify({
        ...olderRunner.welcome,
        event: event(firstRunId, binding.bindingGeneration, 2, "run.completed", {
          status: "completed",
        }),
        type: "runner.event",
      }),
    );
    // The next reply starts with the follow-up, and the Host asks for the
    // update instead of sending it to this Runner.
    await waitForCondition(
      async () => (await runOf(waiting.message.id))?.status === "failed",
      20_000,
    );
    const refusedRun = (await runOf(waiting.message.id))!;
    await expect(
      runtime.store.database
        .selectFrom("workspaceEvents")
        .select("data")
        .where("runId", "=", refusedRun.id)
        .where("type", "=", "run.failed")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      data: {
        message: "Update this Runner so messages sent while Opensteer replies are answered.",
      },
    });
    expect(commandsOf(olderRunner.frames, "run.execute")).toEqual([]);
    const closed = waitForClose(olderRunner.socket);
    olderRunner.socket.close();
    await closed;

    // Updated, the Runner comes back as a new boot that advertises it.
    const updatedRunner = await connect(descriptorFor(`rbt_${randomUUID()}`, true));
    runnerSocket = updatedRunner.socket;
    updatedRunner.socket.send(
      JSON.stringify({
        ...updatedRunner.welcome,
        complete: true,
        executions: [],
        type: "runner.executions.attach",
      }),
    );
    const next = await say("steer-answer-next", "Plan it again");
    if (!next.run) throw new Error("The next message did not start a reply");
    const nextRunId = next.run.id;
    await waitForCondition(
      async () => commandsOf(updatedRunner.frames, "run.execute").length === 1,
      20_000,
    );
    const execute = commandsOf(updatedRunner.frames, "run.execute")[0]!;
    if (execute.type !== "run.execute") throw new Error("Expected the reply's execute");
    updatedRunner.socket.send(
      JSON.stringify({
        ...updatedRunner.welcome,
        commandId: execute.commandId,
        correlationId: execute.correlationId,
        type: "runner.command-accepted",
      }),
    );
    const nextBinding = execute.context.bindingGeneration;
    updatedRunner.socket.send(
      JSON.stringify({
        ...updatedRunner.welcome,
        event: event(nextRunId, nextBinding, 0, "run.started", { status: "running" }),
        type: "runner.event",
      }),
    );
    await waitForCondition(async () => (await runOf(next.message.id))?.status === "running");
    // Joined: the follow-up reaches the reply under way.
    const refused = await say("steer-answer-refused", "Add the floor plan");
    expect(refused).toMatchObject({ disposition: "steering", run: { id: nextRunId } });
    await waitForCondition(
      async () => commandsOf(updatedRunner.frames, "run.steer").length === 1,
      20_000,
    );
    const behind = await say("steer-answer-behind", "And book the room");
    expect(behind).toMatchObject({ disposition: "steering", run: { id: nextRunId } });
    const steer = commandsOf(updatedRunner.frames, "run.steer")[0]!;
    if (steer.type !== "run.steer") throw new Error("Expected a steer");
    expect(steer.input.messageId).toBe(refused.message.id);
    // The engine definitely did not take it.
    updatedRunner.socket.send(
      JSON.stringify({
        ...updatedRunner.welcome,
        commandId: steer.commandId,
        correlationId: steer.correlationId,
        error: {
          code: "conflict",
          message: "The engine could not take this message",
          retryable: false,
        },
        type: "runner.command-rejected",
      }),
    );
    await waitForCondition(async () => (await inputOf(behind.message.id)).state === "pending");
    await expect(inputOf(refused.message.id)).resolves.toMatchObject({
      commandStatus: null,
      runId: null,
      state: "pending",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    // What the person sent after it never reached the Runner ahead of it.
    expect(
      commandsOf(updatedRunner.frames, "run.steer").map((command) =>
        command.type === "run.steer" ? command.input.messageId : null,
      ),
    ).toEqual([refused.message.id]);
    const failedHandOffs = await runtime.store.database
      .selectFrom("commands")
      .select(["status", "idempotencyKey"])
      .where("runId", "=", nextRunId)
      .where("type", "=", "run.steer")
      .orderBy("createdAt", "asc")
      .execute();
    expect(failedHandOffs.map(({ status }) => status)).toEqual(["failed", "failed"]);
    // The reply ends; the next one starts with both, in the order they were sent.
    updatedRunner.socket.send(
      JSON.stringify({
        ...updatedRunner.welcome,
        event: event(nextRunId, nextBinding, 1, "run.completed", { status: "completed" }),
        type: "runner.event",
      }),
    );
    await waitForCondition(
      async () => commandsOf(updatedRunner.frames, "run.execute").length === 2,
      20_000,
    );
    const following = commandsOf(updatedRunner.frames, "run.execute")[1]!;
    if (following.type !== "run.execute") throw new Error("Expected the next reply's execute");
    expect(following.inputs.map(({ messageId }) => messageId)).toEqual([
      refused.message.id,
      behind.message.id,
    ]);
  }, 90_000);

  it("opens a browser module stream beside the primary connection, once per ticket", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-browser-module-"));
    const hostPort = await freePort();
    const config = testHostConfig(hostPort, dataDirectory, portableFs.url);
    runtime = await createHostRuntime(config);
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    await initializeOwnerSession(origin);

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
      modules: { browser: { profileSnapshotVersion: 2, runtimeId: "relay-browser" } },
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
      expect.objectContaining({ keyId: "host-browser-v1" }),
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

  it("enrolls a messaging-only computer and projects its one module", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-runner-messaging-module-"));
    const hostPort = await freePort();
    const config = testHostConfig(hostPort, dataDirectory, portableFs.url);
    runtime = await createHostRuntime(config);
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    await initializeOwnerSession(origin);

    const enrollment = await testRpcData(
      origin,
      "commands.dispatch",
      {
        allowedModules: ["messaging"],
        idempotencyKey: "enroll-messaging-computer",
        name: "Messaging computer",
        type: "runner.enrollment.createManaged",
      },
      { headers: authorization(accessToken) },
    );
    if (enrollment.type !== "runner.enrollment.createManaged") {
      throw new Error("Runner enrollment command mismatch.");
    }

    const runnerId = createId("runner");
    const connection = await openRunnerSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
    runnerSocket = connection.socket;
    const enrolled = await enrollRunnerSocket(
      connection.socket,
      RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: {
          messaging: {
            capabilities: [
              {
                manifest: slackChannelProviderManifest,
                provider: "slack",
                transportKinds: ["socket"],
              },
            ],
          },
        },
        name: "Messaging computer",
        runnerId,
        runnerKind: "managed",
        runtimeVersion: "integration",
      }),
      enrollment.token,
      connection.challenge,
    );
    connection.socket.send(
      JSON.stringify({
        ...enrolled.fence,
        modules: [
          {
            checkedAt: new Date().toISOString(),
            detail: null,
            module: "messaging",
            readiness: "ready",
          },
        ],
        type: "runner.modules.report",
      }),
    );

    await waitForCondition(async () => {
      const listed = await testRpcData(
        origin,
        "machines.list",
        {},
        { headers: authorization(accessToken) },
      );
      const machine = listed.machines.find((candidate) => candidate.id === runnerId);
      return machine?.modules.messaging?.readiness === "ready";
    });
    // A messaging computer is a Machine like any other: one row, one identity,
    // and no agents module it never claimed.
    const listed = await testRpcData(
      origin,
      "machines.list",
      {},
      { headers: authorization(accessToken) },
    );
    expect(listed.machines.find((machine) => machine.id === runnerId)).toMatchObject({
      // A service describes no device: it is not a computer anybody recognises.
      device: null,
      modules: { messaging: expect.objectContaining({ readiness: "ready" }) },
      ownerName: null,
      ownership: "deployment",
      status: "online",
    });
    expect(
      listed.machines.find((machine) => machine.id === runnerId)?.modules.agents,
    ).toBeUndefined();
  });

  it("stands a Personal Host up passwordlessly with native local Workspaces", async () => {
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
      acceptsExternalRunners: false,
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
      workspace: {
        deletionRetentionDays: 14,
        shape: {
          defaultWorkspaceBacking: "local-directory",
          kind: "personal" as const,
        },
        storage: {
          kind: "local-directory",
          ownerEnvironmentId,
        },
      },
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
    const mainRunner = await connectLocalWorkspaceRunner({
      enrollmentToken: offered.runnerEnrollmentToken,
      environmentId: ownerEnvironmentId,
      name: "Main computer",
      origin,
      runnerKind: "main",
    });
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
        "content-type": "application/json",
        origin,
      },
      method: "POST",
    });
    expect(claimed.status).toBe(200);
    const sessionHeaders = { cookie: responseCookies(claimed).join("; "), origin };
    const bootstrap = await testRpcData(origin, "bootstrap.get", {}, { headers: sessionHeaders });
    expect(bootstrap.user.instanceRole).toBe("administrator");
    expect(bootstrap.user.displayName).toBe("You");
    expect(bootstrap.sessionSurface).toBe("canonical");
    expect(bootstrap.workspaceSharingAvailable).toBe(false);
    // Main exists without anyone naming it, and is the only Workspace.
    expect(bootstrap.workspaces).toHaveLength(1);
    expect(bootstrap.workspaces[0]).toMatchObject({
      kind: "main",
      // The bytes live on the Main Runner's disk, and the view names that
      // machine rather than any path on it.
      location: { environmentId: ownerEnvironmentId, kind: "machine" },
      name: "Main",
    });
    expect(JSON.stringify(bootstrap.workspaces[0])).not.toContain(dataDirectory);
    const specialized = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "personal-specialized-workspace",
        name: "Private research",
        type: "workspace.create",
      },
      { headers: sessionHeaders },
    );
    if (specialized.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    expect(specialized.workspace).toMatchObject({
      location: { environmentId: ownerEnvironmentId, kind: "machine" },
      name: "Private research",
      status: "ready",
    });
    const sharingSpecialized = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "share-personal-specialized",
        role: "collaborator",
        type: "workspace.invitation.create",
        workspaceId: specialized.workspace.id,
      },
      { headers: sessionHeaders },
    );
    expect(sharingSpecialized.status).toBe(403);
    expect(await sharingSpecialized.json()).toMatchObject({
      error: {
        code: "forbidden",
        message: "Workspace sharing is unavailable for this Deployment",
      },
    });

    // Main is the mount point for specialized Workspaces, so it cannot be shared.
    const mainWorkspace = bootstrap.workspaces[0];
    if (!mainWorkspace) throw new Error("Main Workspace is missing.");
    const sharingMain = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "share-main",
        role: "collaborator",
        type: "workspace.invitation.create",
        workspaceId: mainWorkspace.id,
      },
      { headers: sessionHeaders },
    );
    expect(sharingMain.status).toBe(403);

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
        "content-type": "application/json",
        origin,
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
      headers: { ...sessionHeaders, "content-type": "application/json" },
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
      headers: { ...sessionHeaders, "content-type": "application/json" },
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
    // The route a request arrived on is the trusted ingress authority, never an
    // Origin header a client writes for itself.
    const exchangeIngress = {
      "content-type": "application/json",
      host: new URL(privateOrigin).host,
      "x-forwarded-proto": "https",
    };
    const wrongRoute = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: pairingBody,
      headers: { ...exchangeIngress, host: "wrong.example" },
      method: "POST",
    });
    expect(wrongRoute.status).toBe(403);
    const claimedOrigin = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: pairingBody,
      headers: { "content-type": "application/json", origin: privateOrigin },
      method: "POST",
    });
    expect(claimedOrigin.status).toBe(403);
    const paired = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: pairingBody,
      headers: exchangeIngress,
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
      headers: exchangeIngress,
      method: "POST",
    });
    expect(replay.status).toBe(403);
    const remoteHeaders = { cookie: remoteCookies.join("; "), origin: privateOrigin };
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
    const remoteCannotMint = await fetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
      body: "{}",
      headers: { ...remoteHeaders, "content-type": "application/json" },
      method: "POST",
    });
    expect(remoteCannotMint.status).toBe(403);

    // The same route, the same authority, a phone's delivery: a pairing code
    // authorises either presentation, and the header one sets no cookie.
    const nativePairing = await jsonFetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
      body: "{}",
      headers: { ...sessionHeaders, "content-type": "application/json" },
      method: "POST",
    });
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
      headers: exchangeIngress,
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

    // The phone reaches the Deployment; it is never the computer that runs it.
    const nativeCannotMint = await fetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
      body: "{}",
      headers: { ...nativeHeaders, "content-type": "application/json" },
      method: "POST",
    });
    expect(nativeCannotMint.status).toBe(403);
    // `canonicalAuthorizationRequired` is refused on exactly this surface, and
    // the phone's credential never reports the canonical one.
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
    // Renaming the cookie must not turn a routed session into this
    // Deployment's own: at the canonical origin a canonical session passes the
    // mutation origin check and `canonicalAuthorizationRequired`. Every
    // presentation but the remote cookie's own is refused.
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

    // Off is a local-machine operation. It advances the route generation and
    // revokes the remote cookie in the same database transaction.
    const disabled = await fetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({ mode: "off", routeOrigin: null, schemaVersion: 1 }),
      headers: { ...sessionHeaders, "content-type": "application/json" },
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
      body: JSON.stringify({ completionGrant, hostCredential, linkGeneration, schemaVersion: 1 }),
      headers: { ...sessionHeaders, "content-type": "application/json" },
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
      headers: { ...sessionHeaders, "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
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
      headers: connectIngress,
      method: "POST",
    });
    expect(wrongDelivery.status).toBe(403);
    const connected = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: sessionBody,
      headers: connectIngress,
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
      headers: { "content-type": "application/json", origin: connectOrigin },
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
      headers: { ...browserExchangeHeaders, origin: "https://other-portal.example" },
      method: "POST",
      redirect: "manual",
    });
    expect(wrongPortal.status).toBe(403);
    const browserConnected = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: new URLSearchParams({ grant: browserGrant }),
      headers: browserExchangeHeaders,
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
    const routeSocket = new WebSocket(`ws://127.0.0.1:${hostPort}/v1/realtime`, {
      headers: { cookie: browserCookiePair, origin: connectOrigin },
    });
    await new Promise<void>((resolve, reject) => {
      routeSocket.once("open", resolve);
      routeSocket.once("error", reject);
    });
    routeSocket.close();
    const refusedPortalSocket = new WebSocket(`ws://127.0.0.1:${hostPort}/v1/realtime`, {
      headers: { cookie: browserCookiePair, origin: portalOrigin },
    });
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
        cookie: browserCookiePair,
        origin: portalOrigin,
      },
      method: "POST",
    });
    expect(portalCannotMutate.status).toBe(403);
    const tamperedParts = browserGrant.split(".");
    const signature = tamperedParts[2]!;
    tamperedParts[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const tampered = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: new URLSearchParams({ grant: tamperedParts.join(".") }),
      headers: browserExchangeHeaders,
      method: "POST",
      redirect: "manual",
    });
    expect(tampered.status).toBe(403);
    const wrongMediaType = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
      body: new URLSearchParams({ grant: browserGrant }),
      headers: { ...browserExchangeHeaders, "content-type": "text/plain" },
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
      headers: { ...sessionHeaders, "content-type": "application/json" },
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
      headers: browserExchangeHeaders,
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
      acceptsExternalRunners: false,
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
      workspace: {
        deletionRetentionDays: 14,
        shape: {
          defaultWorkspaceBacking: "local-directory",
          kind: "personal" as const,
        },
        storage: {
          kind: "local-directory",
          ownerEnvironmentId,
        },
      },
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
        "content-type": "application/json",
        origin,
      },
      method: "POST",
    });
    expect(claimed.status).toBe(200);
    const sessionHeaders = { cookie: responseCookies(claimed).join("; "), origin };
    const jsonHeaders = { ...sessionHeaders, "content-type": "application/json" };

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
      body: JSON.stringify({ completionGrant, hostCredential, linkGeneration, schemaVersion: 1 }),
      headers: jsonHeaders,
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
        challengeCredential: `olc_${"a".repeat(43)}`,
        challengeId: `phc_${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      headers: jsonHeaders,
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
      headers: jsonHeaders,
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
        headers: jsonHeaders,
        method: "PUT",
      },
    );
    expect(projectionRefused.status).toBe(403);
    const revokeRefused = await fetch(`${origin}/v1/personal-remote-access/connect-resource`, {
      body: JSON.stringify({
        hostInstanceId: authority.hostInstanceId,
        operationId: `cop_${crypto.randomUUID()}`,
      }),
      headers: jsonHeaders,
      method: "DELETE",
    });
    expect(revokeRefused.status).toBe(409);
    // No Connect route exists, so no Account session grant can be exchanged
    // for one either: the exchange is fenced by the same unreachable state.
    expect(
      await jsonFetch(`${origin}/v1/personal-remote-access`, { headers: sessionHeaders }),
    ).toMatchObject({ mode: "off", route: null });

    // The owner's own machine sees the whole link. A session that arrived over
    // a signed private route sees only that the link is not yet usable.
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
        "content-type": "application/json",
        host: new URL(privateOrigin).host,
        "x-forwarded-proto": "https",
      },
      method: "POST",
    });
    expect(paired.status, await paired.clone().text()).toBe(200);
    const remoteHeaders = { cookie: responseCookies(paired).join("; "), origin: privateOrigin };
    const remoteStatus = await jsonFetch(`${origin}/v1/personal-remote-access`, {
      headers: remoteHeaders,
    });
    expect(remoteStatus.accountLink).toEqual({ state: "activating" });
    expect(JSON.stringify(remoteStatus)).not.toContain(accountId);
    expect(JSON.stringify(remoteStatus)).not.toContain(linkGeneration);

    // Cancelling an activating link is one call, and the Account answering
    // "no such link" is a durable answer that completes it rather than a
    // failure that strands the owner half-linked.
    activationOutcome = "not-found";
    await fetch(`${origin}/v1/personal-remote-access`, {
      body: JSON.stringify({ mode: "off", routeOrigin: null, schemaVersion: 1 }),
      headers: jsonHeaders,
      method: "PUT",
    });
    const removed = await fetch(`${origin}/v1/personal-remote-access/account-unlink/remove-link`, {
      body: JSON.stringify({ schemaVersion: 1 }),
      headers: jsonHeaders,
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
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-hosted-bootstrap-"));
    const hostPort = await freePort();
    const config = testHostConfig(hostPort, dataDirectory, portableFs.url);
    runtime = await createHostRuntime(config);
    await runtime.listen();

    const response = await fetch(`${config.runtimeOrigin.origin}/v1/local-bootstrap`);
    expect(response.status).toBe(404);
  });

  it("persists the exact managed owner and Main Runner bootstrap across restart", async () => {
    dataDirectory = await realpath(await mkdtemp(join(tmpdir(), "opensteer-managed-bootstrap-")));
    const hostPort = await freePort();
    const base = testHostConfig(hostPort, dataDirectory, new URL("http://127.0.0.1:9"));
    const hostInstance = await loadOrCreateHostInstance(dataDirectory);
    const keys = await loadOrCreateHostKeys({ dataDirectory });
    const ownerSubject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    const runnerEnrollmentToken = "managed-main-runner-token".padEnd(40, "x");
    const config: HostConfig = {
      ...base,
      account: {
        controlApiOrigin: new URL("https://accounts.opensteer.test"),
        hostCredential: `osc_${"a".repeat(43)}`,
        initialRunnerEnrollmentToken: runnerEnrollmentToken,
        issuer: new URL("https://accounts.opensteer.test"),
        oidcClientId: "opensteer-managed-host",
        oidcClientSecret: `ocs_${"b".repeat(43)}`,
        owner: { displayName: "Managed Owner", email: "owner@example.test", subject: ownerSubject },
        provisioningMode: "managed",
        reachability: "canonical",
      },
      bindAddress: "0.0.0.0",
      deploymentIdentity: {
        deploymentId: createId("deployment"),
        hostInstanceId: hostInstance.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(
          keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        ),
      },
      exposure: "networked",
      identity: {
        ...base.identity,
        initialOwnerEnrollment: undefined,
        localPasswordEnabled: false,
      },
    };

    runtime = await createHostRuntime(config);
    await expect(
      runtime.store.database
        .selectFrom("users")
        .innerJoin("authAccounts", "authAccounts.userId", "users.id")
        .select([
          "authAccounts.accountId",
          "authAccounts.providerId",
          "users.displayName",
          "users.email",
          "users.instanceRole",
        ])
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      accountId: ownerSubject,
      displayName: "Managed Owner",
      email: "owner@example.test",
      instanceRole: "administrator",
    });
    const configuredDirectoryProvider = await runtime.store.database
      .selectFrom("accountDirectoryProvider")
      .select(["issuer", "providerId"])
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirstOrThrow();
    expect(configuredDirectoryProvider).toEqual({
      issuer: "https://accounts.opensteer.test",
      providerId: expect.stringMatching(/^oidc\.opensteer-account\./u),
    });
    const pendingProjection = await runtime.store.database
      .selectFrom("accountDirectoryProjections")
      .select(["accountId", "generation", "providerId", "publishedGeneration"])
      .where("accountId", "=", ownerSubject)
      .executeTakeFirstOrThrow();
    expect(pendingProjection).toEqual({
      accountId: ownerSubject,
      generation: "1",
      providerId: configuredDirectoryProvider.providerId,
      publishedGeneration: "0",
    });
    const enrollment = await runtime.store.database
      .selectFrom("runnerEnrollments")
      .select(["id", "tokenHash"])
      .where("idempotencyKey", "=", "deployment-managed-main-runner")
      .executeTakeFirstOrThrow();
    expect(enrollment.tokenHash).toBe(hashRunnerEnrollmentToken(runnerEnrollmentToken));

    // Give the managed owner one Account directory projection so the restart
    // below has both a Host identity and a membership to publish.
    const ownerBinding = await runtime.store.database
      .selectFrom("authAccounts")
      .select(["providerId", "userId"])
      .where("accountId", "=", ownerSubject)
      .executeTakeFirstOrThrow();
    await new AccountDirectoryStore(runtime.store.database).configureProvider({
      issuer: config.account!.issuer.origin,
      providerId: ownerBinding.providerId,
    });
    await sql`
      select opensteer_set_account_directory_projection(
        ${ownerBinding.providerId}, ${ownerSubject}, ${ownerBinding.userId}, true
      )
    `.execute(runtime.store.database);

    await runtime.close();
    const accountCalls: { readonly body: unknown; readonly path: string }[] = [];
    const managedAccountFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input.toString());
      const body: unknown = JSON.parse(String(init?.body));
      accountCalls.push({ body, path: url.pathname });
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
        `Bearer ${config.account!.hostCredential}`,
      );
      if (url.pathname === "/v1/host/authority") {
        const { authorityEnvelope } = PublishHostAuthorityRequestSchema.parse(body);
        return Response.json({
          deploymentId: authorityEnvelope.document.deploymentId,
          published: true,
        });
      }
      if (url.pathname === `/v1/host/directory/${ownerSubject}`) {
        const projection = DirectoryProjectionRequestSchema.parse(body);
        return Response.json({
          accountId: ownerSubject,
          generation: projection.generation,
          present: projection.present,
        });
      }
      throw new Error(`Unexpected managed Account request: ${url.href}`);
    });
    runtime = await createHostRuntime(config, { accountDirectoryFetch: managedAccountFetch });
    const replay = await runtime.store.database
      .selectFrom("runnerEnrollments")
      .select(["id", "tokenHash"])
      .where("idempotencyKey", "=", "deployment-managed-main-runner")
      .executeTakeFirstOrThrow();
    expect(replay).toEqual(enrollment);
    await expect(
      runtime.store.database
        .selectFrom("accountDirectoryProvider")
        .select(["issuer", "providerId"])
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual(configuredDirectoryProvider);
    // Identity first, membership second: the directory publisher does not
    // start until the Account has accepted the Host's signed document, and the
    // membership projection itself carries no identity.
    await vi.waitFor(() => {
      expect(accountCalls.map(({ path }) => path)).toEqual([
        "/v1/host/authority",
        `/v1/host/directory/${ownerSubject}`,
      ]);
    });
    expect(accountCalls[0]!.body).toMatchObject({
      authorityEnvelope: { document: { deploymentId: config.deploymentIdentity!.deploymentId } },
    });
    expect(accountCalls[1]!.body).not.toHaveProperty("authorityEnvelope");
    await vi.waitFor(async () => {
      await expect(
        runtime!.store.database
          .selectFrom("accountDirectoryProjections")
          .select(["generation", "publishedGeneration"])
          .where("accountId", "=", ownerSubject)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ generation: "1", publishedGeneration: "1" });
    });

    await runtime.close();
    runtime = undefined;
    await expect(
      createHostRuntime({
        ...config,
        account: {
          ...config.account!,
          controlApiOrigin: new URL("https://replacement.opensteer.test"),
          issuer: new URL("https://replacement.opensteer.test"),
        },
      }),
    ).rejects.toThrow(/provider identity does not match durable Host state/u);
    const differentSubject = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
    await expect(
      createHostRuntime({
        ...config,
        account: {
          ...config.account!,
          owner: { ...config.account!.owner!, subject: differentSubject },
        },
      }),
    ).rejects.toThrow(/durable Host authority/u);
  });
});

function testHostConfig(
  hostPort: number,
  hostDataDirectory: string,
  portableFsManagerUrl: URL,
): HostConfig {
  return {
    acceptsExternalRunners: true,
    authSecret: "runtime-auth-secret".padEnd(40, "x"),
    bindAddress: "127.0.0.1",
    canonicalOrigin: new URL(`http://127.0.0.1:${hostPort}`),
    browserRuntime: { attachKeyId: "host-browser-v1" },
    browserProfileKeyPath: undefined,
    credentialKeyPath: undefined,
    databaseUrl: databaseUrl ?? "postgres://unconfigured",
    dataDirectory: hostDataDirectory,
    identity: {
      initialOwnerEnrollment: { lifetimeSeconds: 3_600, token: accessToken },
      localPasswordEnabled: true,
      oidcConfigPath: undefined,
      signupPolicy: "invite-only",
    },
    executionLeaseMs: 90_000,
    maxConcurrentDispatches: 4,
    maxConcurrentTriggerDispatches: 4,
    mode: "development",
    port: hostPort,
    exposure: "networked" as const,
    privateKeyPath: undefined,
    publicKeyPath: undefined,
    runtimeOrigin: new URL(`http://127.0.0.1:${hostPort}`),
    workspace: portableFsWorkspaceConfig(portableFsManagerUrl),
  };
}

function portableFsWorkspaceConfig(managerUrl: URL): HostConfig["workspace"] {
  return {
    deletionRetentionDays: 14,
    shape: {
      defaultWorkspaceBacking: "portablefs",
      kind: "server" as const,
    },
    storage: {
      archiveAfterDays: 7,
      authorizationDomain: "opensteer-test",
      defaultBlockLimitBytes: 10 * 1_024 * 1_024 * 1_024,
      defaultInodeLimit: 1_000_000,
      filesServiceUrl: new URL("http://127.0.0.1:4315"),
      kind: "portablefs",
      maxBlockLimitBytes: 100 * 1_024 * 1_024 * 1_024,
      maxInodeLimit: 10_000_000,
      managerCaPath: undefined,
      managerCertPath: undefined,
      managerKeyPath: undefined,
      managerServerName: undefined,
      managerUrl,
      productIssuer: "opensteer-test",
      productPrivateKeyPath: undefined,
      serviceId: "test-portablefs",
    },
  };
}

function withoutInitialOwner(config: HostConfig): HostConfig {
  return {
    ...config,
    identity: { ...config.identity, initialOwnerEnrollment: undefined },
  };
}

async function initializeOwnerSession(origin: string): Promise<void> {
  const exchanged = await fetch(`${origin}/v1/rpc/auth.setup.exchange`, {
    body: JSON.stringify({ token: accessToken }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      origin,
    },
    method: "POST",
  });
  if (!exchanged.ok) throw new Error(`Setup exchange failed with HTTP ${exchanged.status}.`);
  const admissionCookies = responseCookies(exchanged);
  const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
    body: JSON.stringify({
      email: "alex@example.com",
      kind: "password",
      password: "integration-owner-password",
    }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      cookie: admissionCookies.join("; "),
      origin,
    },
    method: "POST",
  });
  if (!claimed.ok) {
    throw new Error(`Owner claim failed with HTTP ${claimed.status}: ${await claimed.text()}`);
  }
  const sessionCookies = responseCookies(claimed);
  if (sessionCookies.length === 0) throw new Error("Host did not issue a session cookie.");
  ownerSessionHeaders = { cookie: sessionCookies.join("; "), origin };
  const enrollment = await testRpcData(
    origin,
    "commands.dispatch",
    {
      // The lend flow grants both modules this Deployment's own computer has.
      allowedModules: ["agents", "browser"],
      idempotencyKey: "test-local-runner",
      name: "Test local computer",
      type: "runner.enrollment.createLocal",
    },
    { headers: ownerSessionHeaders },
  );
  if (enrollment.type !== "runner.enrollment.createLocal") {
    throw new Error("Runner enrollment command mismatch.");
  }
  runnerToken = enrollment.token;
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
  if (!full || full.instanceRole !== "administrator") {
    throw new Error("Test administrator has not been initialized");
  }
  return full.id;
}

async function initialOwnerEnrollmentDeadline(store: OpensteerStore) {
  return store.database
    .selectFrom("ownerEnrollments")
    .select(["createdAt", "expiresAt", "tokenHash"])
    .where("idempotencyKey", "=", "initial-owner-bootstrap")
    .executeTakeFirstOrThrow();
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

function waitForWorkspaceEvent(
  socket: WebSocket,
  eventType: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for workspace event ${eventType}`)),
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
async function seededHarness(store: HostRuntime["store"], environmentId: EnvironmentId) {
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
  const response = await fetch(url, init);
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function openWebSocket(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, token ? { headers: authorization(token) } : undefined);
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
  return RunnerDescriptorSchema.parse({
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
        "execution-plane-v2",
      ]),
    ],
    ...(input.device === undefined ? {} : { device: input.device }),
    modules: {
      agents: {
        environmentIds: input.environmentIds,
        harnessDrivers: input.harnessDrivers,
        localStorage: input.localStorage ?? null,
        maxConcurrentRuns: input.maxConcurrentRuns ?? 1,
        providerStateModes: input.providerStateModes ?? ["ambient", "isolated"],
        workspaceBackings: input.workspaceBackings ?? ["portablefs"],
        workspaceMounts: input.workspaceMounts ?? [],
      },
    },
    name: input.name,
    runnerId: input.runnerId,
    runnerKind: input.runnerKind,
    runtimeVersion: input.runtimeVersion,
  });
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
          catalogs: message.harnesses.map(catalogFor),
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
