import { testRunnerDescriptor } from "./runner-fixture.test-support.js";
export { testRunnerDescriptor } from "./runner-fixture.test-support.js";
import { findActiveBrowserSessionForPerson } from "./browser-session-store.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import type { ChannelStore } from "./channel-store.js";
import {
  createChannelId,
  slackChannelProviderManifest,
  type ChannelAccountId,
  type ChannelConversationId,
  type ChannelIngressId,
  type ChannelProviderManifest,
} from "@opensteer/channel-core";
import { RunnerIdSchema, type RunnerId } from "@opensteer/core";
import {
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
} from "@opensteer/integration-core";
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { createId } from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  type RunnerDescriptor,
  type RunnerModuleName,
} from "@opensteer/protocol";
import type { OpensteerStore } from "./store.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  ModelSelectionSchema,
  ProviderContinuationIdentitySchema,
  type HarnessInstanceId,
  type RunId,
  type ThreadId,
  type TaskFolder,
  PendingRequestSchema,
  type RequestId,
  type EnvironmentId,
} from "@opensteer/core";
import type { PendingAgentEvent } from "@opensteer/protocol";
import { createDatabase } from "./connection.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";

export const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
export const testModelSelection = ModelSelectionSchema.parse({
  providerId: "openai",
  modelId: "fixture",
  options: {},
});
export const testContinuationIdentity = ProviderContinuationIdentitySchema.parse({
  driverKind: "native",
  continuationKey: `runner:v1:${"A".repeat(43)}`,
});

