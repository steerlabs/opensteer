import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { enqueueNodeStop, failNodeStop } from "./node-control.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("a subagent stop the computer could not take", (test) => {
  test("takes the task's row before the node's, as the lock order ranks them", async ({
    storeFixture: f,
  }) => {
    const fixture = await f.startRunFixture("failed-node-stop");
    const attempt = await f.database
      .selectFrom("runAttempts")
      .select("id")
      .where("runId", "=", fixture.run.id)
      .where("status", "=", "current")
      .executeTakeFirstOrThrow();
    const nodeId = createId("executionNode");
    await f.database
      .insertInto("executionNodes")
      .values({
        id: nodeId,
        attemptId: attempt.id,
        runId: fixture.run.id,
        status: "running",
        kind: "subagent",
        effort: null,
        phaseIndex: null,
        phases: sql`'[]'::jsonb`,
        title: "Subagent",
        startedAt: new Date(),
        endedAt: null,
        nativeRef: `native:${nodeId}`,
        originCallId: null,
        parentNodeId: null,
        prompt: null,
        result: null,
        sessionRef: null,
        model: null,
        stopSupported: true,
      })
      .execute();
    const { command } = await enqueueNodeStop(f.database, {
      nodeId,
      runId: fixture.run.id,
      threadId: fixture.threadId,
      requestedBy: fixture.userId,
      idempotencyKey: "stop-subagent",
    });
    await f.database
      .updateTable("commands")
      .set({ status: "dispatched" })
      .where("id", "=", command.id)
      .execute();
    // The stop could not be sent: the node is no longer stopping and the command says why. Under
    // OPENSTEER_LOCK_ORDER_MODE=enforce a lock taken out of rank fails this test at teardown.
    await failNodeStop(f.database, command.id, "The computer did not take the stop");
    expect(
      await f.database
        .selectFrom("executionNodes")
        .select("stopping")
        .where("id", "=", nodeId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ stopping: false });
    expect(
      await f.database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", command.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed" });
  });
});
