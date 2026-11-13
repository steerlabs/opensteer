import { expect } from "vitest";
import {
  createId,
  MessageIdSchema,
  TeamMessageIdSchema,
  TeamTurnContextSchema,
  type RunId,
  type TeamSource,
} from "@opensteer/core";
import { TeamRunRequestSchema } from "@opensteer/protocol";
import { describeStore, type StoreFixture } from "@opensteer/database/test-support/store";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { admitTeamTaskRequest } from "@opensteer/database/task-admission-store";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { personalTeamRunOutcome } from "@opensteer/database/personal-team-run-store";
import { needsYouPage, NotificationStore } from "@opensteer/database";
import { TeamRunTools } from "./tools.js";
import { PersonalTeamRequests } from "./requests.js";
import { TaskAdmissionService } from "../threads/task-admission-service.js";
import type { TeamLinkCallInput, TeamLinkResult } from "../team-link-endpoint/contracts.js";

async function consentFixture(base: StoreFixture) {
  const personal = await base.createRunFixture("Consent");
  const database = base.database;
  const execution = {
    environmentId: personal.environmentId,
    harnessInstanceId: personal.harnessInstance.id,
    modelSelection: personal.thread.modelSelection,
  };
  const origin = {
    teamId: createId("deployment"),
    channelId: createId("teamChannel"),
    threadRootId: TeamMessageIdSchema.parse("1"),
  };
  const source: TeamSource = {
    ...origin,
    messageId: TeamMessageIdSchema.parse("2"),
    audience: {
      teamName: "Studio",
      channelName: "Design",
      channelKind: "private",
      memberCount: 2,
      peopleOnly: false,
    },
  };
  await database
    .insertInto("personalTeamLinks")
    .values({
      id: crypto.randomUUID(),
      teamDeploymentId: origin.teamId,
      teamHostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: "fixture",
      approvedOrigin: "https://team.example.invalid",
      authorityEnvelope: {},
      state: "active",
    })
    .execute();
  const f = {
    ...personal,
    database,
    execution,
    origin,
    source,
    ask: () =>
      admitTeamTaskRequest(database, {
        bodyMarkdown: "Asking task",
        origin,
        source,
        requestId: createId("teamAgentRequest"),
        triggerMessageId: TeamMessageIdSchema.parse("3"),
        ownerId: personal.userId,
        execution,
      }),
    start: (runId: RunId) => startPersonalQueuedRunFixture(base.store, runId),
  };
  await f.database
    .updateTable("personalTeamLinks")
    .set({ remoteOwnerUserId: f.userId, remoteLinkId: createId("teamLink") })
    .where("teamDeploymentId", "=", f.origin.teamId)
    .execute();
  const store = new PersonalTeamRequestsStore(f.database);
  const presentation = {
    asker: { teamUserId: createId("user"), displayName: "Maya", actor: "agent" as const },
    bodyMarkdown: "Please check the launch using your notes.",
    attachments: [],
    destination: f.origin,
    audience: f.source.audience,
  };
  const frame = TeamRunRequestSchema.parse({
    request: {
      id: createId("teamAgentRequest"),
      kind: "ask",
      ownerUserId: f.userId,
      channelId: f.origin.channelId,
      threadRootId: f.origin.threadRootId,
      triggerMessageId: "2",
      state: "awaiting_approval",
      steps: [],
      createdAt: new Date().toISOString(),
      consentExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      acceptedAt: null,
      expiresAt: null,
      finishedAt: null,
      replyMessageId: null,
      failureCode: null,
      changeSeq: "1",
    },
    source: { ...f.source, messageId: "2" },
    presentation,
    bodyMarkdown: presentation.bodyMarkdown,
    attachments: [],
  });
  let offline = false;
  let missing = false;
  let acknowledged = false;
  let returnPersistedBeforeAck = false;
  const calls: TeamLinkCallInput[] = [];
  const publisher = new PersonalTeamRequests({
    links: new PersonalTeamLinksStore(f.database),
    requests: store,
    admission: new TaskAdmissionService({
      database: f.database,
      execution: async () => f.execution,
      publish() {},
      revokeGrants() {},
    }),
    runs: { outcome: (request) => personalTeamRunOutcome(f.database, request) },
    rpc: () => ({
      call: async (input): Promise<TeamLinkResult> => {
        calls.push(input);
        if (offline)
          throw new (await import("@opensteer/core")).OpensteerError({
            code: "runner_offline",
            message: "Offline",
          });
        if (input.type === "accept") {
          const saved = await store.mirror(f.origin.teamId, input.requestId);
          if (saved?.kind === "return") {
            returnPersistedBeforeAck = saved.returnAdmission !== null;
            return {
              kind: "accepted",
              request: {
                ...frame.request,
                id: input.requestId,
                kind: "return",
                consentExpiresAt: null,
                state: "done",
              },
            };
          }
          if (saved?.kind === "self")
            return {
              kind: "accepted",
              request: {
                ...frame.request,
                id: input.requestId,
                kind: "self",
                consentExpiresAt: null,
                state: "queued",
              },
            };
          expect(saved?.localDecision).toBe(input.decision);
          acknowledged = true;
          return {
            kind: "accepted",
            request: {
              ...frame.request,
              state: input.decision === "decline" ? "declined" : "queued",
            },
          };
        }
        if (input.type === "reconcile")
          return {
            kind: "reconciled",
            requests: await Promise.all(
              input.requestIds.map(async (requestId) => {
                const saved = await store.mirror(f.origin.teamId, requestId);
                return {
                  requestId,
                  request: missing
                    ? null
                    : {
                        ...frame.request,
                        id: requestId,
                        kind: saved!.kind,
                        consentExpiresAt:
                          saved!.kind === "ask" ? frame.request.consentExpiresAt : null,
                        state:
                          saved!.kind === "ask"
                            ? ("awaiting_approval" as const)
                            : ("queued" as const),
                      },
                };
              }),
            ),
          };
        if (input.type === "context")
          return {
            kind: "context",
            context: {
              request: { ...frame.request, state: "queued" },
              presentation: frame.presentation,
              source: frame.source,
              audience: frame.source.audience,
              instructionsMarkdown: "",
              instructionsRevision: frame.request.changeSeq,
            },
          };
        if (input.type === "receipt") return { kind: "receipt", messageId: null };
        return { kind: "ok" };
      },
    }),
  });
  return {
    ...f,
    store,
    frame,
    publisher,
    calls,
    offline: (value: boolean) => {
      offline = value;
    },
    missing: () => {
      missing = true;
    },
    acknowledged: () => acknowledged,
    returnPersistedBeforeAck: () => returnPersistedBeforeAck,
  };
}

