import { randomUUID } from "node:crypto";
import { ShellSessionIdSchema } from "@opensteer/protocol";
import { expect } from "vitest";
import { appendShellEvents, reserveShellSession } from "./machine-store.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("Shell audit persistence", (it) => {
  it("allocates distinct ordered ids within and across event batches", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("shell-audit-ids");
    const sessionId = ShellSessionIdSchema.parse(`shs_${randomUUID()}`);
    await reserveShellSession(storeFixture.database, {
      callerMachineName: "Hosting computer",
      callerRunnerId: f.runnerId,
      policyRevision: 1,
      requestedBy: f.userId,
      runId: f.run.id,
      runnerId: f.runnerId,
      sessionId,
      startedAt: new Date(),
      threadId: f.thread.id,
      threadTitle: f.thread.title,
    });
    const events = ["first", "second", "third"].map((command, channel) => ({
      at: new Date(),
      event: { kind: "exec" as const, command, channel },
    }));
    expect(await appendShellEvents(storeFixture.database, sessionId, events.slice(0, 2))).toBe(2);
    expect(await appendShellEvents(storeFixture.database, sessionId, events.slice(2))).toBe(1);
    const saved = await storeFixture.database
      .selectFrom("machineAccessEvents")
      .select(["id", "event"])
      .where("sessionId", "=", sessionId)
      .orderBy("id")
      .execute();
    expect(saved.map(({ event }) => event)).toEqual(events.map(({ event }) => event));
    expect(saved.every(({ id }, index) => BigInt(id) > BigInt(saved[index - 1]?.id ?? "0"))).toBe(
      true,
    );
  });
});
