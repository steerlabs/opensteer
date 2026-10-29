import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
} from "@opensteer/core";
import {
  createDatabase,
  IntegrationPlatformStore,
  IntegrationStore,
  OpensteerStore,
} from "@opensteer/database";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { computerAppIntegrations } from "@opensteer/integration-catalog";
import { createComputerAppApproval } from "@opensteer/runner-auth";
import type { PendingAgentEvent, RunnerDescriptor } from "@opensteer/protocol";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMachineAccessDatabase,
  resetMachineAccessDatabase,
} from "../runtime/machine-access.test-support.js";
import { integrationCallSubject } from "./integration-call-subject.js";
import {
  IntegrationPlatformService,
  type ComputerUseGateway,
} from "./integration-platform-service.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
const definition = computerAppIntegrations.find(({ id }) => id === "macos-app")!;

/** The setup request ids in the last approval list the Mac was sent. */
function listedTo(pushed: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) {
  const list = pushed.mock.calls.at(-1)?.[1] as
    { readonly approvals: readonly { readonly request: { readonly id: string } }[] } | undefined;
  return list?.approvals.map(({ request }) => request.id) ?? [];
}

integration.sequential("Host computer-use approval transactions", () => {
  let dataDirectory: string;
  let isolated: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-computer-use-test-"));
    isolated = await createMachineAccessDatabase(baseDatabaseUrl!);
    database = createDatabase({
      applicationName: "host-computer-use-test",
      connectionString: isolated.url,
      maxConnections: 4,
    });
  }, 120_000);
  beforeEach(async () => resetMachineAccessDatabase(isolated.url));
  afterAll(async () => {
    await database?.destroy();
    await isolated?.drop();
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  });

  async function fixture() {
    const store = new OpensteerStore(database);
    const persistence = new IntegrationPlatformStore(database);
    const connections = new IntegrationStore(database);
    const task = await createComputerUseTask(store, randomUUID(), { kind: "specialized" });
    const runnerId = createId("runner");
    const keys = generateKeyPairSync("ed25519");
    await database
      .insertInto("runners")
      .values({
        accessPolicy: sql`'{"commands":false,"forwarding":false,"reach":"nobody","shares":[]}'::jsonb`,
        accessPolicyRevision: 1,
        allowedModules: sql`'["integrations"]'::jsonb`,
        capabilities: sql`'[]'::jsonb`,
        connectionGeneration: 0,
        enrolledAt: new Date(),
        enrollmentTokenHash: `sha256:${runnerId}`,
        id: runnerId,
        kind: "local",
        lastSeenAt: null,
        maxConcurrentRuns: null,
        moduleDescriptors: sql`'{"integrations":{"platform":"darwin"}}'::jsonb`,
        name: "Alex's Mac",
        ownerKind: "user",
        ownerUserId: task.userId,
        publicKeyFingerprint: `sha256:${runnerId}`,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        revokedAt: null,
      })
      .execute();
    // The desktop's approval key, which the owner registered on this Mac; the
    // Runner's own key above signs nothing the Host accepts as consent.
    const approvalKeys = generateKeyPairSync("ed25519");
    await persistence.registerComputerUseApprovalKey({
      ownerUserId: task.userId,
      publicKey: approvalKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      requestId: "register-approval-key",
      runnerId,
    });
    /** Every approval list the Mac was sent, on its own stream. */
    const pushed = vi.fn(async (_runnerId: string, _list: unknown) => true);
    /** Runs once, first thing in the Mac's next admission turn. */
    const admission: { next?: (() => Promise<void>) | undefined } = {};
    const computerUse: ComputerUseGateway = {
      eligibleInventory: async () => ({
        machines: [{ runnerId, name: "Alex's Mac", ready: true, state: "ready" }],
        phones: [],
      }),
      // Only a Mac is set up here: asked for its phones, the person has none.
      eligibleMachines: async (_owner, definitionId) =>
        definitionId === "macos-app"
          ? [{ runnerId, name: "Alex's Mac", ready: true, state: "ready" }]
          : [],
      resolveApp: async () => ({
        identity: notes,
        allowed: true,
        reason: null,
        risk: "standard",
        running: false,
        path: "/System/Applications/Notes.app",
      }),
      holders: () => new Map(),
      threadTitle: async () => "Shopping list",
      closeForConnection: vi.fn(),
      installedApps: vi.fn(),
      prepare: vi.fn(),
      release: vi.fn(),
      releaseSession: vi.fn(),
      sendAct: vi.fn(),
      sendObserve: vi.fn(),
      sendWindowOperation: vi.fn(),
      stop: vi.fn(),
    };
    const service = new IntegrationPlatformService({
      adapters: [],
      authorizationSource: { providerAuthorizations: async () => ({}) },
      listConnections: (owner) => connections.listConnections(owner),
      computerApps: {
        reportsApp: () => "reported",
        appStatus: () => ({
          definitionId: "macos-app",
          operations: [
            { operation: "observe", state: "ready", detail: null, remedy: null },
            { operation: "act", state: "ready", detail: null, remedy: null },
          ],
        }),
        attached: () => true,
        machinesFor: () => [],
        openMcpSession: vi.fn(),
        proveComputerAppApprovalKey: async () => null,
        approvalRelayRefusal: () => null,
        relaysComputerAppApprovals: () => true,
        sendComputerAppApprovalOutcome: vi.fn(async () => true),
        sendComputerAppApprovals: pushed,
        withRunnerAdmission: async (_runner, action) => {
          const next = admission.next;
          admission.next = undefined;
          await next?.();
          return action();
        },
        send: vi.fn(),
      },
      computerUse,
      credentialMaterializer: {
        materializeForAdapter: vi.fn(),
        markAdapterAuthorizationRequired: vi.fn(),
      },
      dataDirectory,
      definitions: [definition],
      isRunnerConnected: () => true,
      mcpOauth: { providerFor: vi.fn() },
      onWorkspaceEvent: vi.fn(),
      onConnectionsChanged: vi.fn(),
      onRequestsChanged: vi.fn(),
      store: persistence,
    });
    await service.installCatalogDefinition({
      actorUserId: task.userId,
      definitionId: definition.id,
      digest: integrationDefinitionDigest(definition),
      requestId: "install",
    });
    const input = {
      access: "read-write" as const,
      app: "Notes",
      reason: "Add groceries",
      callId: "request-notes",
      ownerUserId: task.userId,
      originatingRunId: task.runId,
      runnerId,
      threadId: task.threadId,
      workspaceId: task.workspaceId,
    };
    async function automatic() {
      const request = await service.computerAppApprovals.requestComputerAppSetup({
        kind: "policy",
        appApproval: "automatic",
        actorUserId: task.userId,
        runnerId,
      });
      await service.computerAppApprovals.setComputerConnection({
        kind: "policy",
        appApproval: "automatic",
        approval: createComputerAppApproval(approvalKeys.privateKey, request),
        actorUserId: task.userId,
        runnerId,
        isAdministrator: true,
        requestId: "automatic",
      });
    }
    async function approve(access: "read" | "read-write") {
      const request = (await persistence.listComputerAppSetupRequests(task.userId)).find(
        ({ kind }) => kind === "app",
      );
      if (!request) throw new Error("Expected app setup request");
      return service.computerAppApprovals.setComputerConnection({
        kind: "app",
        app: notes,
        access,
        approval: createComputerAppApproval(approvalKeys.privateKey, request),
        actorUserId: task.userId,
        runnerId,
        definitionId: "macos-app",
        isAdministrator: true,
        requestId: "approve-notes",
      });
    }
    return {
      admission,
      service,
      store,
      persistence,
      connections,
      task,
      input,
      automatic,
      approve,
      pushed,
    };
  }

  it("asks on the Mac when automatic approval is switched off while the task's ask waits its turn", async () => {
    const test = await fixture();
    await test.automatic();
    test.admission.next = async () => {
      await test.persistence.setComputerUsePolicy({
        appApproval: "ask",
        ownerUserId: test.task.userId,
        requestId: "policy-off-mid-ask",
        runnerId: test.input.runnerId,
      });
    };

    const requested = await test.service.computerAppApprovals.requestComputerAppAccess(test.input);

    expect(requested).toMatchObject({
      status: "pending",
      nextAction:
        "Approval is pending on Alex's Mac. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.",
    });
    const [setup] = await test.persistence.listComputerAppSetupRequests(test.task.userId);
    await vi.waitFor(() => expect(listedTo(test.pushed)).toEqual([setup!.id]));
    expect(await test.connections.listConnections(test.task.userId)).toEqual([]);
  });

  it("stores task context, sends the Mac the approval, and atomically fulfils the app Request with tools and a Workspace grant", async () => {
    const test = await fixture();
    const requested = await test.service.computerAppApprovals.requestComputerAppAccess(test.input);
    expect(requested.status).toBe("pending");
    const [setup] = await test.persistence.listComputerAppSetupRequests(test.task.userId);
    expect(setup).toMatchObject({
      kind: "app",
      reason: "Add groceries",
      threadTitle: "Shopping list",
      threadId: test.task.threadId,
      workspaceId: test.task.workspaceId,
    });
    // The Mac's list carries what its panel shows, the Workspace's name too.
    await vi.waitFor(() =>
      expect(test.pushed).toHaveBeenLastCalledWith(test.input.runnerId, {
        approvalKeyId: expect.stringMatching(/^sha256:/u),
        approvals: [
          { request: expect.objectContaining({ ...setup, workspaceName: expect.any(String) }) },
        ],
      }),
    );
    const connection = await test.approve("read-write");
    expect(connection?.displayName).toBe("Notes on Alex's Mac");
    expect(
      await test.service.computerAppApprovals.requestComputerAppAccess(test.input),
    ).toMatchObject({ status: "already-available" });
    expect(
      (
        await test.service.listCallableTools({
          ownerUserId: test.task.userId,
          workspaceId: test.task.workspaceId,
          threadId: test.task.threadId,
        })
      )
        .map((row) => row.tool.name)
        .sort(),
    ).toEqual(["act", "observe"]);
    if (requested.status !== "pending") throw new Error("Expected Request");
    const stored = await database
      .selectFrom("requests")
      .select("status")
      .where("id", "=", requested.request.id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe("fulfilled");
  });

  it("creates automatically, keeps connections when policy turns off, blocks, and unblocks only through signed approval", async () => {
    const test = await fixture();
    await test.automatic();
    expect(
      await test.service.computerAppApprovals.requestComputerAppAccess(test.input),
    ).toMatchObject({ status: "fulfilled" });
    expect(
      (
        await test.service.listCallableTools({
          ownerUserId: test.task.userId,
          workspaceId: test.task.workspaceId,
          threadId: test.task.threadId,
        })
      )
        .map((row) => row.tool.name)
        .sort(),
    ).toEqual(["act", "observe"]);
    const [connection] = await test.connections.listConnections(test.task.userId);
    // Nothing reads which policy revision approved an app, so it is not written.
    expect(connection?.computer?.policyRevision).toBeNull();
    await test.service.computerAppApprovals.setComputerUsePolicy({
      runnerId: test.input.runnerId,
      ownerUserId: test.task.userId,
      appApproval: "ask",
      requestId: "ask",
    });
    expect(await test.connections.listConnections(test.task.userId)).toEqual([connection]);
    await test.service.computerAppApprovals.blockComputerApp({
      connectionId: connection!.id,
      ownerUserId: test.task.userId,
      requestId: "block",
    });
    await test.automatic();
    await expect(
      test.service.computerAppApprovals.requestComputerAppAccess(test.input),
    ).rejects.toThrow("Notes is blocked on Alex's Mac.");
    expect(
      await test.service.listCallableTools({
        ownerUserId: test.task.userId,
        threadId: test.task.threadId,
        workspaceId: test.task.workspaceId,
      }),
    ).toEqual([]);
    await test.service.computerAppApprovals.requestComputerAppSetup({
      kind: "app",
      app: notes,
      access: "read",
      actorUserId: test.task.userId,
      runnerId: test.input.runnerId,
      definitionId: "macos-app",
    });
    const restored = await test.approve("read");
    expect(restored).toMatchObject({
      id: connection!.id,
      computer: { blockedAt: null, access: "read" },
    });
  });

  it("attributes historical integration_call computer events only to their own grant", async () => {
    const test = await fixture();
    await test.service.computerAppApprovals.requestComputerAppAccess(test.input);
    await test.approve("read-write");
    // Old transcripts still resolve their saved references; agents now use computer.
    const act = (
      await test.service.listCallableTools({
        ownerUserId: test.task.userId,
        workspaceId: test.task.workspaceId,
        threadId: test.task.threadId,
      })
    ).find((row) => row.tool.name === "act");
    if (!act) throw new Error("Missing internal act authority");
    const actRef = `${act.grant.id}.${act.tool.id}.${act.tool.schemaDigest}`;
    const onError = vi.fn();
    const sources = {
      listCallableTools: test.service.listCallableTools.bind(test.service),
      getComputerConnectionForCall: test.persistence.getComputerConnectionForCall,
      onError,
      runRequester: test.store.runRequester.bind(test.store),
    };
    const { task } = test;
    const toolStarted = (
      ordinal: number,
      toolRef: string,
      of: Pick<
        typeof task,
        "bindingGeneration" | "environmentId" | "runId" | "threadId" | "workspaceId"
      > = task,
    ): PendingAgentEvent => ({
      bindingGeneration: of.bindingGeneration,
      data: {
        arguments: { arguments: {}, toolRef },
        callId: `call-${ordinal}`,
        tool: { name: "integration_call", namespace: "opensteer.integrations" },
      },
      emittedAt: new Date().toISOString(),
      environmentId: of.environmentId,
      ordinal,
      runId: of.runId,
      threadId: of.threadId,
      type: "tool.started",
      workspaceId: of.workspaceId,
    });
    const event = toolStarted(1, actRef);

    const integration = await integrationCallSubject(sources, event);

    expect(integration).toEqual({
      account: "Notes",
      computerApp: {
        app: "Notes",
        bundleId: "com.apple.Notes",
        computer: "Alex's Mac",
        runnerId: test.input.runnerId,
      },
      effect: "write",
      integration: "Computer use",
      operation: { name: "act", title: "Act" },
    });
    const commit = (subject: typeof integration) =>
      test.store.commitRunnerEvent({
        environmentId: task.environmentId,
        event,
        ...(subject ? { integration: subject } : {}),
        runnerBootId: task.runnerBootId,
        runnerId: task.runnerId,
      });
    const committed = await commit(integration);
    // What the Host publishes is the event it committed.
    expect(committed.wasDuplicate).toBe(false);
    expect(committed.event.data).toMatchObject({ integration });
    const replayed = await commit(undefined);
    expect(replayed.wasDuplicate).toBe(true);
    expect(replayed.event).toEqual(committed.event);

    // The same person's task in another Workspace cannot resolve this
    // Workspace's grant.
    const elsewhere = await createWorkspace(test.store, task.userId, randomUUID(), "specialized");
    const { thread } = await test.store.createThread({
      createdBy: task.userId,
      environmentId: task.environmentId,
      harnessInstanceId: task.harnessInstanceId,
      idempotencyKey: "thread-elsewhere",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: { effort: "low" },
        providerId: "openai",
      }),
      title: "Elsewhere",
      workspaceId: elsewhere.id,
    });
    const queued = await test.store.enqueueThreadInput({
      content: [{ text: "Work elsewhere", type: "text" }],
      idempotencyKey: "elsewhere-turn",
      policy: "queue",
      requestedBy: task.userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    if (!queued.run) throw new Error("Expected a Run elsewhere");
    await expect(
      integrationCallSubject(
        sources,
        toolStarted(1, actRef, {
          ...task,
          runId: queued.run.id,
          threadId: thread.id,
          workspaceId: elsewhere.id,
        }),
      ),
    ).resolves.toBeUndefined();
    // A ref whose schema changed, and one for a removed grant, name nothing.
    const [grantId, toolId] = actRef.split(".");
    await expect(
      integrationCallSubject(sources, toolStarted(2, `${grantId}.${toolId}.${"z".repeat(43)}`)),
    ).resolves.toBeUndefined();
    const [grant] = await test.persistence.listGrants({
      ownerUserId: task.userId,
      workspaceId: task.workspaceId,
    });
    await test.service.revokeGrant({
      grantId: grant!.id,
      ownerUserId: task.userId,
      requestId: "revoke-for-subject",
      workspaceId: task.workspaceId,
    });
    await expect(integrationCallSubject(sources, toolStarted(2, actRef))).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it("never widens an existing connection automatically and routes grant-only requests through ordinary access", async () => {
    const test = await fixture();
    await test.service.computerAppApprovals.requestComputerAppAccess({
      ...test.input,
      access: "read",
    });
    const connection = await test.approve("read");
    await test.automatic();
    expect(
      await test.service.computerAppApprovals.requestComputerAppAccess({
        ...test.input,
        callId: "widen",
      }),
    ).toMatchObject({ status: "pending" });
    expect((await test.connections.listConnections(test.task.userId))[0]?.computer?.access).toBe(
      "read",
    );
    const [grant] = await test.persistence.listGrants({
      ownerUserId: test.task.userId,
      workspaceId: test.task.workspaceId,
    });
    await test.service.revokeGrant({
      grantId: grant!.id,
      ownerUserId: test.task.userId,
      requestId: "revoke-grant",
      workspaceId: test.task.workspaceId,
    });
    await test.service.computerAppApprovals.setComputerUsePolicy({
      runnerId: test.input.runnerId,
      ownerUserId: test.task.userId,
      appApproval: "ask",
      requestId: "ask",
    });
    const requested = await test.service.computerAppApprovals.requestComputerAppAccess({
      ...test.input,
      access: "read",
      callId: "grant-only",
    });
    expect(requested).toMatchObject({ status: "pending", request: { kind: "integration.access" } });
    await test.automatic();
    expect(
      await test.service.computerAppApprovals.requestComputerAppAccess({
        ...test.input,
        access: "read",
        callId: "grant-automatic",
      }),
    ).toMatchObject({ status: "fulfilled" });
    expect(
      (
        await test.service.listCallableTools({
          ownerUserId: test.task.userId,
          workspaceId: test.task.workspaceId,
          threadId: test.task.threadId,
        })
      ).map((row) => row.tool.name),
    ).toEqual(["observe"]);
    expect((await test.connections.listConnections(test.task.userId))[0]?.id).toBe(connection!.id);
  });

  it("keeps a computer-app reason longer than 500 characters on the grant-only request", async () => {
    const test = await fixture();
    await test.service.computerAppApprovals.requestComputerAppAccess({
      ...test.input,
      access: "read",
    });
    await test.approve("read");
    const [grant] = await test.persistence.listGrants({
      ownerUserId: test.task.userId,
      workspaceId: test.task.workspaceId,
    });
    await test.service.revokeGrant({
      grantId: grant!.id,
      ownerUserId: test.task.userId,
      requestId: "revoke-grant",
      workspaceId: test.task.workspaceId,
    });
    const reason = "Add every item from the shared shopping list. ".repeat(20).trim();
    expect(reason.length).toBeGreaterThan(500);
    const requested = await test.service.computerAppApprovals.requestComputerAppAccess({
      ...test.input,
      access: "read",
      callId: "grant-only-long-reason",
      reason,
    });
    expect(requested).toMatchObject({
      status: "pending",
      request: { kind: "integration.access", payload: { reason } },
    });
    if (requested.status !== "pending") throw new Error("Expected Request");
    const stored = await database
      .selectFrom("requests")
      .select("payload")
      .where("id", "=", requested.request.id)
      .executeTakeFirstOrThrow();
    expect(stored.payload).toMatchObject({ kind: "integration.access", reason });
  });
});
async function createWorkspace(
  store: OpensteerStore,
  createdBy: ReturnType<typeof createId<"user">>,
  suffix: string,
  kind?: "main" | "specialized",
) {
  return store.createWorkspace({
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: `wsp_${suffix.replaceAll("-", "_")}`,
    },
    capacityPolicy: {
      blockHardLimitBytes: 10_000_000,
      inodeHardLimit: 10_000,
      kind: "hard-quota",
    },
    createdBy,
    idempotencyKey: `workspace-${suffix}`,
    ...(kind === undefined ? {} : { kind }),
    name: `Workspace ${suffix}`,
    status: "ready",
  });
}

