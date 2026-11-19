import pg from "pg";
import { expect, onTestFinished } from "vitest";
import { describeStore } from "./store.integration.test-support.js";

describeStore("waiting queue projection", (it) => {
  it("builds a task's waiting queue once when a dispatch claims several reports", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const task = await createRunFixture("queue-projection");
    // Reports wait passively until a Run takes them along.
    for (const text of ["Second", "Third", "Fourth"])
      await store.enqueueThreadInput({
        requestedBy: task.userId,
        threadId: task.threadId,
        content: [{ type: "text", text }],
        source: { kind: "human" },
        policy: "report",
        idempotencyKey: `queue-projection-${text}`,
      });
    const first = await enqueueHumanTrigger({
      requestedBy: task.userId,
      threadId: task.threadId,
      content: [{ type: "text", text: "First" }],
      idempotencyKey: "queue-projection-first",
    });

    // Each full queue read selects the task's waiting queue inputs.
    let queueReads = 0;
    const original = pg.Client.prototype.query;
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      const text = typeof first === "string" ? first : (first.text ?? "");
      if (
        /from "thread_inputs" where "thread_id" = \$1 and "policy" = \$2 and "state" in/u.test(text)
      )
        queueReads++;
      return (original as (...values: unknown[]) => unknown).apply(this, args);
    } as typeof original;
    onTestFinished(() => {
      pg.Client.prototype.query = original;
    });
    expect(await store.claimCommand(first.command.id, "queue-projection")).not.toBeNull();
    pg.Client.prototype.query = original;

    const claimed = await database
      .selectFrom("threadInputs")
      .select("messageId")
      .where("threadId", "=", task.threadId)
      .where("state", "=", "claimed")
      .execute();
    expect(claimed.length).toBe(4);
    expect(queueReads).toBe(1);
  });
});
