import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";

// Classification remains held back: expiry itself must refuse renewal, events
// and tools. An ordinary refused event must not consume its Runner ordinal;
// the explicit lease-lost report must remain admissible for classification.
describeStore("execution lease clock", (it) => {
  it("refuses expired authority before classification without consuming the ordinal", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("clock-expired-authority");
    const clock = new ManualClock();
    const store = new OpensteerStore(database, { executionClock: clock });
    const binding = await database
      .selectFrom("providerSessions")
      .select(["leaseExpiresAt", "leaseTokenHash"])
      .where("id", "=", f.run.providerSessionId)
      .executeTakeFirstOrThrow();
    clock.advanceBy(binding.leaseExpiresAt!.getTime() - clock.now());
    const authority = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      membershipGeneration: 1,
      requestedBy: f.userId,
      runId: f.run.id,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
    };
    const single = await store.renewExecutionBinding({
      ...authority,
      leaseExpiresAt: new Date(clock.now() + 60_000),
      leaseTokenHash: binding.leaseTokenHash!,
    });
    const multiple = await store.renewActiveExecutionBindings({
      activeRunIds: [f.run.id],
      leaseExpiresAt: new Date(clock.now() + 60_000),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    expect(single).toBe(false);
    expect(multiple).toEqual([]);
    // Renewal is > now; sweep remains < now. Equality must not be normalized.
    expect((await store.recoverRunsWithExpiredExecutionBindings()).events).toEqual([]);
    clock.advanceBy(1);
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({ code: "forbidden" });
    const eventContext = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      runId: f.run.id,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
    };
    const ordinary = {
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        ...eventContext,
        data: { content: [{ type: "text", text: "Too late" }], messageId: createId("message") },
        ordinal: 1,
        type: "assistant.message",
      }),
    };
    await expect(store.commitRunnerEvent(ordinary)).rejects.toMatchObject({ code: "forbidden" });
    const beforeClassification = await database
      .selectFrom("runs")
      .select(["status", "nextRunnerOrdinal"])
      .where("id", "=", f.run.id)
      .executeTakeFirstOrThrow();
    expect(beforeClassification).toEqual({ status: "running", nextRunnerOrdinal: 1 });
    const admitted = await store.commitRunnerEvent({
      ...ordinary,
      event: pendingEvent({
        ...eventContext,
        data: { status: "interrupted", cause: "lease-lost" },
        ordinal: 1,
        type: "run.interrupted",
      }),
    });
    expect(admitted.wasDuplicate).toBe(false);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-execution-clock-"));
    await writeFile(
      join(directory, "authority.json"),
      JSON.stringify(
        {
          domainNow: clock.now(),
          originalLeaseExpiresAt: binding.leaseExpiresAt,
          singleRenewal: single,
          renewedRuns: multiple,
          beforeClassification,
          leaseLostAdmitted: true,
        },
        null,
        2,
      ) + "\n",
    );
    console.info(`Expired execution authority evidence: ${directory}`);
  });
});