/** A Request may only be opened from a Run the Host has seen start. */
async function createComputerUseTask(
  store: OpensteerStore,
  suffix: string,
  options: { readonly kind?: "main" | "specialized" } = {},
) {
  const userId = await store.createUser(`Owner ${suffix}`);
  const runnerId = createId("runner");
  const environmentId = createId("environment");
  if (!(await store.getDeployment())) {
    await store.ensureDeployment({
      canonicalOrigin: "https://test-host.invalid",
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
      hostInstanceId: createId("hostInstance"),
    });
  }
  const pair = generateKeyPairSync("ed25519");
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
  const enrollmentTokenHash = `sha256:${createHash("sha256")
    .update(`test-enrollment-${suffix}`, "utf8")
    .digest("base64url")}`;
  await store.createRunnerEnrollment({
    allowedModules: ["agents"],
    createdBy: userId,
    expiresAt: new Date(Date.now() + 60_000),
    id: `ren_${randomUUID()}`,
    idempotencyKey: `test-runner-${suffix}`,
    mainEnrollmentPurpose: "initial",
    name: `Test runner ${suffix}`,
    requestFingerprint: `sha256:test-runner-${suffix}`,
    runnerKind: "main",
    tokenHash: enrollmentTokenHash,
  });
  const descriptor: RunnerDescriptor = {
    bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
    capabilities: ["filesystem"],
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ThreadAccessModeSchema.options,
            driverKind: HarnessIdSchema.parse("native"),
            readiness: "configured",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "Native",
                quota: "none",
                sourceId: "native",
                stateKinds: ["isolated"],
              },
            ],
          },
        ],
        localStorage: null,
        maxConcurrentRuns: 4,
        providerStateModes: ["isolated"],
        workspaceBackings: ["portablefs"],
        workspaceMounts: [],
      },
    },
    name: `Runner ${suffix}`,
    runnerId,
    runnerKind: "main",
    runtimeVersion: "test",
  };
  await store.enrollRunnerConnection({
    descriptor,
    enrollmentTokenHash,
    publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  const workspace = await createWorkspace(store, userId, suffix, options.kind);
  const harnessInstance = await store.createHarnessInstance({
    config: { model: "test" },
    driverKind: HarnessIdSchema.parse("native"),
    environmentId,
    name: "Native",
    sourceId: "native",
    stateKind: "isolated",
  });
  const { thread } = await store.createThread({
    createdBy: userId,
    environmentId,
    harnessInstanceId: harnessInstance.id,
    idempotencyKey: `thread-${suffix}`,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: { effort: "low" },
      providerId: "openai",
    }),
    title: `Thread ${suffix}`,
    workspaceId: workspace.id,
  });
  const admitted = await store.enqueueThreadInput({
    content: [{ text: "Start the work", type: "text" }],
    idempotencyKey: `${suffix}-initial-turn`,
    policy: "queue",
    requestedBy: userId,
    source: { kind: "human" },
    threadId: thread.id,
  });
  if (!admitted.command || !admitted.run) throw new Error("Expected the input to queue a Run");
  await store.claimCommand(admitted.command.id, `${suffix}-dispatcher`);
  const runnerBootId = `boot-${suffix}`;
  const binding = await store.acquireExecutionBinding({
    bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: HarnessIdSchema.parse("native"),
    },
    harnessInstanceId: harnessInstance.id,
    leaseTokenHash: `${suffix}-lease`,
    membershipGeneration: 1,
    runnerBootId,
    runnerId,
    runId: admitted.run.id,
    threadId: thread.id,
  });
  const started: PendingAgentEvent = {
    bindingGeneration: binding.bindingGeneration,
    data: { status: "running" },
    emittedAt: new Date().toISOString(),
    environmentId,
    ordinal: 0,
    runId: admitted.run.id,
    threadId: thread.id,
    type: "run.started",
    workspaceId: workspace.id,
  };
  await store.commitRunnerEvent({ environmentId, event: started, runnerBootId, runnerId });
  return {
    bindingGeneration: binding.bindingGeneration,
    environmentId,
    harnessInstanceId: harnessInstance.id,
    runId: admitted.run.id,
    runnerBootId,
    runnerId,
    threadId: thread.id,
    userId,
    workspaceId: workspace.id,
  };
}
