import {
  createChannelId,
  slackChannelProviderManifest,
  type ChannelAccountId,
  type ChannelConversationId,
  type ChannelIngressId,
  type ChannelProviderManifest,
} from "@opensteer/channel-core";
import {
  createId,
  HarnessIdSchema,
  ModelSelectionSchema,
  PendingRequestSchema,
  RunnerIdSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  type EnvironmentId,
  type HarnessInstanceId,
  type RequestId,
  type RunId,
  type RunnerId,
  type UserId,
  type Workspace,
} from "@opensteer/core";
import {
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
} from "@opensteer/integration-core";
import {
  HarnessInstanceCatalogSchema,
  type PendingAgentEvent,
  type RunnerDescriptor,
  type RunnerModuleName,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ChannelIngressDeferredError,
  ChannelStore,
  createDatabase,
  OpensteerStore,
  TriggerStore,
} from "./index.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";

export const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;

const integration = databaseUrl ? describe : describe.skip;

export const testModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

export const testContinuationIdentity = {
  continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
  driverKind: HarnessIdSchema.parse("native"),
} as const;

/**
 * What a Runner last reported for an account. A channel message picks the
 * model marked `isDefault` here, so a fixture whose Threads are created for it
 * has to have one.
 */
export function testReadyHarnessCatalog(harnessInstanceId: HarnessInstanceId) {
  return HarnessInstanceCatalogSchema.parse({
    continuationIdentity: testContinuationIdentity,
    driverKind: "native",
    harnessInstanceId,
    models: [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: testModelSelection.modelId,
        options: [],
        providerId: testModelSelection.providerId,
      },
    ],
    status: "ready",
  });
}

/** The messaging computer: an enrolled Runner whose only module is messaging. */
export const testMessagingRunnerId = RunnerIdSchema.parse(
  "rnr_00000000-0000-4000-8000-000000000001",
);

export const replacementMessagingRunnerId = RunnerIdSchema.parse(
  "rnr_00000000-0000-4000-8000-000000000002",
);

export const testWorkspaceProfile = {
  defaultWorkspaceBacking: "portablefs",
  kind: "server" as const,
} as const;

/**
 * What a reach-only computer advertises: the `shell` module and nothing else.
 * The host key is a placeholder — the store records what a machine claims about
 * itself and never judges it.
 */
export const reachOnlyModules: RunnerDescriptor["modules"] = {
  shell: { hostPublicKey: `ssh-ed25519 ${"A".repeat(68)}`, platform: "darwin" },
};

/** What the Host would say; adoption inserts whichever of these it decides on. */
export const testChannelNotices = {
  approvalPending: "Your access request is waiting for approval.",
  linkByDirectMessage: "Send me a direct message to link your account.",
  linkCode: (code: string) => `Enter the code **${code}** to link your account.`,
  noRoute: "This conversation is not routed to an Opensteer Workspace.",
  notAMember: "You don't have access to the Workspace this conversation is routed to.",
} as const;

export function testChannelAccessPolicy(mode: "anyone" | "approved" | "linked-members" | "owner") {
  const sender = { allowedExternalUserIds: [], mode } as const;
  return {
    channels: { conversationIds: [], scope: "all" as const, sender },
    directMessages: sender,
  };
}

export function portableFsBacking(workspace: Workspace) {
  expect(workspace.backing.kind).toBe("portablefs");
  if (workspace.backing.kind !== "portablefs") {
    throw new Error(`Expected PortableFS backing, received ${workspace.backing.kind}`);
  }
  return workspace.backing;
}

