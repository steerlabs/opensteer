import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  PendingRequestSchema,
  ThreadAccessModeSchema,
  createId,
  type AgentEventView as AgentEvent,
  type ContentPart,
  type EnvironmentId,
  type MessageId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  runExecuteInputsMax,
  type PendingAgentEvent,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { beforeAll, describe, expect, it as baseIt } from "vitest";
import { AttachmentStore } from "./attachment-store.js";
import { createDatabase, OpensteerStore } from "./index.js";
import { jsonValue } from "./store-primitives.js";

/**
 * A person's message in their conversation contributes to the reply under way
 * instead of waiting for it to finish; every other sender and every work
 * Thread keep their queue. Each scenario leaves a receipt of the inputs,
 * commands, Runs, attempts and Host events it produced.
 */
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const evidenceRoot =
  process.env.OPENSTEER_CONVERSATION_DELIVERY_OUTPUT ??
  join(tmpdir(), "opensteer-conversation-delivery", randomUUID());
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
const continuationIdentity = {
  continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
  driverKind: HarnessIdSchema.parse("native"),
} as const;

interface FixtureOptions {
  /** `false` is an engine that can only take a message by restarting its attempt. */
  readonly steering?: boolean;
  readonly role?: "conversation" | "work";
  readonly collaborator?: boolean;
  /** `false` is a Runner from before `steer-answer-v1`. */
  readonly steerAnswer?: boolean;
  /** Whether the engine takes images mid-turn; absent, the engine takes no files. */
  readonly imageSteering?: boolean;
}

