import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentToolsMcpService } from "./agent-tools-mcp-service.js";
import { baselineWorkspaceCreateResponse } from "./agent-control-baseline.test-support.js";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createId,
  provisionalThreadTitle,
  HarnessIdSchema,
  type AgentEvent,
  type Message,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  type Run,
  type Thread,
  type UserId,
} from "@opensteer/core";
import { createDatabase, migrateToLatest, OpensteerStore } from "@opensteer/database";
import { CommandService, KeyedAdmissionQueue } from "@opensteer/orchestration";
import { HarnessInputSchema, type RunnerDescriptor } from "@opensteer/protocol";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentControlService,
  type AgentControlRunScope,
  type AgentControlTokenService,
} from "./agent-control-service.js";

const evidenceRoot = join(tmpdir(), "opensteer-title-review", randomUUID());
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const testModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

integration("agent-to-agent messaging round trip", () => {
  const database = createDatabase({
    applicationName: "opensteer-agent-messaging-integration-test",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 4,
  });
  const store = new OpensteerStore(database);
  const claimsByToken = new Map<string, AgentControlRunScope>();
  const admission = new KeyedAdmissionQueue({
    maxInFlight: 4,
    maxQueuedBytes: 4_000_000,
    maxQueuedCommands: 64,
  });
  const commands = new CommandService({
    admission,
    onExecutionQueued: vi.fn(),
    onWorkspaceEvent: vi.fn(),
    store,
  });
  const service = new AgentControlService({
    browserSources: {
      agentSignIn: async () => {
        throw new Error("Unexpected browser sign-in");
      },
    },
    machineFullDiskAccess: {
      request: async () => {
        throw new Error("Unexpected full access request");
      },
    },
    browser: {
      createProfile: unexpected,
      profileSiteData: unexpected,
      closeAgentSession: unexpected,
      listAgentSessions: unexpected,
      listGrantedProfiles: unexpected,
      openAgentSession: unexpected,
      requestAccess: unexpected,
      requestSaveProfile: unexpected,
    },
    canRunHarness: () => true,
    commands,
    isEnvironmentConnected: () => true,
    onWorkspaceEvent: vi.fn(),
    store,
    tokens: {
      authenticate: async (token: string) => {
        const claims = claimsByToken.get(token);
        if (!claims) throw new Error(`No test claims for ${token}`);
        return claims;
      },
    } as unknown as AgentControlTokenService,
    defaultWorkspaceBacking: "portablefs",
    environmentWorkspaceBackings: () => ["portablefs"],
    workspaceMounts: { mount: unexpected },
    workspaces: {
      create: async (input) =>
        store.createWorkspace({
          ...input,
          backing: {
            generation: 1,
            kind: "portablefs",
            serviceId: "test-portablefs",
            volumeId: randomUUID(),
          },
          capacityPolicy: {
            kind: "hard-quota",
            blockHardLimitBytes: 10_000_000,
            inodeHardLimit: 10_000,
          },
          status: "ready",
        }),
    },
  });

  beforeAll(async () => {
    await migrateToLatest(database);
  });

  beforeEach(async () => {
    claimsByToken.clear();
    await sql`
      truncate table
        workspace_events,
        agent_control_requests,
        commands,
        thread_inputs,
        causal_chains,
        delegations,
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
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("round-trips typed agent authorship across Threads", async () => {
    const fixture = await createMessagingFixture();

    const outbound = await service.handle(fixture.tokenA, {
      content: [{ text: "Please summarize the signed contract.", type: "text" }],
      delivery: "queue",
      requestId: randomUUID(),
      threadId: fixture.threadB.id,
      type: "thread.message",
    });
    if (outbound.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(outbound.result.disposition).toBe("run-queued");
    expect(outbound.result.thread.id).toBe(fixture.threadB.id);
    expect(outbound.result.run).toMatchObject({
      status: "queued",
      threadId: fixture.threadB.id,
    });
    expect(outbound.result.message).toMatchObject({
      author: {
        displayName: "Contract coordination",
        kind: "agent",
        runId: fixture.runA.id,
        threadId: fixture.threadA.id,
        workspaceId: fixture.threadA.workspaceId,
        workspaceName: "Main workspace",
      },
      content: [{ text: "Please summarize the signed contract.", type: "text" }],
      kind: "input",
      threadId: fixture.threadB.id,
    });
    if (!outbound.result.run) throw new Error("Expected the trigger to queue a Run");
    const inboundCommandId = await pendingCommandIdForRun(outbound.result.run.id);
    await store.claimCommand(inboundCommandId, "messaging-dispatcher");
    const inboundContext = await store.loadRunDispatchContext(inboundCommandId);
    expect(projectHarnessInputs(inboundContext.inputs)).toEqual([
      {
        author: outbound.result.message.author,
        content: [{ text: "Please summarize the signed contract.", type: "text" }],
        createdAt: outbound.result.message.createdAt,
        kind: "input",
        messageId: outbound.result.message.id,
      },
    ]);
    await activateClaimedRun(fixture, outbound.result.run, fixture.threadB);

    claimsByToken.set(
      fixture.tokenB,
      testClaims({
        capabilityProfileId: fixture.threadB.capabilityProfileId,
        environmentId: fixture.environmentId,
        requestedBy: fixture.userId,
        runId: outbound.result.run.id,
        runnerId: fixture.runnerId,
        threadId: fixture.threadB.id,
        workspaceId: fixture.threadB.workspaceId,
      }),
    );
    const reply = await service.handle(fixture.tokenB, {
      content: [{ text: "Summarized: the counterparty signed on Tuesday.", type: "text" }],
      delivery: "steer",
      requestId: randomUUID(),
      threadId: fixture.threadA.id,
      type: "thread.message",
    });
    if (reply.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(reply.result.disposition).toBe("steering");
    expect(reply.result.run?.id).toBe(fixture.runA.id);
    expect(reply.result.message).toMatchObject({
      author: {
        displayName: "Client research",
        kind: "agent",
        runId: outbound.result.run.id,
        threadId: fixture.threadB.id,
        workspaceId: fixture.threadB.workspaceId,
        workspaceName: "Main workspace",
      },
      kind: "input",
      threadId: fixture.threadA.id,
    });

    const replyCommand = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", fixture.runA.id)
      .where("type", "=", "run.steer")
      .executeTakeFirstOrThrow();
    await store.claimCommand(replyCommand.id, "messaging-dispatcher");
    const steered = await store.loadSteerDispatchInput(replyCommand.id);
    expect(projectHarnessInputs([steered.message])).toEqual([
      {
        author: reply.result.message.author,
        content: [{ text: "Summarized: the counterparty signed on Tuesday.", type: "text" }],
        createdAt: reply.result.message.createdAt,
        kind: "input",
        messageId: reply.result.message.id,
      },
    ]);
  });

  it("steers an active Run exactly once on an exact retry", async () => {
    const fixture = await createMessagingFixture();
    const running = await startRun(fixture, fixture.threadB);

    const request = {
      content: [{ text: "The contract is signed.", type: "text" as const }],
      delivery: "steer" as const,
      requestId: randomUUID(),
      threadId: fixture.threadB.id,
      type: "thread.message" as const,
    };
    const steered = await service.handle(fixture.tokenA, request);
    if (steered.type !== "thread.message.result") throw new Error("Expected a message result");

    expect(steered.result.disposition).toBe("steering");
    expect(steered.result.run?.id).toBe(running.runId);
    expect(steered.result.input).toMatchObject({
      policy: "steer",
      runId: running.runId,
      state: "claimed",
    });
    expect(steered.result.message).toMatchObject({
      author: { kind: "agent", runId: fixture.runA.id, threadId: fixture.threadA.id },
      runId: running.runId,
    });
    const steer = await database
      .selectFrom("commands")
      .select(["id", "runId", "type"])
      .where("type", "=", "run.steer")
      .execute();
    expect(steer).toHaveLength(1);
    expect(steer[0]).toMatchObject({ runId: running.runId });

    const retried = await service.handle(fixture.tokenA, request);
    if (retried.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(retried.result).toMatchObject({
      disposition: "steering",
      input: { messageId: steered.result.input.messageId },
      message: { id: steered.result.message.id },
      run: { id: running.runId },
    });
    await expect(
      database
        .selectFrom("commands")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("type", "=", "run.steer")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  });

  it("leaves a report pending on an idle Thread", async () => {
    const fixture = await createMessagingFixture();

    const queued = await service.handle(fixture.tokenA, {
      content: [{ text: "The contract is signed.", type: "text" }],
      delivery: "report",
      requestId: randomUUID(),
      threadId: fixture.threadB.id,
      type: "thread.message",
    });
    if (queued.type !== "thread.message.result") throw new Error("Expected a message result");

    expect(queued.result.disposition).toBe("pending");
    expect(queued.result.run).toBeNull();
    expect(queued.result.input).toMatchObject({
      messageId: queued.result.message.id,
      policy: "report",
      runId: null,
      state: "pending",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("id")
        .where("threadId", "=", fixture.threadB.id)
        .where("type", "in", ["run.execute", "run.steer"])
        .execute(),
    ).resolves.toEqual([]);
  });

  /*
   * Commands now run side by side across Threads. Failure modes against a real
   * database: concurrent transactions deadlock or lose a command; one Thread's
   * messages queue out of the order they were sent.
   */
  it("admits a burst of sends across Threads without losing one or reordering a Thread", async () => {
    const fixture = await createMessagingFixture();
    const threads = [fixture.threadA, fixture.threadB];
    for (let index = 0; index < 6; index += 1) {
      const { thread } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstanceId,
        idempotencyKey: `burst-thread-${index}-${randomUUID()}`,
        modelSelection: testModelSelection,
        title: `Burst ${index}`,
        workspaceId: fixture.threadA.workspaceId,
      });
      threads.push(thread);
    }
    const sends = threads.flatMap((thread) =>
      Array.from({ length: 5 }, (_unused, order) =>
        commands.enqueueThreadInput({
          content: [{ text: `${thread.id} ${order}`, type: "text" }],
          idempotencyKey: `burst-${thread.id}-${order}`,
          policy: "queue",
          requestedBy: fixture.userId,
          source: { kind: "human" },
          threadId: thread.id,
        }),
      ),
    );

    const settled = await Promise.allSettled(sends);

    expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
    for (const thread of threads) {
      const queued = await database
        .selectFrom("threadInputs")
        .innerJoin("messages", "messages.id", "threadInputs.messageId")
        .select("messages.content")
        .where("threadInputs.threadId", "=", thread.id)
        .where("messages.content", "@>", sql<never>`${JSON.stringify([{ type: "text" }])}::jsonb`)
        .orderBy("threadInputs.queueRank", "asc")
        .execute();
      const burst = queued
        .map((row) => (row.content as readonly { readonly text?: string }[])[0]?.text ?? "")
        .filter((text) => text.startsWith(`${thread.id} `));
      expect(burst).toEqual([0, 1, 2, 3, 4].map((order) => `${thread.id} ${order}`));
    }
  });

  it.each([undefined, "Agent chose this"])(
    "delegates with title %s and reads the live worker title in summaries",
    async (title) => {
      const fixture = await createMessagingFixture();
      const task = "\n  Research  contract changes \nwith the full instructions";
      const response = await service.handle(fixture.tokenA, {
        requestId: randomUUID(),
        type: "thread.delegate",
        task,
        workspaceId: fixture.threadA.workspaceId,
        ...(title === undefined ? {} : { title }),
      });
      if (response.type !== "thread.delegate.result") throw new Error("Expected delegation");
      if (!response.result.run) throw new Error("Expected a delegated Run");
      const worker = response.result.thread;
      const summary = async () =>
        (
          await store.listThreadAssignmentsForOwner({
            ownerId: fixture.userId,
            threadId: fixture.threadA.id,
          })
        )?.assignments.find((assignment) => assignment.id === response.result.assignmentId);
      const row = await database
        .selectFrom("threads")
        .select(["title", "titleSource"])
        .where("id", "=", worker.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        title: title ?? provisionalThreadTitle(task),
        titleSource: title === undefined ? "provisional" : "chosen",
      });
      const event = await store.applyGeneratedThreadName({
        threadId: worker.id,
        title: "Contract research",
      });
      expect(event === null).toBe(title !== undefined);
      expect((await summary())?.workerThread.title).toBe(title ?? "Contract research");
      await commands.renameThread({
        idempotencyKey: randomUUID(),
        requestedBy: fixture.userId,
        threadId: worker.id,
        title: "Reviewed contract",
      });
      expect((await summary())?.workerThread.title).toBe("Reviewed contract");
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", response.result.run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(command.id, "title-dispatcher");
      expect((await store.loadRunDispatchContext(command.id)).titleRequest).toEqual({
        request: task.trim(),
        icon: true,
      });
      await commands.cancelAssignment({
        assignmentId: response.result.assignmentId,
        idempotencyKey: randomUUID(),
        requestedBy: fixture.userId,
      });
      const reused = await service.handle(fixture.tokenA, {
        requestId: randomUUID(),
        type: "thread.delegate",
        task: "Another task",
        threadId: worker.id,
      });
      if (reused.type !== "thread.delegate.result") throw new Error("Expected reuse");
      expect(
        await database
          .selectFrom("threads")
          .select(["title", "titleSource"])
          .where("id", "=", worker.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ title: "Reviewed contract", titleSource: "chosen" });
    },
  );

  it("chooses a new delegated icon and preserves every mark when reusing a worker", async () => {
    const f = await createMessagingFixture();
    const response = await service.handle(f.tokenA, {
      type: "thread.delegate",
      requestId: randomUUID(),
      task: "Book a flight",
      icon: "plane",
      workspaceId: f.threadA.workspaceId,
    });
    if (response.type !== "thread.delegate.result") throw new Error("Expected delegation");
    const worker = response.result.thread;
    const before = await database
      .selectFrom("threads")
      .select(["icon", "iconSource", "color"])
      .where("id", "=", worker.id)
      .executeTakeFirstOrThrow();
    expect(before).toEqual({ icon: "plane", iconSource: "chosen", color: worker.color });
    await commands.cancelAssignment({
      assignmentId: response.result.assignmentId,
      idempotencyKey: randomUUID(),
      requestedBy: f.userId,
    });
    await expect(
      service.handle(f.tokenA, {
        type: "thread.delegate",
        requestId: randomUUID(),
        threadId: worker.id,
        task: "New task",
        icon: "hotel",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const reused = await service.handle(f.tokenA, {
      type: "thread.delegate",
      requestId: randomUUID(),
      threadId: worker.id,
      task: "New task",
    });
    if (reused.type !== "thread.delegate.result") throw new Error("Expected reuse");
    expect(
      await database
        .selectFrom("threads")
        .select(["icon", "iconSource", "color"])
        .where("id", "=", worker.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });

  it.each([undefined, "Explicit legacy title"])(
    "replays legacy agent delegation receipts with title %s and rejects changed intent",
    async (title) => {
      const fixture = await createMessagingFixture();
      const task = "Research contract changes " + "with the full instructions ".repeat(14);
      const request = {
        requestId: randomUUID(),
        type: "thread.delegate",
        task,
        workspaceId: fixture.threadA.workspaceId,
        ...(title === undefined ? {} : { title }),
      };
      const response = await service.handle(fixture.tokenA, request);
      if (response.type !== "thread.delegate.result") throw new Error("Expected delegation");
      expect(await service.handle(fixture.tokenA, request)).toMatchObject({
        type: "thread.delegate.result",
        result: {
          thread: { id: response.result.thread.id },
          assignmentId: response.result.assignmentId,
        },
      });
      await expect(
        service.handle(fixture.tokenA, { ...request, task: task + " changed" }),
      ).rejects.toMatchObject({ code: "conflict" });
      await sql`update commands set payload = (payload - 'titleSource' - 'callerIntent') ||
        jsonb_build_object('title', ${title ?? task.slice(0, 240)}::text)
        where payload->>'type' = 'thread.delegate' and thread_id = ${response.result.thread.id}`.execute(
        database,
      );
      const replay = await service.handle(fixture.tokenA, request);
      expect(replay).toMatchObject({
        type: "thread.delegate.result",
        result: {
          thread: { id: response.result.thread.id },
          assignmentId: response.result.assignmentId,
        },
      });
      for (const changed of [{ task: task + " changed" }, { title: "Changed explicit name" }]) {
        await expect(
          service.handle(fixture.tokenA, { ...request, ...changed }),
        ).rejects.toMatchObject({
          code: "conflict",
        });
      }
      await titleEvidence(`legacy-agent-${title === undefined ? "untitled" : "chosen"}`, {
        replay,
      });
    },
  );

  it("keeps agent Workspace create compatible with the baseline Runner while storing the requested colour", async () => {
    const f = await createMessagingFixture();
    const response = await service.handle(f.tokenA, {
      type: "workspace.create",
      requestId: randomUUID(),
      name: "Travel",
      icon: "plane",
      color: "teal",
    });
    expect(baselineWorkspaceCreateResponse.parse(response)).toEqual(response);
    if (response.type !== "workspace.create.result") throw new Error("Expected Workspace");
    expect(await store.getWorkspaceForOwner(response.workspace.id, f.userId)).toMatchObject({
      icon: "plane",
      color: "teal",
    });
  });

  it.each(["rename", "generated", "icon", "generated-icon"] as const)(
    "republishes completed cross-Workspace assignment titles after %s",
    async (mode) => {
      const fixture = await createMessagingFixture();
      const workspace = await store.createWorkspace({
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: randomUUID(),
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        createdBy: fixture.userId,
        idempotencyKey: randomUUID(),
        name: "Worker workspace",
        status: "ready",
      });
      const response = await service.handle(fixture.tokenA, {
        requestId: randomUUID(),
        type: "thread.delegate",
        task: "Research the contract",
        workspaceId: workspace.id,
      });
      if (response.type !== "thread.delegate.result" || !response.result.run)
        throw new Error("Expected delegated Run");
      const worker = response.result.thread;
      const run = response.result.run;
      await store.claimCommand(await pendingCommandIdForRun(run.id), "title-review-dispatcher");
      const binding = await activateClaimedRun(fixture, run, worker);
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: "boot-1",
        runnerId: fixture.runnerId,
        event: {
          bindingGeneration: binding.bindingGeneration,
          data: { status: "completed" },
          emittedAt: new Date().toISOString(),
          environmentId: fixture.environmentId,
          ordinal: 1,
          runId: run.id,
          threadId: worker.id,
          type: "run.completed",
          workspaceId: workspace.id,
        },
      });
      await store.drainPendingAssignmentReturns();
      const before = await database
        .selectFrom("delegations")
        .selectAll()
        .where("id", "=", response.result.assignmentId)
        .executeTakeFirstOrThrow();
      expect(before.status).toBe("completed");
      const reused = await store.delegateThread({
        accessMode: worker.accessMode,
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstanceId,
        idempotencyKey: randomUUID(),
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: fixture.runA.id, parentThreadId: fixture.threadA.id },
        task: [{ text: "Follow up on the contract", type: "text" }],
        threadId: worker.id,
        title: "Follow-up seed",
        titleSource: "provisional",
        workspaceId: workspace.id,
      });
      expect(reused.assignment.status).toBe("open");
      const head = await database
        .selectFrom("workspaces")
        .select("eventSequence")
        .where("id", "=", fixture.threadA.workspaceId)
        .executeTakeFirstOrThrow();
      const title =
        mode === "rename"
          ? "Reviewed contract"
          : mode === "generated"
            ? "Contract research"
            : worker.title;
      const icon = mode === "icon" || mode === "generated-icon" ? "plane" : null;
      const events: AgentEvent[] = [];
      if (mode === "rename" || mode === "icon") {
        const changed = new CommandService({
          admission,
          onExecutionQueued: () => undefined,
          onWorkspaceEvent: (event) => events.push(event),
          store,
        });
        await (mode === "icon"
          ? changed.setThreadIcon({
              icon: "plane",
              requestedBy: fixture.userId,
              threadId: worker.id,
              idempotencyKey: randomUUID(),
            })
          : changed.renameThread({
              idempotencyKey: randomUUID(),
              requestedBy: fixture.userId,
              threadId: worker.id,
              title,
            }));
      } else {
        const result = await store.applyGeneratedThreadName({
          threadId: worker.id,
          ...(mode === "generated-icon" ? { icon: "plane" as const } : { title }),
        });
        if (result) events.push(...result.events);
      }
      const updates = await database
        .selectFrom("workspaceEvents")
        .selectAll()
        .where("workspaceId", "=", fixture.threadA.workspaceId)
        .where("sequence", ">", head.eventSequence)
        .where("type", "=", "assignment.updated")
        .execute();
      expect(updates).toHaveLength(2);
      for (const assignment of [before, reused.assignment]) {
        expect(updates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              threadId: fixture.threadA.id,
              data: {
                assignment: expect.objectContaining({
                  id: assignment.id,
                  revision: assignment.revision + 1,
                  status: assignment.status,
                  workerThread: expect.objectContaining({ title, icon, color: worker.color }),
                }),
              },
            }),
          ]),
        );
      }
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workspaceId: fixture.threadA.workspaceId,
            threadId: fixture.threadA.id,
            type: "assignment.updated",
          }),
          expect.objectContaining({
            workspaceId: workspace.id,
            threadId: worker.id,
            type: "assignment.updated",
          }),
        ]),
      );
      const otherOwner = await store.createUser("Parent workspace owner");
      const tokenHash = `sha256:${randomUUID()}`;
      const invitation = await store.createWorkspaceInvitation({
        createdBy: fixture.userId,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: randomUUID(),
        intendedEmail: null,
        requestFingerprint: `sha256:${randomUUID()}`,
        role: "owner",
        selector: randomUUID(),
        tokenHash,
        type: "link",
        workspaceId: fixture.threadA.workspaceId,
      });
      await store.acceptWorkspaceInvitation({
        selector: invitation.selector,
        tokenHash,
        userEmail: "parent-owner@titles.test",
        userEmailVerified: true,
        userId: otherOwner,
      });
      const parentHead = await database
        .selectFrom("workspaces")
        .select("eventSequence")
        .where("id", "=", fixture.threadA.workspaceId)
        .executeTakeFirstOrThrow();
      await database
        .updateTable("workspaceMemberships")
        .set({ state: "revoked", revokedAt: new Date(), revokedBy: fixture.userId })
        .where("workspaceId", "=", fixture.threadA.workspaceId)
        .where("userId", "=", fixture.userId)
        .execute();
      const hidden = await store.renameThread({
        idempotencyKey: randomUUID(),
        requestedBy: fixture.userId,
        threadId: worker.id,
        title: "Private worker title",
      });
      expect(hidden.events?.filter((event) => event.type === "assignment.updated")).toHaveLength(2);
      expect(
        hidden.events?.some((event) => event.workspaceId === fixture.threadA.workspaceId),
      ).toBe(false);
      expect(
        await database
          .selectFrom("workspaceEvents")
          .select("eventId")
          .where("workspaceId", "=", fixture.threadA.workspaceId)
          .where("sequence", ">", parentHead.eventSequence)
          .execute(),
      ).toEqual([]);
      await titleEvidence(`completed-${mode}`, { before, updates, events, hidden });
    },
  );

  async function titleEvidence(name: string, result: unknown) {
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, `${name}.json`), JSON.stringify(result, null, 2));
    console.info(`Title review receipt: ${join(evidenceRoot, `${name}.json`)}`);
  }

  it("thread_write shares Done, freezes messages and delegation, and reopens through the same authority", async () => {
    const f = await createMessagingFixture();
    const write = (action: string, fields = {}) =>
      service.handle(f.tokenA, {
        type: "thread.write",
        requestId: randomUUID(),
        input: { threadId: f.threadB.id, action, ...fields },
      });
    expect(await write("rename", { title: "Shared result" })).toMatchObject({
      type: "thread.write.result",
      doneWhenRunEnds: false,
      thread: { title: "Shared result", doneAt: null },
    });
    expect(await write("set_icon", { icon: null })).toMatchObject({
      type: "thread.write.result",
      doneWhenRunEnds: false,
    });
    const done = await write("done");
    expect(done).toMatchObject({
      type: "thread.write.result",
      doneWhenRunEnds: false,
      thread: { id: f.threadB.id, doneAt: expect.any(String) },
    });
    await expect(
      service.handle(f.tokenA, {
        type: "thread.message",
        requestId: randomUUID(),
        threadId: f.threadB.id,
        content: [{ type: "text", text: "No new work" }],
        delivery: "queue",
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "This task is Done. Reopen it first." });
    await expect(
      service.handle(f.tokenA, {
        type: "thread.delegate",
        requestId: randomUUID(),
        threadId: f.threadB.id,
        task: "No delegation",
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "This task is Done. Reopen it first." });
    expect(await write("reopen")).toMatchObject({ thread: { doneAt: null } });
    const next = await service.handle(f.tokenA, {
      type: "thread.message",
      requestId: randomUUID(),
      threadId: f.threadB.id,
      content: [{ type: "text", text: "Now run" }],
      delivery: "queue",
    });
    expect(next).toMatchObject({
      type: "thread.message.result",
      result: { run: { status: "queued" } },
    });
    await mkdir("/tmp/opensteer-task-done", { recursive: true });
    await writeFile(
      "/tmp/opensteer-task-done/agent-host.json",
      JSON.stringify({ done, next, threadId: f.threadB.id, runId: f.runA.id }, null, 2),
    );
  });

  it("gates thread_write on the bound Runner capability and returns the compact Thread summary", async () => {
    const f = await createMessagingFixture();
    const claims = claimsByToken.get(f.tokenA)!;
    const mcp = new AgentToolsMcpService({
      agentControl: service,
      publicUrl: new URL("http://localhost"),
      store,
      runnerCapabilities: async (scope) => (await store.runnerCapabilities(scope.runnerId)) ?? [],
      tokens: { authenticate: async () => claims } as unknown as AgentControlTokenService,
    });
    const inventories: string[][] = [];
    try {
      for (const modern of [true, false]) {
        if (!modern)
          await database
            .updateTable("runners")
            .set({ capabilities: sql`${JSON.stringify(["filesystem"])}::jsonb` })
            .where("id", "=", f.runnerId)
            .execute();
        const server = await mcp.createServer({
          control: service,
          profileId: claims.capabilityProfileId,
          run: claims,
          scope: "run",
          subjectId: claims.runId,
          toolContractVersion: null,
        });
        const client = new Client({ name: "task-done-test", version: "1" });
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport);
          const receive = serverTransport.onmessage!;
          serverTransport.onmessage = (message, extra) =>
            receive(message, {
              ...extra,
              authInfo: { token: f.tokenA, clientId: "task-done-test", scopes: [] },
            });
          await client.connect(clientTransport);
          const names = (await client.listTools()).tools.map(({ name }) => name);
          inventories.push(names);
          expect(names.includes("thread_write")).toBe(modern);
          if (modern) {
            const result = await client.callTool({
              name: "thread_write",
              arguments: { threadId: f.threadB.id, action: "rename", title: "MCP write" },
            });
            expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
            expect(result.structuredContent).toMatchObject({
              thread: { id: f.threadB.id, title: "MCP write", doneAt: null },
              doneWhenRunEnds: false,
            });
          }
        } finally {
          await client.close();
          await server.close();
        }
      }
      await expect(
        service.handle(f.tokenA, {
          type: "thread.write",
          requestId: randomUUID(),
          input: { action: "done" },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await mkdir("/tmp/opensteer-task-done", { recursive: true });
      await writeFile(
        "/tmp/opensteer-task-done/runner-capability.json",
        JSON.stringify({ runId: f.runA.id, inventories }, null, 2),
      );
    } finally {
      await mcp.close();
    }
  });

  async function createMessagingFixture() {
    const userId = await store.createUser("Alex");
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    await enrollTestRunner({ createdBy: userId, environmentId, runnerId });
    const mainWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `wsp_main_${randomUUID()}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      idempotencyKey: `messaging-main-${randomUUID()}`,
      name: "Main workspace",
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
    const { thread: threadA } = await store.createThread({
      createdBy: userId,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      idempotencyKey: `messaging-thread-a-${randomUUID()}`,
      modelSelection: testModelSelection,
      title: "Contract coordination",
      workspaceId: mainWorkspace.id,
    });
    const { thread: threadB } = await store.createThread({
      createdBy: userId,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      idempotencyKey: `messaging-thread-b-${randomUUID()}`,
      modelSelection: testModelSelection,
      title: "Client research",
      workspaceId: mainWorkspace.id,
    });
    expect(threadA.capabilityProfileId).toBe("main");
    expect(threadB.capabilityProfileId).toBe("main");

    const humanTurn = await commands.enqueueThreadInput({
      content: [{ text: "Coordinate the contract review", type: "text" }],
      idempotencyKey: `messaging-human-${randomUUID()}`,
      policy: "queue",
      requestedBy: userId,
      source: { kind: "human" },
      threadId: threadA.id,
    });
    if (!humanTurn.command || !humanTurn.run) {
      throw new Error("Expected the initial human input to queue a Run");
    }
    await store.claimCommand(humanTurn.command.id, "messaging-dispatcher");
    await activateClaimedRun(
      {
        environmentId,
        harnessInstanceId: harnessInstance.id,
        runnerId,
      },
      humanTurn.run,
      threadA,
    );
    const tokenA = `token-a-${randomUUID()}`;
    claimsByToken.set(
      tokenA,
      testClaims({
        capabilityProfileId: threadA.capabilityProfileId,
        environmentId,
        requestedBy: userId,
        runId: humanTurn.run.id,
        runnerId,
        threadId: threadA.id,
        workspaceId: threadA.workspaceId,
      }),
    );
    return {
      environmentId,
      harnessInstanceId: harnessInstance.id,
      humanCommandId: humanTurn.command.id,
      runA: humanTurn.run,
      runnerId,
      threadA,
      threadB,
      tokenA,
      tokenB: `token-b-${randomUUID()}`,
      userId,
    };
  }

  /** Drives a Thread's head Run to `running` on a live execution binding. */
  async function startRun(
    fixture: Awaited<ReturnType<typeof createMessagingFixture>>,
    thread: Thread,
  ) {
    const turn = await commands.enqueueThreadInput({
      content: [{ text: "Start the research", type: "text" }],
      idempotencyKey: `messaging-start-${randomUUID()}`,
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    if (!turn.command || !turn.run) throw new Error("Expected the input to queue a Run");
    const runnerBootId = "boot-1";
    await store.claimCommand(turn.command.id, "messaging-dispatcher");
    const binding = await activateClaimedRun(fixture, turn.run, thread, runnerBootId);
    return { bindingGeneration: binding.bindingGeneration, runId: turn.run.id, runnerBootId };
  }

  async function activateClaimedRun(
    fixture: Pick<
      Awaited<ReturnType<typeof createMessagingFixture>>,
      "environmentId" | "harnessInstanceId" | "runnerId"
    >,
    run: Run,
    thread: Thread,
    runnerBootId = "boot-1",
  ) {
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: HarnessIdSchema.parse("native"),
      },
      harnessInstanceId: fixture.harnessInstanceId,
      leaseTokenHash: `lease-${randomUUID()}`,
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: run.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: {
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        emittedAt: new Date().toISOString(),
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: run.id,
        threadId: thread.id,
        type: "run.started",
        workspaceId: thread.workspaceId,
      },
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    return binding;
  }

  async function pendingCommandIdForRun(runId: ReturnType<typeof createId<"run">>) {
    const row = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function enrollTestRunner(input: {
    readonly createdBy: UserId;
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    readonly runnerId: ReturnType<typeof createId<"runner">>;
  }): Promise<void> {
    if (!(await store.getDeployment())) {
      await store.ensureDeployment({
        canonicalOrigin: "https://agent-messaging.opensteer.test",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: {
          defaultWorkspaceBacking: "portablefs",
          kind: "server" as const,
        },
      });
    }
    const pair = generateKeyPairSync("ed25519");
    const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
    const descriptor: RunnerDescriptor = {
      bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
      capabilities: ["filesystem", "task-done-v1"],
      modules: {
        agents: {
          environmentIds: [input.environmentId],
          harnessDrivers: [
            {
              accessModes: [...ThreadAccessModeSchema.options],
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
      name: "Main runner",
      runnerId: input.runnerId,
      runnerKind: "main",
      runtimeVersion: "test",
    };
    const suffix = randomUUID();
    const enrollmentTokenHash = `sha256:${createHash("sha256")
      .update(`agent-messaging-${suffix}`, "utf8")
      .digest("base64url")}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: `agent-messaging-runner-${suffix}`,
      mainEnrollmentPurpose: "initial",
      name: descriptor.name,
      requestFingerprint: `sha256:agent-messaging-${suffix}`,
      runnerKind: "main",
      tokenHash: enrollmentTokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor,
      enrollmentTokenHash,
      publicKeyFingerprint: `sha256:${createHash("sha256")
        .update(publicKeyDer)
        .digest("base64url")}`,
      publicKeyPem,
    });
  }
});

function testClaims(input: {
  readonly capabilityProfileId: Thread["capabilityProfileId"];
  readonly environmentId: ReturnType<typeof createId<"environment">>;
  readonly requestedBy: UserId;
  readonly runId: ReturnType<typeof createId<"run">>;
  readonly runnerId: ReturnType<typeof createId<"runner">>;
  readonly threadId: Thread["id"];
  readonly workspaceId: Thread["workspaceId"];
}): AgentControlRunScope {
  return {
    aud: "opensteer-agent-control",
    bindingGeneration: 1,
    exp: Math.floor(Date.now() / 1_000) + 60,
    iat: Math.floor(Date.now() / 1_000),
    iss: "opensteer-host",
    jti: randomUUID(),
    membershipGeneration: 1,
    runnerBootId: "boot-1",
    ...input,
  };
}

function projectHarnessInputs(messages: readonly Message[]) {
  return messages.map((message) =>
    HarnessInputSchema.parse({
      author: message.author,
      content: message.content,
      createdAt: message.createdAt,
      kind: message.kind,
      messageId: message.id,
    }),
  );
}

async function unexpected(): Promise<never> {
  throw new Error("Unexpected agent control dependency call");
}
