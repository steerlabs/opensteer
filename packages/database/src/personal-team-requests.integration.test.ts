import { expect } from "vitest";
import { createId, TeamMessageIdSchema, type TeamSource } from "@opensteer/core";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import { admitTeamTaskRequest } from "./task-admission-store.js";
import { PersonalTeamRequestsStore } from "./personal-team-requests-store.js";
import { NotificationStateStore } from "./notification-state.js";

describeStore("personal team reply watermark", (it) => {
  for (const ending of ["automatic", "explicit", "stopped"] as const)
    it(`reads the matched publication without substituting a private final (${ending})`, async ({
      storeFixture: f,
    }) => {
      const explicit = ending !== "automatic";
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
        bodyMarkdown: "Team ask",
        origin: { teamId, channelId, threadRootId },
        requestId,
        triggerMessageId: threadRootId,
        source,
        ownerId: personal.userId,
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
      const empty = { taskId: null, completedAt: null };
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
      if (explicit) await requests.prepareExplicitReply(teamId, requestId);
      await requests.publication(teamId, requestId, "accepted", input.replyMessageId);
      expect(await requests.replyTask(personal.userId, input)).toEqual(empty);
      if (explicit)
        await f.store.commitRunnerEvent({
          environmentId: personal.environmentId,
          runnerId: personal.runnerId,
          runnerBootId: run.runnerBootId,
          event: pendingEvent({
            type: "assistant.message",
            environmentId: personal.environmentId,
            bindingGeneration: run.bindingGeneration,
            ordinal: 2,
            runId: run.runId,
            threadId: admitted.receipt.taskId,
            data: {
              messageId: createId("message"),
              content: [{ type: "text", text: "Different private final, never published" }],
            },
          }),
        });
      await f.store.commitRunnerEvent({
        environmentId: personal.environmentId,
        runnerId: personal.runnerId,
        runnerBootId: run.runnerBootId,
        event: pendingEvent({
          ...(ending === "stopped"
            ? { type: "run.interrupted" as const, data: { status: "interrupted" as const } }
            : { type: "run.completed" as const, data: { status: "completed" as const } }),
          environmentId: personal.environmentId,
          bindingGeneration: run.bindingGeneration,
          ordinal: explicit ? 3 : 2,
          runId: run.runId,
          threadId: admitted.receipt.taskId,
        }),
      });
      if (explicit) {
        expect(await requests.replyTask(personal.userId, input)).toEqual(empty);
        return;
      }
      const completed = await f.database
        .selectFrom("runs")
        .select("completedAt")
        .where("id", "=", run.runId)
        .executeTakeFirstOrThrow();
      const expected = {
        taskId: admitted.receipt.taskId,
        completedAt: completed.completedAt!.toISOString(),
      };
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
      await f.store.commitRunnerEvent({
        environmentId: personal.environmentId,
        runnerId: personal.runnerId,
        runnerBootId: privateRun.runnerBootId,
        event: pendingEvent({
          type: "run.completed",
          environmentId: personal.environmentId,
          bindingGeneration: privateRun.bindingGeneration,
          ordinal: 2,
          runId: privateRun.runId,
          threadId: admitted.receipt.taskId,
          data: { status: "completed" },
        }),
      });
      const privateCompletion = (await f.store.getThreadForOwner(expected.taskId, personal.userId))!
        .latestRunCompletedAt!;
      expect(privateCompletion > expected.completedAt).toBe(true);
      const state = new NotificationStateStore(f.database);
      await state.visit({
        threadId: expected.taskId,
        userId: personal.userId,
        visitedAt: expected.completedAt,
      });
      const read = await f.store.getThreadForOwner(expected.taskId, personal.userId);
      expect(read?.lastVisitedAt).toBe(expected.completedAt);
      expect(read?.latestRunCompletedAt).toBe(privateCompletion);
      expect(read!.lastVisitedAt! < read!.latestRunCompletedAt!).toBe(true);
      await requests.publication(teamId, requestId, "blocked");
      expect(await requests.replyTask(personal.userId, input)).toEqual(empty);
    });
});
