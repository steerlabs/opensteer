import { expect } from "vitest";
import { createId, TeamMessageIdSchema, type TeamSource } from "@opensteer/core";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import { admitTeamTaskRequest } from "./task-admission-store.js";
import { PersonalTeamRequestsStore } from "./personal-team-requests-store.js";
import { NotificationStateStore } from "./notification-state.js";

describeStore("personal team reply watermark", (it) => {
  it("reads only the authenticated owner's matched publication through that Run's final message", async ({
    storeFixture: f,
  }) => {
    const personal = await f.createRunFixture("Reply lookup");
    const teamId = createId("deployment"),
      channelId = createId("teamChannel"),
      threadRootId = TeamMessageIdSchema.parse("1");
    await f.database
      .insertInto("personalTeamLinks")
      .values({
        id: crypto.randomUUID(),
        teamDeploymentId: teamId,
        teamHostInstanceId: createId("hostInstance"),
        hostKeyFingerprint: "fixture",
        approvedOrigin: "https://team.example.invalid",
        authorityEnvelope: {},
        state: "active",
      })
      .execute();
    const source: TeamSource = {
      teamId,
      channelId,
      threadRootId,
      messageId: threadRootId,
      audience: {
        teamName: "Acme",
        channelName: "Support",
        channelKind: "private",
        memberCount: 2,
        peopleOnly: false,
      },
    };
    const requestId = createId("teamAgentRequest");
    const admitted = await admitTeamTaskRequest(f.database, {
      origin: { teamId, channelId, threadRootId },
      requestId,
      triggerMessageId: threadRootId,
      source,
      ownerId: personal.userId,
      folder: personal.folder,
      execution: {
        environmentId: personal.environmentId,
        harnessInstanceId: personal.harnessInstance.id,
        modelSelection: personal.thread.modelSelection,
      },
    });
    const requests = new PersonalTeamRequestsStore(f.database);
    const input = {
      teamId,
      channelId,
      threadRootId,
      replyMessageId: TeamMessageIdSchema.parse("42"),
    };
    const empty = { taskId: null, throughSequence: null };
    expect(await requests.replyTask(personal.userId, input)).toEqual(empty);
    const run = await startPersonalQueuedRunFixture(f.store, admitted.receipt.runId!);
    const replyId = createId("message");
    await f.store.commitRunnerEvent({
      environmentId: personal.environmentId,
      runnerId: personal.runnerId,
      runnerBootId: run.runnerBootId,
      event: pendingEvent({
        type: "assistant.message",
        environmentId: personal.environmentId,
        bindingGeneration: run.bindingGeneration,
        ordinal: 1,
        runId: run.runId,
        threadId: admitted.receipt.taskId,
        data: { messageId: replyId, content: [{ type: "text", text: "Published answer" }] },
      }),
    });
    await requests.publication(teamId, requestId, "accepted", input.replyMessageId);
    expect(await requests.replyTask(personal.userId, input)).toEqual(empty);
    await f.store.commitRunnerEvent({
      environmentId: personal.environmentId,
      runnerId: personal.runnerId,
      runnerBootId: run.runnerBootId,
      event: pendingEvent({
        type: "run.completed",
        environmentId: personal.environmentId,
        bindingGeneration: run.bindingGeneration,
        ordinal: 2,
        runId: run.runId,
        threadId: admitted.receipt.taskId,
        data: { status: "completed" },
      }),
    });
    const message = await f.database
      .selectFrom("messages")
      .select("sequence")
      .where("id", "=", replyId)
      .executeTakeFirstOrThrow();
    const expected = { taskId: admitted.receipt.taskId, throughSequence: message.sequence };
    expect(await requests.replyTask(personal.userId, input)).toEqual(expected);
    for (const wrong of [
      { ...input, teamId: createId("deployment") },
      { ...input, channelId: createId("teamChannel") },
      { ...input, threadRootId: TeamMessageIdSchema.parse("2") },
      { ...input, replyMessageId: TeamMessageIdSchema.parse("43") },
    ])
      expect(await requests.replyTask(personal.userId, wrong)).toEqual(empty);
    await expect(requests.replyTask(createId("user"), input)).rejects.toMatchObject({
      code: "forbidden",
    });
    const later = await f.store.enqueueThreadInput({
      threadId: admitted.receipt.taskId,
      requestedBy: personal.userId,
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "private-later",
      content: [{ type: "text", text: "Private follow-up" }],
    });
    const privateRun = await startPersonalQueuedRunFixture(f.store, later.run!.id);
    await f.store.commitRunnerEvent({
      environmentId: personal.environmentId,
      runnerId: personal.runnerId,
      runnerBootId: privateRun.runnerBootId,
      event: pendingEvent({
        type: "assistant.message",
        environmentId: personal.environmentId,
        bindingGeneration: privateRun.bindingGeneration,
        ordinal: 1,
        runId: privateRun.runId,
        threadId: admitted.receipt.taskId,
        data: {
          messageId: createId("message"),
          content: [{ type: "text", text: "Private later answer" }],
        },
      }),
    });
    expect(await requests.replyTask(personal.userId, input)).toEqual(expected);
    const state = new NotificationStateStore(f.database);
    await state.markRead({
      threadId: expected.taskId,
      userId: personal.userId,
      throughSequence: expected.throughSequence,
    });
    const read = await state.getReadState({ threadId: expected.taskId, userId: personal.userId });
    expect(read.readSequence).toBe(expected.throughSequence);
    expect(BigInt(read.unreadSequence!)).toBeGreaterThan(BigInt(expected.throughSequence));
    await requests.publication(teamId, requestId, "blocked");
    expect(await requests.replyTask(personal.userId, input)).toEqual(empty);
  });
});
