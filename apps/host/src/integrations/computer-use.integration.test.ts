import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { createPersonalRunFixturePort } from "@opensteer/database/test-support/personal-run";

import { createId } from "@opensteer/core";
import {
  createDatabase,
  IntegrationPlatformStore,
  IntegrationStore,
  OpensteerStore,
} from "@opensteer/database";
import { computerAppIntegrations } from "@opensteer/integration-catalog";

import type { PendingAgentEvent } from "@opensteer/protocol";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { sql } from "kysely";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMachineAccessDatabase } from "../integrations/personal-machine.test-support.js";
import { integrationCallSubject } from "./integration-call-subject.js";
import { operationAddress } from "./integration-operation.js";
import {
  IntegrationPlatformService,
  type ComputerUseGateway,
} from "./integration-platform-service.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
const definition = computerAppIntegrations.find(({ id }) => id === "macos-app")!;

/** The setup request ids in the last approval list the Mac was sent. */

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
  beforeEach(async () => {
    await sql`truncate table deployments,users,runners restart identity cascade`.execute(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.drop();
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  });

  async function fixture() {
    const store = new OpensteerStore(database);
    const persistence = new IntegrationPlatformStore(database);
    const connections = new IntegrationStore(database);
    const task = await createComputerUseTask(store, randomUUID(), dataDirectory);
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

    /** Every approval list the Mac was sent, on its own stream. */
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
      secretVault: new AesGcmSecretVault(
        new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
      ),
      computerApps: {
        removePluginData: async () => {},
        compatibilityReason: () => null,
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
      onDeploymentEvent: vi.fn(),
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
        setupRequestId: request.id,
        actorUserId: task.userId,
        runnerId,

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
        setupRequestId: request.id,
        actorUserId: task.userId,
        runnerId,
        definitionId: "macos-app",

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
        "Approval for Alex's Mac is pending; the owner can allow or decline from any Opensteer app. Pending grants no access; do not poll, repeat or route around the Request.",
    });
    const [setup] = await test.persistence.listComputerAppSetupRequests(test.task.userId);
    expect(setup).toMatchObject({ runnerId: test.input.runnerId, ownerUserId: test.task.userId });
    expect(await test.connections.listConnections(test.task.userId)).toEqual([]);
  });

  it("stores task context, exposes owner review context, and atomically fulfils the app Request with tools and a Workspace grant", async () => {
    const test = await fixture();
    const requested = await test.service.computerAppApprovals.requestComputerAppAccess(test.input);
    expect(requested.status).toBe("pending");
    const [setup] = await test.persistence.listComputerAppSetupRequests(test.task.userId);
    expect(setup).toMatchObject({
      kind: "app",
      reason: "Add groceries",
      threadTitle: "Shopping list",
      threadId: test.task.threadId,
    });
    expect(setup?.deploymentId).toEqual(test.task.deploymentId);
    const connection = await test.approve("read-write");
    expect(connection?.displayName).toBe("Notes on Alex's Mac");
    expect(
      await test.service.computerAppApprovals.requestComputerAppAccess(test.input),
    ).toMatchObject({ status: "already-available" });
    expect(
      (
        await test.service.listCallableTools({
          ownerUserId: test.task.userId,

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

  it("creates automatically, keeps connections when policy turns off, blocks, and unblocks only through owner approval", async () => {
    const test = await fixture();
    await test.automatic();
    expect(
      await test.service.computerAppApprovals.requestComputerAppAccess(test.input),
    ).toMatchObject({ status: "fulfilled" });
    expect(
      (
        await test.service.listCallableTools({
          ownerUserId: test.task.userId,

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

        threadId: test.task.threadId,
      })
    ).find((row) => row.tool.name === "act");
    if (!act) throw new Error("Missing internal act authority");
    const actAddress = { account: act.grant.connectionId, operation: operationAddress(act) };
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
      address: { readonly account: string | null; readonly operation: string },
      of: Pick<typeof task, "bindingGeneration" | "environmentId" | "runId" | "threadId"> = task,
    ): PendingAgentEvent => ({
      bindingGeneration: of.bindingGeneration,
      data: {
        arguments: { ...address, arguments: {} },
        callId: `call-${ordinal}`,
        tool: { name: "integration_call", namespace: "opensteer.integrations" },
      },
      emittedAt: new Date().toISOString(),
      environmentId: of.environmentId,
      ordinal,
      runId: of.runId,
      threadId: of.threadId,
      type: "tool.started",
    });
    const event = toolStarted(1, actAddress);

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

    // An address whose schema changed, and one for a removed grant, name nothing.
    await expect(
      integrationCallSubject(
        sources,
        toolStarted(2, { ...actAddress, operation: `${act.tool.name}@zzzzzzzz` }),
      ),
    ).resolves.toBeUndefined();
    const [grant] = await test.persistence.listGrants({
      ownerUserId: task.userId,
    });
    await test.service.revokeGrant({
      grantId: grant!.id,
      ownerUserId: task.userId,
      requestId: "revoke-for-subject",
    });
    await expect(
      integrationCallSubject(sources, toolStarted(2, actAddress)),
    ).resolves.toBeUndefined();
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
    });
    await test.service.revokeGrant({
      grantId: grant!.id,
      ownerUserId: test.task.userId,
      requestId: "revoke-grant",
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
    });
    await test.service.revokeGrant({
      grantId: grant!.id,
      ownerUserId: test.task.userId,
      requestId: "revoke-grant",
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
async function createComputerUseTask(store: OpensteerStore, suffix: string, directory: string) {
  const personal = await seedPersonalFixture(store.database, directory),
    admission = createPersonalRunFixturePort(store);
  const task = await admission.createTask({
    ownerId: personal.userId,
    folder: personal.agentHome,
    suffix,
  });
  const started = await admission.startTask(task.threadId, "Start");
  return {
    bindingGeneration: started.bindingGeneration,
    environmentId: personal.environmentId,
    harnessInstanceId: task.harnessInstance.id,
    runId: started.runId,
    runnerBootId: started.runnerBootId,
    runnerId: personal.runnerId,
    threadId: task.threadId,
    userId: personal.userId,
    folder: personal.agentHome,
    deploymentId: personal.deploymentId,
  };
}