/** Writes one browser-usage verification artifact where the run asked for them. */
export async function writeBrowserUsageArtifact(name: string, value: unknown): Promise<void> {
  const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
  if (!directory) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${name}`, JSON.stringify(value, null, 2));
}

export async function enrollTestRunner(
  store: OpensteerStore,
  input: {
    /** What this computer may ever advertise; agents unless a caller says otherwise. */
    readonly allowedModules?: readonly RunnerModuleName[];
    /** Null when the Deployment authored this enrollment for its own Main Runner. */
    readonly createdBy: ReturnType<typeof createId<"user">> | null;
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    /** What this boot advertises; the full agents machine unless a caller says otherwise. */
    readonly modules?: RunnerDescriptor["modules"];
    readonly name: string;
    /** Present when a managed Runner was attached for one person. */
    readonly ownerUserId?: ReturnType<typeof createId<"user">>;
    readonly runnerId: ReturnType<typeof createId<"runner">>;
    readonly runnerKind?: "main" | "local" | "managed";
    readonly tokenSuffix: string;
  },
): Promise<void> {
  if (!(await store.getDeployment())) {
    await store.ensureDeployment({
      canonicalOrigin: "https://test-host.invalid",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: testWorkspaceProfile,
    });
  }
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
  const descriptor: RunnerDescriptor = testRunnerDescriptor({
    environmentId: input.environmentId,
    ...(input.modules ? { modules: input.modules } : {}),
    name: input.name,
    runnerId: input.runnerId,
    runnerKind: input.runnerKind ?? "main",
  });
  const enrollmentTokenHash = `sha256:${createHash("sha256")
    .update(`test-enrollment-${input.tokenSuffix}`, "utf8")
    .digest("base64url")}`;
  await store.createRunnerEnrollment({
    allowedModules: input.allowedModules ?? ["agents"],
    createdBy: input.createdBy,
    expiresAt: new Date(Date.now() + 60_000),
    id: `ren_${randomUUID()}`,
    idempotencyKey: `test-runner-${input.tokenSuffix}`,
    name: input.name,
    ...(input.runnerKind && input.runnerKind !== "main"
      ? {}
      : { mainEnrollmentPurpose: "initial" as const }),
    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
    requestFingerprint: `sha256:test-runner-${input.tokenSuffix}`,
    runnerKind: input.runnerKind ?? "main",
    tokenHash: enrollmentTokenHash,
  });
  await store.enrollRunnerConnection({
    descriptor,
    enrollmentTokenHash,
    publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
    publicKeyPem,
  });
}

export function testRunnerDescriptor(input: {
  readonly environmentId: ReturnType<typeof createId<"environment">>;
  /** What this boot advertises; the full agents machine unless a caller says otherwise. */
  readonly modules?: RunnerDescriptor["modules"];
  readonly name: string;
  readonly runnerId: ReturnType<typeof createId<"runner">>;
  readonly runnerKind: "main" | "local" | "managed";
}): RunnerDescriptor {
  return {
    bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
    capabilities: ["filesystem"],
    modules: input.modules ?? {
      agents: {
        environmentIds: [input.environmentId],
        harnessDrivers: [
          {
            accessModes: ThreadAccessModeSchema.options,
            driverKind: HarnessIdSchema.parse("native"),
            readiness: "configured",
            steering: true,
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
    name: input.name,
    runnerId: input.runnerId,
    runnerKind: input.runnerKind,
    runtimeVersion: "test",
  };
}

export function fingerprint(publicKey: KeyObject): string {
  return `sha256:${createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url")}`;
}

export function pendingEvent<T extends PendingAgentEvent>(input: Omit<T, "emittedAt">): T {
  return { ...input, emittedAt: new Date().toISOString() } as T;
}

export function liveRequest(input: {
  readonly harnessInstanceId: string;
  readonly id: string;
  readonly presentation: unknown;
  readonly requestedBy: string;
  readonly runId: string;
  readonly threadId: string;
  readonly workspaceId: string;
}) {
  return PendingRequestSchema.parse({
    callId: input.id,
    cancellationReason: null,
    createdAt: new Date().toISOString(),
    id: input.id,
    kind: "harness.input",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: input.runId,
    originatingThreadId: input.threadId,
    originatingWorkspaceId: input.workspaceId,
    payload: { kind: "harness.input" },
    presentation: input.presentation,
    requestedBy: input.requestedBy,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: input.workspaceId,
  });
}

export function sealedTestRequestResponse(): {
  readonly envelope: Buffer;
  readonly keyVersion: number;
  readonly requestFingerprint: string;
} {
  return {
    envelope: Buffer.from("encrypted-test-action-response"),
    keyVersion: 1,
    requestFingerprint: "hmac-sha256-v1:1:test-action-response",
  };
}

export function testOpenApiAdapterContract(input: {
  readonly definitionId: string;
  readonly provider: string;
}) {
  const definition = IntegrationDefinitionSchema.parse({
    adapter: "openapi",
    authMethods: [
      {
        id: "api-key",
        inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
        kind: "api-key",
        label: "API key",
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
        ],
      },
    ],
    config: {},
    description: "Test adapter definition",
    id: input.definitionId,
    name: input.definitionId,
    provider: input.provider,
  });
  return {
    adapterSnapshot: {
      adapter: "openapi" as const,
      config: {},
      definitionId: definition.id,
    },
    definition,
    manifest: { definition: integrationDefinitionSummary(definition) },
  };
}