export interface PersonalRunFixturePort {
  createTask(input: {
    readonly ownerId: string;
    readonly folder: TaskFolder;
    readonly suffix: string;
  }): Promise<{
    readonly threadId: ThreadId;
    readonly thread: import("@opensteer/core").Thread;
    readonly harnessInstance: Awaited<ReturnType<OpensteerStore["createHarnessInstance"]>>;
  }>;
  startTask(
    threadId: ThreadId,
    text: string,
  ): Promise<{
    readonly runId: RunId;
    readonly run: import("@opensteer/core").Run;
    readonly turn: import("./thread-store.js").EnqueuedThreadInput & {
      readonly run: import("@opensteer/core").Run;
      readonly command: import("./schema.js").CommandRow;
    };
    readonly bindingGeneration: number;
    readonly runnerBootId: string;
  }>;
}
export async function createStoreFixture() {
  const clone = await cloneTestDatabase("host");
  try {
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({
        connectionString: clone.url,
        applicationName: "opensteer-integration-test",
        maxConnections: 6,
      });
      return { database, close: () => database.destroy() };
    });
    const { OpensteerStore } = await import("./store.js");
    const store = new OpensteerStore(database, {
      readPersonalResources: readEmptyPersonalResources,
    });
    const { createPersonalRunFixturePort } = await import("./personal-run-fixture.test-support.js");
    const personalRuns = createPersonalRunFixturePort(store);
    let personal: Awaited<ReturnType<typeof seedPersonalFixture>> | undefined;
    async function createRunFixture(
      suffix: string,
      admission: PersonalRunFixturePort = personalRuns,
    ) {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "opensteer-personal-fixture-")),
      );
      await ownTestDatabaseProducer(clone.url, async () => ({
        close: () => rm(directory, { recursive: true, force: true }),
      }));
      personal ??= await seedPersonalFixture(database, directory);
      const task = await admission.createTask({
        ownerId: personal.userId,
        folder: personal.agentHome,
        suffix,
      });
      return {
        ...personal,
        ...task,
        folder: personal.agentHome,
        close: () => rm(directory, { recursive: true, force: true }),
      };
    }
    async function startRunFixture(
      suffix: string,
      admission: PersonalRunFixturePort = personalRuns,
    ) {
      const fixture = await createRunFixture(suffix, admission);
      return { ...fixture, ...(await admission.startTask(fixture.threadId, "Fixture input")) };
    }

    const { TriggerStore } = await import("./trigger-store.js");
    const triggers = new TriggerStore(database);
    type HumanTriggerInput = Omit<
      Parameters<OpensteerStore["enqueueThreadInput"]>[0],
      "policy" | "source"
    >;
    async function enqueueHumanTrigger(input: HumanTriggerInput, targetStore = store) {
      const admitted = await targetStore.enqueueThreadInput({
        ...input,
        policy: "queue",
        source: { kind: "human" },
      });
      if (!admitted.command || !admitted.run) throw new Error("Expected a queued personal Run");
      return { ...admitted, command: admitted.command, run: admitted.run };
    }
    async function recordReadyHarnessCatalog(
      environmentId: EnvironmentId,
      harness: { readonly id: HarnessInstanceId; readonly runtimeRevision: number },
    ) {
      await store.recordHarnessCatalogs({
        catalogs: [testReadyHarnessCatalog(harness.id)],
        environmentId,
        expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
      });
    }
    async function bindAgentControlRun(
      fixture: Awaited<ReturnType<typeof createRunFixture>>,
      runId: RunId,
      suffix: string,
      threadId = fixture.threadId,
    ) {
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: suffix,
        runnerBootId: suffix,
        runnerId: fixture.runnerId,
        runId,
        threadId,
      });
      return {
        bindingGeneration: binding.bindingGeneration,
        environmentId: fixture.environmentId,
        requestedBy: fixture.userId,
        runnerBootId: suffix,
        runnerId: fixture.runnerId,
      };
    }
    async function startTriggerOccurrence(
      fixture: Awaited<ReturnType<typeof startRunFixture>>,
      suffix: string,
    ) {
      const created = await triggers.create({
        actorThreadId: null,
        anchorThreadId: fixture.threadId,
        createdBy: fixture.userId,
        idempotencyKey: "trigger-" + suffix,
        name: "Trigger " + suffix,
        program: {
          toolContractVersion: 3,
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
      await store.claimCommand(occurrence.commandId, suffix);
      await triggers.startExecution({
        commandId: occurrence.commandId,
        runnerBootId: "trigger-boot-" + suffix,
        runnerId: fixture.runnerId,
      });
      return occurrence;
    }
    async function openLiveRequest(
      fixture: Awaited<ReturnType<typeof startRunFixture>>,
      requestId: RequestId,
    ) {
      const run = await database
        .selectFrom("runs")
        .select("nextRunnerOrdinal")
        .where("id", "=", fixture.run.id)
        .executeTakeFirstOrThrow();
      return store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
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
              threadId: fixture.threadId,
            }),
          },
          environmentId: fixture.environmentId,
          ordinal: run.nextRunnerOrdinal,
          runId: fixture.run.id,
          threadId: fixture.threadId,
          type: "request.opened",
        }),
      });
    }

    async function enrollMessagingRunner(runnerId: RunnerId, name: string): Promise<void> {
      const tokenHash = `sha256:messaging-runner-${runnerId}`;
      await store.createRunnerEnrollment({
        allowedModules: ["integrations", "messaging"],
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
    async function createChannelDeliveryFixture(suffix: string) {
      const { ChannelStore } = await import("./channel-store.js");
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
        folder: fixture.folder,
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
    async function createChannelNoticeFixture(
      suffix: string,
      options: {
        readonly accessMode?: "anyone" | "approved" | "owner";
        readonly providers?: readonly ChannelProviderManifest[];
      } = {},
    ) {
      const { ChannelStore, ChannelIngressDeferredError } = await import("./channel-store.js");
      const fixture = await createRunFixture(`channel-notice-${suffix}`);
      const messagingRunnerId = testMessagingRunnerId;
      await enrollMessagingRunner(messagingRunnerId, "Test messaging service");
      const channels = new ChannelStore(
        database,
        options.providers ? { providers: options.providers } : {},
      );
      const configured = await channels.createConnection({
        accessPolicy: testChannelAccessPolicy(options.accessMode ?? "owner"),
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
        folder: fixture.folder,
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
      const availableEngines = [
        { environmentId: fixture.environmentId, driverKinds: [fixture.harnessInstance.driverKind] },
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
            availableEngines,
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
      return { adopt, channels, claimFor, configured, event, fixture, notices, availableEngines };
    }
    async function enablePersonalRemoteAccess() {
      const enabled = {
        generation: 1,
        mode: "private" as const,
        routeOrigin: "https://personal.test.invalid",
        updatedAt: new Date(),
      };
      await database
        .insertInto("personalRemoteAccess")
        .values({ singletonKey: "personal", ...enabled })
        .onConflict((c) => c.column("singletonKey").doUpdateSet(enabled))
        .execute();
    }
    async function enrollBrowserRunner(ownerId: import("@opensteer/core").UserId, name: string) {
      const personal = await database
        .selectFrom("personalSettings")
        .select("agentHomeComputerId")
        .where("ownerId", "=", ownerId)
        .executeTakeFirstOrThrow();
      const computer = await database
        .selectFrom("runners")
        .select(["allowedModules", "moduleDescriptors"])
        .where("id", "=", personal.agentHomeComputerId)
        .executeTakeFirstOrThrow();
      await database
        .updateTable("runners")
        .set({
          name,
          allowedModules: sql`${JSON.stringify([...new Set([...computer.allowedModules, "browser"])])}::jsonb`,
          moduleDescriptors: {
            ...computer.moduleDescriptors,
            browser: { runtimeId: name, wireVersion: 2 },
          },
        })
        .where("id", "=", personal.agentHomeComputerId)
        .execute();
      return personal.agentHomeComputerId;
    }
    async function createTaskForOwner(ownerId: import("@opensteer/core").UserId, suffix: string) {
      const task = await createRunFixture(suffix);
      if (task.userId !== ownerId)
        throw new Error("This fixture only creates the personal owner's tasks");
      return task.thread;
    }
    async function stagedRequestRace(
      lock: (
        transaction: import("kysely").Transaction<import("./schema.js").DatabaseSchema>,
      ) => Promise<unknown>,
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ) {
      const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const blocker = (await import("./personal-transaction.js")).withPersonalTransaction(
        database,
        async (transaction) => {
          await lock(transaction);
          held.resolve();
          await withTimeout(release.promise, 5_000, {
            timeoutError: () => new Error("Request race fence was never released"),
          });
        },
      );
      await withTimeout(held.promise, 5_000, {
        timeoutError: () => new Error("Request race never acquired its fence"),
      });
      let a: Promise<unknown> | undefined, b: Promise<unknown> | undefined;
      try {
        a = first();
        void a.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const waiting = await sql<{
              count: string;
            }>`select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
              database,
            );
            expect(
              Number(waiting.rows[0]!.count),
              "First Request writer never reached the fence",
            ).toBeGreaterThanOrEqual(1);
          },
          { timeout: 2_000 },
        );
        b = second();
        void b.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const waiting = await sql<{
              count: string;
            }>`select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
              database,
            );
            expect(
              Number(waiting.rows[0]!.count),
              "Both Request writers never reached the fence",
            ).toBeGreaterThanOrEqual(2);
          },
          { timeout: 2_000 },
        );
      } finally {
        release.resolve();
        await blocker;
      }
      return Promise.allSettled([a!, b!]);
    }

    async function runDelegatedTurn(
      fixture: Awaited<ReturnType<typeof startRunFixture>>,
      run: { readonly id: RunId; readonly threadId: ThreadId },
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
    return Object.freeze({
      createTaskForOwner,
      stagedRequestRace,
      runDelegatedTurn,
      enablePersonalRemoteAccess,
      enrollBrowserRunner,
      enrollMessagingRunner,
      createChannelDeliveryFixture,
      insertChannelDelivery,
      createChannelNoticeFixture,
      triggers,
      enqueueHumanTrigger,
      recordReadyHarnessCatalog,
      bindAgentControlRun,
      startTriggerOccurrence,
      openLiveRequest,
      principalIdFor: (userId: import("@opensteer/core").UserId) =>
        import("./personal-transaction.js").then(({ withPersonalTransaction }) =>
          withPersonalTransaction(database, async (transaction) =>
            (await import("./store-primitives.js")).principalIdForUser(transaction, userId),
          ),
        ),
      database,
      databaseUrl: clone.url,
      store,
      createRunFixture,
      startRunFixture,
      close: clone.drop,
    });
  } catch (error) {
    await clone.drop();
    throw error;
  }
}
export type StoreFixture = Awaited<ReturnType<typeof createStoreFixture>>;
const storeTest = it.extend<{ storeFixture: StoreFixture }>({
  storeFixture: async ({ task }, use) => {
    const started = performance.now();
    const fixture = await createStoreFixture();
    recordTestDatabaseSetup(task, started);
    await use(fixture);
  },
});
export function describeStore(name: string, body: (test: typeof storeTest) => void): void {
  describe(name, () => body(storeTest));
}

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
      canonicalOrigin: "http://127.0.0.1:4310",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { kind: "personal" },
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
    payload: { kind: "harness.input" },
    presentation: input.presentation,
    requestedBy: input.requestedBy,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
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

export async function writeBrowserUsageArtifact(name: string, value: unknown): Promise<void> {
  const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
  if (!directory) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${name}`, JSON.stringify(value, null, 2));
}

export function testChannelAccessPolicy(mode: "anyone" | "approved" | "owner") {
  const sender = { allowedExternalUserIds: [], mode } as const;
  return {
    channels: { conversationIds: [], scope: "all" as const, sender },
    directMessages: sender,
  };
}

export const readEmptyPersonalResources: import("./snapshot-store.js").PersonalSnapshotResourcesReader =
  async ({ database }) => {
    const [app, tab, profile] = await Promise.all([
      database.selectFrom("apps").select("id").limit(1).executeTakeFirst(),
      database
        .selectFrom("personalTabs")
        .select("id")
        .where("closedAt", "is", null)
        .limit(1)
        .executeTakeFirst(),
      database.selectFrom("browserProfiles").select("id").limit(1).executeTakeFirst(),
    ]);
    if (app || tab || profile)
      throw new Error(
        "This fixture needs a resource snapshot collaborator for its private resources",
      );
    return {
      appTabs: [],
      browser: {
        available: false,
        placements: [],
        profiles: [],
        groups: { rows: [], complete: true },
        tabs: [],
      },
    };
  };

export const testMessagingRunnerId = RunnerIdSchema.parse(
  "rnr_00000000-0000-4000-8000-000000000001",
);
export const replacementMessagingRunnerId = RunnerIdSchema.parse(
  "rnr_00000000-0000-4000-8000-000000000002",
);
export const testChannelNotices = {
  approvalPending: "Your access request is waiting for approval.",
  linkByDirectMessage: "Send a direct message to link your account.",
  linkCode: (code: string) => `Enter the code **${code}** to link your account.`,
  noRoute: "Choose a task folder for this conversation.",
} as const;

export const reachOnlyModules: RunnerDescriptor["modules"] = {
  shell: { hostPublicKey: `ssh-ed25519 ${"A".repeat(68)}`, platform: "darwin" },
};

export { seedPersonalOwnerResources } from "./personal-fixture.test-support.js";

export function personalBrowserRepository(store: OpensteerStore) {
  return Object.assign(store, {
    findActiveBrowserSessionForPerson: (ownerId: import("@opensteer/core").UserId) =>
      findActiveBrowserSessionForPerson(store.database, ownerId),
  });
}

export {
  messageFromRow,
  runFromRow,
  threadFromRow,
  threadInputFromRow,
} from "./thread-row-mappers.js";
