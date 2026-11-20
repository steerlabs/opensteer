import { createId, type UserId } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore, testModelSelection } from "./store.integration.test-support.js";

describeStore("a browser session's catalog cut", (test) => {
  test("refuses a Run whose thread is not admitted or whose assignment has a cancelled ancestor, and only for its owner", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const f = await startRunFixture("session-cut");
    const sessionId = `bsn_${crypto.randomUUID()}` as never;
    await store.createBrowserSession({
      id: sessionId,
      ownerId: f.userId,
      placementKey: "p",
      runnerId: f.runnerId,
      origin: "agent",
      profileId: null,
      runtimeId: "r",
    });
    await store.attachBrowserSession({
      agentBindingId: `run:${f.runId}`,
      ownerId: f.userId,
      sessionId,
    });
    const refusal = async () =>
      (await store.readBrowserSessionCut(f.userId, sessionId))?.bindings[0]?.run?.refusal;
    expect(await refusal(), "Eligible as tool admission sees it").toBeNull();

    // Thread admission: the thread's environment is no longer on the owner's agent home computer.
    const environment = await database
      .selectFrom("executionEnvironments")
      .select("runnerId")
      .where("id", "=", f.environmentId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("executionEnvironments")
      .set({ runnerId: null })
      .where("id", "=", f.environmentId)
      .execute();
    expect(await refusal()).toBe("thread");
    await database
      .updateTable("executionEnvironments")
      .set({ runnerId: environment.runnerId })
      .where("id", "=", f.environmentId)
      .execute();
    expect(await refusal()).toBeNull();

    // A cancelled ancestor assignment, two levels up from the Run's own.
    const delegate = (key: string) =>
      store.delegateThread({
        accessMode: "auto",
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey: key,
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
        task: [{ text: "Child", type: "text" }],
        title: "Child",
      });
    const ancestor = await delegate("session-cut-ancestor");
    const own = await delegate("session-cut-own");
    await database
      .updateTable("delegations")
      .set({ parentAssignmentId: ancestor.assignment.id })
      .where("id", "=", own.assignment.id)
      .execute();
    await database
      .updateTable("runs")
      .set({ assignmentId: own.assignment.id })
      .where("id", "=", f.runId)
      .execute();
    expect(await refusal(), "An open ancestry stays eligible").toBeNull();
    await database
      .updateTable("delegations")
      .set({ status: "cancelled" })
      .where("id", "=", ancestor.assignment.id)
      .execute();
    expect(await refusal()).toBe("cancelled");

    // Another person's id reads nothing of this session.
    expect(await store.readBrowserSessionCut(createId("user") as UserId, sessionId)).toBeNull();
  });
});
