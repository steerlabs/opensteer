import { personalFixtureOwner } from "./personal-run-fixture.test-support.js";
import { withPersonalTransaction } from "./personal-transaction.js";

import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  NotificationIdSchema,
  notificationPushWindowMilliseconds,
  HarnessIdSchema,
  MessageAuthorSchema,
  ModelSelectionSchema,
  PendingRequestSchema,
  createId,
  messageTextPartMaxLength,
  type ContentPart,
  type HarnessInstanceId,
  type MessageAuthor,
  type MessageId,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  BrowserSurfaceIdSchema,
  createBrowserSessionId,
  HarnessInstanceCatalogSchema,
  TaskPageSchema,
  taskLineMaxLength,
  type TaskPage,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { describe, expect, it as baseIt } from "vitest";
import { AccountDirectoryStore } from "./account-directory-store.js";
import { createDatabase } from "./connection.js";
import {
  NotificationStore,
  type DecidedNotification,
  type NotificationPublication,
} from "./notification-store.js";
import { messageFromRow } from "./thread-row-mappers.js";
import { NotificationStateStore } from "./notification-state.js";
import { issueRunGrant } from "./run-grants.js";
import { jsonValue } from "./store-primitives.js";
import { TriggerStore } from "./trigger-store.js";
import {
  pendingEvent,
  testContinuationIdentity,
  sealedTestRequestResponse,
} from "./store.integration.test-support.js";
import { requestInsert } from "./request-store.js";
import { OpensteerStore } from "./store.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
const directoryProviderId = "oidc:opensteer-account";
integration("notification decision boundary", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-notification-integration-test",
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return {
        database,
        close: () => database.destroy(),
      };
    });
    const store = new OpensteerStore(database);
    const directory = new AccountDirectoryStore(database);
    let now = new Date();
    const notifications = new NotificationStore(database, {
      now: () => now,
    });
    const notificationState = new NotificationStateStore(database);
    async function linkAccount(userId: UserId): Promise<string> {
      const accountId = `acct_${randomUUID()}`;
      const createdAt = new Date();
      await database
        .insertInto("authAccounts")
        .values({
          accessToken: null,
          accessTokenExpiresAt: null,
          accountId,
          createdAt,
          id: createId("authAccount"),
          idToken: null,
          password: null,
          providerId: directoryProviderId,
          refreshToken: null,
          refreshTokenExpiresAt: null,
          scope: null,
          updatedAt: createdAt,
          userId,
        })
        .execute();
      return accountId;
    }

    async function createFixture(suffix: string, voice = false, worker = false): Promise<Fixture> {
      const personal = await personalFixtureOwner(database, databaseUrl);
      const { userId: ownerId, environmentId, runnerId } = personal;
      const harnessInstance = await store.createHarnessInstance({
        config: {
          model: "test",
        },
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Native",
        sourceId: "native",
        stateKind: "isolated",
      });
      const parent = worker
        ? await store.createThread({
            createdBy: ownerId,
            environmentId,
            harnessInstanceId: harnessInstance.id,
            idempotencyKey: `parent-${suffix}`,
            modelSelection,
            title: `Parent ${suffix}`,
          })
        : null;
      const { thread } = await store.createThread({
        createdBy: ownerId,
        environmentId,
        harnessInstanceId: harnessInstance.id,
        ...(parent ? { parentThreadId: parent.thread.id } : {}),
        purpose: voice ? "voice" : "task",
        idempotencyKey: `thread-${suffix}`,
        modelSelection,
        title: `Thread ${suffix}`,
      });
      const admitted = await store.enqueueThreadInput({
        content: [
          {
            text: "Start the work",
            type: "text",
          },
        ],
        idempotencyKey: `${suffix}-turn`,
        policy: "queue",
        requestedBy: ownerId,
        source: {
          kind: "human",
        },
        threadId: thread.id,
      });
      if (!admitted.run) throw new Error("Expected the fixture turn to queue a Run");
      return {
        environmentId,
        harnessInstance,
        ownerAccountId: await linkAccount(ownerId),
        ownerId,
        runId: admitted.run.id,
        runnerId,
        threadId: thread.id,
      };
    }
    async function anotherUser(_fixture: Fixture, name: string): Promise<UserId> {
      const userId = await store.createUser(name);
      return userId;
    }
    async function addThread(
      base: Fixture,
      input: {
        readonly voice?: boolean;
        readonly requestedBy?: UserId;
        readonly suffix: string;
        readonly title?: string;
      },
    ): Promise<Fixture> {
      const { thread } = await store.createThread({
        createdBy: base.ownerId,
        environmentId: base.environmentId,
        harnessInstanceId: base.harnessInstance.id,
        purpose: input.voice ? "voice" : "task",
        idempotencyKey: `thread-${input.suffix}`,
        modelSelection,
        title: input.title ?? `Thread ${input.suffix}`,
      });
      const admitted = await store.enqueueThreadInput({
        content: [
          {
            text: "Start the work",
            type: "text",
          },
        ],
        idempotencyKey: `${input.suffix}-turn`,
        policy: "queue",
        requestedBy: input.requestedBy ?? base.ownerId,
        source: {
          kind: "human",
        },
        threadId: thread.id,
      });
      if (!admitted.run) throw new Error("Expected the Thread's turn to queue a Run");
      return {
        ...base,
        runId: admitted.run.id,
        threadId: thread.id,
      };
    }
    async function claimRun(runId: RunId): Promise<void> {
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", runId)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      expect(await store.claimCommand(command.id, "notification-request-test")).not.toBeNull();
    }
    async function personSession(fixture: Fixture): Promise<string> {
      const id = createId("authSession");
      const now = new Date();
      await database
        .insertInto("authSessions")
        .values({
          id,
          userId: fixture.ownerId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 60_000),
          ipAddress: null,
          userAgent: null,
          deviceLabel: "Test phone",
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      return id;
    }
    async function startRequestRun(fixture: Fixture): Promise<number> {
      await claimRun(fixture.runId);
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: `request-${fixture.runId}`,
        runnerBootId: "test-boot",
        runnerId: fixture.runnerId,
        runId: fixture.runId,
        threadId: fixture.threadId,
      });
      await store.bindProviderSession({
        bindingGeneration: binding.bindingGeneration,
        harnessInstanceId: fixture.harnessInstance.id,
        providerSessionId: binding.providerSessionId,
        providerSessionReference: `native-${fixture.threadId}`,
        runId: fixture.runId,
        runnerBootId: "test-boot",
        runnerId: fixture.runnerId,
        threadId: fixture.threadId,
      });
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: "test-boot",
        runnerId: fixture.runnerId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          environmentId: fixture.environmentId,
          runId: fixture.runId,
          threadId: fixture.threadId,
          ordinal: 0,
          type: "run.started",
          data: {
            status: "running",
          },
        }),
      });
      return binding.bindingGeneration;
    }
    async function finishRequestRun(fixture: Fixture): Promise<void> {
      const run = await database
        .selectFrom("runs")
        .select("bindingGeneration")
        .where("id", "=", fixture.runId)
        .executeTakeFirstOrThrow();
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: "test-boot",
        runnerId: fixture.runnerId,
        event: pendingEvent({
          bindingGeneration: run.bindingGeneration!,
          environmentId: fixture.environmentId,
          runId: fixture.runId,
          threadId: fixture.threadId,
          ordinal: 1,
          type: "run.completed",
          data: {
            status: "completed",
          },
        }),
      });
    }
    async function markRunning(fixture: Fixture, runId: RunId = fixture.runId): Promise<void> {
      const run = await database
        .updateTable("runs")
        .set({
          bindingGeneration: 1,
          startedAt: new Date(),
          status: "running",
        })
        .where("id", "=", runId)
        .returning("providerSessionId")
        .executeTakeFirstOrThrow();
      await database
        .updateTable("providerSessions")
        .set({
          bindingGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseTokenHash: `lease-${runId}`,
          runnerBootId: "test-boot",
          runnerId: fixture.runnerId,
          status: "running",
        })
        .where("id", "=", run.providerSessionId!)
        .executeTakeFirstOrThrow();
      await withPersonalTransaction(database, (transaction) =>
        issueRunGrant(transaction, {
          bindingGeneration: 1,
          modelSelection,
          runId,
          runnerBootId: "test-boot",
          runnerId: fixture.runnerId,
        }),
      );
    }
    async function appendReply(
      fixture: Fixture,
      content: readonly ContentPart[],
      target: {
        readonly runId: RunId;
        readonly threadId: ThreadId;
      } = fixture,
    ): Promise<{
      readonly id: MessageId;
      readonly sequence: string;
      readonly createdAt: string;
    }> {
      return withPersonalTransaction(database, async (transaction) => {
        const context = await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select(["runs.actorPrincipalId", "threads.nextMessageSequence"])
          .where("runs.id", "=", target.runId)
          .forNoKeyUpdate("threads")
          .executeTakeFirstOrThrow();
        const id = createId("message");
        const message = await transaction
          .insertInto("messages")
          .values({
            actorPrincipalId: context.actorPrincipalId,
            author: jsonValue(
              MessageAuthorSchema.parse({
                displayName: "Opensteer",
                kind: "agent",
                runId: target.runId,
                threadId: target.threadId,
              }),
            ),
            content: jsonValue(content),
            id,
            kind: "assistant",
            runId: target.runId,
            sequence: context.nextMessageSequence,
            threadId: target.threadId,
          })
          .returning("createdAt")
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("threads")
          .set({
            nextMessageSequence: sql`next_message_sequence + 1`,
            updatedAt: new Date(),
          })
          .where("id", "=", target.threadId)
          .executeTakeFirstOrThrow();
        return {
          id,
          sequence: String(context.nextMessageSequence),
          createdAt: message.createdAt.toISOString(),
        };
      });
    }
    async function appendRunnerEvent(
      fixture: Fixture,
      event:
        | {
            readonly data: { readonly replyMessageId: MessageId | null };
            readonly type: "run.completed";
          }
        | {
            readonly data: {
              readonly phase: "background" | "turn";
              readonly replyMessageId?: MessageId | null;
            };
            readonly type: "run.phase";
          },
      target: { readonly runId: RunId; readonly threadId: ThreadId } = fixture,
    ): Promise<void> {
      await withPersonalTransaction(database, (transaction) =>
        event.type === "run.completed"
          ? appendHostDeploymentEvent(transaction, {
              type: "run.completed",
              environmentId: fixture.environmentId,
              runId: target.runId,
              threadId: target.threadId,
              data: { ...event.data, status: "completed" },
            })
          : appendHostDeploymentEvent(transaction, {
              type: "run.phase",
              environmentId: fixture.environmentId,
              runId: target.runId,
              threadId: target.threadId,
              data: event.data,
            }),
      );
    }

    async function appendCompletedReply(
      fixture: Fixture,
      content: readonly ContentPart[],
      target: {
        readonly runId: RunId;
        readonly threadId: ThreadId;
      } = fixture,
    ): Promise<{
      readonly id: MessageId;
      readonly sequence: string;
      readonly createdAt: string;
    }> {
      const reply = await appendReply(fixture, content, target);
      await appendRunnerEvent(
        fixture,
        {
          data: {
            replyMessageId: reply.id,
          },
          type: "run.completed",
        },
        target,
      );
      return reply;
    }
    async function appendRunFailed(
      fixture: Fixture,
      message = "Runner unavailable",
      target: {
        readonly runId: RunId;
        readonly threadId: ThreadId;
      } = fixture,
    ): Promise<void> {
      await withPersonalTransaction(database, (transaction) =>
        appendHostDeploymentEvent(transaction, {
          data: {
            code: "runner_execution_error",
            message,
            retryable: false,
            status: "failed",
          },
          environmentId: fixture.environmentId,
          runId: target.runId,
          threadId: target.threadId,
          type: "run.failed",
        }),
      );
    }
    async function appendRunInterrupted(fixture: Fixture): Promise<void> {
      await withPersonalTransaction(database, (transaction) =>
        appendHostDeploymentEvent(transaction, {
          data: {
            status: "interrupted",
          },
          environmentId: fixture.environmentId,
          runId: fixture.runId,
          threadId: fixture.threadId,
          type: "run.interrupted",
        }),
      );
    }
    function pendingRequest(fixture: Fixture, requiredActor: "owner" | "requester") {
      return PendingRequestSchema.parse({
        callId: `call-${randomUUID()}`,
        cancellationReason: null,
        createdAt: now.toISOString(),
        id: createId("request"),
        kind: "harness.approval",
        mode: "live",
        originatingOccurrenceId: null,
        originatingRunId: fixture.runId,
        originatingThreadId: fixture.threadId,
        payload: {
          kind: "harness.approval",
        },
        presentation: {
          kind: "choice",
          options: [
            {
              hint: "allow-once",
              id: "allow",
              label: "Allow",
            },
          ],
          title: "May I edit this file?",
        },
        requestedBy: fixture.ownerId,
        requiredActor,
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
      });
    }
    async function appendRequestOpened(
      fixture: Fixture,
      requiredActor: "owner" | "requester",
    ): Promise<RequestId> {
      return storeOpenedRequest(fixture, pendingRequest(fixture, requiredActor));
    }
    async function storeOpenedRequest(
      fixture: Fixture,
      request: import("@opensteer/core").PendingRequest,
    ): Promise<RequestId> {
      await withPersonalTransaction(database, async (transaction) => {
        await transaction.insertInto("requests").values(requestInsert(request)).execute();
        await appendHostDeploymentEvent(transaction, {
          data: {
            request,
          },
          environmentId: fixture.environmentId,
          runId: fixture.runId,
          threadId: fixture.threadId,
          type: "request.opened",
        });
      });
      return request.id;
    }
    async function openRequest(fixture: Fixture): Promise<RequestId> {
      const created = await store.requests.create({
        callId: `call-${randomUUID()}`,
        kind: "harness.approval",
        mode: "live",
        originatingRunId: fixture.runId,
        originatingThreadId: fixture.threadId,
        payload: {
          kind: "harness.approval",
        },
        presentation: {
          kind: "choice",
          options: [
            {
              hint: "allow-once",
              id: "allow",
              label: "Allow",
            },
          ],
          title: "May I run the migration?",
        },
        requestedBy: fixture.ownerId,
        requiredActor: "requester",
      });
      return created.request.id;
    }
    async function appendPreinstallAccessOpened(fixture: Fixture): Promise<RequestId> {
      const request = PendingRequestSchema.parse({
        callId: `call-${randomUUID()}`,
        cancellationReason: null,
        createdAt: now.toISOString(),
        id: createId("request"),
        kind: "integration.access",
        mode: "durable",
        originatingOccurrenceId: null,
        originatingRunId: fixture.runId,
        originatingThreadId: fixture.threadId,
        payload: {
          access: "read",
          installationId: null,
          kind: "integration.access",
          manifest: {
            digest: "a".repeat(43),
            kind: "catalog",
          },
          reason: "Read the calendar",
          requestedConnectionId: null,
          requestedServerId: null,
        },
        presentation: {
          kind: "external",
          subject: {
            id: "catalog:calendar",
            kind: "integration-install-manifest",
          },
          title: "Calendar access",
        },
        requestedBy: fixture.ownerId,
        requiredActor: "requester",
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
      });
      return storeOpenedRequest(fixture, request);
    }
    async function setRunSeedAuthor(fixture: Fixture, kind: MessageAuthor["kind"]): Promise<void> {
      const author = MessageAuthorSchema.parse(
        kind === "human"
          ? {
              displayName: "Owner",
              kind,
              principalId: "test-principal",
              userId: fixture.ownerId,
            }
          : kind === "agent"
            ? {
                displayName: "Specialist",
                kind,
                runId: createId("run"),
                threadId: createId("thread"),
              }
            : kind === "trigger"
              ? {
                  displayName: "Schedule",
                  kind,
                  occurrenceId: createId("triggerOccurrence"),
                  source: "schedule",
                  triggerId: createId("trigger"),
                }
              : kind === "watch"
                ? {
                    activationId: createId("triggerWatchActivation"),
                    displayName: "Watch",
                    kind,
                    revisionId: createId("triggerRevision"),
                    triggerId: createId("trigger"),
                  }
                : {
                    cause: "request-answered",
                    kind,
                  },
      );
      await database
        .updateTable("runs")
        .set({
          personWaited: kind === "human",
        })
        .where("id", "=", fixture.runId)
        .execute();
      const seed = await database
        .selectFrom("runs")
        .select("seedInputId")
        .where("id", "=", fixture.runId)
        .executeTakeFirstOrThrow();
      await database
        .updateTable("messages")
        .set({
          author: jsonValue(author),
          kind: kind === "platform" ? "continuation" : "input",
        })
        .where("id", "=", seed.seedInputId)
        .executeTakeFirstOrThrow();
    }
    async function makePersonalDeployment(subject: string): Promise<void> {
      await sql`
      update public.deployments
      set deployment_shape = jsonb_build_object(
        'kind', 'personal'
      )
      where singleton_key = 'primary'
    `.execute(database);
      const linkedAt = new Date();
      await database
        .insertInto("personalRemoteAccountLink")
        .values({
          challengeId: `phc_${randomUUID()}`,
          grantId: `phg_${randomUUID()}`,
          hostCredential: `osc_${"c".repeat(43)}`,
          issuer: "https://accounts.opensteer.invalid",
          linkGeneration: "g".repeat(43),
          linkedAt,
          singletonKey: "opensteer-account",
          state: "active",
          subject,
          updatedAt: linkedAt,
        })
        .execute();
    }
    const observed = new Map<string, DecidedNotification>();
    const publications = new Map<string, NotificationPublication>();
    const readEvents = new Set<string>();
    async function decideCommitted(_fixture: Fixture) {
      const rows = await database
        .selectFrom("deploymentEvents")
        .selectAll()
        .orderBy("sequence", "asc")
        .execute();
      const decided: DecidedNotification[] = [];
      for (const row of rows) {
        if (readEvents.has(row.eventId)) continue;
        readEvents.add(row.eventId);
        const parsed = AgentEventSchema.safeParse({
          ...row,
          createdAt: row.createdAt.toISOString(),
        });
        if (!parsed.success) continue;
        for (const decision of await notifications.decide(parsed.data)) {
          decided.push(decision);
          observed.set(decision.view.id, decision);
          publications.set(decision.view.id, {
            ...decision.view,
            userId: decision.userId,
            eventId: row.eventId,
            sequence: row.sequence,
            occurredAt: new Date(decision.view.occurredAt),
            expiresAt: new Date(
              Date.parse(decision.view.occurredAt) + notificationPushWindowMilliseconds,
            ),
          });
        }
      }
      return {
        decided,
      };
    }
    async function observedViews() {
      return [...observed.values()].map(
        ({ userId, view: { id: _id, occurredAt: _occurredAt, ...view } }) => ({
          ...view,
          userId,
        }),
      );
    }
    async function publicationEntries(): Promise<readonly NotificationPublication[]> {
      return [...publications.values()];
    }
    const text = (value: string): ContentPart[] => [
      {
        text: value,
        type: "text",
      },
    ];
    now = new Date();
    observed.clear();
    publications.clear();
    readEvents.clear();
    await personalFixtureOwner(database, databaseUrl);
    await directory.configureProvider({
      issuer: "https://accounts.opensteer.invalid",
      providerId: directoryProviderId,
    });
    return Object.freeze({
      database,
      store,
      directory,
      notifications,
      notificationState,
      linkAccount,
      createFixture,
      anotherUser,
      addThread,
      claimRun,
      personSession,
      startRequestRun,
      finishRequestRun,
      markRunning,
      appendReply,
      appendRunnerEvent,
      appendCompletedReply,
      appendRunFailed,
      appendRunInterrupted,
      pendingRequest,
      appendRequestOpened,
      storeOpenedRequest,
      openRequest,
      appendPreinstallAccessOpened,
      setRunSeedAuthor,
      makePersonalDeployment,
      observed,
      publications,
      readEvents,
      decideCommitted,
      observedViews,
      publicationEntries,
      text,
      databaseUrl,
      state: {
        get now() {
          return now;
        },
        set now(value: typeof now) {
          now = value;
        },
      },
    });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{
    storeFixture: StoreFixture;
  }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  // Wall-clock time: event rows are stamped by the database and Node's clock,
  // and a notification's fifteen-minute window is measured from them.

  interface Fixture {
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    readonly harnessInstance: {
      readonly id: HarnessInstanceId;
      readonly runtimeRevision: number;
    };
    readonly ownerAccountId: string;
    readonly ownerId: UserId;
    readonly runId: RunId;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
  }

  /** The one enrolled machine a Thread needs before it may hold a Run. */

  /**
   * One person's first Workspace — their Main one — with a Thread and a queued
   * Run they asked for. `voice` makes that Thread their Voice.
   */

  /**
   * Another Thread on the fixture's one Main machine — one per Deployment — with
   * a queued Run of its own: in the fixture's Workspace unless told otherwise.
   */

  /**
   * Dispatches a Run the way a Runner binding does, without a Runner: started,
   * bound, and holding the grant a live Run's tools and Requests need.
   */

  /** An assistant message as a Runner's `assistant.message` commits it. */

  /**
   * `run.completed` and `run.phase` are Runner-authored, so their canonical
   * shape is inserted directly to exercise the projection without a lease.
   */

  /**
   * A stored pending Request and its `request.opened`, as the Host writes the
   * two together, for audience rules that do not need the Run to be running.
   */

  /** A Request the running Run really asks, so the publisher can reread its status. */

  /**
   * Rewrites what seeded the fixture's Run. The projection must not care: a
   * reply in Voice answers the person whoever or whatever woke the agent.
   */

  /**
   * Reshapes the fixture's Deployment as a linked Personal Host. The fixture
   * enrolls a Runner, which claims the Deployment as a server one, so the shape
   * is corrected here rather than threaded through every caller.
   */

  describe("freshness", () => {
    it("never decides events at or past the fifteen-minute window", async ({ storeFixture }) => {
      const { createFixture, appendCompletedReply, text, decideCommitted } = storeFixture;
      const fixture = await createFixture("old-event");
      await appendCompletedReply(fixture, text("Too late"));
      storeFixture.state.now = new Date(Date.now() + notificationPushWindowMilliseconds);
      expect((await decideCommitted(fixture)).decided).toEqual([]);
    });
  });
  describe("replies", () => {
    it.for(["human", "trigger", "watch", "agent", "platform"] as const)(
      "alerts the person for a Voice reply to a %s-seeded Run",
      async (seed, { storeFixture }) => {
        const {
          createFixture,
          setRunSeedAuthor,
          appendCompletedReply,
          text,
          decideCommitted,
          observedViews,
        } = storeFixture;
        const fixture = await createFixture(`seed-${seed}`, true);
        await setRunSeedAuthor(fixture, seed);
        const reply = await appendCompletedReply(fixture, text("Here is what I found."));
        await decideCommitted(fixture);
        expect(await observedViews()).toEqual([
          {
            body: "Here is what I found.",
            kind: "reply-published",
            messageId: reply.id,
            requestId: null,
            runId: fixture.runId,
            threadId: fixture.threadId,
            title: "Opensteer",
            userId: fixture.ownerId,
          },
        ]);
      },
    );
    it.for(["trigger", "watch", "agent", "human"] as const)(
      "notifies for a work reply only when the person asked (%s)",
      async (seed, { storeFixture }) => {
        const { createFixture, setRunSeedAuthor, appendCompletedReply, text, decideCommitted } =
          storeFixture;
        const fixture = await createFixture(`worker-${seed}`, false, true);
        await setRunSeedAuthor(fixture, seed);
        await appendCompletedReply(fixture, text("Done."));
        expect((await decideCommitted(fixture)).decided).toHaveLength(seed === "human" ? 1 : 0);
      },
    );
    it.for(["reply", "failure", "system"] as const)(
      "notifies after a person answers a durable Request (%s)",
      async (outcome, { storeFixture }) => {
        const {
          createFixture,
          personSession,
          startRequestRun,
          finishRequestRun,
          store,
          appendCompletedReply,
          appendRunFailed,
          text,
          observedViews,
          decideCommitted,
        } = storeFixture;
        const fixture = await createFixture(`request-continuation-${outcome}`, false, true);
        await startRequestRun(fixture);
        const opened =
          outcome === "system"
            ? await store.requests.create({
                callId: randomUUID(),
                kind: "machine.full-disk-access",
                mode: "durable",
                originatingRunId: fixture.runId,
                originatingThreadId: fixture.threadId,
                requestedBy: fixture.ownerId,
                requiredActor: "requester",
                payload: {
                  kind: "machine.full-disk-access",
                  machineId: fixture.runnerId,
                  machineName: "Test Mac",
                  reason: "Read files",
                },
                presentation: {
                  kind: "external",
                  title: "Full Disk Access",
                  subject: {
                    kind: "machine",
                    id: fixture.runnerId,
                  },
                },
              })
            : await store.requests.openPasswordSignIn({
                callId: randomUUID(),
                kind: "browser.password-sign-in",
                mode: "durable",
                originatingRunId: fixture.runId,
                originatingThreadId: fixture.threadId,
                requestedBy: fixture.ownerId,
                requiredActor: "requester",
                payload: {
                  kind: "browser.password-sign-in",
                  operationId: randomUUID(),
                  scope: "personal",
                  permissionVersion: 6,
                  runnerId: fixture.runnerId,
                  computerName: "Test Mac",
                  reason: "Sign in",
                  site: "https://example.com",
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
                presentation: {
                  kind: "external",
                  title: "Sign in",
                  subject: {
                    kind: "browser-site",
                    id: "https://example.com",
                  },
                },
              });
        if (outcome === "system")
          await store.requests.fulfillMachineFullDiskAccessRequests(fixture.runnerId);
        else
          await store.requests.settlePasswordSignInRequest({
            ownerId: fixture.ownerId,
            requestId: opened.request.id,
            settlementSessionId: await personSession(fixture),
            settlement: {
              status: "declined",
            },
          });
        await finishRequestRun(fixture);
        const admitted = await store.enqueueThreadInput({
          content: text("The person declined sign-in."),
          idempotencyKey: randomUUID(),
          policy: "queue",
          requestedBy: fixture.ownerId,
          threadId: fixture.threadId,
          source: {
            kind: "platform",
            cause: "request-resolved",
            referenceId: opened.request.id,
            sourceRunId: fixture.runId,
          },
        });
        expect(admitted.run, JSON.stringify(admitted)).not.toBeNull();
        const next = {
          ...fixture,
          runId: admitted.run!.id,
        };
        await startRequestRun(next);
        if (outcome !== "failure") await appendCompletedReply(next, text("Continued."));
        else await appendRunFailed(next);
        await decideCommitted(next);
        const decisions = await observedViews();
        expect(
          decisions.filter(
            (d) => d.kind === (outcome !== "failure" ? "reply-published" : "run-failed"),
          ),
        ).toHaveLength(outcome === "system" ? 0 : 1);
      },
    );
    it.for([true, false])(
      "a live Request answer joins an automatic Run (person: %s)",
      async (person, { storeFixture }) => {
        const {
          createFixture,
          store,
          database,
          personSession,
          startRequestRun,
          finishRequestRun,
          appendCompletedReply,
          text,
          observedViews,
          decideCommitted,
        } = storeFixture;
        const fixture = await createFixture(`live-answer-${person}`, false, true);
        // End the fixture's initial human turn before the scheduled work begins.
        await startRequestRun(fixture);
        await finishRequestRun(fixture);
        const triggers = new TriggerStore(database);
        const created = await triggers.create({
          actorThreadId: null,
          anchorThreadId: fixture.threadId,
          createdBy: fixture.ownerId,
          idempotencyKey: randomUUID(),
          name: "Automatic work",
          program: {
            toolContractVersion: 3,
            language: "javascript",
            source: "export default async () => null",
          },
          source: {
            kind: "schedule",
            schedule: {
              kind: "cron",
              expression: "0 9 * * *",
              timezone: "UTC",
            },
          },
        });
        const occurrence = await triggers.enqueueManual({
          actorThreadId: null,
          ownerId: fixture.ownerId,
          triggerId: created.trigger.id,
        });
        await store.claimCommand(occurrence.commandId, "request-test");
        await triggers.startExecution({
          commandId: occurrence.commandId,
          runnerBootId: "test-boot",
          runnerId: fixture.runnerId,
        });
        const admitted = await store.enqueueThreadInput({
          content: text("Automatic wake"),
          policy: "queue",
          requestedBy: fixture.ownerId,
          idempotencyKey: randomUUID(),
          threadId: fixture.threadId,
          source: {
            kind: "trigger",
            occurrenceId: occurrence.id,
          },
        });
        expect(admitted.run, JSON.stringify(admitted)).not.toBeNull();
        const automatic = {
          ...fixture,
          runId: admitted.run!.id,
        };
        const automaticBinding = await startRequestRun(automatic);
        const requestId = createId("request");
        const request = PendingRequestSchema.parse({
          ...storeFixture.pendingRequest(automatic, "requester"),
          id: requestId,
        });
        await store.commitRunnerEvent({
          environmentId: automatic.environmentId,
          runnerBootId: "test-boot",
          runnerId: automatic.runnerId,
          event: pendingEvent({
            bindingGeneration: automaticBinding,
            environmentId: automatic.environmentId,
            runId: automatic.runId,
            threadId: automatic.threadId,
            ordinal: 1,
            type: "request.opened",
            data: {
              request,
            },
          }),
        });
        if (person) {
          const command = await store.enqueueRunnerControl({
            type: "request.respond",
            requestId,
            response: {
              kind: "choice",
              optionId: "allow",
            },
            settlementSessionId: await personSession(fixture),
            sealedResponse: sealedTestRequestResponse(),
            requestedBy: fixture.ownerId,
            runId: automatic.runId,
            threadId: fixture.threadId,
            idempotencyKey: randomUUID(),
          });
          await store.claimCommand(command.command.id, "request-answer");
          await store.succeedCommand(command.command.id);
        } else await store.requests.cancelForRun(automatic.runId, "run-ended");
        await appendCompletedReply(automatic, text("Finished."));
        await decideCommitted(automatic);
        const decisions = await observedViews();
        expect(decisions.filter((d) => d.kind === "reply-published")).toHaveLength(person ? 1 : 0);
      },
    );
    it("notifies when a person's input joins an automatic worker Run", async ({ storeFixture }) => {
      const {
        createFixture,
        setRunSeedAuthor,
        appendReply,
        appendCompletedReply,
        text,
        decideCommitted,
        database,
      } = storeFixture;
      const fixture = await createFixture("worker-human-join", false, true);
      await setRunSeedAuthor(fixture, "trigger");
      const joined = await appendReply(fixture, text("Please check this too."));
      await database
        .updateTable("messages")
        .set({
          kind: "input",
          author: jsonValue({
            kind: "human",
            displayName: "Owner",
            principalId: "test-principal",
            userId: fixture.ownerId,
          }),
        })
        .where("id", "=", joined.id)
        .execute();
      await appendCompletedReply(fixture, text("Checked."));
      expect((await decideCommitted(fixture)).decided).toHaveLength(1);
    });
    it("does not notify for a failed Trigger-woken worker", async ({ storeFixture }) => {
      const { createFixture, setRunSeedAuthor, appendRunFailed, decideCommitted } = storeFixture;
      const fixture = await createFixture("worker-failed", false, true);
      await setRunSeedAuthor(fixture, "trigger");
      await appendRunFailed(fixture, "Something failed.");
      expect((await decideCommitted(fixture)).decided).toEqual([]);
    });
    it("alerts only for the Voice relay of delegated work, never the task's own reply or failure", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        store,
        database,
        markRunning,
        text,
        appendCompletedReply,
        appendRunFailed,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("delegated", true);
      await store.recordHarnessCatalogs({
        catalogs: [
          HarnessInstanceCatalogSchema.parse({
            continuationIdentity: {
              continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
              driverKind: HarnessIdSchema.parse("native"),
            },
            driverKind: "native",
            harnessInstanceId: fixture.harnessInstance.id,
            models: [
              {
                displayName: "GPT-5.6 Sol",
                isDefault: true,
                modelId: modelSelection.modelId,
                options: [],
                providerId: modelSelection.providerId,
              },
            ],
            status: "ready",
          }),
        ],
        environmentId: fixture.environmentId,
        expectedRevisions: new Map([
          [fixture.harnessInstance.id, fixture.harnessInstance.runtimeRevision],
        ]),
      });
      await markRunning(fixture);
      const delegated = await store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.ownerId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "delegated-task",
        modelSelection,
        origin: {
          kind: "run",
          parentRunId: fixture.runId,
          parentThreadId: fixture.threadId,
        },
        task: text("Research the vendors"),
        title: "Vendor research",
      });
      const task = {
        runId: delegated.run.id,
        threadId: delegated.thread.id,
      };
      expect(delegated.run.requestedBy).toBe(fixture.ownerId);

      // Model the dispatcher consuming the queued seed before completing its Run.
      await database
        .updateTable("threadInputs")
        .set({
          state: "claimed",
          runId: task.runId,
        })
        .where("messageId", "=", delegated.run.seedInputId)
        .execute();
      // A person addressing a worker joins its open Assignment too.
      await database
        .updateTable("runs")
        .set({
          status: "completed",
        })
        .where("id", "=", task.runId)
        .execute();
      const bound = await store.enqueueThreadInput({
        content: text("Check one more vendor"),
        idempotencyKey: "person-open-assignment",
        policy: "queue",
        requestedBy: fixture.ownerId,
        source: {
          kind: "human",
        },
        threadId: task.threadId,
      });
      expect(bound.run?.assignmentId).toBe(delegated.assignment.id);
      if (!bound.run) throw new Error("Expected a person-started worker Run");
      await appendCompletedReply(fixture, text("Vendor B costs more."), {
        runId: bound.run.id,
        threadId: task.threadId,
      });
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
      expect(await store.runAssignment(bound.run.id)).toEqual({
        assignerThreadId: fixture.threadId,
        open: true,
      });

      // The task's reply returns to Voice's agent, and its failure is that
      // agent's to report: neither is the person's news yet.
      await appendCompletedReply(fixture, text("Vendor A is cheapest."), task);
      await appendRunFailed(fixture, "The vendor site timed out", task);
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
      const relay = await appendCompletedReply(fixture, text("Vendor A is the cheapest option."));
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([
        expect.objectContaining({
          kind: "reply-published",
          messageId: relay.id,
          runId: fixture.runId,
          threadId: fixture.threadId,
          userId: fixture.ownerId,
        }),
      ]);
      await database
        .updateTable("threadInputs")
        .set({
          state: "claimed",
          runId: bound.run.id,
        })
        .where("messageId", "=", bound.run.seedInputId)
        .execute();
      await database
        .updateTable("runs")
        .set({
          status: "completed",
        })
        .where("id", "=", bound.run.id)
        .execute();
      await store.cancelAssignment({
        assignmentId: delegated.assignment.id,
        requestedBy: fixture.ownerId,
        idempotencyKey: "close-worker-assignment",
      });
      expect(await store.runAssignment(bound.run.id)).toEqual({
        assignerThreadId: fixture.threadId,
        open: false,
      });
      const unbound = await store.enqueueThreadInput({
        content: text("A new question for you"),
        idempotencyKey: "person-closed-assignment",
        policy: "queue",
        requestedBy: fixture.ownerId,
        source: {
          kind: "human",
        },
        threadId: task.threadId,
      });
      expect(unbound.run?.assignmentId).toBeNull();
      if (!unbound.run) throw new Error("Expected an unbound person-started Run");
      const directReply = await appendCompletedReply(fixture, text("Here is your answer."), {
        runId: unbound.run.id,
        threadId: task.threadId,
      });
      await decideCommitted(fixture);
      expect(await observedViews()).toContainEqual(
        expect.objectContaining({
          kind: "reply-published",
          messageId: directReply.id,
          runId: unbound.run.id,
        }),
      );
    });
    it("never alerts for a report, in Voice or anywhere else", async ({ storeFixture }) => {
      const { createFixture, markRunning, store, text, decideCommitted, observedViews } =
        storeFixture;
      const fixture = await createFixture("report", true);
      await markRunning(fixture);
      await store.enqueueThreadInput({
        content: text("Specialist update: the build is green."),
        idempotencyKey: "report-to-voice",
        policy: "report",
        requestedBy: fixture.ownerId,
        source: {
          kind: "agent",
          runId: fixture.runId,
        },
        threadId: fixture.threadId,
      });
      await decideCommitted(fixture);
      expect(
        (await store.getThreadForOwner(fixture.threadId, fixture.ownerId))?.latestRunCompletedAt,
      ).toBeNull();
      expect(await observedViews()).toEqual([]);
    });
    it("never tells a person about their own messages, and tells only the person a Run answers", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        anotherUser,
        linkAccount,
        markRunning,
        store,
        text,
        decideCommitted,
        observedViews,
        appendCompletedReply,
      } = storeFixture;
      const fixture = await createFixture("own-message", true);
      const colleague = await anotherUser(fixture, "Colleague");
      await linkAccount(colleague);
      await markRunning(fixture);
      await store.enqueueThreadInput({
        content: text("Also check the calendar"),
        idempotencyKey: "own-steer",
        policy: "steer",
        requestedBy: fixture.ownerId,
        source: {
          kind: "human",
        },
        threadId: fixture.threadId,
      });
      await store.enqueueThreadInput({
        content: text("And then email Sam"),
        idempotencyKey: "own-queue",
        policy: "queue",
        requestedBy: fixture.ownerId,
        source: {
          kind: "human",
        },
        threadId: fixture.threadId,
      });
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
      await appendCompletedReply(fixture, text("Calendar checked."));
      await decideCommitted(fixture);
      expect((await observedViews()).map(({ userId }) => userId)).toEqual([fixture.ownerId]);
    });
    it("does not alert for a channel conversation's Run, which answers where it was asked", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        database,
        appendCompletedReply,
        text,
        appendRunFailed,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("channel", true);
      await database
        .updateTable("runs")
        .set({
          replyTarget: jsonValue({
            conversationId: "C024BE91L",
            kind: "channel",
          }),
        })
        .where("id", "=", fixture.runId)
        .executeTakeFirstOrThrow();
      await appendCompletedReply(fixture, text("Posted in Slack."));
      await appendRunFailed(fixture);
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
    });
    it("uses the same id for a reply named first by a background turn and then by the completion", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        appendReply,
        text,
        appendRunnerEvent,
        decideCommitted,
        observedViews,
        appendCompletedReply,
      } = storeFixture;
      const fixture = await createFixture("background", true);
      const reply = await appendReply(fixture, text("Started the export; I'll report back."));
      await appendRunnerEvent(fixture, {
        data: {
          phase: "turn",
        },
        type: "run.phase",
      });
      await appendRunnerEvent(fixture, {
        data: {
          phase: "background",
          replyMessageId: null,
        },
        type: "run.phase",
      });
      await appendRunnerEvent(fixture, {
        data: {
          phase: "background",
          replyMessageId: reply.id,
        },
        type: "run.phase",
      });
      const first = (await decideCommitted(fixture)).decided;
      expect(first).toHaveLength(1);
      await appendRunnerEvent(fixture, {
        data: {
          replyMessageId: reply.id,
        },
        type: "run.completed",
      });
      const repeated = (await decideCommitted(fixture)).decided;
      expect(repeated).toHaveLength(1);
      expect(repeated[0]!.view.id).toBe(first[0]!.view.id);
      expect(NotificationIdSchema.parse(first[0]!.view.id)).toMatch(
        /^ntf_[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      const digest = createHash("sha256")
        .update(`${fixture.ownerId}|reply-published|${reply.id}`)
        .digest();
      digest[6] = (digest[6]! & 0x0f) | 0x80;
      digest[8] = (digest[8]! & 0x3f) | 0x80;
      expect(first[0]!.view.id.replaceAll("-", "").slice(4)).toBe(
        digest.subarray(0, 16).toString("hex"),
      );
      expect(await observedViews()).toEqual([
        expect.objectContaining({
          kind: "reply-published",
          messageId: reply.id,
        }),
      ]);

      // The same Run ending later with a reply of its own is news again.
      const finished = await appendCompletedReply(fixture, text("The export finished."));
      await decideCommitted(fixture);
      expect((await observedViews()).map(({ messageId }) => messageId)).toEqual([
        reply.id,
        finished.id,
      ]);
    });
    it("does not project a reply the person already read", async ({ storeFixture }) => {
      const {
        createFixture,
        appendCompletedReply,
        text,
        notificationState,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("already-read", true);
      const reply = await appendCompletedReply(fixture, text("Read on another screen."));
      await notificationState.visit({
        threadId: fixture.threadId,
        visitedAt: reply.createdAt,
        userId: fixture.ownerId,
      });
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
    });
    it("rechecks the visit before publishing a decided reply", async ({ storeFixture }) => {
      const {
        createFixture,
        appendCompletedReply,
        appendReply,
        addThread,
        database,
        text,
        decideCommitted,
        notificationState,
        publicationEntries,
        notifications,
      } = storeFixture;
      const fixture = await createFixture("grace", true);
      const read = await appendCompletedReply(fixture, text("You saw this one."));
      const unread = await appendCompletedReply(fixture, text("You did not see this one."));
      const active = await addThread(fixture, {
        suffix: "addressed-grace",
      });
      const intermediate = await appendReply(active, text("Still working."));
      const addressed = await appendReply(active, text("Milestone ready."));
      const row = await database
        .updateTable("messages")
        .set({
          addressedToUserId: active.ownerId,
        })
        .where("id", "=", addressed.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const addressedEvent = await withPersonalTransaction(database, (transaction) =>
        appendHostDeploymentEvent(transaction, {
          type: "message.created",
          data: {
            input: null,
            message: messageFromRow(row),
            addressedToUserId: active.ownerId,
          },
          environmentId: active.environmentId,
          threadId: active.threadId,
          runId: active.runId,
        }),
      );
      await decideCommitted(fixture);
      await decideCommitted(active);
      expect(BigInt(addressed.sequence)).toBe(BigInt(intermediate.sequence) + 1n);
      await notificationState.visit({
        threadId: fixture.threadId,
        visitedAt: read.createdAt,
        userId: fixture.ownerId,
      });
      await notificationState.visit({
        threadId: active.threadId,
        visitedAt: addressed.createdAt,
        userId: active.ownerId,
      });
      expect(await notifications.decide(addressedEvent)).toEqual([]);
      const claimed = await publicationEntries();
      expect(claimed.map(({ messageId }) => messageId).sort()).toEqual(
        [read.id, unread.id, addressed.id].sort(),
      );
      const reasons = new Map(
        await Promise.all(
          claimed.map(
            async (entry) =>
              [entry.messageId, await notifications.publicationSkipReason(entry)] as const,
          ),
        ),
      );
      expect(reasons.get(read.id)).toBe("Reply was read before publication");
      expect(reasons.get(unread.id)).toBeNull();
      expect(reasons.get(addressed.id)).toBe("Reply was read before publication");
    });
    it("skips a reply that has no words or files to show", async ({ storeFixture }) => {
      const { createFixture, appendCompletedReply, text, decideCommitted, observedViews } =
        storeFixture;
      const fixture = await createFixture("blank", true);
      await appendCompletedReply(fixture, text(" \n\t "));
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
    });
  });
  describe("failures", () => {
    it("alerts the person when their Run fails", async ({ storeFixture }) => {
      const { createFixture, appendRunFailed, decideCommitted, observedViews } = storeFixture;
      const fixture = await createFixture("failed", true);
      await appendRunFailed(fixture);
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([
        {
          body: "Opensteer couldn't finish: Runner unavailable",
          kind: "run-failed",
          messageId: null,
          requestId: null,
          runId: fixture.runId,
          threadId: fixture.threadId,
          title: "Opensteer",
          userId: fixture.ownerId,
        },
      ]);
    });
    it("says nothing when somebody stopped the Run", async ({ storeFixture }) => {
      const {
        createFixture,
        markRunning,
        store,
        appendRunInterrupted,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("stopped", true);
      await markRunning(fixture);
      await store.enqueueRunnerControl({
        idempotencyKey: "stop-it",
        requestedBy: fixture.ownerId,
        runId: fixture.runId,
        threadId: fixture.threadId,
        type: "run.interrupt",
      });
      await appendRunInterrupted(fixture);
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
    });
    it("treats an interruption nobody asked for, after the Run started, as a failure", async ({
      storeFixture,
    }) => {
      const { createFixture, markRunning, appendRunInterrupted, decideCommitted, observedViews } =
        storeFixture;
      const fixture = await createFixture("runner-lost", true);
      await markRunning(fixture);
      await appendRunInterrupted(fixture);
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([
        expect.objectContaining({
          body: "Opensteer stopped before it finished.",
          kind: "run-failed",
          runId: fixture.runId,
          userId: fixture.ownerId,
        }),
      ]);
    });
    it("says nothing about a Run interrupted before it started", async ({ storeFixture }) => {
      const {
        createFixture,
        appendRunInterrupted,
        addThread,
        store,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("never-started", true);
      await appendRunInterrupted(fixture);
      const queued = await addThread(fixture, {
        suffix: "stopped-while-queued",
      });
      // Stopping a queued Run ends it here, with its own `run.interrupted`.
      await store.enqueueRunnerControl({
        idempotencyKey: "stop-queued",
        requestedBy: queued.ownerId,
        runId: queued.runId,
        threadId: queued.threadId,
        type: "run.interrupt",
      });
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
    });
    it("keeps a long failure message within the body limit", async ({ storeFixture }) => {
      const { createFixture, appendRunFailed, decideCommitted, observedViews } = storeFixture;
      const fixture = await createFixture("long-failure", true);
      await appendRunFailed(fixture, `The engine said: ${"overloaded ".repeat(40)}`);
      await decideCommitted(fixture);
      const [row] = await observedViews();
      expect(row?.body.startsWith("Opensteer couldn't finish: The engine said: overloaded")).toBe(
        true,
      );
      expect(row?.body.length).toBeLessThanOrEqual(180);
      expect(row?.body.endsWith("…")).toBe(true);
    });
  });
  describe("requests", () => {
    it("tells the requester, with the Request's own title", async ({ storeFixture }) => {
      const { createFixture, appendRequestOpened, decideCommitted, observedViews } = storeFixture;
      const fixture = await createFixture("request", true);
      const requestId = await appendRequestOpened(fixture, "requester");
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([
        {
          body: "May I edit this file?",
          kind: "request-opened",
          messageId: null,
          requestId,
          runId: null,
          threadId: fixture.threadId,
          title: "Opensteer",
          userId: fixture.ownerId,
        },
      ]);
    });
    it("never tells anyone about a Request answered before it was read", async ({
      storeFixture,
    }) => {
      const { createFixture, appendRequestOpened, database, decideCommitted, observedViews } =
        storeFixture;
      const fixture = await createFixture("answered-request", true);
      const requestId = await appendRequestOpened(fixture, "requester");
      // The decision reads the opening after the person already answered it.
      await database
        .updateTable("requests")
        .set({
          resolvedAt: storeFixture.state.now,
          resolvedBy: fixture.ownerId,
          status: "declined",
        })
        .where("id", "=", requestId)
        .execute();
      expect((await decideCommitted(fixture)).decided).toEqual([]);
      expect(await observedViews()).toEqual([]);
    });

    it("pushes a Request at once and skips it once answered", async ({ storeFixture }) => {
      const {
        createFixture,
        markRunning,
        openRequest,
        decideCommitted,
        publicationEntries,
        notifications,
        store,
      } = storeFixture;
      const fixture = await createFixture("answered", true);
      await markRunning(fixture);
      const requestId = await openRequest(fixture);
      await decideCommitted(fixture);
      const [entry] = await publicationEntries();
      expect(entry).toMatchObject({
        kind: "request-opened",
        requestId,
      });
      await expect(notifications.publicationSkipReason(entry!)).resolves.toBeNull();
      await store.requests.cancelForRun(fixture.runId, "run-ended");
      await expect(notifications.publicationSkipReason(entry!)).resolves.toBe(
        "Request was answered before the notification was published",
      );
    });
    it("skips any notification once its fifteen-minute window has closed", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        markRunning,
        openRequest,
        decideCommitted,
        publicationEntries,
        notifications,
      } = storeFixture;
      const fixture = await createFixture("expired", true);
      await markRunning(fixture);
      await openRequest(fixture);
      await decideCommitted(fixture);
      const [entry] = await publicationEntries();
      expect(entry!.expiresAt.getTime() - entry!.occurredAt.getTime()).toBe(15 * 60_000);
      storeFixture.state.now = new Date(entry!.expiresAt.getTime() - 1);
      await expect(notifications.publicationSkipReason(entry!)).resolves.toBeNull();
      storeFixture.state.now = new Date(entry!.expiresAt.getTime());
      await expect(notifications.publicationSkipReason(entry!)).resolves.toBe(
        "Notification expired before it could be published",
      );
    });
  });
  describe("audience", () => {
    it("does not notify a disabled personal owner", async ({ storeFixture }) => {
      const {
        createFixture,

        database,
        appendCompletedReply,
        text,
        appendRunFailed,
        appendRequestOpened,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("gone", true);
      await database
        .updateTable("users")
        .set({ disabledAt: new Date() })
        .where("id", "=", fixture.ownerId)
        .execute();
      await appendCompletedReply(fixture, text("For a disabled owner."));
      await appendRunFailed(fixture);
      await appendRequestOpened(fixture, "requester");
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);
    });
    it("skips a decided notification once its recipient can no longer open the Thread", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        appendRunFailed,
        decideCommitted,
        publicationEntries,
        notifications,
        database,
      } = storeFixture;
      const fixture = await createFixture("disabled-later", true);
      await appendRunFailed(fixture);
      await decideCommitted(fixture);
      const [entry] = await publicationEntries();
      await expect(notifications.publicationSkipReason(entry!)).resolves.toBeNull();
      await database
        .updateTable("users")
        .set({
          disabledAt: new Date(),
        })
        .where("id", "=", fixture.ownerId)
        .execute();
      await expect(notifications.publicationSkipReason(entry!)).resolves.toBe(
        "Recipient can no longer open this Thread",
      );
    });
  });
  describe("presentation", () => {
    it("titles a reply by its Thread outside Voice, and Voice as Opensteer", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        addThread,

        appendCompletedReply,
        text,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const voice = await createFixture("title-voice", true);
      const work = await addThread(voice, {
        suffix: "title-work",
      });
      const specialist = await addThread(voice, {
        suffix: "title-project",
        title: "Research desk",
      });
      await appendCompletedReply(voice, text("From Voice."));
      await appendCompletedReply(work, text("From a work Thread."));
      await appendCompletedReply(specialist, text("From a specialist."));
      for (const fixture of [voice, work, specialist]) await decideCommitted(fixture);
      const titles = Object.fromEntries(
        (await observedViews()).map((row) => [row.body, row.title]),
      );
      expect(titles).toEqual({
        "From Voice.": "Opensteer",
        "From a specialist.": "Research desk",
        "From a work Thread.": "Thread title-work",
      });
    });
    it("summarizes historical place parts in notifications and quotes without addresses", async ({
      storeFixture,
    }) => {
      const { createFixture, appendCompletedReply, decideCommitted, store } = storeFixture;
      const fixture = await createFixture("place-labels", true);
      // Canonical historical messages remain readable even though new assistant replies cannot attach places.
      const reply = await appendCompletedReply(fixture, [
        {
          type: "browser-page",
          sessionId: createBrowserSessionId(),
          tabId: BrowserSurfaceIdSchema.parse("tab-labels"),
          title: "",
          url: "https://example.test/private/path?fixture=hidden",
        },
        {
          type: "computer-app",
          machineId: fixture.runnerId,
          app: {
            bundleId: "com.apple.Notes",
            displayName: "Notes",
            teamId: null,
          },
          name: "Notes on Studio Mac",
        },
        {
          type: "phone",
          machineId: fixture.runnerId,
          display: "main",
          name: "Pixel",
        },
      ]);
      const projected = await decideCommitted(fixture);
      expect(projected.decided[0]?.view.body).toBe("Browser page, Notes on Studio Mac, Pixel");
      const quoted = await store.enqueueThreadInput({
        content: [
          {
            type: "text",
            text: "About these places",
          },
        ],
        quotedMessageId: reply.id,
        idempotencyKey: "place-label-quote",
        policy: "queue",
        requestedBy: fixture.ownerId,
        source: {
          kind: "human",
        },
        threadId: fixture.threadId,
      });
      expect(quoted.message.quote?.excerpt).toBe("Browser page\nNotes on Studio Mac\nPixel");
      expect(quoted.message.quote?.excerpt).not.toContain("https:");
      expect(quoted.message.quote?.excerpt).not.toContain("private/path");
    });
    it("shows a reply as one plain line of its own words", async ({ storeFixture }) => {
      const { createFixture, appendCompletedReply, decideCommitted, observedViews } = storeFixture;
      const fixture = await createFixture("markdown", true);
      await appendCompletedReply(fixture, [
        {
          text: [
            "## Results",
            "",
            "- **Revenue** is up",
            "- See [the report](https://example.com/r)",
            "",
            "```ts",
            "const x = 1;",
            "```",
            "`inline`",
          ].join("\n"),
          type: "text",
        },
      ]);
      await decideCommitted(fixture);
      expect((await observedViews())[0]?.body).toBe(
        "Results Revenue is up See the report const x = 1; inline",
      );
    });
    it("names the files a reply carries when it has no words", async ({ storeFixture }) => {
      const { createFixture, appendCompletedReply, decideCommitted, observedViews } = storeFixture;
      const fixture = await createFixture("files", true);
      const file = (name: string): ContentPart => ({
        artifactId: `art_${name}`,
        mediaType: "application/pdf",
        name,
        type: "artifact",
      });
      await appendCompletedReply(fixture, [file("invoice.pdf")]);
      await appendCompletedReply(fixture, [
        {
          text: "  ",
          type: "text",
        },
        file("a.pdf"),
        file("b.pdf"),
      ]);
      await decideCommitted(fixture);
      expect((await observedViews()).map(({ body }) => body)).toEqual([
        "Sent a file",
        "Sent 2 files",
      ]);
    });
    it("keeps a long reply within 180 characters, ending in an ellipsis", async ({
      storeFixture,
    }) => {
      const { createFixture, appendCompletedReply, text, decideCommitted, observedViews } =
        storeFixture;
      const fixture = await createFixture("long-reply", true);
      await appendCompletedReply(fixture, text(`Summary: ${"lorem ipsum dolor ".repeat(30)}`));
      await decideCommitted(fixture);
      const body = (await observedViews())[0]?.body ?? "";
      expect(body.length).toBeLessThanOrEqual(180);
      expect(body.length).toBeGreaterThan(170);
      expect(body.startsWith("Summary: lorem ipsum dolor")).toBe(true);
      expect(body.endsWith("…")).toBe(true);
    });
    it("cuts a long reply at a whole emoji, counting UTF-16 units as clients do", async ({
      storeFixture,
    }) => {
      const { createFixture, appendCompletedReply, text, decideCommitted, observedViews } =
        storeFixture;
      const fixture = await createFixture("emoji-reply", true);
      // 177 units, then emoji of two units each: the first fits before the
      // ellipsis at exactly 180 units, the next would split or overflow.
      await appendCompletedReply(fixture, text(`${"a".repeat(177)}${"😀".repeat(5)}`));
      await decideCommitted(fixture);
      const body = (await observedViews())[0]?.body ?? "";
      expect(body).toBe(`${"a".repeat(177)}😀…`);
      expect(body.length).toBe(180);
      expect(body).not.toMatch(/[\uD800-\uDFFF]/u);
    });
  });
  describe("Account subjects", () => {
    it("reaches a Personal Host's owner through the Account they linked", async ({
      storeFixture,
    }) => {
      const { createFixture, database, makePersonalDeployment, notifications } = storeFixture;
      const fixture = await createFixture("personal");
      const subject = `acct_${randomUUID()}`;
      // A Personal Host holds no Account OIDC provider at all: its owner is the
      // one administrator, and the link row is the only place that subject lives.
      await database.deleteFrom("authAccounts").where("userId", "=", fixture.ownerId).execute();
      await makePersonalDeployment(subject);
      await expect(notifications.accountSubjects(fixture.ownerId)).resolves.toEqual([subject]);
    });
    it("never lends a Personal link to another user", async ({ storeFixture }) => {
      const { createFixture, database, makePersonalDeployment, notifications } = storeFixture;
      const fixture = await createFixture("personal-member");
      await database.deleteFrom("authAccounts").where("userId", "=", fixture.ownerId).execute();
      await makePersonalDeployment(`acct_${randomUUID()}`);

      const other = await storeFixture.store.createUser("Another user");
      await expect(notifications.accountSubjects(other)).resolves.toEqual([]);
    });
    it("drops a Personal owner whose Account link is not active", async ({ storeFixture }) => {
      const { createFixture, database, makePersonalDeployment, notifications } = storeFixture;
      const fixture = await createFixture("personal-inactive");
      await database.deleteFrom("authAccounts").where("userId", "=", fixture.ownerId).execute();
      await makePersonalDeployment(`acct_${randomUUID()}`);
      await database
        .updateTable("personalRemoteAccountLink")
        .set({
          state: "activating",
        })
        .where("singletonKey", "=", "opensteer-account")
        .execute();
      await expect(notifications.accountSubjects(fixture.ownerId)).resolves.toEqual([]);
    });
    it("decides notifications for a person with no Account, whose own clients still show them", async ({
      storeFixture,
    }) => {
      const { createFixture, database, appendRunFailed, decideCommitted, notifications } =
        storeFixture;
      const fixture = await createFixture("no-account", true);
      await database.deleteFrom("authAccounts").where("userId", "=", fixture.ownerId).execute();
      await appendRunFailed(fixture);
      expect((await decideCommitted(fixture)).decided).toHaveLength(1);
      await expect(notifications.accountSubjects(fixture.ownerId)).resolves.toEqual([]);
    });
  });
  describe("viewer state", () => {
    it("records the time zone a person's client reports", async ({ storeFixture }) => {
      const { createFixture, notificationState, database } = storeFixture;
      const fixture = await createFixture("time-zone");
      await expect(notificationState.timeZoneFor(fixture.ownerId)).resolves.toBeNull();
      await expect(
        notificationState.setTimeZone({
          timeZone: "America/Los_Angeles",
          userId: fixture.ownerId,
        }),
      ).resolves.toBe("America/Los_Angeles");
      await expect(notificationState.timeZoneFor(fixture.ownerId)).resolves.toBe(
        "America/Los_Angeles",
      );
      await expect(
        notificationState.setTimeZone({
          timeZone: "Mars/Olympus_Mons",
          userId: fixture.ownerId,
        }),
      ).rejects.toThrow();
      await database
        .updateTable("users")
        .set({
          disabledAt: new Date(),
        })
        .where("id", "=", fixture.ownerId)
        .execute();
      await expect(
        notificationState.setTimeZone({
          timeZone: "Europe/Paris",
          userId: fixture.ownerId,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(notificationState.timeZoneFor(fixture.ownerId)).resolves.toBe(
        "America/Los_Angeles",
      );
    });
  });
  describe("task list", () => {
    /** A Thread as a person creates it before sending anything: no Run, no message. */

    /**
     * Someone else entirely: their own Workspace and a Thread in it, on the
     * fixture's one Main machine.
     */

    /** The Thread's next Run, made the way a later turn would be numbered. */
    async function laterRun(storeFixture: StoreFixture, runId: RunId): Promise<RunId> {
      const { database } = storeFixture;
      const id = createId("run");
      await sql`
        insert into public.runs
        select (jsonb_populate_record(null::public.runs, to_jsonb(run) || jsonb_build_object(
          'id', ${id}::text, 'run_ordinal', run.run_ordinal + 1, 'status', 'queued', 'failure', null
        ))).*
        from public.runs run
        where run.id = ${runId}
      `.execute(database);
      return id;
    }

    async function endRun(
      storeFixture: StoreFixture,
      runId: RunId,
      outcome:
        | {
            readonly status: "completed";
          }
        | {
            readonly failure: string;
            readonly status: "failed";
          },
    ): Promise<void> {
      const { database } = storeFixture;
      await database
        .updateTable("runs")
        .set({
          failure:
            outcome.status === "failed"
              ? jsonValue({
                  code: "runner_execution_error",
                  message: outcome.failure,
                  retryable: false,
                  status: "failed",
                })
              : null,
          status: outcome.status,
        })
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
    }

    /** What a page says, checked against the wire schema clients parse it with. */
    async function tasksOf(
      storeFixture: StoreFixture,
      userId: UserId,
      input: {
        readonly before?: string;
        readonly maxBytes?: number;
        readonly maxItems?: number;
      } = {},
    ): Promise<TaskPage> {
      const { store } = storeFixture;
      return TaskPageSchema.parse(
        await store.taskPageForUser({
          userId,
          ...input,
        }),
      );
    }
    function entryOf(page: TaskPage, threadId: ThreadId) {
      const entry = page.tasks.find(({ thread }) => thread.id === threadId);
      if (!entry) throw new Error(`Thread ${threadId} is not on the page`);
      return entry;
    }

    it("reads the last reply from the newest published assistant message, as one plain line", async ({
      storeFixture,
    }) => {
      const { createFixture, appendReply, text, store, database } = storeFixture;
      const fixture = await createFixture("tasks-reply");
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply,
      ).toBeNull();
      await appendReply(
        fixture,
        text(
          "## Summary\n\n- **Done.** Saved in `report.md`.\n-   Next:   [the plan](https://example.com/plan)\n\n\n\nThe end",
        ),
      );
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply,
      ).toBe("Summary Done. Saved in report.md. Next: the plan The end");

      // A person's message after it is not a reply, even once it is delivered.
      const followUp = await store.enqueueThreadInput({
        content: text("Thanks, now do the next one"),
        idempotencyKey: "tasks-reply-follow-up",
        policy: "queue",
        requestedBy: fixture.ownerId,
        source: {
          kind: "human",
        },
        threadId: fixture.threadId,
      });
      await database
        .updateTable("threadInputs")
        .set({
          deliveredAt: new Date(),
          runId: fixture.runId,
          state: "delivered",
        })
        .where("messageId", "=", followUp.message.id)
        .executeTakeFirstOrThrow();
      // Nor is an assistant message that says nothing, or one taken back before
      // anyone saw it.
      await appendReply(fixture, text("   \n  "));
      const withdrawn = await appendReply(fixture, text("A draft nobody saw"));
      await sql`
        insert into public.thread_inputs (
          actor_principal_id, authority_source, cancel_reason, causal_chain_id, delivered_at,
          idempotency_key, message_id, policy, queue_rank, reply_target,
          request_fingerprint, requested_by, run_id, state, steer_command_id, thread_id, updated_at)
        select actor_principal_id, authority_source, 'withdrawn', causal_chain_id, null,
          ${`withdrawn-${withdrawn.id}`}, ${withdrawn.id}, 'queue',
          queue_rank + 1000, reply_target, request_fingerprint, requested_by, null, 'cancelled',
          null, thread_id, now()
        from public.thread_inputs
        where message_id = ${followUp.message.id}
      `.execute(database);
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply,
      ).toBe("Summary Done. Saved in report.md. Next: the plan The end");

      // A reply that is only a file is the latest reply: it has no words to show.
      await appendReply(fixture, [
        {
          artifactId: "report",
          mediaType: "text/markdown",
          name: "report.md",
          type: "artifact",
        },
      ]);
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply,
      ).toBeNull();

      // Its first words, when it has several parts.
      await appendReply(fixture, [
        {
          artifactId: "chart",
          mediaType: "image/png",
          name: "chart.png",
          type: "artifact",
        },
        {
          text: "  ",
          type: "text",
        },
        {
          text: "Here is the chart.",
          type: "text",
        },
        {
          text: "And a second part.",
          type: "text",
        },
      ]);
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply,
      ).toBe("Here is the chart.");
    });
    it("cuts a huge reply in the database and never splits a character", async ({
      storeFixture,
    }) => {
      const { createFixture, appendReply, text } = storeFixture;
      const fixture = await createFixture("tasks-huge");
      await appendReply(fixture, text("word ".repeat(messageTextPartMaxLength / 5)));
      const words = entryOf(
        await tasksOf(storeFixture, fixture.ownerId),
        fixture.threadId,
      ).lastReply;
      expect(words?.length).toBeLessThanOrEqual(taskLineMaxLength);
      expect(words).toMatch(/^word word .*…$/u);
      await appendReply(fixture, text("😀".repeat(1_000)));
      const emoji =
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply ?? "";
      expect(emoji.length).toBeLessThanOrEqual(taskLineMaxLength);
      expect(emoji.endsWith("…")).toBe(true);
      expect(emoji).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );

      // Whitespace collapses before the line is cut; past what the database
      // reads, the words before it are what is left.
      await appendReply(fixture, text(`Before${" \n\t".repeat(3_000)}after`));
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply,
      ).toBe("Before after");
      await appendReply(fixture, text(`Before${" ".repeat(100_000)}after`));
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply,
      ).toBe("Before");
    });
    it("says why only while the latest Run failed", async ({ storeFixture }) => {
      const { createFixture } = storeFixture;
      const fixture = await createFixture("tasks-failure");
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure,
      ).toBeNull();
      await endRun(storeFixture, fixture.runId, {
        failure: "Runner unavailable.\n\n   Try again later.",
        status: "failed",
      });
      expect(entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure).toBe(
        "Runner unavailable. Try again later.",
      );
      const retry = await laterRun(storeFixture, fixture.runId);
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure,
      ).toBeNull();
      await endRun(storeFixture, retry, {
        status: "completed",
      });
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure,
      ).toBeNull();
      const again = await laterRun(storeFixture, retry);
      await endRun(storeFixture, again, {
        failure: "x".repeat(20_000),
        status: "failed",
      });
      const long = entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure;
      expect(long?.length).toBeLessThanOrEqual(taskLineMaxLength);
      expect(long?.endsWith("…")).toBe(true);
      const blank = await laterRun(storeFixture, again);
      await endRun(storeFixture, blank, {
        failure: "",
        status: "failed",
      });
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure,
      ).toBeNull();
    });
  });
});