describeStore("personal team consent and returns", (it) => {
  it("persists consent without work, replays approval after a lost ack, and resolves device races", async ({
    storeFixture,
  }) => {
    const f = await consentFixture(storeFixture);
    const counts = async () =>
      Promise.all(
        ["threads", "runs", "requests"].map((table) =>
          f.database
            .selectFrom(table as "threads")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow(),
        ),
      );
    const before = await counts();
    const admit = () =>
      admitTeamTaskRequest(f.database, {
        bodyMarkdown: f.frame.bodyMarkdown,
        origin: f.origin,
        requestId: f.frame.request.id,
        triggerMessageId: f.frame.request.triggerMessageId,
        source: f.frame.source,
        ownerId: f.userId,
        execution: f.execution,
      });
    await f.publisher.deliver(f.origin.teamId, f.frame);
    await f.publisher.deliver(f.origin.teamId, f.frame);
    expect(await counts()).toEqual(before);
    await expect(admit()).rejects.toMatchObject({ code: "forbidden" });
    expect(await needsYouPage(f.database, { userId: f.userId })).toMatchObject({
      count: 1,
      entries: [{ kind: "team-ask", presentation: f.frame.presentation }],
    });
    const notifications = new NotificationStore(f.database);
    const notification = await notifications.teamAsk(f.origin.teamId, f.frame.request.id);
    expect(notification).toMatchObject({ kind: "request-opened", threadId: null });
    expect(await notifications.publicationSkipReason(notification!)).toBeNull();
    f.offline(true);
    await expect(
      f.publisher.decide(f.userId, f.origin.teamId, f.frame.request.id, "approve"),
    ).rejects.toMatchObject({ code: "runner_offline" });
    expect(f.acknowledged()).toBe(false);
    await expect(admit()).rejects.toMatchObject({ code: "forbidden" });
    expect(await counts()).toEqual(before);
    expect(await notifications.publicationSkipReason(notification!)).toContain("no longer");
    await expect(
      f.publisher.decide(f.userId, f.origin.teamId, f.frame.request.id, "decline"),
    ).rejects.toMatchObject({ code: "conflict" });
    f.offline(false);
    await Promise.all([
      f.publisher.reconnect(f.origin.teamId),
      f.publisher.decide(f.userId, f.origin.teamId, f.frame.request.id, "approve"),
    ]);
    const saved = (await f.store.get(f.origin.teamId, f.frame.request.id))!;
    expect(saved).toMatchObject({ localDecision: "approve", remoteState: "queued" });
    const message = await f.database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", MessageIdSchema.parse(saved.inputId))
      .executeTakeFirstOrThrow();
    expect(message.author).toMatchObject({ kind: "team-member", ...f.frame.presentation!.asker });
    const inputs = await f.database
      .selectFrom("threadInputs")
      .selectAll()
      .where("threadId", "=", saved.taskId)
      .execute();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      requestedBy: f.userId,
      replyTarget: { kind: "team-thread", requestId: f.frame.request.id },
    });
    expect((await needsYouPage(f.database, { userId: f.userId })).count).toBe(0);
    const provider = await f.database
      .selectFrom("providerSessions")
      .select("personalContext")
      .where("threadId", "=", saved.taskId)
      .executeTakeFirstOrThrow();
    expect(provider.personalContext).toBe(true);
    const context = await new TeamRunTools(
      f.publisher.options.links,
      f.store,
      f.publisher.options.rpc,
    ).context(saved.runId!);
    expect(
      TeamTurnContextSchema.parse({
        kind: "team",
        asker: context.asker,
        source: context.source,
        instructionsMarkdown: context.instructionsMarkdown,
        instructionsRevision: context.instructionsRevision,
      }),
    ).toMatchObject({
      asker: { displayName: "Maya", actor: "agent" },
    });
  });

  it("declines without admission and removes stale consent on reconnect", async ({
    storeFixture,
  }) => {
    const f = await consentFixture(storeFixture);
    await f.publisher.deliver(f.origin.teamId, f.frame);
    await expect(
      f.publisher.decide(createId("user"), f.origin.teamId, f.frame.request.id, "approve"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.publisher.decide(f.userId, f.origin.teamId, f.frame.request.id, "decline");
    expect(await f.store.mirror(f.origin.teamId, f.frame.request.id)).toMatchObject({
      taskId: null,
      localDecision: "decline",
      remoteState: "declined",
    });
    const second = {
      ...f.frame,
      request: { ...f.frame.request, id: createId("teamAgentRequest") },
    };
    await f.publisher.deliver(f.origin.teamId, second);
    expect((await needsYouPage(f.database, { userId: f.userId })).count).toBe(1);
    f.missing();
    await f.publisher.reconnect(f.origin.teamId);
    expect((await needsYouPage(f.database, { userId: f.userId })).count).toBe(0);
    expect((await f.store.mirror(f.origin.teamId, second.request.id))?.taskId).toBeNull();
  });

  for (const mode of ["team", "private-background"] as const)
    it(`admits a return once privately behind active work, before accepting (${mode})`, async ({
      storeFixture,
    }) => {
      const f = await consentFixture(storeFixture);
      const privateInput =
        mode === "private-background"
          ? await storeFixture.store.enqueueThreadInput({
              threadId: f.thread.id,
              requestedBy: f.userId,
              source: { kind: "human" },
              policy: "queue",
              content: [{ type: "text", text: "Ask a teammate" }],
              idempotencyKey: "private-asking-run",
            })
          : null;
      const asking = privateInput
        ? {
            receipt: {
              taskId: f.thread.id,
              inputId: privateInput.message.id,
              runId: privateInput.run!.id,
            },
          }
        : await f.ask();
      await f.start(asking.receipt.runId!);
      if (privateInput)
        await f.database
          .updateTable("runs")
          .set({ phase: "background" })
          .where("id", "=", asking.receipt.runId!)
          .execute();
      const returned = {
        ...f.frame,
        request: {
          ...f.frame.request,
          id: createId("teamAgentRequest"),
          kind: "return" as const,
          state: "queued" as const,
          consentExpiresAt: null,
        },
        presentation: null,
        returnPayload: {
          originAskId: createId("teamAgentRequest"),
          resumeRunId: asking.receipt.runId!,
          outcome: "answered" as const,
          bodyMarkdown: "The answer is ready.",
          attachments: [],
          author: { ...f.frame.presentation!.asker, actor: "agent" as const },
        },
      };
      f.offline(true);
      await expect(f.publisher.deliver(f.origin.teamId, returned)).rejects.toMatchObject({
        code: "runner_offline",
      });
      f.offline(false);
      await f.publisher.reconnect(f.origin.teamId);
      await Promise.all([
        f.publisher.deliver(f.origin.teamId, returned),
        f.publisher.deliver(f.origin.teamId, returned),
      ]);
      expect(f.returnPersistedBeforeAck()).toBe(true);
      const saved = (await f.store.mirror(f.origin.teamId, returned.request.id))!;
      expect(saved).toMatchObject({
        returnAdmission: "admitted",
        taskId: asking.receipt.taskId,
        runId: null,
      });
      const queued = await f.database
        .selectFrom("threadInputs")
        .selectAll()
        .where("threadId", "=", asking.receipt.taskId)
        .where("teamRequestId", "is", null)
        .where("messageId", "!=", asking.receipt.inputId)
        .execute();
      expect(queued).toHaveLength(1);
      const sourceRun = await f.database
        .selectFrom("runs")
        .select("causalChainId")
        .where("id", "=", asking.receipt.runId!)
        .executeTakeFirstOrThrow();
      expect(queued[0]!.causalChainId).toBe(sourceRun.causalChainId);
      expect(queued[0]).toMatchObject({
        replyTarget: null,
        state: "pending",
        requestedBy: f.userId,
      });
      const message = await f.database
        .selectFrom("messages")
        .selectAll()
        .where("id", "=", queued[0]!.messageId)
        .executeTakeFirstOrThrow();
      expect(message.author).toMatchObject({
        kind: "team-member",
        actor: "agent",
        displayName: "Maya",
      });
      expect(JSON.stringify(message.content)).toContain("answered");
      expect(JSON.stringify(message.content)).toContain("The answer is ready");
      f.offline(true);
      await expect(f.publisher.deliver(f.origin.teamId, returned)).rejects.toMatchObject({
        code: "runner_offline",
      });
      f.offline(false);
      await f.publisher.reconnect(f.origin.teamId);
      expect(
        await f.database
          .selectFrom("threadInputs")
          .select("messageId")
          .where(
            "idempotencyKey",
            "=",
            `team-return:${f.origin.teamId}:${returned.returnPayload.originAskId}`,
          )
          .execute(),
      ).toHaveLength(1);
    });

  it("records returns to Done or absent tasks as undeliverable without rerouting", async ({
    storeFixture,
  }) => {
    const f = await consentFixture(storeFixture);
    const asking = await f.ask();
    await f.database
      .updateTable("threads")
      .set({ doneAt: new Date(), doneReason: null })
      .where("id", "=", asking.receipt.taskId)
      .execute();
    for (const resumeRunId of [asking.receipt.runId!, createId("run")]) {
      const returned = {
        ...f.frame,
        request: {
          ...f.frame.request,
          id: createId("teamAgentRequest"),
          kind: "return" as const,
          state: "queued" as const,
          consentExpiresAt: null,
        },
        presentation: null,
        returnPayload: {
          originAskId: createId("teamAgentRequest"),
          resumeRunId,
          outcome: "expired" as const,
          bodyMarkdown: null,
          attachments: [],
          author: { ...f.frame.presentation!.asker, actor: "agent" as const },
        },
      };
      await f.publisher.deliver(f.origin.teamId, returned);
      expect(await f.store.mirror(f.origin.teamId, returned.request.id)).toMatchObject({
        returnAdmission: "undeliverable",
        taskId: null,
      });
    }
    expect(
      await f.database
        .selectFrom("threadInputs")
        .selectAll()
        .where("threadId", "=", asking.receipt.taskId)
        .execute(),
    ).toHaveLength(1);
  });

  it("expires consent locally and never delivers a return to a closed delegation", async ({
    storeFixture,
  }) => {
    const f = await consentFixture(storeFixture);
    await f.publisher.deliver(f.origin.teamId, f.frame);
    await f.database
      .updateTable("personalTeamRequests")
      .set({ consentExpiresAt: new Date(Date.now() - 1000) })
      .where("teamDeploymentId", "=", f.origin.teamId)
      .where("requestId", "=", f.frame.request.id)
      .execute();
    expect((await needsYouPage(f.database, { userId: f.userId })).count).toBe(0);
    await expect(
      f.publisher.decide(f.userId, f.origin.teamId, f.frame.request.id, "approve"),
    ).rejects.toMatchObject({ code: "conflict" });
    const parent = await storeFixture.store.enqueueThreadInput({
      threadId: f.thread.id,
      requestedBy: f.userId,
      source: { kind: "human" },
      policy: "queue",
      content: [{ type: "text", text: "Delegate" }],
      idempotencyKey: "parent",
    });
    const asking = await f.ask();
    const assignmentId = createId("delegation");
    await f.database.transaction().execute(async (tx) => {
      await tx
        .updateTable("runs")
        .set({ assignmentId })
        .where("id", "=", asking.receipt.runId!)
        .execute();
      await tx
        .insertInto("delegations")
        .values({
          id: assignmentId,
          childRunId: asking.receipt.runId!,
          childThreadId: asking.receipt.taskId,
          initialInputMessageId: asking.receipt.inputId,
          objective: "Ask a teammate",
          origin: "run",
          parentRunId: parent.run!.id,
          parentThreadId: f.thread.id,
          status: "completed",
          revision: 1,
          resultStatus: "delivered",
          finishedAt: new Date(),
          completedAt: new Date(),
        })
        .execute();
    });
    const returned = {
      ...f.frame,
      request: {
        ...f.frame.request,
        id: createId("teamAgentRequest"),
        kind: "return" as const,
        state: "queued" as const,
        consentExpiresAt: null,
      },
      presentation: null,
      returnPayload: {
        originAskId: createId("teamAgentRequest"),
        resumeRunId: asking.receipt.runId!,
        outcome: "declined" as const,
        bodyMarkdown: null,
        attachments: [],
        author: { ...f.frame.presentation!.asker, actor: "agent" as const },
      },
    };
    await f.publisher.deliver(f.origin.teamId, returned);
    expect(await f.store.mirror(f.origin.teamId, returned.request.id)).toMatchObject({
      returnAdmission: "undeliverable",
      taskId: null,
    });
  });
});