integration.sequential("conversation delivery", () => {
  async function createTestFixture() {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-conversation-delivery-test",
        connectionString: databaseUrl,
        maxConnections: 6,
      });
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const attachments = new AttachmentStore(database);
    async function fixture(suffix: string, options: FixtureOptions = {}) {
      if (!(await store.getDeployment()))
        await store.ensureDeployment({
          canonicalOrigin: "https://test-host.invalid",
          deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
          hostInstanceId: createId("hostInstance"),
        });
      const ownerId = await store.createUser("Owner");
      const runnerId = createId("runner");
      const environmentId = createId("environment");
      const runnerBootId = `rbt_${randomUUID()}` as RunnerDescriptor["bootId"];
      const descriptor = await enrollRunner({
        bootId: runnerBootId,
        environmentId,
        imageSteering: options.imageSteering,
        runnerId,
        steerAnswer: options.steerAnswer ?? true,
        steering: options.steering ?? true,
        suffix,
        userId: ownerId,
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
        createdBy: ownerId,
        idempotencyKey: `workspace-${suffix}`,
        name: `Workspace ${suffix}`,
        status: "ready",
      });
      const harness = await store.createHarnessInstance({
        config: { model: "test" },
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Native",
        stateKind: "isolated",
      });
      await store.recordHarnessCatalogs({
        catalogs: [
          HarnessInstanceCatalogSchema.parse({
            continuationIdentity,
            driverKind: "native",
            harnessInstanceId: harness.id,
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
        environmentId,
        expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
      });
      let collaboratorId: UserId | null = null;
      if (options.collaborator) {
        collaboratorId = await store.createUser("Collaborator");
        const invitation = await store.createWorkspaceInvitation({
          createdBy: ownerId,
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: `invite-${suffix}`,
          intendedEmail: null,
          requestFingerprint: `sha256:invite-${suffix}`,
          role: "collaborator",
          selector: `selector-${suffix}`,
          tokenHash: `sha256:token-${suffix}`,
          type: "link",
          workspaceId: workspace.id,
        });
        await store.acceptWorkspaceInvitation({
          selector: invitation.selector,
          tokenHash: `sha256:token-${suffix}`,
          userEmail: `${suffix}@test.invalid`,
          userEmailVerified: true,
          userId: collaboratorId,
        });
      }
      const role = options.role ?? "conversation";
      const { thread } = await store.createThread({
        createdBy: ownerId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: `thread-${suffix}`,
        modelSelection,
        // Chat itself; a shared conversation stands in for another person's view.
        ...(role === "conversation" && !options.collaborator ? { home: true } : { role }),
        title: `Thread ${suffix}`,
        workspaceId: workspace.id,
      });
      expect(thread.role).toBe(role);
      return {
        collaboratorId,
        descriptor,
        environmentId,
        harness,
        ownerId,
        runnerBootId,
        runnerId,
        suffix,
        thread,
        workspace,
      };
    }
    function text(value: string): ContentPart[] {
      return [{ text: value, type: "text" }];
    }
    async function send(f: Fixture, key: string, options: { readonly by?: UserId } = {}) {
      return store.enqueueThreadInput({
        content: text(`Message ${key}`),
        idempotencyKey: key,
        policy: "queue",
        requestedBy: options.by ?? f.ownerId,
        source: { kind: "human" },
        threadId: f.thread.id,
      });
    }
    async function sendImage(f: Fixture, key: string) {
      const reserved = await attachments.reserve({
        idempotencyKey: `upload-${key}`,
        mediaType: "image/png",
        name: `${key}.png`,
        sizeBytes: 4,
        uploaderId: f.ownerId,
        workspaceId: f.workspace.id,
      });
      await attachments.complete({
        attachmentId: reserved.id,
        install: async () => undefined,
        kind: "image",
        sha256: createHash("sha256").update(key).digest("hex"),
        uploaderId: f.ownerId,
      });
      return store.enqueueThreadInput({
        content: [
          {
            artifactId: reserved.id,
            mediaType: "image/png",
            name: `${key}.png`,
            sizeBytes: 4,
            type: "artifact",
          },
        ],
        idempotencyKey: key,
        policy: "queue",
        requestedBy: f.ownerId,
        source: { kind: "human" },
        threadId: f.thread.id,
      });
    }
    async function finish(f: Fixture, runId: RunId) {
      await emit(f, runId, "assistant.message", {
        content: text("Answered."),
        messageId: createId("message"),
      });
      await emit(f, runId, "run.completed", { status: "completed" });
    }
    async function nextFrame(f: Fixture) {
      const queued = (await runsOf(f)).filter(({ status }) => status === "queued");
      expect(queued).toHaveLength(1);
      const { claimed } = await claimAndBind(f, queued[0]!.id);
      const context = await store.loadRunDispatchContext(claimed.command.id);
      return { inputs: context.inputs.map(({ id }) => id), runId: queued[0]!.id };
    }
    async function handOffs(runId: RunId) {
      return database
        .selectFrom("commands")
        .select(["createdAt", "id", "idempotencyKey", "payload", "status", "type"])
        .where("runId", "=", runId)
        .where("type", "in", ["run.steer", "run.restart"])
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc")
        .execute();
    }
    async function pendingInputs(f: Fixture) {
      return database
        .selectFrom("threadInputs")
        .select("messageId")
        .where("threadId", "=", f.thread.id)
        .where("state", "=", "pending")
        .orderBy("queueRank", "asc")
        .execute();
    }
    async function platformInput(f: Fixture, key: string, sourceRunId: RunId) {
      return store.enqueueThreadInput({
        content: text(`Platform ${key}`),
        idempotencyKey: key,
        policy: "queue",
        requestedBy: f.ownerId,
        source: {
          cause: "request-resolved",
          kind: "platform",
          referenceId: `req_${key}`,
          sourceRunId,
        },
        threadId: f.thread.id,
      });
    }
    async function runRow(runId: RunId) {
      return database
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
    }
    async function executeCommand(runId: RunId) {
      return database
        .selectFrom("commands")
        .selectAll()
        .where("runId", "=", runId)
        .where("type", "=", "run.execute")
        .where("status", "=", "pending")
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow();
    }
    async function claimAndBind(f: Fixture, runId: RunId) {
      const command = await executeCommand(runId);
      const claimed = await store.claimCommand(command.id, `${f.suffix}-dispatcher`);
      if (!claimed) throw new Error("The Run's execute was not claimable");
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity,
        harnessInstanceId: f.harness.id,
        leaseTokenHash: `${f.suffix}-lease-${randomUUID()}`,
        membershipGeneration: 1,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
        runId,
        threadId: f.thread.id,
      });
      return { binding: binding.bindingGeneration, claimed };
    }
    async function emit(
      f: Fixture,
      runId: RunId,
      type: PendingAgentEvent["type"],
      data: unknown,
      bindingGeneration?: number,
    ) {
      const run = await runRow(runId);
      const generation = bindingGeneration ?? run.bindingGeneration;
      if (generation === null) throw new Error("The Run has no binding to report from");
      const committed = await store.commitRunnerEvent({
        environmentId: f.environmentId,
        event: {
          bindingGeneration: generation,
          data,
          emittedAt: new Date().toISOString(),
          environmentId: f.environmentId,
          ordinal: run.nextRunnerOrdinal,
          runId,
          threadId: f.thread.id,
          type,
          workspaceId: f.workspace.id,
        } as PendingAgentEvent,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      });
      if (
        [
          "run.started",
          "run.status",
          "run.restarted",
          "run.phase",
          "run.completed",
          "run.failed",
          "run.interrupted",
        ].includes(type) &&
        !committed.wasDuplicate
      ) {
        const seed = await database
          .selectFrom("messages")
          .select("author")
          .where("id", "=", run.seedInputId)
          .executeTakeFirstOrThrow();
        expect(committed.event.data).toMatchObject({ startedBy: seed.author });
      }
      return committed;
    }
    async function start(f: Fixture, runId: RunId) {
      const bound = await claimAndBind(f, runId);
      const started = await emit(f, runId, "run.started", { status: "running" }, bound.binding);
      await bindSession(f, runId, bound.binding);
      return { ...bound, started };
    }
    async function bindSession(f: Fixture, runId: RunId, bindingGeneration: number) {
      const { providerSessionId } = await runRow(runId);
      if (!providerSessionId) throw new Error("The Run has no provider session");
      await store.bindProviderSession({
        bindingGeneration,
        harnessInstanceId: f.harness.id,
        providerSessionId,
        providerSessionReference: `native-session-${f.thread.id}`,
        runId,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
        threadId: f.thread.id,
      });
    }
    async function running(f: Fixture, key = "first") {
      const first = await send(f, key);
      if (!first.run) throw new Error("Expected the first message to start a Run");
      await start(f, first.run.id);
      return first.run.id;
    }
    async function input(messageId: MessageId) {
      return database
        .selectFrom("threadInputs")
        .selectAll()
        .where("messageId", "=", messageId)
        .executeTakeFirstOrThrow();
    }
    async function steerCommand(messageId: MessageId) {
      const row = await input(messageId);
      if (!row.steerCommandId) throw new Error(`${messageId} was not handed to a Run`);
      return database
        .selectFrom("commands")
        .selectAll()
        .where("id", "=", row.steerCommandId)
        .executeTakeFirstOrThrow();
    }
    async function runsOf(f: Fixture) {
      return database
        .selectFrom("runs")
        .select(["id", "status", "seedInputId", "runOrdinal"])
        .where("threadId", "=", f.thread.id)
        .orderBy("runOrdinal", "asc")
        .execute();
    }
    async function thread(f: Fixture) {
      return database
        .selectFrom("threads")
        .select(["inputQueuePaused", "status"])
        .where("id", "=", f.thread.id)
        .executeTakeFirstOrThrow();
    }
    async function stop(f: Fixture, runId: RunId, key: string, by?: UserId) {
      return store.enqueueRunnerControl({
        idempotencyKey: key,
        requestedBy: by ?? f.ownerId,
        runId,
        threadId: f.thread.id,
        type: "run.interrupt",
      });
    }
    async function openApproval(f: Fixture, runId: RunId) {
      const request = PendingRequestSchema.parse({
        callId: createId("request"),
        cancellationReason: null,
        createdAt: new Date().toISOString(),
        id: createId("request"),
        kind: "harness.input",
        mode: "live",
        originatingOccurrenceId: null,
        originatingRunId: runId,
        originatingThreadId: f.thread.id,
        originatingWorkspaceId: f.workspace.id,
        payload: { kind: "harness.input" },
        presentation: {
          detail: "Send the drafted email?",
          kind: "choice",
          options: [
            { hint: "confirm", id: "send", label: "Send" },
            { hint: "reject-once", id: "decline", label: "Not now" },
          ],
          title: "Send email",
        },
        requestedBy: f.ownerId,
        requiredActor: "requester",
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
        targetWorkspaceId: f.workspace.id,
      });
      await emit(f, runId, "request.opened", { request });
      return request;
    }
    async function answer(f: Fixture, runId: RunId, requestId: string, key: string) {
      const response = await store.enqueueRunnerControl({
        idempotencyKey: key,
        requestedBy: f.ownerId,
        requestId: requestId as never,
        response: { kind: "choice", optionId: "send" },
        runId,
        sealedResponse: {
          envelope: Buffer.from("encrypted-test-action-response"),
          keyVersion: 1,
          requestFingerprint: `hmac-sha256-v1:1:${key}`,
        },
        threadId: f.thread.id,
        type: "request.respond",
      });
      const claimed = await store.claimCommand(response.command.id, `${f.suffix}-answers`);
      if (!claimed) throw new Error("The answer was not claimable");
      return store.dispatchRequestResponse(response.command.id, async (beforeAck) => {
        await beforeAck();
      });
    }
    async function receipt(name: string, f: Fixture, extra: Record<string, unknown> = {}) {
      const [inputs, commands, runs, attempts, messages, page] = await Promise.all([
        database
          .selectFrom("threadInputs")
          .select([
            "messageId",
            "policy",
            "state",
            "cancelReason",
            "runId",
            "steerCommandId",
            "queueRank",
          ])
          .where("threadId", "=", f.thread.id)
          .orderBy("queueRank", "asc")
          .execute(),
        database
          .selectFrom("commands")
          .select(["id", "type", "status", "idempotencyKey", "runId", "createdAt"])
          .where("threadId", "=", f.thread.id)
          .orderBy("createdAt", "asc")
          .orderBy("id", "asc")
          .execute(),
        database
          .selectFrom("runs")
          .select(["id", "status", "seedInputId", "runOrdinal", "phase"])
          .where("threadId", "=", f.thread.id)
          .orderBy("runOrdinal", "asc")
          .execute(),
        database
          .selectFrom("runAttempts")
          .innerJoin("runs", "runs.id", "runAttempts.runId")
          .select([
            "runAttempts.runId",
            "runAttempts.ordinal",
            "runAttempts.reason",
            "runAttempts.status",
            "runAttempts.outcome",
          ])
          .where("runs.threadId", "=", f.thread.id)
          .orderBy("runAttempts.runId", "asc")
          .orderBy("runAttempts.ordinal", "asc")
          .execute(),
        database
          .selectFrom("messages")
          .select(["id", "sequence", "runId", "kind"])
          .where("threadId", "=", f.thread.id)
          .orderBy("sequence", "asc")
          .execute(),
        store.threadEventPageForOwner({ ownerId: f.ownerId, threadId: f.thread.id }),
      ]);
      await writeFile(
        join(evidenceRoot, `${name}.json`),
        JSON.stringify(
          {
            scenario: name,
            threadRole: f.thread.role,
            inputs,
            commands,
            runs,
            attempts,
            messages,
            events: (page?.events ?? []).map(summarizeEvent),
            ...extra,
          },
          null,
          2,
        ),
      );
    }
    async function enrollRunner(input: {
      readonly bootId: RunnerDescriptor["bootId"];
      readonly environmentId: EnvironmentId;
      readonly imageSteering: boolean | undefined;
      readonly runnerId: RunnerId;
      readonly steerAnswer: boolean;
      readonly steering: boolean;
      readonly suffix: string;
      readonly userId: UserId;
    }): Promise<RunnerDescriptor> {
      const pair = generateKeyPairSync("ed25519");
      const descriptor: RunnerDescriptor = {
        bootId: input.bootId,
        capabilities: [
          "filesystem",
          ...(input.steering ? [] : ["attempts-v1" as const]),
          ...(input.steerAnswer ? ["steer-answer-v1" as const] : []),
        ],
        name: "Main runner",
        runnerId: input.runnerId,
        runnerKind: "main",
        runtimeVersion: "test",
        modules: {
          agents: {
            environmentIds: [input.environmentId],
            harnessDrivers: [
              {
                accessModes: ThreadAccessModeSchema.options,
                driverKind: HarnessIdSchema.parse("native"),
                readiness: "configured",
                steering: input.steering,
                ...(input.imageSteering === undefined
                  ? {}
                  : {
                      messageAttachments: {
                        nativeImages: {
                          maxBytes: 10_000_000,
                          maxPixels: 40_000_000,
                          mediaTypes: ["image/png"],
                          steering: input.imageSteering,
                        },
                      },
                    }),
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
      };
      const tokenHash = `sha256:${createHash("sha256").update(input.suffix).digest("base64url")}`;
      await store.createRunnerEnrollment({
        allowedModules: ["agents"],
        createdBy: input.userId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `runner-${input.suffix}`,
        mainEnrollmentPurpose: "initial",
        name: descriptor.name,
        requestFingerprint: `sha256:${input.suffix}`,
        runnerKind: "main",
        tokenHash,
      });
      await store.enrollRunnerConnection({
        descriptor,
        enrollmentTokenHash: tokenHash,
        publicKeyFingerprint: `sha256:${createHash("sha256")
          .update(pair.publicKey.export({ format: "der", type: "spki" }))
          .digest("base64url")}`,
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      });
      return descriptor;
    }

    return Object.freeze({
      database,
      store,
      attachments,
      fixture,
      text,
      send,
      sendImage,
      finish,
      nextFrame,
      handOffs,
      pendingInputs,
      platformInput,
      runRow,
      executeCommand,
      claimAndBind,
      emit,
      start,
      bindSession,
      running,
      input,
      steerCommand,
      runsOf,
      thread,
      stop,
      openApproval,
      answer,
      receipt,
      enrollRunner,
      databaseUrl,
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

  beforeAll(async () => {
    await mkdir(evidenceRoot, { recursive: true });
    console.info(`Conversation delivery receipts: ${evidenceRoot}`);
  });

  type Fixture = Awaited<ReturnType<StoreFixture["fixture"]>>;

  /** The person sends a picture, uploaded the way a client does. */

  /** The reply answers and its Run completes. */

  /** Dispatches the Thread's queued Run and returns what its `run.execute` carries, in order. */

  /** A task's result or a Request continuation: work the platform queues to the conversation. */

  /** Claims the Run's pending execute (its first dispatch), then binds it. */

  /** As an engine does once it holds a native session, so the next Run continues it. */

  /** The person's first message in an idle conversation, started and running. */

  /** The person answers on the approval card and the Runner accepts it. */

  it("joins a person's message into the reply under way, once, without a second Run", async ({
    storeFixture,
  }) => {
    const { fixture, running, send, steerCommand, database, store, emit, input, runsOf, receipt } =
      storeFixture;
    const f = await fixture("native-join");
    const runId = await running(f);
    const follow = await send(f, "also-include-x");
    expect(follow).toMatchObject({
      disposition: "steering",
      input: { policy: "queue", runId, state: "claimed" },
      message: { runId },
      run: { id: runId },
      wasDuplicate: false,
    });
    const command = await steerCommand(follow.message.id);
    expect(command).toMatchObject({ runId, status: "pending", type: "run.steer" });
    // A retried Send replays the same message and the same hand-off.
    const replay = await send(f, "also-include-x");
    expect(replay).toMatchObject({ disposition: "steering", wasDuplicate: true });
    expect(replay.command?.id).toBe(command.id);
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("type", "=", "run.steer")
        .where("runId", "=", runId)
        .execute(),
    ).toHaveLength(1);
    // Nothing waits in the queue: the person's message is already the Run's.
    expect(
      (await store.getThreadInputQueue({ requestedBy: f.ownerId, threadId: f.thread.id })).items,
    ).toEqual([]);
    await store.claimCommand(command.id, "native-join-steer");
    await emit(f, runId, "message.injected", { messageId: follow.message.id });
    expect(await input(follow.message.id)).toMatchObject({ runId, state: "delivered" });
    expect(await runsOf(f)).toHaveLength(1);
    await receipt("native-join", f);
  });

  it("restarts a restart-only engine's reply to take the follow-up in the same Run", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      running,
      runRow,
      send,
      steerCommand,
      emit,
      executeCommand,
      store,
      input,
      runsOf,
      receipt,
    } = storeFixture;
    const f = await fixture("restart-join", { steering: false });
    const runId = await running(f);
    const firstBinding = (await runRow(runId)).bindingGeneration!;
    const follow = await send(f, "restart-follow-up");
    expect(follow).toMatchObject({
      disposition: "steering",
      input: { runId, state: "claimed" },
      run: { id: runId },
    });
    expect(follow.revokedGrants).toHaveLength(1);
    expect((await steerCommand(follow.message.id)).type).toBe("run.restart");
    // A second message while the replacement waits joins the same restart.
    const second = await send(f, "restart-follow-up-2");
    expect(second).toMatchObject({ disposition: "steering", input: { runId, state: "claimed" } });
    expect(second.revokedGrants).toEqual([]);
    // The interrupted attempt ends; the Run goes back to its queue and its
    // replacement starts with exactly the two follow-ups.
    await emit(f, runId, "run.interrupted", { status: "interrupted" }, firstBinding);
    expect((await runRow(runId)).status).toBe("queued");
    const replacement = await executeCommand(runId);
    const claimed = await store.claimCommand(replacement.id, "restart-join-dispatcher");
    if (!claimed) throw new Error("Expected the replacement to be claimable");
    const context = await store.loadRunDispatchContext(replacement.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([follow.message.id, second.message.id]);
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity,
      harnessInstanceId: f.harness.id,
      leaseTokenHash: "restart-join-lease-2",
      membershipGeneration: 1,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      runId,
      threadId: f.thread.id,
    });
    await emit(f, runId, "run.started", { status: "running" }, binding.bindingGeneration);
    expect(await input(follow.message.id)).toMatchObject({ runId, state: "delivered" });
    expect(await input(second.message.id)).toMatchObject({ runId, state: "delivered" });
    expect(await runsOf(f)).toHaveLength(1);
    await receipt("restart-join", f);
  });

  it("gives a burst sent before the reply starts to its first turn, in order", async ({
    storeFixture,
  }) => {
    const { fixture, send, claimAndBind, store, emit, input, runsOf, receipt } = storeFixture;
    const f = await fixture("burst");
    const first = await send(f, "burst-a");
    const runId = first.run!.id;
    const b = await send(f, "burst-b");
    const c = await send(f, "burst-c");
    expect(b).toMatchObject({ disposition: "pending", run: null });
    expect(c).toMatchObject({ disposition: "pending", run: null });
    const { claimed } = await claimAndBind(f, runId);
    const placed = claimed.events
      .filter((event) => event.type === "message.placed")
      .map((event) => (event.data as { message: { id: MessageId } }).message.id);
    expect(placed).toEqual([b.message.id, c.message.id]);
    const context = await store.loadRunDispatchContext(claimed.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([
      first.message.id,
      b.message.id,
      c.message.id,
    ]);
    await emit(f, runId, "run.started", { status: "running" });
    for (const id of [first.message.id, b.message.id, c.message.id])
      expect(await input(id)).toMatchObject({ runId, state: "delivered" });
    expect(await runsOf(f)).toHaveLength(1);
    await receipt("burst-first-turn", f);
  });

  it("keeps a work Thread's queue: one message per turn and no automatic hand-off", async ({
    storeFixture,
  }) => {
    const { fixture, send, claimAndBind, store, emit, input, stop, thread, receipt } = storeFixture;
    const f = await fixture("work-queue", { role: "work" });
    const first = await send(f, "work-a");
    const runId = first.run!.id;
    const queued = await send(f, "work-b");
    const { claimed } = await claimAndBind(f, runId);
    const context = await store.loadRunDispatchContext(claimed.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([first.message.id]);
    await emit(f, runId, "run.started", { status: "running" });
    expect(await input(queued.message.id)).toMatchObject({ runId: null, state: "pending" });
    const later = await send(f, "work-c");
    expect(later).toMatchObject({ disposition: "pending", run: null });
    const view = await store.getThreadInputQueue({ requestedBy: f.ownerId, threadId: f.thread.id });
    expect(view.items.map(({ canSteer, message }) => ({ canSteer, id: message.id }))).toEqual([
      { canSteer: true, id: queued.message.id },
      { canSteer: true, id: later.message.id },
    ]);
    const stopped = await stop(f, runId, "work-stop");
    expect(stopped.events.some((event) => event.type === "thread.input-queue-updated")).toBe(true);
    expect((await thread(f)).inputQueuePaused).toBe(true);
    await receipt("work-queue-unchanged", f);
  });

  it("hands follow-ups sent while the reply starts to it when the engine starts, in order", async ({
    storeFixture,
  }) => {
    const { fixture, send, claimAndBind, emit, steerCommand, store, receipt } = storeFixture;
    const f = await fixture("starting");
    const first = await send(f, "starting-a");
    const runId = first.run!.id;
    const bound = await claimAndBind(f, runId);
    const b = await send(f, "starting-b");
    const c = await send(f, "starting-c");
    expect(b).toMatchObject({ disposition: "pending" });
    expect(c).toMatchObject({ disposition: "pending" });
    await emit(f, runId, "run.started", { status: "running" }, bound.binding);
    const [bCommand, cCommand] = [
      await steerCommand(b.message.id),
      await steerCommand(c.message.id),
    ];
    expect([bCommand.type, cCommand.type]).toEqual(["run.steer", "run.steer"]);
    // Commands dispatch in creation order and their ids are random.
    expect(bCommand.createdAt.getTime()).toBeLessThan(cCommand.createdAt.getTime());
    const next = await store.claimNextCommand(f.environmentId, "starting-dispatcher");
    expect(next?.command.id).toBe(bCommand.id);
    await emit(f, runId, "message.injected", { messageId: b.message.id });
    expect((await store.claimNextCommand(f.environmentId, "starting-dispatcher"))?.command.id).toBe(
      cCommand.id,
    );
    await receipt("starting-follow-ups", f);
  });

  it("holds a follow-up behind a live approval and hands it over once the person answers", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      running,
      openApproval,
      store,
      runRow,
      thread,
      send,
      database,
      answer,
      input,
      steerCommand,
      receipt,
    } = storeFixture;
    const f = await fixture("approval");
    const runId = await running(f);
    const first = await openApproval(f, runId);
    const second = await openApproval(f, runId);
    // The Host projects Request changes on its drain.
    await store.drainPendingThreadStates();
    expect((await runRow(runId)).status).toBe("waiting");
    expect((await thread(f)).status).toBe("waiting");
    const follow = await send(f, "while-waiting");
    expect(follow).toMatchObject({ disposition: "pending", run: null });
    // Sending never answers the approval.
    expect(
      await database
        .selectFrom("requests")
        .select("status")
        .where("originatingRunId", "=", runId)
        .execute(),
    ).toEqual([{ status: "pending" }, { status: "pending" }]);
    await answer(f, runId, first.id, "answer-first");
    expect((await runRow(runId)).status).toBe("waiting");
    expect(await input(follow.message.id)).toMatchObject({ state: "pending" });
    const events = await answer(f, runId, second.id, "answer-second");
    expect((await runRow(runId)).status).toBe("running");
    expect(events.some(isRunningState)).toBe(true);
    expect(await input(follow.message.id)).toMatchObject({ runId, state: "claimed" });
    expect((await steerCommand(follow.message.id)).type).toBe("run.steer");
    expect((await thread(f)).status).toBe("running");
    await receipt("approval-then-follow-up", f);
  });

  it("is running again once its engine cancels the last open approval", async ({
    storeFixture,
  }) => {
    const { fixture, running, openApproval, send, emit, runRow, input, receipt } = storeFixture;
    const f = await fixture("provider-cancel");
    const runId = await running(f);
    const request = await openApproval(f, runId);
    const follow = await send(f, "after-provider-cancel");
    expect(follow).toMatchObject({ disposition: "pending" });
    await emit(f, runId, "request.cancelled", { reason: "source-closed", requestId: request.id });
    expect((await runRow(runId)).status).toBe("running");
    expect(await input(follow.message.id)).toMatchObject({ runId, state: "claimed" });
    await receipt("provider-cancel-then-follow-up", f);
  });

  it("never joins another person's Run, another reply target or a stale membership", async ({
    storeFixture,
  }) => {
    const { fixture, running, send, database, runsOf, receipt } = storeFixture;
    const f = await fixture("isolation", { collaborator: true });
    const runId = await running(f);
    const theirs = await send(f, "collaborator-message", { by: f.collaboratorId! });
    expect(theirs).toMatchObject({ disposition: "pending", run: null });
    // The same person writing from the app does not join a reply going to a channel.
    await database
      .updateTable("runs")
      .set({ replyTarget: sql`'{"conversationId":"chc_reply","kind":"channel"}'::jsonb` })
      .where("id", "=", runId)
      .execute();
    const inApp = await send(f, "in-app-while-channel-reply");
    expect(inApp).toMatchObject({ disposition: "pending", run: null });
    expect(await runsOf(f)).toHaveLength(1);
    await receipt("isolation", f);
  });

  it("keeps machine input waiting behind the person's reply", async ({ storeFixture }) => {
    const { fixture, running, platformInput, input, receipt } = storeFixture;
    const f = await fixture("machine");
    const runId = await running(f);
    const result = await platformInput(f, "task-result", runId);
    expect(result).toMatchObject({ disposition: "pending", run: null });
    expect(await input(result.message.id)).toMatchObject({ state: "pending" });
    await receipt("machine-waits", f);
  });

  it("returns a refused hand-off to the inbox without retrying it, then answers it exactly once", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      running,
      send,
      steerCommand,
      store,
      input,
      database,
      emit,
      text,
      runsOf,
      receipt,
    } = storeFixture;
    const f = await fixture("refusal");
    const runId = await running(f);
    const b = await send(f, "refused-b");
    const bFirst = await steerCommand(b.message.id);
    await store.claimCommand(bFirst.id, "refusal-dispatcher");
    await store.refuseSteer(bFirst.id, "The engine is between model calls");
    expect(await input(b.message.id)).toMatchObject({ runId: null, state: "pending" });
    // The refusal itself never schedules another hand-off.
    expect(
      await database.selectFrom("commands").select("id").where("type", "=", "run.steer").execute(),
    ).toHaveLength(1);
    // The next Send hands both over, oldest first, under fresh command identities.
    const c = await send(f, "refused-c");
    expect(c).toMatchObject({ disposition: "steering" });
    const bSecond = await steerCommand(b.message.id);
    const cCommand = await steerCommand(c.message.id);
    expect(bSecond.id).not.toBe(bFirst.id);
    expect(
      new Set([bFirst.idempotencyKey, bSecond.idempotencyKey, cCommand.idempotencyKey]).size,
    ).toBe(3);
    expect(bSecond.createdAt.getTime()).toBeLessThan(cCommand.createdAt.getTime());
    await store.claimCommand(bSecond.id, "refusal-dispatcher");
    await emit(f, runId, "message.injected", { messageId: b.message.id });
    await store.claimCommand(cCommand.id, "refusal-dispatcher");
    await store.markSteerUnknown(cCommand.id, "The Runner connection closed before it answered");
    expect(await input(c.message.id)).toMatchObject({ runId, state: "unknown" });
    // A message refused just before the reply ends is answered by the next Run.
    const d = await send(f, "refused-d");
    const dCommand = await steerCommand(d.message.id);
    await store.claimCommand(dCommand.id, "refusal-dispatcher");
    await store.refuseSteer(dCommand.id, "The turn ended");
    await emit(f, runId, "assistant.message", {
      content: text("Done with A and B."),
      messageId: createId("message"),
    });
    await emit(f, runId, "run.completed", { status: "completed" });
    const runs = await runsOf(f);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ seedInputId: d.message.id, status: "queued" });
    expect(await input(b.message.id)).toMatchObject({ runId, state: "delivered" });
    // Uncertain stays uncertain and never seeds new work.
    expect(await input(c.message.id)).toMatchObject({ runId, state: "unknown" });
    await receipt("refusal-uncertain-completion", f);
  });

  it("ends the reply on Stop without pausing the conversation and cancels its undelivered follow-ups", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      running,
      send,
      platformInput,
      steerCommand,
      stop,
      thread,
      input,
      database,
      emit,
      runsOf,
      claimAndBind,
      store,
      runRow,
      receipt,
    } = storeFixture;
    const f = await fixture("stop");
    const runId = await running(f);
    const b = await send(f, "stop-b");
    const c = await send(f, "stop-c");
    const reminder = await platformInput(f, "stop-reminder", runId);
    const bCommand = await steerCommand(b.message.id);
    const stopped = await stop(f, runId, "stop-reply");
    expect(stopped.events.some((event) => event.type === "thread.input-queue-updated")).toBe(false);
    expect((await thread(f)).inputQueuePaused).toBe(false);
    for (const id of [b.message.id, c.message.id])
      expect(await input(id)).toMatchObject({ cancelReason: "stopped", state: "cancelled" });
    expect(
      await database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", bCommand.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed" });
    // Independent work keeps its meaning.
    expect(await input(reminder.message.id)).toMatchObject({ state: "pending" });
    // Written while the stopped reply winds down: answered next, never cancelled.
    const after = await send(f, "stop-after");
    expect(after).toMatchObject({ disposition: "pending", run: null });
    await emit(f, runId, "run.interrupted", { status: "interrupted" });
    expect(await input(after.message.id)).toMatchObject({ state: "pending" });
    const runs = await runsOf(f);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ seedInputId: reminder.message.id, status: "queued" });
    // The person's later message rides that next reply's first turn.
    const { claimed } = await claimAndBind(f, runs[1]!.id);
    const context = await store.loadRunDispatchContext(claimed.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([reminder.message.id, after.message.id]);
    // A Stop naming the finished reply cannot reach the new one.
    await expect(stop(f, runId, "stale-stop")).rejects.toMatchObject({ code: "conflict" });
    expect((await runRow(runs[1]!.id)).status).toBe("starting");
    await receipt("stop-then-send", f);
  });

  it.for([
    ["refused", { cancelReason: "stopped", state: "cancelled" }],
    ["accepted", { state: "delivered" }],
    ["uncertain", { state: "unknown" }],
  ] as const)(
    "settles a hand-off already on its way when Stop lands: %s",
    async ([outcome, expected], { storeFixture }) => {
      const { fixture, running, send, steerCommand, store, stop, input, emit, runsOf, receipt } =
        storeFixture;
      const f = await fixture(`stop-receipt-${outcome}`);
      const runId = await running(f);
      const inFlight = await send(f, `in-flight-${outcome}`);
      const waiting = await send(f, `behind-${outcome}`);
      const command = await steerCommand(inFlight.message.id);
      // Dispatched to the Runner before the person pressed Stop; one control
      // command per Thread is in flight at a time, so the next one waits.
      expect(await store.claimCommand(command.id, "stop-receipts-dispatcher")).not.toBeNull();
      await stop(f, runId, `stop-${outcome}`);
      expect(await input(waiting.message.id)).toMatchObject({
        cancelReason: "stopped",
        state: "cancelled",
      });
      if (outcome === "refused") await store.refuseSteer(command.id, "Refused after Stop");
      if (outcome === "accepted")
        await emit(f, runId, "message.injected", { messageId: inFlight.message.id });
      if (outcome === "uncertain")
        await store.markSteerUnknown(command.id, "No answer before the connection closed");
      expect(await input(inFlight.message.id)).toMatchObject(expected);
      await emit(f, runId, "run.interrupted", { status: "interrupted" });
      expect(await input(inFlight.message.id)).toMatchObject(expected);
      // Nothing the person stopped starts another reply.
      expect(await runsOf(f)).toHaveLength(1);
      await receipt(`stop-late-receipt-${outcome}`, f);
    },
  );

  it("cancels follow-ups a Stop finds waiting for a restart that never reached the Runner", async ({
    storeFixture,
  }) => {
    const { fixture, running, runRow, send, steerCommand, stop, input, emit, runsOf, receipt } =
      storeFixture;
    const f = await fixture("stop-restart", { steering: false });
    const runId = await running(f);
    const firstBinding = (await runRow(runId)).bindingGeneration!;
    const follow = await send(f, "restart-before-stop");
    expect((await steerCommand(follow.message.id)).type).toBe("run.restart");
    await stop(f, runId, "stop-restart");
    expect(await input(follow.message.id)).toMatchObject({
      cancelReason: "stopped",
      state: "cancelled",
    });
    await emit(f, runId, "run.interrupted", { status: "interrupted" }, firstBinding);
    expect((await runRow(runId)).status).toBe("interrupted");
    expect(await input(follow.message.id)).toMatchObject({ state: "cancelled" });
    expect(await runsOf(f)).toHaveLength(1);
    await receipt("stop-undispatched-restart", f);
  });

  it("keeps follow-ups when the background deadline, not the person, stops the Run", async ({
    storeFixture,
  }) => {
    const { fixture, running, emit, text, send, store, thread, input, runsOf, receipt } =
      storeFixture;
    const f = await fixture("deadline");
    const runId = await running(f);
    await emit(f, runId, "assistant.message", {
      content: text("Started the long job."),
      messageId: createId("message"),
    });
    await emit(f, runId, "run.phase", { phase: "background" });
    const follow = await send(f, "during-background");
    expect(follow).toMatchObject({ disposition: "steering", input: { runId } });
    const stops: unknown[] = [];
    await store.stopRunsPastBackgroundDeadline(
      (stopped) => stops.push(stopped),
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );
    expect(stops).toHaveLength(1);
    expect((await thread(f)).inputQueuePaused).toBe(false);
    await emit(f, runId, "run.interrupted", { status: "interrupted" });
    // Never dispatched, and nobody asked to drop it: it is answered next.
    expect(await input(follow.message.id)).toMatchObject({ state: "pending" });
    const runs = await runsOf(f);
    expect(runs[1]).toMatchObject({ seedInputId: follow.message.id, status: "queued" });
    await receipt("deadline-keeps-follow-up", f);
  });

  it("ends a reply that had not started and keeps the conversation open", async ({
    storeFixture,
  }) => {
    const { fixture, send, stop, runRow, input, thread, runsOf, receipt } = storeFixture;
    const f = await fixture("stop-queued");
    const first = await send(f, "queued-a");
    const b = await send(f, "queued-b");
    await stop(f, first.run!.id, "stop-queued");
    expect((await runRow(first.run!.id)).status).toBe("interrupted");
    expect(await input(first.message.id)).toMatchObject({ state: "cancelled" });
    expect(await input(b.message.id)).toMatchObject({
      cancelReason: "stopped",
      state: "cancelled",
    });
    expect((await thread(f)).inputQueuePaused).toBe(false);
    expect(await runsOf(f)).toHaveLength(1);
    const next = await send(f, "queued-next");
    expect(next).toMatchObject({ disposition: "run-queued" });
    await receipt("stop-queued-reply", f);
  });

  it("orders a Send and a Stop from two devices by admission", async ({ storeFixture }) => {
    const { fixture, running, send, stop, input, emit, runsOf, receipt } = storeFixture;
    const f = await fixture("dual-device");
    const runId = await running(f);
    const beforeStop = await send(f, "phone-before-stop");
    await stop(f, runId, "laptop-stop");
    const afterStop = await send(f, "phone-after-stop");
    expect(await input(beforeStop.message.id)).toMatchObject({ state: "cancelled" });
    expect(await input(afterStop.message.id)).toMatchObject({ state: "pending" });
    await emit(f, runId, "run.interrupted", { status: "interrupted" });
    expect((await runsOf(f))[1]).toMatchObject({ seedInputId: afterStop.message.id });
    await receipt("dual-device-stop", f);
  });

  it("settles a conversation an older Stop left paused, once, without running or losing anything", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      running,
      emit,
      text,
      store,
      send,
      start,
      database,
      platformInput,
      thread,
      input,
      runsOf,
      claimAndBind,
      receipt,
    } = storeFixture;
    const f = await fixture("legacy-paused");
    const runId = await running(f);
    await emit(f, runId, "assistant.message", {
      content: text("First answer."),
      messageId: createId("message"),
    });
    await emit(f, runId, "run.completed", { status: "completed" });
    const { thread: workThread } = await store.createThread({
      createdBy: f.ownerId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: "thread-legacy-paused-work",
      modelSelection,
      role: "work",
      title: "Legacy work",
      workspaceId: f.workspace.id,
    });
    const work: Fixture = { ...f, suffix: "legacy-paused-work", thread: workThread };
    const workFirst = await send(work, "legacy-work-a");
    await start(work, workFirst.run!.id);
    const workQueued = await send(work, "legacy-work-b");
    // What an earlier Host left behind: a paused Chat holding a person's
    // message and a finished task's result, and a paused work Thread.
    await database
      .updateTable("threads")
      .set({ inputQueuePaused: true, inputQueuePausedBy: f.ownerId })
      .where("id", "in", [f.thread.id, work.thread.id])
      .execute();
    const held = await send(f, "legacy-held");
    const result = await platformInput(f, "legacy-task-result", runId);
    expect(held).toMatchObject({ disposition: "pending" });
    expect(result).toMatchObject({ disposition: "pending" });

    const settled = await store.recoverThreadWorkQueues();
    expect((await thread(f)).inputQueuePaused).toBe(false);
    expect(await input(held.message.id)).toMatchObject({
      cancelReason: "stopped",
      state: "cancelled",
    });
    // The task's outcome becomes context for the person's next turn.
    expect(await input(result.message.id)).toMatchObject({ policy: "report", state: "pending" });
    expect(await runsOf(f)).toHaveLength(1);
    expect(settled.map(summarizeEvent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thread.input-queue-updated" }),
        expect.objectContaining({ type: "thread-input.updated" }),
      ]),
    );
    // A work Thread's pause is the person's to lift.
    expect((await thread(work)).inputQueuePaused).toBe(true);
    expect(await input(workQueued.message.id)).toMatchObject({ state: "pending" });
    expect(
      (await store.recoverThreadWorkQueues()).filter((event) => event.threadId === f.thread.id),
    ).toEqual([]);

    const next = await send(f, "legacy-next");
    expect(next).toMatchObject({ disposition: "run-queued" });
    const { claimed } = await claimAndBind(f, next.run!.id);
    const context = await store.loadRunDispatchContext(claimed.command.id);
    expect(context.reports.messages.map(({ id }) => id)).toEqual([result.message.id]);
    await receipt("legacy-paused-settlement", f, { settledEvents: settled.map(summarizeEvent) });
  });

  it.for([
    [
      "as the engine starts",
      async (storeFixture: StoreFixture, f: Fixture) => {
        const { send, claimAndBind, sendImage, emit, bindSession } = storeFixture;
        const first = await send(f, "barrier-start-first");
        const runId = first.run!.id;
        const bound = await claimAndBind(f, runId);
        const image = await sendImage(f, "barrier-start-image");
        const later = await send(f, "barrier-start-text");
        await emit(f, runId, "run.started", { status: "running" }, bound.binding);
        await bindSession(f, runId, bound.binding);
        return { image, later, runId };
      },
    ],
    [
      "when the person answers the last approval",
      async (storeFixture: StoreFixture, f: Fixture) => {
        const { running, openApproval, store, sendImage, send, answer, runRow } = storeFixture;
        const runId = await running(f, "barrier-approval-first");
        const request = await openApproval(f, runId);
        await store.drainPendingThreadStates();
        const image = await sendImage(f, "barrier-approval-image");
        const later = await send(f, "barrier-approval-text");
        await answer(f, runId, request.id, "barrier-approval-answer");
        expect((await runRow(runId)).status).toBe("running");
        return { image, later, runId };
      },
    ],
    [
      "when the engine cancels its own question",
      async (storeFixture: StoreFixture, f: Fixture) => {
        const { running, openApproval, sendImage, send, emit, runRow } = storeFixture;
        const runId = await running(f, "barrier-cancel-first");
        const request = await openApproval(f, runId);
        const image = await sendImage(f, "barrier-cancel-image");
        const later = await send(f, "barrier-cancel-text");
        await emit(f, runId, "request.cancelled", {
          reason: "source-closed",
          requestId: request.id,
        });
        expect((await runRow(runId)).status).toBe("running");
        return { image, later, runId };
      },
    ],
    [
      "as they are sent while it replies",
      async (storeFixture: StoreFixture, f: Fixture) => {
        const { running, sendImage, send } = storeFixture;
        const runId = await running(f, "barrier-running-first");
        const image = await sendImage(f, "barrier-running-image");
        expect(image).toMatchObject({ disposition: "pending", run: null });
        const later = await send(f, "barrier-running-text");
        return { image, later, runId };
      },
    ],
  ] as const)(
    "holds a picture the engine cannot take mid-turn, and what follows it, %s",
    async ([moment, reach], { storeFixture }) => {
      const { fixture, input, handOffs, finish, nextFrame, receipt } = storeFixture;
      const f = await fixture(`image-barrier-${moment.split(" ").at(-1)}`, {
        imageSteering: false,
      });
      const { image, later, runId } = await reach(storeFixture, f);
      expect(await input(image.message.id)).toMatchObject({ runId: null, state: "pending" });
      expect(await input(later.message.id)).toMatchObject({ runId: null, state: "pending" });
      expect(await handOffs(runId)).toEqual([]);
      // The next reply starts with both, in the order the person sent them.
      await finish(f, runId);
      const frame = await nextFrame(f);
      expect(frame.inputs).toEqual([image.message.id, later.message.id]);
      await receipt(`image-barrier-${moment.replaceAll(" ", "-")}`, f, { frame });
    },
  );

  it("hands a picture to a reply whose engine takes images mid-turn", async ({ storeFixture }) => {
    const { fixture, send, claimAndBind, sendImage, emit, input, handOffs, receipt } = storeFixture;
    const f = await fixture("image-steerable", { imageSteering: true });
    const first = await send(f, "steerable-first");
    const runId = first.run!.id;
    const bound = await claimAndBind(f, runId);
    const image = await sendImage(f, "steerable-image");
    const later = await send(f, "steerable-text");
    await emit(f, runId, "run.started", { status: "running" }, bound.binding);
    expect(await input(image.message.id)).toMatchObject({ runId, state: "claimed" });
    expect(
      (await handOffs(runId)).map(({ payload, type }) => [type, messageIdOf(payload)]),
    ).toEqual([
      ["run.steer", image.message.id],
      ["run.steer", later.message.id],
    ]);
    await receipt("image-steerable", f);
  });

  it("returns what followed a refused hand-off with it, in the refusal's transaction", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      running,
      sendImage,
      send,
      handOffs,
      store,
      input,
      finish,
      nextFrame,
      receipt,
    } = storeFixture;
    const f = await fixture("refused-image", { imageSteering: true });
    const runId = await running(f, "refused-image-first");
    const image = await sendImage(f, "refused-image");
    const later = await send(f, "after-refused-image");
    expect([image.disposition, later.disposition]).toEqual(["steering", "steering"]);
    const [imageCommand, laterCommand] = await handOffs(runId);
    expect([messageIdOf(imageCommand!.payload), messageIdOf(laterCommand!.payload)]).toEqual([
      image.message.id,
      later.message.id,
    ]);
    // One control command per Thread is in flight at a time.
    const dispatched = await store.claimNextCommand(f.environmentId, "refused-image-dispatcher");
    expect(dispatched?.command.id).toBe(imageCommand!.id);
    expect(await store.claimNextCommand(f.environmentId, "refused-image-dispatcher")).toBeNull();
    // The Runner could not prepare the picture: a definite refusal.
    await store.refuseSteer(imageCommand!.id, "Pi could not prepare this image");
    expect(await input(image.message.id)).toMatchObject({ runId: null, state: "pending" });
    expect(await input(later.message.id)).toMatchObject({
      runId: null,
      state: "pending",
      steerCommandId: null,
    });
    expect((await handOffs(runId)).map(({ status }) => status)).toEqual(["failed", "failed"]);
    // Nothing the person sent after the picture reaches the Runner ahead of it.
    expect(await store.claimNextCommand(f.environmentId, "refused-image-dispatcher")).toBeNull();
    await finish(f, runId);
    const frame = await nextFrame(f);
    expect(frame.inputs).toEqual([image.message.id, later.message.id]);
    await receipt("refused-hand-off-keeps-order", f, { frame });
  });

  it("leaves delivered, uncertain and earlier hand-offs alone when a later one is refused", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      running,
      send,
      steerCommand,
      store,
      emit,
      input,
      handOffs,
      database,
      start,
      finish,
      nextFrame,
      receipt,
    } = storeFixture;
    const f = await fixture("refusal-reach");
    const runId = await running(f, "reach-first");
    const a = await send(f, "reach-a");
    const aCommand = await steerCommand(a.message.id);
    await store.claimCommand(aCommand.id, "reach-dispatcher");
    await emit(f, runId, "message.injected", { messageId: a.message.id });
    const b = await send(f, "reach-b");
    const bCommand = await steerCommand(b.message.id);
    await store.claimCommand(bCommand.id, "reach-dispatcher");
    await store.markSteerUnknown(bCommand.id, "The connection closed before the Runner answered");
    const c = await send(f, "reach-c");
    const d = await send(f, "reach-d");
    const cCommand = await steerCommand(c.message.id);
    const dCommand = await steerCommand(d.message.id);
    expect((await store.claimNextCommand(f.environmentId, "reach-dispatcher"))?.command.id).toBe(
      cCommand.id,
    );
    await store.refuseSteer(cCommand.id, "The engine is between model calls");
    expect(await input(a.message.id)).toMatchObject({ runId, state: "delivered" });
    expect(await input(b.message.id)).toMatchObject({ runId, state: "unknown" });
    expect(await input(c.message.id)).toMatchObject({ runId: null, state: "pending" });
    expect(await input(d.message.id)).toMatchObject({ runId: null, state: "pending" });
    const statuses = new Map((await handOffs(runId)).map(({ id, status }) => [id, status]));
    expect([aCommand, bCommand, cCommand, dCommand].map(({ id }) => statuses.get(id))).toEqual([
      "succeeded",
      "unknown",
      "failed",
      "failed",
    ]);
    // Recovery retires the old command without proving its input was refused.
    await database
      .updateTable("providerSessions")
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where("threadId", "=", f.thread.id)
      .where("active", "=", true)
      .execute();
    const recovered = await store.recoverRunsWithExpiredExecutionBindings();
    expect(recovered.events).toContainEqual(
      expect.objectContaining({
        type: "run.restarted",
        data: expect.objectContaining({ reason: "recovery" }),
      }),
    );
    expect(await input(b.message.id)).toMatchObject({ runId, state: "unknown" });
    expect((await handOffs(runId)).find(({ id }) => id === bCommand.id)?.status).toBe("failed");
    await start(f, runId);
    // Successor cleanup must never turn the retired command into a refusal receipt.
    await finish(f, runId);
    expect(await input(b.message.id)).toMatchObject({ runId, state: "unknown" });
    const frame = await nextFrame(f);
    expect(frame.inputs).toEqual([c.message.id, d.message.id]);
    expect(
      (await handOffs(runId)).filter(({ payload }) => messageIdOf(payload) === b.message.id),
    ).toHaveLength(1);
    await receipt("refusal-reach", f, { frame });
  });

  it("keeps a work Thread's refused hand-off to that one message", async ({ storeFixture }) => {
    const { fixture, running, emit, text, send, steerCommand, store, input, receipt } =
      storeFixture;
    const f = await fixture("work-refusal", { role: "work" });
    const runId = await running(f, "work-refusal-first");
    await emit(f, runId, "assistant.message", {
      content: text("Started the long job."),
      messageId: createId("message"),
    });
    await emit(f, runId, "run.phase", { phase: "background" });
    const x = await send(f, "work-refusal-x");
    const y = await send(f, "work-refusal-y");
    expect([x.disposition, y.disposition]).toEqual(["steering", "steering"]);
    const xCommand = await steerCommand(x.message.id);
    const yCommand = await steerCommand(y.message.id);
    await store.claimCommand(xCommand.id, "work-refusal-dispatcher");
    await store.refuseSteer(xCommand.id, "The engine is between model calls");
    expect(await input(x.message.id)).toMatchObject({ runId: null, state: "pending" });
    expect(await input(y.message.id)).toMatchObject({ runId, state: "claimed" });
    expect((await steerCommand(y.message.id)).status).toBe("pending");
    expect(yCommand.id).toBe((await steerCommand(y.message.id)).id);
    await receipt("work-refusal-scope", f);
  });

  it.for([
    ["predates steer-answer-v1", false],
    ["advertises steer-answer-v1", true],
  ] as const)(
    "after a Host restart, a Runner that %s and reattaches its reply",
    async ([state, steerAnswer], { storeFixture }) => {
      const {
        fixture,
        running,
        store,
        runRow,
        send,
        handOffs,
        openApproval,
        answer,
        finish,
        runsOf,
        receipt,
      } = storeFixture;
      const f = await fixture(`reattach-${steerAnswer ? "current" : "older"}`, { steerAnswer });
      // An earlier Host dispatched this reply to the Runner.
      const runId = await running(f, "reattach-first");
      const leaseExpiresAt = new Date(Date.now() + 10 * 60_000);
      await store.restartExecutionLeases(leaseExpiresAt);
      // The same Runner boot connects to the upgraded Host and states its Run.
      await store.authenticateRunnerConnection(f.descriptor);
      const run = await runRow(runId);
      const attached = await store.attachRunnerExecutions({
        dispatchingRunIds: [],
        executions: [
          {
            bindingGeneration: run.bindingGeneration!,
            environmentId: f.environmentId,
            nextOrdinal: run.nextRunnerOrdinal,
            runId,
            threadId: f.thread.id,
            workspaceId: f.workspace.id,
          },
        ],
        leaseExpiresAt,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      });
      expect(attached.results).toEqual([
        { nextOrdinal: run.nextRunnerOrdinal, runId, status: "attached" },
      ]);
      const follow = await send(f, "after-host-upgrade");
      if (steerAnswer) {
        expect(follow).toMatchObject({
          disposition: "steering",
          input: { runId, state: "claimed" },
        });
        expect((await handOffs(runId)).map(({ type }) => type)).toEqual(["run.steer"]);
      } else {
        expect(follow).toMatchObject({ disposition: "pending", run: null });
        expect(await handOffs(runId)).toEqual([]);
        // Nor at the next moment the Run could take it.
        const request = await openApproval(f, runId);
        await answer(f, runId, request.id, "reattach-answer");
        expect((await runRow(runId)).status).toBe("running");
        expect(await handOffs(runId)).toEqual([]);
        // The next reply starts with it; dispatching that reply asks for the update.
        await finish(f, runId);
        expect((await runsOf(f))[1]).toMatchObject({
          seedInputId: follow.message.id,
          status: "queued",
        });
      }
      await receipt(`reattach-${state.replaceAll(" ", "-")}`, f);
    },
  );

  it("does not restart an older Runner's reply into an attempt the Host would refuse to send", async ({
    storeFixture,
  }) => {
    const { fixture, running, send, handOffs, database, finish, runRow, runsOf, receipt } =
      storeFixture;
    const f = await fixture("older-restart", { steerAnswer: false, steering: false });
    const runId = await running(f, "older-restart-first");
    const follow = await send(f, "older-restart-follow-up");
    expect(follow).toMatchObject({ disposition: "pending", revokedGrants: [], run: null });
    expect(await handOffs(runId)).toEqual([]);
    expect(
      await database
        .selectFrom("runAttempts")
        .select(["reason", "status"])
        .where("runId", "=", runId)
        .execute(),
    ).toEqual([{ reason: "initial", status: "current" }]);
    await finish(f, runId);
    expect((await runRow(runId)).status).toBe("completed");
    expect((await runsOf(f))[1]).toMatchObject({ seedInputId: follow.message.id });
    await receipt("older-restart", f);
  });

  it("hands every message sent before the engine starts to its first turn or its start", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      send,
      database,
      claimAndBind,
      store,
      emit,
      handOffs,
      pendingInputs,
      runsOf,
      receipt,
    } = storeFixture;
    const f = await fixture("large-burst");
    const total = 71;
    const sent = [await send(f, "burst-000")];
    const runId = sent[0]!.run!.id;
    const pending = await send(f, "burst-001");
    expect(pending).toMatchObject({ disposition: "pending", run: null });
    const templateMessage = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", pending.message.id)
      .executeTakeFirstOrThrow();
    const templateInput = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", pending.message.id)
      .executeTakeFirstOrThrow();
    const templateChain = await database
      .selectFrom("causalChains")
      .selectAll()
      .where("id", "=", templateInput.causalChainId)
      .executeTakeFirstOrThrow();
    // Admission has its own journeys. Seed the large startup boundary in one
    // transaction instead of repeating admission and its lock probes 71 times.
    const extra = Array.from({ length: total - 2 }, (_, index) => ({
      causalChainId: createId("causalChain"),
      messageId: createId("message"),
      sequence: (BigInt(templateMessage.sequence) + BigInt(index) + 1n).toString(),
    }));
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("threads")
        .set({
          nextMessageSequence: (
            BigInt(templateMessage.sequence) +
            BigInt(extra.length) +
            1n
          ).toString(),
        })
        .where("id", "=", f.thread.id)
        .execute();
      await transaction
        .insertInto("causalChains")
        .values(
          extra.map((row) => ({
            ...templateChain,
            id: row.causalChainId,
            rootMessageId: row.messageId,
          })),
        )
        .execute();
      await transaction
        .insertInto("messages")
        .values(
          extra.map((row) => ({
            ...templateMessage,
            content: jsonValue(templateMessage.content),
            id: row.messageId,
            sequence: row.sequence,
          })),
        )
        .execute();
      await transaction
        .insertInto("threadInputs")
        .values(
          extra.map((row) => ({
            ...templateInput,
            causalChainId: row.causalChainId,
            messageId: row.messageId,
            idempotencyKey: `burst-${row.sequence}`,
            queueRank: row.sequence,
          })),
        )
        .execute();
    });
    const ids = [
      sent[0]!.message.id,
      pending.message.id,
      ...extra.map(({ messageId }) => messageId),
    ];
    const { binding, claimed } = await claimAndBind(f, runId);
    const context = await store.loadRunDispatchContext(claimed.command.id);
    const framed = Math.min(total, runExecuteInputsMax);
    expect(context.inputs.map(({ id }) => id)).toEqual(ids.slice(0, framed));
    await emit(f, runId, "run.started", { status: "running" }, binding);
    const steers = await handOffs(runId);
    expect(steers.map(({ type }) => type)).toEqual(Array(total - framed).fill("run.steer"));
    expect(steers.map(({ payload }) => messageIdOf(payload))).toEqual(ids.slice(framed));
    // Commands dispatch in creation order: no two hand-offs share a timestamp.
    const stamps = await sql<{ readonly distinct: string; readonly total: string }>`
      select count(distinct created_at) as distinct, count(*) as total
      from commands where run_id = ${runId} and type = 'run.steer'`.execute(database);
    expect(stamps.rows[0]!.distinct).toBe(stamps.rows[0]!.total);
    expect(await pendingInputs(f)).toEqual([]);
    expect(await runsOf(f)).toHaveLength(1);
    await receipt("large-burst", f, {
      framed: context.inputs.map(({ id }) => id),
      steered: steers.length,
      total,
    });
  });

  it("bounds a restart to what one dispatch carries and hands the rest at the next start", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      running,
      runRow,
      send,
      emit,
      executeCommand,
      store,
      input,
      pendingInputs,
      handOffs,
      receipt,
    } = storeFixture;
    const f = await fixture("restart-bound", { steering: false });
    const runId = await running(f, "restart-bound-first");
    const firstBinding = (await runRow(runId)).bindingGeneration!;
    const total = runExecuteInputsMax + 8;
    const sent = [];
    for (let index = 0; index < total; index += 1)
      sent.push(await send(f, `restart-bound-${String(index).padStart(3, "0")}`));
    const ids = sent.map(({ message }) => message.id);
    expect(sent.map(({ disposition }) => disposition)).toEqual([
      ...Array(runExecuteInputsMax).fill("steering"),
      ...Array(total - runExecuteInputsMax).fill("pending"),
    ]);
    await emit(f, runId, "run.interrupted", { status: "interrupted" }, firstBinding);
    const replacement = await executeCommand(runId);
    expect(await store.claimCommand(replacement.id, "restart-bound-dispatcher")).not.toBeNull();
    const context = await store.loadRunDispatchContext(replacement.id);
    expect(context.inputs.map(({ id }) => id)).toEqual(ids.slice(0, runExecuteInputsMax));
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity,
      harnessInstanceId: f.harness.id,
      leaseTokenHash: "restart-bound-lease-2",
      membershipGeneration: 1,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      runId,
      threadId: f.thread.id,
    });
    await emit(f, runId, "run.started", { status: "running" }, binding.bindingGeneration);
    for (const id of ids.slice(0, runExecuteInputsMax))
      expect(await input(id)).toMatchObject({ runId, state: "delivered" });
    // The replacement's start is the next moment the Run can take the rest.
    expect(await pendingInputs(f)).toEqual([]);
    const rest = new Set(ids.slice(runExecuteInputsMax));
    const restarts = (await handOffs(runId)).filter(({ payload }) =>
      rest.has(messageIdOf(payload) as MessageId),
    );
    expect(restarts.map(({ payload }) => messageIdOf(payload))).toEqual(
      ids.slice(runExecuteInputsMax),
    );
    expect(restarts.every(({ type }) => type === "run.restart")).toBe(true);
    await receipt("restart-bound", f, { frame: context.inputs.map(({ id }) => id) });
  });

  it("never joins a reply its sender started under an earlier membership", async ({
    storeFixture,
  }) => {
    const { fixture, send, start, store, input, runRow, handOffs, receipt } = storeFixture;
    const f = await fixture("membership-generation", { collaborator: true });
    const collaboratorId = f.collaboratorId!;
    const first = await send(f, "generation-first", { by: collaboratorId });
    const runId = first.run!.id;
    await start(f, runId);
    // Made an owner, the collaborator holds a new membership generation.
    const invitation = await store.createWorkspaceInvitation({
      createdBy: f.ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: "promote-membership-generation",
      intendedEmail: null,
      requestFingerprint: "sha256:promote-membership-generation",
      role: "owner",
      selector: "selector-promote-membership-generation",
      tokenHash: "sha256:token-promote-membership-generation",
      type: "link",
      workspaceId: f.workspace.id,
    });
    await store.acceptWorkspaceInvitation({
      selector: invitation.selector,
      tokenHash: "sha256:token-promote-membership-generation",
      userEmail: "membership-generation@test.invalid",
      userEmailVerified: true,
      userId: collaboratorId,
    });
    const follow = await send(f, "generation-follow-up", { by: collaboratorId });
    expect(follow).toMatchObject({ disposition: "pending", run: null });
    expect(Number((await input(follow.message.id)).membershipGeneration)).toBe(2);
    expect(Number((await runRow(runId)).membershipGeneration)).toBe(1);
    expect(await handOffs(runId)).toEqual([]);
    await receipt("membership-generation", f);
  });
});

function messageIdOf(payload: unknown): string | undefined {
  return (payload as { readonly messageId?: string } | null)?.messageId;
}

function isRunningState(event: AgentEvent): boolean {
  return (
    event.type === "thread.state-changed" &&
    (event.data as { readonly status?: string }).status === "running"
  );
}

function summarizeEvent(event: AgentEvent) {
  const data = event.data as Record<string, unknown> | null;
  const input = data && typeof data === "object" ? (data.input as Record<string, unknown>) : null;
  const message =
    data && typeof data === "object" ? (data.message as Record<string, unknown>) : null;
  return {
    sequence: event.sequence,
    threadId: event.threadId as ThreadId | null,
    runId: event.runId,
    type: event.type,
    ...(input && typeof input === "object"
      ? {
          input: {
            cancelReason: input.cancelReason,
            messageId: input.messageId,
            policy: input.policy,
            runId: input.runId,
            state: input.state,
          },
        }
      : {}),
    ...(message && typeof message === "object"
      ? { message: { id: message.id, runId: message.runId, sequence: message.sequence } }
      : {}),
    ...(event.type === "thread.state-changed" ? { state: data } : {}),
  };
}
