import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  NotificationIdSchema,
  notificationPushWindowMilliseconds,
  HarnessIdSchema,
  MessageAuthorSchema,
  ModelSelectionSchema,
  PendingRequestSchema,
  ThreadAccessModeSchema,
  createId,
  messageTextPartMaxLength,
  type ContentPart,
  type HarnessInstanceId,
  type MessageAuthor,
  type MessageId,
  type Request,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  BrowserSurfaceIdSchema,
  createBrowserSessionId,
  HarnessInstanceCatalogSchema,
  TaskPageSchema,
  taskLineMaxLength,
  type RunnerDescriptor,
  type TaskPage,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { describe, expect, it as baseIt } from "vitest";
import { AccountDirectoryStore } from "./account-directory-store.js";
import { createDatabase, withDatabaseTransaction } from "./connection.js";

import {
  NotificationStore,
  type DecidedNotification,
  type NotificationPublication,
} from "./notification-store.js";
import { NotificationStateStore } from "./notification-state.js";
import { issueRunGrant } from "./run-grants.js";
import { encodeWindowCursor, jsonValue } from "./store-primitives.js";
import { requestInsert } from "./request-store.js";
import { OpensteerStore } from "./store.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
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
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const directory = new AccountDirectoryStore(database);
    let now = new Date();
    const notifications = new NotificationStore(database, { now: () => now });
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
    async function enrollMainRunner(input: {
      readonly environmentId: ReturnType<typeof createId<"environment">>;
      readonly suffix: string;
    }): Promise<RunnerId> {
      if (!(await store.getDeployment())) {
        await store.ensureDeployment({
          canonicalOrigin: "https://notifications-test-host.invalid",
          deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
          hostInstanceId: createId("hostInstance"),
        });
      }
      const pair = generateKeyPairSync("ed25519");
      const enrollmentTokenHash = `sha256:${createHash("sha256")
        .update(`notification-runner-${input.suffix}`, "utf8")
        .digest("base64url")}`;
      const descriptor: RunnerDescriptor = {
        bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
        capabilities: ["filesystem"],
        modules: {
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
        name: `Main ${input.suffix}`,
        runnerId: createId("runner"),
        runnerKind: "main",
        runtimeVersion: "test",
      };
      await store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: null,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `notification-runner-${input.suffix}`,
        mainEnrollmentPurpose: "initial",
        name: descriptor.name,
        requestFingerprint: enrollmentTokenHash,
        runnerKind: "main",
        tokenHash: enrollmentTokenHash,
      });
      await store.enrollRunnerConnection({
        descriptor,
        enrollmentTokenHash,
        publicKeyFingerprint: `sha256:${createHash("sha256")
          .update(pair.publicKey.export({ format: "der", type: "spki" }))
          .digest("base64url")}`,
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      });
      return descriptor.runnerId;
    }
    async function createFixture(suffix: string, home = false): Promise<Fixture> {
      const ownerId = await store.createUser(`Owner ${suffix}`);
      const environmentId = createId("environment");
      const runnerId = await enrollMainRunner({ environmentId, suffix });
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
        createdBy: ownerId,
        idempotencyKey: `workspace-${suffix}`,
        name: `Workspace ${suffix}`,
        status: "ready",
      });
      const harnessInstance = await store.createHarnessInstance({
        config: { model: "test" },
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Native",
        sourceId: "native",
        stateKind: "isolated",
      });
      const { thread } = await store.createThread({
        createdBy: ownerId,
        environmentId,
        harnessInstanceId: harnessInstance.id,
        home,
        idempotencyKey: `thread-${suffix}`,
        modelSelection,
        title: `Thread ${suffix}`,
        workspaceId: workspace.id,
      });
      const admitted = await store.enqueueThreadInput({
        content: [{ text: "Start the work", type: "text" }],
        idempotencyKey: `${suffix}-turn`,
        policy: "queue",
        requestedBy: ownerId,
        source: { kind: "human" },
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
        workspaceId: workspace.id,
      };
    }
    async function addMember(
      fixture: Fixture,
      name: string,
      role: "collaborator" | "owner" = "collaborator",
    ): Promise<UserId> {
      const userId = await store.createUser(name);
      await database
        .insertInto("workspaceMemberships")
        .values({
          generation: 1,
          id: createId("workspaceMembership"),
          invitedBy: fixture.ownerId,
          joinedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          role,
          state: "active",
          updatedAt: new Date(),
          userId,
          workspaceId: fixture.workspaceId,
        })
        .executeTakeFirstOrThrow();
      return userId;
    }
    async function addThread(
      base: Fixture,
      input: {
        readonly home?: boolean;
        readonly requestedBy?: UserId;
        readonly suffix: string;
        readonly title?: string;
        readonly workspaceId?: WorkspaceId;
      },
    ): Promise<Fixture> {
      const workspaceId = input.workspaceId ?? base.workspaceId;
      const { thread } = await store.createThread({
        createdBy: base.ownerId,
        environmentId: base.environmentId,
        harnessInstanceId: base.harnessInstance.id,
        home: input.home ?? false,
        idempotencyKey: `thread-${input.suffix}`,
        modelSelection,
        title: input.title ?? `Thread ${input.suffix}`,
        workspaceId,
      });
      const admitted = await store.enqueueThreadInput({
        content: [{ text: "Start the work", type: "text" }],
        idempotencyKey: `${input.suffix}-turn`,
        policy: "queue",
        requestedBy: input.requestedBy ?? base.ownerId,
        source: { kind: "human" },
        threadId: thread.id,
      });
      if (!admitted.run) throw new Error("Expected the Thread's turn to queue a Run");
      return { ...base, runId: admitted.run.id, threadId: thread.id, workspaceId };
    }
    async function markRunning(fixture: Fixture, runId: RunId = fixture.runId): Promise<void> {
      const run = await database
        .updateTable("runs")
        .set({ bindingGeneration: 1, startedAt: new Date(), status: "running" })
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
      await withDatabaseTransaction(database, (transaction) =>
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
      target: { readonly runId: RunId; readonly threadId: ThreadId } = fixture,
    ): Promise<{ readonly id: MessageId; readonly sequence: string }> {
      return database.transaction().execute(async (transaction) => {
        const context = await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
          .select([
            "runs.actorPrincipalId",
            "threads.nextMessageSequence",
            "threads.workspaceId",
            "workspaces.name as workspaceName",
          ])
          .where("runs.id", "=", target.runId)
          .forNoKeyUpdate("threads")
          .executeTakeFirstOrThrow();
        const id = createId("message");
        await transaction
          .insertInto("messages")
          .values({
            actorPrincipalId: context.actorPrincipalId,
            author: jsonValue(
              MessageAuthorSchema.parse({
                displayName: "Opensteer",
                kind: "agent",
                runId: target.runId,
                threadId: target.threadId,
                workspaceId: context.workspaceId,
                workspaceName: context.workspaceName,
              }),
            ),
            content: jsonValue(content),
            id,
            kind: "assistant",
            runId: target.runId,
            sequence: context.nextMessageSequence,
            threadId: target.threadId,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("threads")
          .set({ nextMessageSequence: sql`next_message_sequence + 1`, updatedAt: new Date() })
          .where("id", "=", target.threadId)
          .executeTakeFirstOrThrow();
        return { id, sequence: String(context.nextMessageSequence) };
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
      await database.transaction().execute(async (transaction) => {
        const eventId = createId("event");
        const createdAt = new Date();
        const workspace = await transaction
          .updateTable("workspaces")
          .set({ eventSequence: sql<string>`event_sequence + 1`, updatedAt: createdAt })
          .where("id", "=", fixture.workspaceId)
          .returning("eventSequence")
          .executeTakeFirstOrThrow();
        const data =
          event.type === "run.completed" ? { ...event.data, status: "completed" } : event.data;
        const parsed = AgentEventSchema.parse({
          createdAt: createdAt.toISOString(),
          data,
          environmentId: fixture.environmentId,
          eventId,
          runId: target.runId,
          sequence: String(workspace.eventSequence),
          threadId: target.threadId,
          type: event.type,
          workspaceId: fixture.workspaceId,
        });
        await transaction
          .insertInto("workspaceEvents")
          .values({
            createdAt,
            data: jsonValue(parsed.data),
            environmentId: fixture.environmentId,
            eventId,
            runId: target.runId,
            runnerBindingGeneration: null,
            runnerBootId: null,
            runnerId: null,
            runnerOrdinal: null,
            sequence: workspace.eventSequence,
            threadId: target.threadId,
            type: event.type,
            workspaceId: fixture.workspaceId,
          })
          .executeTakeFirstOrThrow();
      });
    }
    async function appendCompletedReply(
      fixture: Fixture,
      content: readonly ContentPart[],
      target: { readonly runId: RunId; readonly threadId: ThreadId } = fixture,
    ): Promise<{ readonly id: MessageId; readonly sequence: string }> {
      const reply = await appendReply(fixture, content, target);
      await appendRunnerEvent(
        fixture,
        { data: { replyMessageId: reply.id }, type: "run.completed" },
        target,
      );
      return reply;
    }
    async function appendRunFailed(
      fixture: Fixture,
      message = "Runner unavailable",
      target: { readonly runId: RunId; readonly threadId: ThreadId } = fixture,
    ): Promise<void> {
      await database.transaction().execute((transaction) =>
        appendHostWorkspaceEvent(transaction, {
          data: { code: "runner_execution_error", message, retryable: false, status: "failed" },
          environmentId: fixture.environmentId,
          runId: target.runId,
          threadId: target.threadId,
          type: "run.failed",
          workspaceId: fixture.workspaceId,
        }),
      );
    }
    async function appendRunInterrupted(fixture: Fixture): Promise<void> {
      await database.transaction().execute((transaction) =>
        appendHostWorkspaceEvent(transaction, {
          data: { status: "interrupted" },
          environmentId: fixture.environmentId,
          runId: fixture.runId,
          threadId: fixture.threadId,
          type: "run.interrupted",
          workspaceId: fixture.workspaceId,
        }),
      );
    }
    function pendingRequest(
      fixture: Fixture,
      requiredActor: "administrator" | "requester" | "workspace-owner",
    ) {
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
        originatingWorkspaceId: fixture.workspaceId,
        payload: { kind: "harness.approval" },
        presentation: {
          kind: "choice",
          options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
          title: "May I edit this file?",
        },
        requestedBy: fixture.ownerId,
        requiredActor,
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
        targetWorkspaceId: fixture.workspaceId,
      });
    }
    async function appendRequestOpened(
      fixture: Fixture,
      requiredActor: "administrator" | "requester" | "workspace-owner",
    ): Promise<RequestId> {
      return storeOpenedRequest(fixture, pendingRequest(fixture, requiredActor));
    }
    async function storeOpenedRequest(fixture: Fixture, request: Request): Promise<RequestId> {
      await database.transaction().execute(async (transaction) => {
        await transaction.insertInto("requests").values(requestInsert(request)).execute();
        await appendHostWorkspaceEvent(transaction, {
          data: { request },
          environmentId: fixture.environmentId,
          runId: fixture.runId,
          threadId: fixture.threadId,
          type: "request.opened",
          workspaceId: fixture.workspaceId,
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
        originatingWorkspaceId: fixture.workspaceId,
        payload: { kind: "harness.approval" },
        presentation: {
          kind: "choice",
          options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
          title: "May I run the migration?",
        },
        requestedBy: fixture.ownerId,
        requiredActor: "requester",
        targetWorkspaceId: fixture.workspaceId,
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
        originatingWorkspaceId: fixture.workspaceId,
        payload: {
          access: "read",
          installationId: null,
          kind: "integration.access",
          manifest: { digest: "a".repeat(43), kind: "catalog" },
          reason: "Read the calendar",
          requestedConnectionId: null,
          requestedServerId: null,
        },
        presentation: {
          kind: "external",
          subject: { id: "catalog:calendar", kind: "integration-install-manifest" },
          title: "Calendar access",
        },
        requestedBy: fixture.ownerId,
        requiredActor: "requester",
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
        targetWorkspaceId: fixture.workspaceId,
      });
      return storeOpenedRequest(fixture, request);
    }
    async function setRunSeedAuthor(fixture: Fixture, kind: MessageAuthor["kind"]): Promise<void> {
      const author = MessageAuthorSchema.parse(
        kind === "human"
          ? { displayName: "Owner", kind, principalId: "test-principal", userId: fixture.ownerId }
          : kind === "agent"
            ? {
                displayName: "Specialist",
                kind,
                runId: createId("run"),
                threadId: createId("thread"),
                workspaceId: fixture.workspaceId,
                workspaceName: "Specialist",
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
                : { cause: "request-answered", kind },
      );
      const seed = await database
        .selectFrom("runs")
        .select("seedInputId")
        .where("id", "=", fixture.runId)
        .executeTakeFirstOrThrow();
      await database
        .updateTable("messages")
        .set({ author: jsonValue(author), kind: kind === "platform" ? "continuation" : "input" })
        .where("id", "=", seed.seedInputId)
        .executeTakeFirstOrThrow();
    }
    async function makePersonalDeployment(subject: string): Promise<void> {
      await sql`
      update public.deployments
      set deployment_shape = jsonb_build_object(
        'defaultWorkspaceBacking', 'portablefs', 'kind', 'personal'
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
    async function decideCommitted(fixture: Fixture) {
      const rows = await database
        .selectFrom("workspaceEvents")
        .selectAll()
        .where("workspaceId", "=", fixture.workspaceId)
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
            occurredAt: new Date(row.createdAt),
            expiresAt: new Date(row.createdAt.getTime() + notificationPushWindowMilliseconds),
          });
        }
      }
      return { decided };
    }
    async function observedViews() {
      return [...observed.values()].map(
        ({
          userId,
          view: { id: _id, occurredAt: _occurredAt, workspaceId: _workspaceId, ...view },
        }) => ({ ...view, userId }),
      );
    }
    async function publicationEntries(): Promise<readonly NotificationPublication[]> {
      return [...publications.values()];
    }
    const text = (value: string): ContentPart[] => [{ text: value, type: "text" }];
    now = new Date();
    observed.clear();
    publications.clear();
    readEvents.clear();
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
      enrollMainRunner,
      createFixture,
      addMember,
      addThread,
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
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
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
    readonly workspaceId: WorkspaceId;
  }

  /** The one enrolled machine a Thread needs before it may hold a Run. */

  /**
   * One person's first Workspace — their Main one — with a Thread and a queued
   * Run they asked for. `home` makes that Thread their Chat.
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
   * reply in Chat answers the person whoever or whatever woke the agent.
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
      "alerts the person for a Chat reply to a %s-seeded Run",
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

    it("alerts only for the Chat relay of delegated work, never the task's own reply or failure", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        store,
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
        origin: { kind: "run", parentRunId: fixture.runId, parentThreadId: fixture.threadId },
        task: text("Research the vendors"),
        title: "Vendor research",
        workspaceId: fixture.workspaceId,
      });
      const task = { runId: delegated.run.id, threadId: delegated.thread.id };
      expect(delegated.run.requestedBy).toBe(fixture.ownerId);

      // The task's reply returns to Chat's agent, and its failure is that
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
    });

    it("never alerts for a report, in Chat or anywhere else", async ({ storeFixture }) => {
      const {
        createFixture,
        markRunning,
        store,
        text,
        decideCommitted,
        notificationState,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("report", true);
      await markRunning(fixture);
      const report = await store.enqueueThreadInput({
        content: text("Specialist update: the build is green."),
        idempotencyKey: "report-to-chat",
        policy: "report",
        requestedBy: fixture.ownerId,
        source: { kind: "agent", runId: fixture.runId },
        threadId: fixture.threadId,
      });

      await decideCommitted(fixture);

      // The report is unread in Chat — it is context for the next turn — but
      // it is not a message to the person, so nothing alerts.
      expect(
        await notificationState.getReadState({
          threadId: fixture.threadId,
          userId: fixture.ownerId,
        }),
      ).toMatchObject({ unreadSequence: report.message.sequence });
      expect(await observedViews()).toEqual([]);
    });

    it("never tells a person about their own messages, and tells only the person a Run answers", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        addMember,
        linkAccount,
        markRunning,
        store,
        text,
        decideCommitted,
        observedViews,
        appendCompletedReply,
      } = storeFixture;
      const fixture = await createFixture("own-message", true);
      const colleague = await addMember(fixture, "Colleague");
      await linkAccount(colleague);
      await markRunning(fixture);
      await store.enqueueThreadInput({
        content: text("Also check the calendar"),
        idempotencyKey: "own-steer",
        policy: "steer",
        requestedBy: fixture.ownerId,
        source: { kind: "human" },
        threadId: fixture.threadId,
      });
      await store.enqueueThreadInput({
        content: text("And then email Sam"),
        idempotencyKey: "own-queue",
        policy: "queue",
        requestedBy: fixture.ownerId,
        source: { kind: "human" },
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
        .set({ replyTarget: jsonValue({ conversationId: "C024BE91L", kind: "channel" }) })
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
      await appendRunnerEvent(fixture, { data: { phase: "turn" }, type: "run.phase" });
      await appendRunnerEvent(fixture, {
        data: { phase: "background", replyMessageId: null },
        type: "run.phase",
      });
      await appendRunnerEvent(fixture, {
        data: { phase: "background", replyMessageId: reply.id },
        type: "run.phase",
      });

      const first = (await decideCommitted(fixture)).decided;
      expect(first).toHaveLength(1);
      await appendRunnerEvent(fixture, {
        data: { replyMessageId: reply.id },
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
        expect.objectContaining({ kind: "reply-published", messageId: reply.id }),
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
      await notificationState.markRead({
        threadId: fixture.threadId,
        throughSequence: reply.sequence,
        userId: fixture.ownerId,
      });

      await decideCommitted(fixture);

      expect(await observedViews()).toEqual([]);
    });

    it("rechecks the read marker before publishing a decided reply", async ({ storeFixture }) => {
      const {
        createFixture,
        appendCompletedReply,
        text,
        decideCommitted,
        notificationState,
        publicationEntries,
        notifications,
      } = storeFixture;
      const fixture = await createFixture("grace", true);
      const read = await appendCompletedReply(fixture, text("You saw this one."));
      const unread = await appendCompletedReply(fixture, text("You did not see this one."));
      await decideCommitted(fixture);

      await notificationState.markRead({
        threadId: fixture.threadId,
        throughSequence: read.sequence,
        userId: fixture.ownerId,
      });

      const claimed = await publicationEntries();
      expect(claimed.map(({ messageId }) => messageId).sort()).toEqual([read.id, unread.id].sort());
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
      const queued = await addThread(fixture, { suffix: "stopped-while-queued" });
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

    it("notifies the requester and Workspace administrators about preinstall access", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        addMember,
        database,
        appendPreinstallAccessOpened,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("preinstall-access");
      const administratorId = await addMember(fixture, "Installation administrator");
      await database
        .updateTable("users")
        .set({ instanceRole: "administrator" })
        .where("id", "=", administratorId)
        .executeTakeFirstOrThrow();
      const requestId = await appendPreinstallAccessOpened(fixture);

      await decideCommitted(fixture);

      const rows = await observedViews();
      expect(rows.map(({ requestId: id }) => id)).toEqual([requestId, requestId]);
      expect(new Set(rows.map(({ userId }) => userId))).toEqual(
        new Set([fixture.ownerId, administratorId]),
      );
    });

    it("tells every active owner about a Workspace-owner Request", async ({ storeFixture }) => {
      const { createFixture, addMember, appendRequestOpened, decideCommitted, observedViews } =
        storeFixture;
      const fixture = await createFixture("owner-request");
      const coOwner = await addMember(fixture, "Co-owner", "owner");
      await addMember(fixture, "Collaborator");

      await appendRequestOpened(fixture, "workspace-owner");
      await decideCommitted(fixture);

      expect(new Set((await observedViews()).map(({ userId }) => userId))).toEqual(
        new Set([fixture.ownerId, coOwner]),
      );
    });

    it("drops an administrator Request nobody in the Workspace may answer", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        appendRequestOpened,
        decideCommitted,
        observedViews,
        database,
        readEvents,
      } = storeFixture;
      const fixture = await createFixture("administrator");
      await appendRequestOpened(fixture, "administrator");
      await decideCommitted(fixture);
      expect(await observedViews()).toEqual([]);

      await database
        .updateTable("users")
        .set({ instanceRole: "administrator" })
        .where("id", "=", fixture.ownerId)
        .execute();
      readEvents.clear();
      await decideCommitted(fixture);
      expect((await observedViews()).map(({ kind }) => kind)).toEqual(["request-opened"]);
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
      expect(entry).toMatchObject({ kind: "request-opened", requestId });
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
    it("silences a muted Workspace's replies and failures but never its Requests", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        notificationState,
        appendCompletedReply,
        text,
        appendRunFailed,
        appendRequestOpened,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("muted", true);
      await notificationState.setAgentNotificationMute({
        muted: true,
        userId: fixture.ownerId,
        workspaceId: fixture.workspaceId,
      });
      await appendCompletedReply(fixture, text("Quiet reply."));
      await appendRunFailed(fixture);
      const requestId = await appendRequestOpened(fixture, "requester");

      await decideCommitted(fixture);

      expect(await observedViews()).toEqual([
        expect.objectContaining({ kind: "request-opened", requestId }),
      ]);
    });

    it("keys mute to the Thread's own Workspace", async ({ storeFixture }) => {
      const {
        createFixture,
        store,
        notificationState,
        appendCompletedReply,
        text,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("mute-elsewhere", true);
      const other = await store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "wsp_mute-elsewhere-other",
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: fixture.ownerId,
        idempotencyKey: "workspace-mute-elsewhere-other",
        name: "Other specialist",
        status: "ready",
      });
      await notificationState.setAgentNotificationMute({
        muted: true,
        userId: fixture.ownerId,
        workspaceId: other.id,
      });

      await appendCompletedReply(fixture, text("Still audible."));
      await decideCommitted(fixture);

      expect((await observedViews()).map(({ kind }) => kind)).toEqual(["reply-published"]);
    });

    it("skips a reply or failure muted after it was decided, but not a Request", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        markRunning,
        openRequest,
        appendCompletedReply,
        text,
        appendRunFailed,
        decideCommitted,
        publicationEntries,
        notificationState,
        notifications,
      } = storeFixture;
      const fixture = await createFixture("muted-later", true);
      await markRunning(fixture);
      await openRequest(fixture);
      await appendCompletedReply(fixture, text("Decided before the mute."));
      await appendRunFailed(fixture);
      await decideCommitted(fixture);
      const claimed = await publicationEntries();
      expect(claimed.map(({ kind }) => kind).sort()).toEqual([
        "reply-published",
        "request-opened",
        "run-failed",
      ]);

      await notificationState.setAgentNotificationMute({
        muted: true,
        userId: fixture.ownerId,
        workspaceId: fixture.workspaceId,
      });

      const reasons = Object.fromEntries(
        await Promise.all(
          claimed.map(
            async (entry) =>
              [entry.kind, await notifications.publicationSkipReason(entry)] as const,
          ),
        ),
      );
      expect(reasons).toEqual({
        "reply-published": "Workspace was muted before publication",
        "request-opened": null,
        "run-failed": "Workspace was muted before publication",
      });
    });

    it("tells nobody who is disabled or no longer a member", async ({ storeFixture }) => {
      const {
        createFixture,
        addMember,
        addThread,
        database,
        appendCompletedReply,
        text,
        appendRunFailed,
        appendRequestOpened,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const fixture = await createFixture("gone", true);
      const colleague = await addMember(fixture, "Departing colleague");
      const colleagueTurn = await addThread(fixture, {
        requestedBy: colleague,
        suffix: "colleague",
      });
      await database
        .updateTable("users")
        .set({ disabledAt: new Date() })
        .where("id", "=", fixture.ownerId)
        .execute();
      await database
        .updateTable("workspaceMemberships")
        .set({ revokedAt: new Date(), revokedBy: fixture.ownerId, state: "revoked" })
        .where("userId", "=", colleague)
        .execute();

      await appendCompletedReply(fixture, text("For a disabled owner."));
      await appendRunFailed(fixture);
      await appendRequestOpened(fixture, "requester");
      await appendCompletedReply(colleagueTurn, text("For a former member."), colleagueTurn);
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
        .set({ disabledAt: new Date() })
        .where("id", "=", fixture.ownerId)
        .execute();

      await expect(notifications.publicationSkipReason(entry!)).resolves.toBe(
        "Recipient can no longer open this Thread",
      );
    });
  });

  describe("presentation", () => {
    it("titles a reply by its Thread outside Chat, and Chat as Opensteer", async ({
      storeFixture,
    }) => {
      const {
        createFixture,
        addThread,
        store,
        appendCompletedReply,
        text,
        decideCommitted,
        observedViews,
      } = storeFixture;
      const chat = await createFixture("title-chat", true);
      const work = await addThread(chat, { suffix: "title-work" });
      const specialized = await store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "wsp_title-specialized",
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: chat.ownerId,
        idempotencyKey: "workspace-title-specialized",
        name: "Research",
        status: "ready",
      });
      const specialist = await addThread(chat, {
        suffix: "title-specialized",
        title: "Research desk",
        workspaceId: specialized.id,
      });

      await appendCompletedReply(chat, text("From Chat."));
      await appendCompletedReply(work, text("From a work Thread."));
      await appendCompletedReply(specialist, text("From a specialist."));
      for (const fixture of [chat, work, specialist]) await decideCommitted(fixture);

      const titles = Object.fromEntries(
        (await observedViews()).map((row) => [row.body, row.title]),
      );
      expect(titles).toEqual({
        "From Chat.": "Opensteer",
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
          app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
          name: "Notes on Studio Mac",
        },
        { type: "phone", machineId: fixture.runnerId, display: "main", name: "Pixel" },
      ]);
      const projected = await decideCommitted(fixture);
      expect(projected.decided[0]?.view.body).toBe("Browser page, Notes on Studio Mac, Pixel");
      const quoted = await store.enqueueThreadInput({
        content: [{ type: "text", text: "About these places" }],
        quotedMessageId: reply.id,
        idempotencyKey: "place-label-quote",
        policy: "queue",
        requestedBy: fixture.ownerId,
        source: { kind: "human" },
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
        { text: "  ", type: "text" },
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
    it("reaches a server Host's user through their Account sign-in only", async ({
      storeFixture,
    }) => {
      const { createFixture, linkAccount, database, addMember, notifications } = storeFixture;
      const fixture = await createFixture("server-subjects");
      const second = await linkAccount(fixture.ownerId);
      // A password sign-in or another provider's identity is not an Account.
      await database
        .insertInto("authAccounts")
        .values({
          accessToken: null,
          accessTokenExpiresAt: null,
          accountId: `local_${randomUUID()}`,
          createdAt: new Date(),
          id: createId("authAccount"),
          idToken: null,
          password: "hashed",
          providerId: "credential",
          refreshToken: null,
          refreshTokenExpiresAt: null,
          scope: null,
          updatedAt: new Date(),
          userId: fixture.ownerId,
        })
        .execute();
      const unlinked = await addMember(fixture, "No Account");

      expect(new Set(await notifications.accountSubjects(fixture.ownerId))).toEqual(
        new Set([fixture.ownerAccountId, second]),
      );
      await expect(notifications.accountSubjects(unlinked)).resolves.toEqual([]);
    });

    it("reaches a Personal Host's owner through the Account they linked", async ({
      storeFixture,
    }) => {
      const { createFixture, database, makePersonalDeployment, notifications } = storeFixture;
      const fixture = await createFixture("personal");
      const subject = `acct_${randomUUID()}`;
      // A Personal Host holds no Account OIDC provider at all: its owner is the
      // one administrator, and the link row is the only place that subject lives.
      await database.deleteFrom("authAccounts").where("userId", "=", fixture.ownerId).execute();
      await database
        .updateTable("users")
        .set({ instanceRole: "administrator" })
        .where("id", "=", fixture.ownerId)
        .execute();
      await makePersonalDeployment(subject);

      await expect(notifications.accountSubjects(fixture.ownerId)).resolves.toEqual([subject]);
    });

    it("never lends a Personal link to a member who is not the owner", async ({ storeFixture }) => {
      const { createFixture, database, makePersonalDeployment, notifications } = storeFixture;
      const fixture = await createFixture("personal-member");
      await database.deleteFrom("authAccounts").where("userId", "=", fixture.ownerId).execute();
      await makePersonalDeployment(`acct_${randomUUID()}`);

      // The Workspace creator is an ordinary user here, so the link — which only
      // a machine-local owner could have made — is not theirs to be reached by.
      await expect(notifications.accountSubjects(fixture.ownerId)).resolves.toEqual([]);
    });

    it("drops a Personal owner whose Account link is not active", async ({ storeFixture }) => {
      const { createFixture, database, makePersonalDeployment, notifications } = storeFixture;
      const fixture = await createFixture("personal-inactive");
      await database.deleteFrom("authAccounts").where("userId", "=", fixture.ownerId).execute();
      await database
        .updateTable("users")
        .set({ instanceRole: "administrator" })
        .where("id", "=", fixture.ownerId)
        .execute();
      await makePersonalDeployment(`acct_${randomUUID()}`);
      await database
        .updateTable("personalRemoteAccountLink")
        .set({ state: "activating" })
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
        notificationState.setTimeZone({ timeZone: "America/Los_Angeles", userId: fixture.ownerId }),
      ).resolves.toBe("America/Los_Angeles");
      await expect(notificationState.timeZoneFor(fixture.ownerId)).resolves.toBe(
        "America/Los_Angeles",
      );
      await expect(
        notificationState.setTimeZone({ timeZone: "Mars/Olympus_Mons", userId: fixture.ownerId }),
      ).rejects.toThrow();
      await database
        .updateTable("users")
        .set({ disabledAt: new Date() })
        .where("id", "=", fixture.ownerId)
        .execute();
      await expect(
        notificationState.setTimeZone({ timeZone: "Europe/Paris", userId: fixture.ownerId }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(notificationState.timeZoneFor(fixture.ownerId)).resolves.toBe(
        "America/Los_Angeles",
      );
    });

    it("keeps unread candidates private, ordered, and scoped to published incoming content", async ({
      storeFixture,
    }) => {
      const { createFixture, markRunning, addMember, store, text, notificationState, database } =
        storeFixture;
      const fixture = await createFixture("viewer-candidates");
      await markRunning(fixture);
      const secondUserId = await addMember(fixture, "Second viewer");
      const queued = await store.enqueueThreadInput({
        content: text("Still queued"),
        idempotencyKey: "viewer-candidates-queued",
        policy: "queue",
        requestedBy: fixture.ownerId,
        source: { kind: "human" },
        threadId: fixture.threadId,
      });
      const before = await notificationState.getReadState({
        threadId: fixture.threadId,
        userId: secondUserId,
      });
      expect(before.unreadSequence).not.toBe(queued.message.sequence);
      const report = await store.enqueueThreadInput({
        content: text("Published report"),
        idempotencyKey: "viewer-candidates-report",
        policy: "report",
        requestedBy: fixture.ownerId,
        source: { kind: "agent", runId: fixture.runId },
        threadId: fixture.threadId,
      });
      const published = await notificationState.getReadState({
        threadId: fixture.threadId,
        userId: secondUserId,
      });
      expect(published.unreadSequence).toBe(report.message.sequence);
      expect(BigInt(published.asOfSequence)).toBeGreaterThan(BigInt(before.asOfSequence));
      await database
        .updateTable("messages")
        .set({
          author: jsonValue(
            MessageAuthorSchema.parse({
              displayName: "Owner",
              kind: "human",
              principalId: "test-principal",
              userId: fixture.ownerId,
            }),
          ),
        })
        .where("id", "=", report.message.id)
        .executeTakeFirstOrThrow();
      expect(
        (
          await notificationState.getReadState({
            threadId: fixture.threadId,
            userId: fixture.ownerId,
          })
        ).unreadSequence,
      ).toBeNull();
      expect(
        (await notificationState.getReadState({ threadId: fixture.threadId, userId: secondUserId }))
          .unreadSequence,
      ).toBe(report.message.sequence);
      await Promise.all([
        notificationState.markRead({
          threadId: fixture.threadId,
          throughSequence: report.message.sequence,
          userId: secondUserId,
        }),
        notificationState
          .markRead({
            threadId: fixture.threadId,
            throughSequence: queued.message.sequence,
            userId: secondUserId,
          })
          .catch(() => undefined),
      ]);
      expect(
        (await notificationState.getReadState({ threadId: fixture.threadId, userId: secondUserId }))
          .readSequence,
      ).toBe(report.message.sequence);
      const withdrawn = await store.enqueueThreadInput({
        content: text("Withdrawn report"),
        idempotencyKey: "viewer-candidates-withdrawn",
        policy: "report",
        requestedBy: fixture.ownerId,
        source: { kind: "agent", runId: fixture.runId },
        threadId: fixture.threadId,
      });
      const beforeWithdrawal = await notificationState.getReadState({
        threadId: fixture.threadId,
        userId: fixture.ownerId,
      });
      expect(beforeWithdrawal.unreadSequence).toBe(withdrawn.message.sequence);
      await database
        .updateTable("threadInputs")
        .set({ state: "cancelled", cancelReason: "report-withdrawn", updatedAt: new Date() })
        .where("messageId", "=", withdrawn.message.id)
        .executeTakeFirstOrThrow();
      await database
        .updateTable("workspaces")
        .set({ eventSequence: sql<string>`event_sequence + 1` })
        .where("id", "=", fixture.workspaceId)
        .executeTakeFirstOrThrow();
      const cancelled = await notificationState.getReadState({
        threadId: fixture.threadId,
        userId: fixture.ownerId,
      });
      expect(cancelled.unreadSequence).toBeNull();
      expect(BigInt(cancelled.asOfSequence)).toBeGreaterThan(BigInt(beforeWithdrawal.asOfSequence));
    });

    it("pages persisted read markers and versions mute choices for one member", async ({
      storeFixture,
    }) => {
      const { createFixture, markRunning, notificationState, store, text } = storeFixture;
      const fixture = await createFixture("viewer-marker-page");
      await markRunning(fixture);
      const initial = await notificationState.listWorkspacePreferences({
        workspaceIds: [fixture.workspaceId],
        userId: fixture.ownerId,
      });
      expect(initial).toEqual([{ workspaceId: fixture.workspaceId, muted: false, revision: "0" }]);
      const muted = await notificationState.setAgentNotificationMute({
        muted: true,
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerId,
      });
      const unmuted = await notificationState.setAgentNotificationMute({
        muted: false,
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerId,
      });
      expect(muted).toMatchObject({ muted: true, revision: "1" });
      expect(unmuted).toMatchObject({ muted: false, revision: "2" });
      const otherWorkspace = await store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "wsp_viewer-marker-page-other",
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: fixture.ownerId,
        idempotencyKey: "workspace-viewer-marker-page-other",
        name: "Other preference",
        status: "ready",
      });
      await notificationState.setAgentNotificationMute({
        muted: true,
        workspaceId: otherWorkspace.id,
        userId: fixture.ownerId,
      });
      const firstPreferencePage = await notificationState.workspacePreferencePage({
        userId: fixture.ownerId,
        limit: 1,
      });
      expect(firstPreferencePage.preferences).toHaveLength(1);
      expect(firstPreferencePage.nextAfterWorkspaceId).not.toBeNull();
      const secondPreferencePage = await notificationState.workspacePreferencePage({
        userId: fixture.ownerId,
        afterWorkspaceId: firstPreferencePage.nextAfterWorkspaceId,
        limit: 1,
      });
      expect(secondPreferencePage.preferences).toHaveLength(1);
      expect(secondPreferencePage.nextAfterWorkspaceId).toBeNull();
      expect([...firstPreferencePage.preferences, ...secondPreferencePage.preferences]).toEqual(
        expect.arrayContaining([
          unmuted,
          { workspaceId: otherWorkspace.id, muted: true, revision: "1" },
        ]),
      );
      const report = await store.enqueueThreadInput({
        content: text("Read me"),
        idempotencyKey: "viewer-marker-page-report",
        policy: "report",
        requestedBy: fixture.ownerId,
        source: { kind: "agent", runId: fixture.runId },
        threadId: fixture.threadId,
      });
      await notificationState.markRead({
        threadId: fixture.threadId,
        throughSequence: report.message.sequence,
        userId: fixture.ownerId,
      });
      const page = await notificationState.readMarkerPage({
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerId,
        limit: 1,
      });
      expect(page.markers).toEqual([
        { threadId: fixture.threadId, readSequence: report.message.sequence },
      ]);
      expect(page.nextAfterThreadId).toBeNull();
      expect(
        (
          await notificationState.readMarkerPage({
            workspaceId: fixture.workspaceId,
            userId: fixture.ownerId,
            afterThreadId: fixture.threadId,
            limit: 1,
          })
        ).markers,
      ).toEqual([]);
    });

    it("keeps the greatest read position under concurrent marks", async ({ storeFixture }) => {
      const { createFixture, appendReply, text, notificationState } = storeFixture;
      const fixture = await createFixture("concurrent-markers");
      const first = await appendReply(fixture, text("First reply"));
      const second = await appendReply(fixture, text("Second reply"));
      await Promise.all([
        notificationState.markRead({
          threadId: fixture.threadId,
          throughSequence: second.sequence,
          userId: fixture.ownerId,
        }),
        notificationState.markRead({
          threadId: fixture.threadId,
          throughSequence: first.sequence,
          userId: fixture.ownerId,
        }),
      ]);
      expect(
        await notificationState.getReadState({
          threadId: fixture.threadId,
          userId: fixture.ownerId,
        }),
      ).toMatchObject({ readSequence: second.sequence, unreadSequence: null });
    });
  });

  describe("task list", () => {
    /** A Thread as a person creates it before sending anything: no Run, no message. */
    async function emptyThread(
      storeFixture: StoreFixture,
      base: Fixture,
      input: { readonly suffix: string; readonly workspaceId?: WorkspaceId },
    ): Promise<ThreadId> {
      const { store } = storeFixture;
      const { thread } = await store.createThread({
        createdBy: base.ownerId,
        environmentId: base.environmentId,
        harnessInstanceId: base.harnessInstance.id,
        home: false,
        idempotencyKey: `thread-${input.suffix}`,
        modelSelection,
        title: `Thread ${input.suffix}`,
        workspaceId: input.workspaceId ?? base.workspaceId,
      });
      return thread.id;
    }

    async function anotherWorkspace(
      storeFixture: StoreFixture,
      base: Fixture,
      suffix: string,
    ): Promise<WorkspaceId> {
      const { store } = storeFixture;
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
        createdBy: base.ownerId,
        idempotencyKey: `workspace-${suffix}`,
        name: `Workspace ${suffix}`,
        status: "ready",
      });
      return workspace.id;
    }

    /**
     * Someone else entirely: their own Workspace and a Thread in it, on the
     * fixture's one Main machine.
     */
    async function someoneElse(
      storeFixture: StoreFixture,
      base: Fixture,
      suffix: string,
    ): Promise<{ readonly threadId: ThreadId; readonly userId: UserId }> {
      const { store } = storeFixture;
      const userId = await store.createUser(`Stranger ${suffix}`);
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
        createdBy: userId,
        idempotencyKey: `workspace-${suffix}`,
        name: `Workspace ${suffix}`,
        status: "ready",
      });
      const { thread } = await store.createThread({
        createdBy: userId,
        environmentId: base.environmentId,
        harnessInstanceId: base.harnessInstance.id,
        home: false,
        idempotencyKey: `thread-${suffix}`,
        modelSelection,
        title: `Thread ${suffix}`,
        workspaceId: workspace.id,
      });
      return { threadId: thread.id, userId };
    }

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

    async function setUpdatedAt(
      storeFixture: StoreFixture,
      threadId: ThreadId,
      updatedAt: string,
    ): Promise<void> {
      const { database } = storeFixture;
      await sql`
        update public.threads set updated_at = ${updatedAt}::timestamptz where id = ${threadId}
      `.execute(database);
    }

    async function endRun(
      storeFixture: StoreFixture,
      runId: RunId,
      outcome:
        { readonly status: "completed" } | { readonly failure: string; readonly status: "failed" },
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
        readonly workspaceId?: WorkspaceId;
      } = {},
    ): Promise<TaskPage> {
      const { store } = storeFixture;
      return TaskPageSchema.parse(await store.taskPageForUser({ userId, ...input }));
    }

    function entryOf(page: TaskPage, threadId: ThreadId) {
      const entry = page.tasks.find(({ thread }) => thread.id === threadId);
      if (!entry) throw new Error(`Thread ${threadId} is not on the page`);
      return entry;
    }

    it("lists the reader's listed, unarchived Threads in every Workspace they actively belong to", async ({
      storeFixture,
    }) => {
      const { createFixture, addThread, addMember, database } = storeFixture;
      const owner = await createFixture("tasks-owner");
      const second = await addThread(owner, {
        suffix: "tasks-second",
        workspaceId: await anotherWorkspace(storeFixture, owner, "tasks-second"),
      });
      const stranger = await someoneElse(storeFixture, owner, "tasks-stranger");
      const colleague = await addMember(owner, "Colleague");
      const helper = await emptyThread(storeFixture, owner, { suffix: "tasks-helper" });
      await database
        .updateTable("threads")
        .set({ listed: false })
        .where("id", "=", helper)
        .executeTakeFirstOrThrow();
      const archived = await emptyThread(storeFixture, owner, { suffix: "tasks-archived" });
      await database
        .updateTable("threads")
        .set({ status: "archived" })
        .where("id", "=", archived)
        .executeTakeFirstOrThrow();
      const deletedWorkspace = await anotherWorkspace(storeFixture, owner, "tasks-deleted");
      const inDeleted = await emptyThread(storeFixture, owner, {
        suffix: "tasks-in-deleted",
        workspaceId: deletedWorkspace,
      });
      await database
        .updateTable("workspaces")
        .set({ deletedAt: new Date(), status: "deleted" })
        .where("id", "=", deletedWorkspace)
        .executeTakeFirstOrThrow();

      const ownerPage = await tasksOf(storeFixture, owner.ownerId);
      expect(new Set(ownerPage.tasks.map(({ thread }) => thread.id))).toEqual(
        new Set([owner.threadId, second.threadId]),
      );
      expect(ownerPage.window).toMatchObject({ hasMore: false, itemCount: 2, totalItems: 2 });
      expect(ownerPage.tasks.map(({ thread }) => thread.id)).not.toContain(stranger.threadId);
      expect(ownerPage.tasks.map(({ thread }) => thread.id)).not.toContain(helper);
      expect(ownerPage.tasks.map(({ thread }) => thread.id)).not.toContain(archived);
      expect(ownerPage.tasks.map(({ thread }) => thread.id)).not.toContain(inDeleted);
      // The colleague belongs to the owner's first Workspace only.
      expect((await tasksOf(storeFixture, colleague)).tasks.map(({ thread }) => thread.id)).toEqual(
        [owner.threadId],
      );
      expect(
        (await tasksOf(storeFixture, stranger.userId)).tasks.map(({ thread }) => thread.id),
      ).toEqual([stranger.threadId]);

      await database
        .updateTable("workspaceMemberships")
        .set({ revokedAt: new Date(), revokedBy: owner.ownerId, state: "revoked" })
        .where("userId", "=", colleague)
        .execute();
      expect(await tasksOf(storeFixture, colleague)).toMatchObject({
        readStates: [],
        tasks: [],
        window: { hasMore: false, itemCount: 0, totalItems: 0 },
      });

      await database
        .updateTable("users")
        .set({ disabledAt: new Date() })
        .where("id", "=", owner.ownerId)
        .execute();
      expect(await tasksOf(storeFixture, owner.ownerId)).toMatchObject({
        tasks: [],
        window: { totalItems: 0 },
      });
    });

    it("pages across Workspaces newest first without skipping or repeating a Thread", async ({
      storeFixture,
    }) => {
      const { createFixture, store } = storeFixture;
      const owner = await createFixture("tasks-order");
      const elsewhere = await anotherWorkspace(storeFixture, owner, "tasks-order-elsewhere");
      const threads = [
        owner.threadId,
        await emptyThread(storeFixture, owner, { suffix: "tasks-order-1" }),
        await emptyThread(storeFixture, owner, { suffix: "tasks-order-2", workspaceId: elsewhere }),
        await emptyThread(storeFixture, owner, { suffix: "tasks-order-3" }),
        await emptyThread(storeFixture, owner, { suffix: "tasks-order-4", workspaceId: elsewhere }),
        await emptyThread(storeFixture, owner, { suffix: "tasks-order-5", workspaceId: elsewhere }),
        await emptyThread(storeFixture, owner, { suffix: "tasks-order-6" }),
      ];
      // Two exact ties in different Workspaces, two updates a few microseconds
      // apart within one millisecond, and distinct times around them.
      const times = [
        "2026-01-01T00:00:06.000Z",
        "2026-01-01T00:00:05.000Z",
        "2026-01-01T00:00:05.000Z",
        "2026-01-01T00:00:04.000100Z",
        "2026-01-01T00:00:04.000900Z",
        "2026-01-01T00:00:03.000Z",
        "2026-01-01T00:00:02.000Z",
      ];
      for (const [index, threadId] of threads.entries()) {
        await setUpdatedAt(storeFixture, threadId, times[index]!);
      }

      const whole = await tasksOf(storeFixture, owner.ownerId);
      const order = whole.tasks.map(({ thread }) => thread.id);
      expect(new Set(order)).toEqual(new Set(threads));
      expect(order[0]).toBe(owner.threadId);
      const stamps = whole.tasks.map(({ thread }) => Date.parse(thread.updatedAt));
      expect(stamps).toEqual([...stamps].sort((left, right) => right - left));

      for (const maxItems of [1, 2, 3]) {
        const seen: ThreadId[] = [];
        let before: string | undefined;
        for (let pages = 0; pages < threads.length + 1; pages += 1) {
          const page = await tasksOf(storeFixture, owner.ownerId, {
            maxItems,
            ...(before ? { before } : {}),
          });
          seen.push(...page.tasks.map(({ thread }) => thread.id));
          expect(page.window.totalItems).toBe(threads.length);
          expect(page.readStates.map(({ threadId }) => threadId)).toEqual(
            page.tasks.map(({ thread }) => thread.id),
          );
          if (!page.window.hasMore) break;
          expect(page.window.nextBefore).not.toBeNull();
          before = page.window.nextBefore ?? undefined;
        }
        expect(seen).toEqual(order);
      }

      // A page cut by bytes says so and continues from where it was cut.
      const firstBytes = Buffer.byteLength(JSON.stringify(whole.tasks[0]), "utf8") + 2;
      const cut = await tasksOf(storeFixture, owner.ownerId, { maxBytes: firstBytes });
      expect(cut.tasks.map(({ thread }) => thread.id)).toEqual([order[0]]);
      expect(cut.window).toMatchObject({ byteCount: firstBytes, hasMore: true, itemCount: 1 });
      if (!cut.window.nextBefore) throw new Error("Expected a cursor after a cut page");
      const next = await tasksOf(storeFixture, owner.ownerId, {
        before: cut.window.nextBefore,
        maxItems: 1,
      });
      expect(next.tasks.map(({ thread }) => thread.id)).toEqual([order[1]]);

      // A cursor is the reader's own, and only for this list.
      const stranger = await store.createUser("Stranger");
      await expect(
        store.taskPageForUser({ before: cut.window.nextBefore, userId: stranger }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(
        store.taskPageForUser({
          before: encodeWindowCursor(
            "thread",
            owner.workspaceId,
            whole.tasks[0]!.thread.updatedAt,
            order[0]!,
          ),
          userId: owner.ownerId,
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
    });

    it("lists one Workspace's tasks for a member, paged within it", async ({ storeFixture }) => {
      const { createFixture, database, store, addMember } = storeFixture;
      const owner = await createFixture("tasks-scope");
      const research = await anotherWorkspace(storeFixture, owner, "tasks-scope-research");
      const inResearch = [
        await emptyThread(storeFixture, owner, { suffix: "tasks-scope-1", workspaceId: research }),
        await emptyThread(storeFixture, owner, { suffix: "tasks-scope-2", workspaceId: research }),
        await emptyThread(storeFixture, owner, { suffix: "tasks-scope-3", workspaceId: research }),
      ];
      const archived = await emptyThread(storeFixture, owner, {
        suffix: "tasks-scope-archived",
        workspaceId: research,
      });
      await database
        .updateTable("threads")
        .set({ status: "archived" })
        .where("id", "=", archived)
        .executeTakeFirstOrThrow();

      const whole = await tasksOf(storeFixture, owner.ownerId, { workspaceId: research });
      expect(new Set(whole.tasks.map(({ thread }) => thread.id))).toEqual(new Set(inResearch));
      expect(whole.tasks.every(({ thread }) => thread.workspaceId === research)).toBe(true);
      expect(whole.window).toMatchObject({ hasMore: false, totalItems: 3 });
      expect(whole.readStates.map(({ threadId }) => threadId)).toEqual(
        whole.tasks.map(({ thread }) => thread.id),
      );

      const first = await tasksOf(storeFixture, owner.ownerId, {
        maxItems: 2,
        workspaceId: research,
      });
      if (!first.window.nextBefore) throw new Error("Expected a cursor within the Workspace");
      const second = await tasksOf(storeFixture, owner.ownerId, {
        before: first.window.nextBefore,
        maxItems: 2,
        workspaceId: research,
      });
      expect([...first.tasks, ...second.tasks].map(({ thread }) => thread.id)).toEqual(
        whole.tasks.map(({ thread }) => thread.id),
      );
      expect(second.window.hasMore).toBe(false);

      // A cursor continues only the list it came from.
      const global = await tasksOf(storeFixture, owner.ownerId, { maxItems: 1 });
      if (!global.window.nextBefore) throw new Error("Expected a cursor across Workspaces");
      await expect(
        store.taskPageForUser({
          before: global.window.nextBefore,
          userId: owner.ownerId,
          workspaceId: research,
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(
        store.taskPageForUser({ before: first.window.nextBefore, userId: owner.ownerId }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(
        store.taskPageForUser({
          before: first.window.nextBefore,
          userId: owner.ownerId,
          workspaceId: owner.workspaceId,
        }),
      ).rejects.toMatchObject({ code: "bad_request" });

      // Only an active, enabled member of a Workspace that still exists may read it.
      const stranger = await someoneElse(storeFixture, owner, "tasks-scope-stranger");
      await expect(
        store.taskPageForUser({ userId: stranger.userId, workspaceId: research }),
      ).rejects.toMatchObject({ code: "not_found" });
      const colleague = await addMember(owner, "Colleague");
      expect(
        (await tasksOf(storeFixture, colleague, { workspaceId: owner.workspaceId })).tasks.map(
          ({ thread }) => thread.id,
        ),
      ).toEqual([owner.threadId]);
      await database
        .updateTable("workspaceMemberships")
        .set({ revokedAt: new Date(), revokedBy: owner.ownerId, state: "revoked" })
        .where("userId", "=", colleague)
        .execute();
      await expect(
        store.taskPageForUser({ userId: colleague, workspaceId: owner.workspaceId }),
      ).rejects.toMatchObject({ code: "not_found" });
      await database
        .updateTable("workspaces")
        .set({ deletedAt: new Date(), status: "deleted" })
        .where("id", "=", research)
        .executeTakeFirstOrThrow();
      await expect(
        store.taskPageForUser({ userId: owner.ownerId, workspaceId: research }),
      ).rejects.toMatchObject({ code: "not_found" });
      await database
        .updateTable("users")
        .set({ disabledAt: new Date() })
        .where("id", "=", owner.ownerId)
        .execute();
      await expect(
        store.taskPageForUser({ userId: owner.ownerId, workspaceId: owner.workspaceId }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

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
        source: { kind: "human" },
        threadId: fixture.threadId,
      });
      await database
        .updateTable("threadInputs")
        .set({ deliveredAt: new Date(), runId: fixture.runId, state: "delivered" })
        .where("messageId", "=", followUp.message.id)
        .executeTakeFirstOrThrow();
      // Nor is an assistant message that says nothing, or one taken back before
      // anyone saw it.
      await appendReply(fixture, text("   \n  "));
      const withdrawn = await appendReply(fixture, text("A draft nobody saw"));
      await sql`
        insert into public.thread_inputs (
          actor_principal_id, authority_source, cancel_reason, causal_chain_id, delivered_at,
          idempotency_key, membership_generation, message_id, policy, queue_rank, reply_target,
          request_fingerprint, requested_by, run_id, state, steer_command_id, thread_id, updated_at)
        select actor_principal_id, authority_source, 'withdrawn', causal_chain_id, null,
          ${`withdrawn-${withdrawn.id}`}, membership_generation, ${withdrawn.id}, 'queue',
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
        { artifactId: "report", mediaType: "text/markdown", name: "report.md", type: "artifact" },
      ]);
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).lastReply,
      ).toBeNull();

      // Its first words, when it has several parts.
      await appendReply(fixture, [
        { artifactId: "chart", mediaType: "image/png", name: "chart.png", type: "artifact" },
        { text: "  ", type: "text" },
        { text: "Here is the chart.", type: "text" },
        { text: "And a second part.", type: "text" },
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
      await endRun(storeFixture, retry, { status: "completed" });
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure,
      ).toBeNull();

      const again = await laterRun(storeFixture, retry);
      await endRun(storeFixture, again, { failure: "x".repeat(20_000), status: "failed" });
      const long = entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure;
      expect(long?.length).toBeLessThanOrEqual(taskLineMaxLength);
      expect(long?.endsWith("…")).toBe(true);

      const blank = await laterRun(storeFixture, again);
      await endRun(storeFixture, blank, { failure: "", status: "failed" });
      expect(
        entryOf(await tasksOf(storeFixture, fixture.ownerId), fixture.threadId).failure,
      ).toBeNull();
    });
  });

  it("shared Done leaves each member's read position untouched", async ({ storeFixture }) => {
    const { createFixture, appendReply, text, notificationState, store } = storeFixture;
    const fixture = await createFixture("shared-done-read-state");
    const reply = await appendReply(fixture, text("Finished"));
    const before = await notificationState.getReadState({
      threadId: fixture.threadId,
      userId: fixture.ownerId,
    });
    await store.setThreadDone({
      done: true,
      threadId: fixture.threadId,
      requestedBy: fixture.ownerId,
      idempotencyKey: "shared-done-read-state",
    });
    const after = await notificationState.getReadState({
      threadId: fixture.threadId,
      userId: fixture.ownerId,
    });
    expect(after.readSequence).toBe(before.readSequence);
    expect(after.unreadSequence).toBe(reply.sequence);
    expect(after.placement).toEqual(
      after.readSequence === null ? null : { done: false, sequence: after.readSequence },
    );
    expect(after.placementRevision).toBe(after.asOfSequence);
    expect(
      (await store.getThreadForOwner(fixture.threadId, fixture.ownerId))?.doneAt,
    ).not.toBeNull();
  });
});