void (undefined as EnvironmentId | undefined);

export async function createStoreFixture() {
  const clone = await cloneTestDatabase("host");
  const { database } = await ownTestDatabaseProducer(clone.url, async () => {
    const database = createDatabase({
      applicationName: "opensteer-integration-test",
      connectionString: clone.url,
      maxConnections: 6,
    });
    return { database, close: () => database.destroy() };
  });

  const store = new OpensteerStore(database);

  const triggers = new TriggerStore(database);

  type HumanTriggerInput = Omit<
    Parameters<OpensteerStore["enqueueThreadInput"]>[0],
    "policy" | "source"
  >;

  async function enqueueHumanTrigger(
    input: HumanTriggerInput,
    targetStore: OpensteerStore = store,
  ) {
    const admitted = await targetStore.enqueueThreadInput({
      ...input,
      policy: "queue",
      source: { kind: "human" },
    });
    expect(admitted).toMatchObject({
      command: { type: "run.execute" },
      disposition: "run-queued",
      run: { status: "queued" },
    });
    if (!admitted.command || !admitted.run) {
      throw new Error("Expected human trigger input to queue a Run");
    }
    return { ...admitted, command: admitted.command, run: admitted.run };
  }

  /** Turns the Personal route on, which is what admits any computer but Main. */
  async function enablePersonalRemoteAccess(): Promise<void> {
    await database
      .updateTable("personalRemoteAccess")
      .set({
        generation: 1,
        mode: "private",
        routeOrigin: "https://personal.test.invalid",
        updatedAt: new Date(),
      })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();
  }

  async function enrollMessagingRunner(runnerId: RunnerId, name: string): Promise<void> {
    const tokenHash = `sha256:messaging-runner-${runnerId}`;
    await store.createRunnerEnrollment({
      allowedModules: ["messaging"],
      createdBy: null,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: `messaging-runner-${runnerId}`,
      name,
      requestFingerprint: `sha256:messaging-runner-${runnerId}`,
      runnerKind: "managed",
      tokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor: {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
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
        name,
        runnerId,
        runnerKind: "managed",
        runtimeVersion: "test",
      },
      enrollmentTokenHash: tokenHash,
      publicKeyFingerprint: `sha256:messaging-key-${runnerId}`,
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${runnerId}\n-----END PUBLIC KEY-----\n`,
    });
  }

  /** A computer whose only module is a browser, which is what a relay pod is. */
  async function enrollBrowserRunner(createdBy: UserId, name: string): Promise<RunnerId> {
    const runnerId = createId("runner");
    const tokenHash = `sha256:browser-runner-${runnerId}`;
    await store.createRunnerEnrollment({
      allowedModules: ["browser"],
      createdBy,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: `browser-runner-${runnerId}`,
      name,
      requestFingerprint: `sha256:browser-runner-${runnerId}`,
      runnerKind: "managed",
      tokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor: {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
        capabilities: [],
        modules: {
          browser: {
            wireVersion: 2,
            runtimeId: name.toLowerCase().replaceAll(" ", "-"),
          },
        },
        name,
        runnerId,
        runnerKind: "managed",
        runtimeVersion: "test",
      },
      enrollmentTokenHash: tokenHash,
      publicKeyFingerprint: `sha256:browser-key-${runnerId}`,
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${runnerId}\n-----END PUBLIC KEY-----\n`,
    });
    return runnerId;
  }

  async function recordReadyHarnessCatalog(
    environmentId: EnvironmentId,
    harness: { readonly id: HarnessInstanceId; readonly runtimeRevision: number },
  ): Promise<void> {
    await store.recordHarnessCatalogs({
      catalogs: [testReadyHarnessCatalog(harness.id)],
      environmentId,
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });
  }

  async function createRunFixture(
    suffix: string,
    options: {
      readonly deploymentShape: {
        readonly defaultWorkspaceBacking: "local-directory" | "portablefs";
        readonly kind: "personal" | "server";
      };
      readonly workspaceBacking: "local-directory" | "portablefs";
    } | null = null,
  ) {
    if (options) {
      await store.ensureDeployment({
        canonicalOrigin:
          options.deploymentShape.kind === "personal"
            ? "http://127.0.0.1:4310"
            : "https://server.test.invalid",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: options.deploymentShape,
      });
    }
    const userId = await store.createUser("Alex");
    if (options?.deploymentShape.kind === "personal") {
      await database
        .updateTable("users")
        .set({ instanceRole: "administrator" })
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
    }
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const localDirectory = options?.workspaceBacking === "local-directory";
    const storageAuthorityId = localDirectory ? createId("storageAuthority") : null;
    const messagingOnMain = options?.deploymentShape.kind === "personal";
    const agentsModule: NonNullable<RunnerDescriptor["modules"]["agents"]> = {
      environmentIds: [environmentId],
      harnessDrivers: [
        {
          accessModes: ThreadAccessModeSchema.options,
          driverKind: HarnessIdSchema.parse("native"),
          readiness: "configured",
          steering: true,
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
      localStorage:
        localDirectory && storageAuthorityId
          ? { bindings: [], storageAuthorityId, truncated: false }
          : null,
      maxConcurrentRuns: 4,
      providerStateModes: ["isolated"],
      workspaceBackings: [localDirectory ? "local-directory" : "portablefs"],
      workspaceMounts: [],
    };
    await enrollTestRunner(store, {
      allowedModules: messagingOnMain ? ["agents", "messaging"] : ["agents"],
      createdBy: options?.deploymentShape.kind === "personal" ? null : userId,
      environmentId,
      modules: {
        agents: agentsModule,
        ...(messagingOnMain
          ? {
              messaging: {
                capabilities: [
                  {
                    manifest: slackChannelProviderManifest,
                    provider: "slack" as const,
                    transportKinds: ["socket" as const],
                  },
                ],
              },
            }
          : {}),
      },
      name: "Main runner",
      runnerId,
      tokenSuffix: suffix,
    });
    const workspace = await store.createWorkspace({
      backing: localDirectory
        ? {
            bindingId: createId("workspaceBinding"),
            generation: 1,
            kind: "local-directory" as const,
            ownerEnvironmentId: environmentId,
            storageAuthorityId: storageAuthorityId!,
          }
        : {
            generation: 1,
            kind: "portablefs" as const,
            serviceId: "test-portablefs",
            volumeId: `wsp_${suffix}`,
          },
      capacityPolicy: localDirectory
        ? { kind: "host-filesystem" as const }
        : {
            blockHardLimitBytes: 10_000_000,
            inodeHardLimit: 10_000,
            kind: "hard-quota" as const,
          },
      createdBy: userId,
      idempotencyKey: `workspace-${suffix}`,
      name: `Workspace ${suffix}`,
      status: "ready",
    });
    expect(workspace.kind).toBe("main");
    const harnessInstance = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    await recordReadyHarnessCatalog(environmentId, harnessInstance);
    const { thread } = await store.createThread({
      createdBy: userId,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      idempotencyKey: `thread-${suffix}`,
      modelSelection: testModelSelection,
      title: `Thread ${suffix}`,
      workspaceId: workspace.id,
    });
    expect(thread.capabilityProfileId).toBe("main");
    return { environmentId, harnessInstance, runnerId, thread, userId, workspace };
  }

  async function createChannelDeliveryFixture(suffix: string) {
    const fixture = await createRunFixture(`channel-delivery-${suffix}`);
    await enrollMessagingRunner(testMessagingRunnerId, "Test messaging service");
    const channels = new ChannelStore(database);
    const configured = await channels.createConnection({
      accessPolicy: testChannelAccessPolicy("anyone"),
      account: {
        displayName: `Delivery ${suffix}`,
        externalAccountId: `T-${suffix}`,
        routingMode: "dedicated",
      },
      connection: {
        runnerId: testMessagingRunnerId,
        connectionMethod: "bring-your-own",
        displayName: `Delivery ${suffix}`,
        externalIdentityId: `U-${suffix}`,
        externalTenantId: `T-${suffix}`,
        provider: "slack",
        transportKind: "socket",
      },
      createdBy: fixture.userId,
      credential: {
        encryptedPayload: Buffer.from(`delivery-${suffix}`),
        encryptionKeyVersion: 1,
        id: createId("credential"),
        name: `Delivery ${suffix}`,
        ownerId: fixture.userId,
        provider: "channel:slack",
      },
      executionPolicy: { harness: "default", harnessInstanceId: null },
      selector: {
        conversationId: null,
        conversationType: null,
        scopeId: null,
        threadId: null,
      },
      workspaceId: fixture.workspace.id,
    });
    await channels.setRuntimeConnectionHealth({
      connectionId: configured.connection.id,
      detail: null,
      reason: null,
      runnerId: testMessagingRunnerId,
      status: "connected",
    });
    const conversationId = createChannelId("conversation");
    await database
      .insertInto("channelConversations")
      .values({
        accountId: configured.account.id,
        activeThreadId: fixture.thread.id,
        bindingId: configured.binding.id,
        bindingRevision: configured.binding.revision,
        conversationType: "dm",
        displayName: `Delivery ${suffix}`,
        externalAccountId: `T-${suffix}`,
        externalConversationId: `D-${suffix}`,
        externalScopeId: null,
        externalThreadId: null,
        id: conversationId,
        provider: "slack",
        providerState: sql`${JSON.stringify({})}::jsonb`,
        updatedAt: new Date(),
        workspaceId: fixture.workspace.id,
      })
      .executeTakeFirstOrThrow();
    return { channels, configured, conversationId, fixture };
  }

  async function insertChannelDelivery(input: {
    readonly accountId: ChannelAccountId;
    readonly conversationId: ChannelConversationId;
    readonly status: "pending" | "leased" | "attempt-started" | "retryable-failed";
  }) {
    const id = createChannelId("delivery");
    const claimed = input.status === "leased" || input.status === "attempt-started";
    await database
      .insertInto("channelDeliveries")
      .values({
        accountId: input.accountId,
        attempts: input.status === "attempt-started" ? 1 : 0,
        claimExpiresAt: claimed ? new Date(Date.now() + 60_000) : null,
        claimOwner: claimed ? testMessagingRunnerId : null,
        claimTokenHash: claimed ? `claim-${id}` : null,
        audience: "conversation",
        content: sql`${JSON.stringify([{ text: "Delivery", type: "text" }])}::jsonb`,
        conversationId: input.conversationId,
        id,
        ingressId: null,
        kind: "status",
        lastError: input.status === "retryable-failed" ? "Temporary provider failure" : null,
        messageId: null,
        nextAttemptAt: new Date(),
        receipt: null,
        sentAt: null,
        status: input.status,
        updatedAt: new Date(),
      })
      .executeTakeFirstOrThrow();
    return id;
  }

  async function bindAgentControlRun(
    fixture: Awaited<ReturnType<typeof createRunFixture>>,
    runId: RunId,
    suffix: string,
    threadId = fixture.thread.id,
  ) {
    const runnerBootId = `boot-agent-control-${suffix}`;
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: `agent-control-${suffix}-lease`,
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId,
      threadId,
    });
    return {
      bindingGeneration: binding.bindingGeneration,
      environmentId: fixture.environmentId,
      membershipGeneration: 1,
      requestedBy: fixture.userId,
      runnerBootId,
      runnerId: fixture.runnerId,
      workspaceId: fixture.workspace.id,
    };
  }

  /** A Thread whose head Run has reached `running` on a bound Runner. */
  async function startRunFixture(suffix: string) {
    const fixture = await createRunFixture(suffix);
    const runnerBootId = `boot-${suffix}`;
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Start the work", type: "text" }],
      idempotencyKey: `${suffix}-initial-turn`,
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, `${suffix}-dispatcher`);
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: `${suffix}-lease`,
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: turn.run.id,
      threadId: fixture.thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: turn.run.id,
        threadId: fixture.thread.id,
        type: "run.started",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    return {
      ...fixture,
      bindingGeneration: binding.bindingGeneration,
      run: turn.run,
      runnerBootId,
      turn,
    };
  }

  async function stagedRequestRace(
    lock: (
      transaction: import("kysely").Transaction<import("./schema.js").DatabaseSchema>,
    ) => Promise<unknown>,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ) {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = database.transaction().execute(async (transaction) => {
      await lock(transaction);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const waiters = (count: number) =>
      expect
        .poll(async () => {
          const result = await sql<{
            waiting: number;
          }>`select count(*)::integer as waiting from pg_stat_activity
        where datname = current_database() and application_name = 'opensteer-integration-test' and wait_event_type = 'Lock'`.execute(
            database,
          );
          return result.rows[0]!.waiting;
        })
        .toBeGreaterThanOrEqual(count);
    const a = first();
    void a.catch(() => undefined);
    let b: Promise<unknown> | undefined;
    try {
      await waiters(1);
      b = second();
      void b.catch(() => undefined);
      await waiters(2);
    } finally {
      release.resolve();
      await blocker;
    }
    const results = await Promise.allSettled([a, b!]);
    for (const result of results) {
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: expect.stringMatching(/^(conflict|forbidden|not_found)$/),
        });
    }
    expect(results.some(({ status }) => status === "fulfilled")).toBe(true);
    return results;
  }

  /** A Trigger anchored to the fixture's Thread, with one Occurrence running. */
  async function startTriggerOccurrence(
    fixture: Awaited<ReturnType<typeof startRunFixture>>,
    suffix: string,
  ) {
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: `trigger-${suffix}`,
      name: `Trigger ${suffix}`,
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: created.trigger.id,
    });
    const claimed = await store.claimCommand(occurrence.commandId, `trigger-dispatcher-${suffix}`);
    if (!claimed) throw new Error("Expected the Trigger command claim");
    await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId: `trigger-boot-${suffix}`,
      runnerId: fixture.runnerId,
    });
    return occurrence;
  }

  function openLiveRequest(
    fixture: Awaited<ReturnType<typeof startRunFixture>>,
    requestId: RequestId,
  ) {
    return store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: {
          request: liveRequest({
            harnessInstanceId: fixture.harnessInstance.id,
            id: requestId,
            presentation: {
              detail: "Approve this operation",
              kind: "choice",
              options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
              title: "Approval required",
            },
            requestedBy: fixture.userId,
            runId: fixture.run.id,
            threadId: fixture.thread.id,
            workspaceId: fixture.workspace.id,
          }),
        },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "request.opened",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
  }

  function createSpecializedWorkspace(ownerId: UserId, suffix: string, id?: Workspace["id"]) {
    return store.createWorkspace({
      ...(id ? { id } : {}),
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `wsp_${suffix}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: `workspace-${suffix}`,
      kind: "specialized" as const,
      name: `Workspace ${suffix}`,
      status: "ready" as const,
    });
  }

  /** The SQL mirror of the TypeScript execution-authority predicate. */
  async function sqlCanExecute(environmentId: EnvironmentId, userId: string): Promise<boolean> {
    const result = await sql<{ readonly allowed: boolean }>`
      select opensteer_user_can_execute_environment(${environmentId}, ${userId}) as allowed
    `.execute(database);
    return result.rows[0]?.allowed === true;
  }

  async function principalIdFor(userId: string): Promise<string> {
    const result = await sql<{
      readonly id: string;
    }>`select id from principals where user_id = ${userId}`.execute(database);
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Principal for user is missing");
    return id;
  }

  /**
   * A deployment where a managed Runner was attached for Alice, and Bob
   * is an active member of the same Workspace. Bob's access to the Workspace is
   * real; only the work location is private.
   */
  async function createCloudBindingFixture(suffix: string) {
    await store.ensureDeployment({
      canonicalOrigin: "https://cloud.test.invalid",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
    });
    const aliceId = await store.createUser("Alice");
    const bobId = await store.createUser("Bob");
    const mainEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: aliceId,
      environmentId: mainEnvironmentId,
      name: "Main runner",
      runnerId: createId("runner"),
      tokenSuffix: `${suffix}-main`,
    });
    const aliceEnvironmentId = createId("environment");
    const aliceRunnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: aliceId,
      environmentId: aliceEnvironmentId,
      name: "Alice's managed Runner",
      ownerUserId: aliceId,
      runnerId: aliceRunnerId,
      runnerKind: "managed",
      tokenSuffix: `${suffix}-alice-cloud`,
    });
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `wsp_${suffix}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: aliceId,
      idempotencyKey: `workspace-${suffix}`,
      name: `Workspace ${suffix}`,
      status: "ready",
    });
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: aliceEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    await recordReadyHarnessCatalog(aliceEnvironmentId, harness);
    const mainHarness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: mainEnvironmentId,
      name: "Native Main",
      stateKind: "isolated",
    });
    await recordReadyHarnessCatalog(mainEnvironmentId, mainHarness);
    const invitation = await store.createWorkspaceInvitation({
      createdBy: aliceId,
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: `${suffix}-invite`,
      intendedEmail: null,
      requestFingerprint: `sha256:${suffix}-invite`,
      role: "collaborator",
      selector: `${suffix}-selector`.padEnd(20, "0").slice(0, 32),
      tokenHash: `sha256:${suffix}-verifier`,
      type: "link",
      workspaceId: workspace.id,
    });
    await store.acceptWorkspaceInvitation({
      selector: invitation.selector,
      tokenHash: `sha256:${suffix}-verifier`,
      userEmail: `${bobId}@test.invalid`,
      userEmailVerified: true,
      userId: bobId,
    });
    return {
      aliceEnvironmentId,
      aliceId,
      aliceRunnerId,
      bobId,
      harness,
      mainHarness,
      mainEnvironmentId,
      workspace,
    };
  }

  /**
   * Drives a delegated Run through the Runner's event stream: start, replies,
   * then its terminal event. Returns the terminal commit and that event so a
   * caller can replay it.
   */
  async function runDelegatedTurn(
    fixture: Awaited<ReturnType<typeof startRunFixture>>,
    run: { readonly id: RunId; readonly threadId: ReturnType<typeof ThreadIdSchema.parse> },
    input: {
      readonly end: "completed" | "failed" | "interrupted";
      readonly replies: readonly string[];
      readonly suffix: string;
    },
  ) {
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await store.claimCommand(command.id, `${input.suffix}-dispatcher`);
    const runnerBootId = `boot-${input.suffix}`;
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: `${input.suffix}-lease`,
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: run.id,
      threadId: run.threadId,
    });
    const commit = (event: PendingAgentEvent) =>
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event,
        runnerBootId,
        runnerId: fixture.runnerId,
      });
    const scope = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: fixture.environmentId,
      runId: run.id,
      threadId: run.threadId,
      workspaceId: fixture.workspace.id,
    };
    await commit(
      pendingEvent({ ...scope, data: { status: "running" }, ordinal: 0, type: "run.started" }),
    );
    for (const [index, text] of input.replies.entries()) {
      await commit(
        pendingEvent({
          ...scope,
          data: { content: [{ text, type: "text" }], messageId: createId("message") },
          ordinal: index + 1,
          type: "assistant.message",
        }),
      );
    }
    const ordinal = input.replies.length + 1;
    const terminalEvent: PendingAgentEvent =
      input.end === "failed"
        ? pendingEvent({
            ...scope,
            data: {
              code: "harness_error",
              message: "The child provider failed",
              retryable: false,
              status: "failed",
            },
            ordinal,
            type: "run.failed",
          })
        : pendingEvent({
            ...scope,
            data: { status: input.end },
            ordinal,
            type: input.end === "completed" ? "run.completed" : "run.interrupted",
          });
    return { terminal: await commit(terminalEvent), terminalEvent, commit };
  }

  /**
   * A connection whose route admits only linked people, so an unlinked sender
   * is the ordinary case rather than a contrivance.
   */
  async function createChannelNoticeFixture(
    suffix: string,
    options: {
      readonly accessMode?: "anyone" | "approved" | "linked-members" | "owner";
      readonly providers?: readonly ChannelProviderManifest[];
      readonly runFixture?: NonNullable<Parameters<typeof createRunFixture>[1]>;
    } = {},
  ) {
    const fixture = await createRunFixture(`channel-notice-${suffix}`, options.runFixture ?? null);
    const messagingRunnerId =
      options.runFixture?.deploymentShape.kind === "personal"
        ? fixture.runnerId
        : testMessagingRunnerId;
    if (messagingRunnerId === testMessagingRunnerId) {
      await enrollMessagingRunner(testMessagingRunnerId, "Test messaging service");
    }
    const channels = new ChannelStore(
      database,
      options.providers ? { providers: options.providers } : {},
    );
    const configured = await channels.createConnection({
      accessPolicy: testChannelAccessPolicy(options.accessMode ?? "linked-members"),
      account: {
        displayName: `Notice ${suffix}`,
        externalAccountId: `T-${suffix}`,
        routingMode: "dedicated",
      },
      connection: {
        runnerId: messagingRunnerId,
        connectionMethod: "bring-your-own",
        displayName: `Notice ${suffix}`,
        externalIdentityId: `U-BOT-${suffix}`,
        externalTenantId: `T-${suffix}`,
        provider: "slack",
        transportKind: "socket",
      },
      createdBy: fixture.userId,
      credential: {
        encryptedPayload: Buffer.from(`notice-${suffix}`),
        encryptionKeyVersion: 1,
        id: createId("credential"),
        name: `Notice ${suffix}`,
        ownerId: fixture.userId,
        provider: "channel:slack",
      },
      executionPolicy: { harness: "default", harnessInstanceId: null },
      selector: { conversationId: null, conversationType: null, scopeId: null, threadId: null },
      workspaceId: fixture.workspace.id,
    });
    await channels.setRuntimeConnectionHealth({
      connectionId: configured.connection.id,
      detail: null,
      reason: null,
      runnerId: messagingRunnerId,
      status: "connected",
    });
    const event = (input: {
      readonly displayName?: string;
      readonly eventId: string;
      readonly externalUserId?: string;
      readonly type?: "channel" | "dm";
      readonly trigger?: "mention" | "conversation-followup";
    }) => ({
      accountExternalId: `T-${suffix}`,
      actor: {
        displayName: input.displayName ?? "External operator",
        externalUserId: input.externalUserId ?? `U-${suffix}`,
      },
      content: [{ text: "Look at this", type: "text" as const }],
      conversation:
        input.type === "dm"
          ? {
              displayName: null,
              externalConversationId: `D-${suffix}`,
              externalScopeId: `T-${suffix}`,
              externalThreadId: null,
              type: "dm" as const,
            }
          : {
              displayName: suffix.toLowerCase(),
              externalConversationId: `C-${suffix}`,
              externalScopeId: `T-${suffix}`,
              externalThreadId: "1786320000.000100",
              type: "channel" as const,
            },
      eventId: input.eventId,
      occurredAt: new Date().toISOString(),
      provider: "slack" as const,
      providerMessageId: input.eventId,
      trigger: input.trigger ?? ("mention" as const),
    });
    const placementCandidates = [
      { environmentId: fixture.environmentId, harnessInstanceId: fixture.harnessInstance.id },
    ];
    const claimFor = async (
      ingressId: ChannelIngressId,
    ): Promise<NonNullable<Awaited<ReturnType<ChannelStore["claimIngress"]>>>> => {
      const claimed = await channels.claimIngress(`notice-worker-${suffix}`);
      expect(claimed?.id).toBe(ingressId);
      return claimed!;
    };
    const adopt = async (
      input: Parameters<typeof event>[0],
    ): Promise<{
      ingressId: ChannelIngressId;
      result: Awaited<ReturnType<ChannelStore["adoptIngress"]>>;
    }> => {
      const committed = await channels.commitIngress(configured.connection.id, event(input));
      const claimed = await claimFor(committed.ingressId);
      try {
        const result = await channels.adoptIngress({
          claimToken: claimed.claimToken,
          ingressId: claimed.id,
          notices: testChannelNotices,
          placementCandidates,
        });
        return { ingressId: committed.ingressId, result };
      } catch (error) {
        // The ingress worker puts a failed claim back so the conversation's
        // lane keeps moving; a test that expects the failure must do the same
        // or its next message can never be claimed.
        await channels.releaseIngress(
          claimed.id,
          claimed.claimToken,
          error instanceof Error ? error.message : String(error),
          { deferred: error instanceof ChannelIngressDeferredError },
        );
        throw error;
      }
    };
    const notices = (ingressId: ChannelIngressId) =>
      database
        .selectFrom("channelDeliveries")
        .select(["audience", "content", "kind", "status"])
        .where("ingressId", "=", ingressId)
        .execute();
    return { adopt, channels, claimFor, configured, event, fixture, notices, placementCandidates };
  }
  return Object.freeze({
    databaseUrl: clone.url,
    database,
    store,
    triggers,
    enqueueHumanTrigger,
    enablePersonalRemoteAccess,
    enrollMessagingRunner,
    enrollBrowserRunner,
    recordReadyHarnessCatalog,
    createRunFixture,
    createChannelDeliveryFixture,
    insertChannelDelivery,
    bindAgentControlRun,
    startRunFixture,
    stagedRequestRace,
    startTriggerOccurrence,
    openLiveRequest,
    createSpecializedWorkspace,
    sqlCanExecute,
    principalIdFor,
    createCloudBindingFixture,
    runDelegatedTurn,
    createChannelNoticeFixture,
  });
}

export type StoreFixture = Awaited<ReturnType<typeof createStoreFixture>>;

const storeTest = it.extend<{ storeFixture: StoreFixture }>({
  storeFixture: async ({ task }, use) => {
    const started = performance.now();
    const fixture = await createStoreFixture();
    if (process.env.OPENSTEER_STORE_SETUP_TIMINGS)
      appendFileSync(
        process.env.OPENSTEER_STORE_SETUP_TIMINGS,
        JSON.stringify({
          file: task.file.filepath,
          test: task.name,
          setupMs: performance.now() - started,
        }) + "\n",
      );
    await use(fixture);
  },
});

export function describeStore(name: string, body: (test: typeof storeTest) => void): void {
  integration(name, () => {
    body(storeTest);
  });
}
