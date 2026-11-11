import { expect } from "vitest";
import { ContinuationService } from "./continuation-service.js";
import { describeStore, pendingEvent } from "@opensteer/database/test-support/store";
describeStore("Continuation paging", (it) => {
  it("keeps a Run's outcomes together at the page boundary, without expanding Trigger rows", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture, startTriggerOccurrence } = storeFixture;
    const fixture = await startRunFixture("continuation-page-group");
    const occurrence = await startTriggerOccurrence(fixture, "continuation-page-group");
    const rows = [];
    for (const [index, callId] of ["older-trigger", "first", "second", "later-trigger"].entries()) {
      const opened = await store.requests.create({
        callId,
        kind: "browser.access",
        mode: "durable",
        ...(callId.endsWith("trigger")
          ? {
              originatingOccurrenceId: occurrence.id,
            }
          : {
              originatingRunId: fixture.run.id,
            }),
        originatingThreadId: fixture.thread.id,
        requestedBy: fixture.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Read email",
          suggestion: {
            kind: "user_choice",
          },
        },
        presentation: {
          kind: "external",
          title: "Choose a profile",
          subject: {
            kind: "workspace",
            id: fixture.workspace.id,
          },
        },
      });
      rows.push(opened.request.id);
      await store.requests.resolveBrowserRequest({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            decision: "declined",
          },
        },
      });
      await database
        .updateTable("requestContinuations")
        .set({
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        })
        .where("requestId", "=", opened.request.id)
        .execute();
    }
    const [older, first, second, later] = rows;
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      runnerId: fixture.runnerId,
      runnerBootId: fixture.runnerBootId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        environmentId: fixture.environmentId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        ordinal: 1,
        type: "run.completed",
        data: {
          status: "completed",
        },
      }),
    });
    expect(
      (await store.requests.listPendingContinuations(2)).map(({ request }) => request.id),
    ).toEqual([older, first, second]);
    const service = new ContinuationService({
      requests: {
        get: (id) => store.requests.get(id),
        listPendingContinuations: () => store.requests.listPendingContinuations(2),
        recordContinuationAttempt: (input) => store.requests.recordContinuationAttempt(input),
      },
      commands: {
        enqueueThreadInput: (input) => store.enqueueThreadInput(input),
      },
      integrations: {
        listDiscoveryInventory: async () => [],
        listCallableTools: async () => [],
        computerUseMachines: async () => [],
        computerUsePhones: async () => [],
      },
      onError: (error) => {
        throw error;
      },
    });
    service.notify();
    await service.close();
    const inputs = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("authoritySource", "@>", {
        kind: "platform",
        cause: "request-resolved",
        sourceRunId: fixture.run.id,
      })
      .execute();
    expect(inputs).toHaveLength(1);
    const message = await database
      .selectFrom("messages")
      .select("content")
      .where("id", "=", inputs[0]!.messageId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(message.content)).toContain(first);
    expect(JSON.stringify(message.content)).toContain(second);
    expect(
      (await store.requests.listPendingContinuations(2)).map(({ request }) => request.id),
    ).toEqual([later]);
  });
});
