import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import pg from "pg";
import { expect, vi } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { OpensteerStore } from "./store.js";
import { describeStore, pendingEvent } from "./store.integration.test-support.js";

// Classification remains held back: expiry itself must refuse renewal, events
// and tools. An ordinary refused event must not consume its Runner ordinal;
// the explicit lease-lost report must remain admissible for classification.
describeStore("execution lease clock", (it) => {
  it("refuses tool authority for a generation with terminal evidence before grant cleanup", async ({
    storeFixture: { startRunFixture, store, database },
  }) => {
    const f = await startRunFixture("terminal-evidence-authority");
    const authority = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      requestedBy: f.userId,
      runId: f.run.id,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      threadId: f.threadId,
    };
    await expect(store.assertActiveGrant(authority)).resolves.toMatchObject({
      agentConnectionId: null,
    });
    const attempt = await database
      .updateTable("runAttempts")
      .set({ terminalEvidenceAt: new Date() })
      .where("runId", "=", f.run.id)
      .where("bindingGeneration", "=", f.bindingGeneration)
      .executeTakeFirst();
    expect(attempt.numUpdatedRows).toBe(1n);
    expect(
      await database
        .selectFrom("grants")
        .select("status")
        .where("runId", "=", f.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "active" });
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
  });

  it("refuses expired authority before classification without consuming the ordinal", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("clock-expired-authority");
    const clock = new ManualClock();
    const store = new OpensteerStore(database, {
      executionClock: clock,
    });
    const binding = await database
      .selectFrom("providerSessions")
      .select(["leaseExpiresAt", "leaseTokenHash"])
      .where("id", "=", f.run.providerSessionId)
      .executeTakeFirstOrThrow();
    clock.advanceBy(binding.leaseExpiresAt!.getTime() - clock.now());
    const authority = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      requestedBy: f.userId,
      runId: f.run.id,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      threadId: f.thread.id,
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
    expect((await store.recoverRunsWithExpiredExecutionBindings()).terminatedRuns).toEqual([]);
    clock.advanceBy(1);
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({
      code: "forbidden",
    });
    const eventContext = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      runId: f.run.id,
      threadId: f.thread.id,
    };
    const ordinary = {
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        ...eventContext,
        data: {
          content: [
            {
              type: "text",
              text: "Too late",
            },
          ],
          messageId: createId("message"),
        },
        ordinal: 1,
        type: "assistant.message",
      }),
    };
    await expect(store.commitRunnerEvent(ordinary)).rejects.toMatchObject({
      code: "forbidden",
    });
    // What the Host does next with a refused report: it must leave the outcome to classification.
    await store.failRunForRefusedRunnerEvent({
      bindingGeneration: f.bindingGeneration,
      message: "Execution capability came from a stale or invalid binding",
      runId: f.run.id,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    const beforeClassification = await database
      .selectFrom("runs")
      .select(["status", "nextRunnerOrdinal"])
      .where("id", "=", f.run.id)
      .executeTakeFirstOrThrow();
    expect(beforeClassification).toEqual({
      status: "running",
      nextRunnerOrdinal: 1,
    });
    const admitted = await store.commitRunnerEvent({
      ...ordinary,
      event: pendingEvent({
        ...eventContext,
        data: {
          status: "interrupted",
          cause: "lease-lost",
        },
        ordinal: 1,
        type: "run.interrupted",
      }),
    });
    expect(admitted.replayed).toBe(false);
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

  it("checks native personal Run authority in one statement and enforces grant, owner, runner, delegation and connection refusals", async ({
    storeFixture: { startRunFixture, store, database },
  }) => {
    const f = await startRunFixture("single-statement-grant-authority");
    const grant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", f.run.id)
      .executeTakeFirstOrThrow();
    const authority = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      grantId: grant.id,
      requestedBy: f.userId,
      runId: f.run.id,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      threadId: f.threadId,
    };

    const sqlStatements: string[] = [];
    const prototype: { query(...args: unknown[]): unknown } = pg.Client.prototype;
    const originalQuery = prototype.query;
    const spy = vi.spyOn(prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const first = args[0];
      sqlStatements.push(
        typeof first === "string"
          ? first
          : first && typeof first === "object" && "text" in first && typeof first.text === "string"
            ? first.text
            : "<unknown>",
      );
      return Reflect.apply(originalQuery, this, args);
    });
    try {
      await expect(store.assertActiveGrant(authority)).resolves.toEqual({
        agentConnectionId: null,
        taskOriginConnectionId: null,
      });
    } finally {
      spy.mockRestore();
    }
    expect(sqlStatements).toHaveLength(1);

    // Wrong grantId and revoked grant both refuse with "Run tool authority has ended".
    await expect(
      store.assertActiveGrant({ ...authority, grantId: createId("grant") }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
    await database
      .updateTable("grants")
      .set({ status: "revoked" })
      .where("id", "=", grant.id)
      .execute();
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
    await database
      .updateTable("grants")
      .set({ status: "active" })
      .where("id", "=", grant.id)
      .execute();

    // Ambiguous active grants sharing the same Run and binding generation refuse when grantId is omitted.
    const { grantId: _omittedGrantId, ...withoutGrantId } = authority;
    await expect(store.assertActiveGrant(withoutGrantId)).resolves.toEqual({
      agentConnectionId: null,
      taskOriginConnectionId: null,
    });
    const duplicateGrantId = createId("grant");
    const existingGrant = await database
      .selectFrom("grants")
      .select(["attemptId"])
      .where("id", "=", grant.id)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("grants")
      .values({
        id: duplicateGrantId,
        runId: f.run.id,
        attemptId: existingGrant.attemptId,
        bindingGeneration: authority.bindingGeneration,
        runnerId: f.runnerId,
        runnerBootId: `rbt_${crypto.randomUUID()}`,
        status: "active",
      })
      .execute();
    await expect(store.assertActiveGrant(withoutGrantId)).rejects.toMatchObject({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
    await database.deleteFrom("grants").where("id", "=", duplicateGrantId).execute();

    // Disabled owner refuses binding.
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", f.userId)
      .execute();
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({
      code: "forbidden",
      message: "Execution capability came from a stale or invalid binding",
    });
    await database
      .updateTable("users")
      .set({ disabledAt: null })
      .where("id", "=", f.userId)
      .execute();

    // Revoked runner refuses binding.
    await database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", f.runnerId)
      .execute();
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({
      code: "forbidden",
      message: "Execution capability came from a stale or invalid binding",
    });
    await database
      .updateTable("runners")
      .set({ revokedAt: null })
      .where("id", "=", f.runnerId)
      .execute();

    // Cancelled delegation ancestor refuses tool authority.
    const assignmentId = createId("delegation");
    const parent = await startRunFixture("single-statement-grant-parent");
    await database
      .insertInto("delegations")
      .values({
        id: assignmentId,
        childRunId: f.run.id,
        childThreadId: f.threadId,
        initialInputMessageId: f.turn.message.id,
        objective: "Delegated work",
        origin: "run",
        parentAssignmentId: null,
        parentRunId: parent.run.id,
        parentThreadId: parent.threadId,
        parentOccurrenceId: null,
        parentWatchActivationId: null,
        status: "cancelled",
        revision: 1,
        resultStatus: "pending",
        resultText: null,
        finishedAt: null,
        completedAt: null,
        replyTarget: null,
        resultAttemptedAt: null,
        resultMessageId: null,
        resultReason: null,
      })
      .execute();
    await database.updateTable("runs").set({ assignmentId }).where("id", "=", f.run.id).execute();
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
    await database
      .updateTable("runs")
      .set({ assignmentId: null })
      .where("id", "=", f.run.id)
      .execute();

    // Connected-agent Run enforces live connection and grant revision / mode.
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Connected Agent",
      clientName: "Connected Agent",
      accessMode: "auto",
      resource: "https://example.test/mcp",
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    await database
      .updateTable("agentConnections")
      .set({ tokenHash: "hash-for-live-connection" })
      .where("id", "=", connection.id)
      .execute();
    await database
      .updateTable("runs")
      .set({
        connectionId: connection.id,
        admittedGrantRevision: connection.grantRevision,
        admittedAccessMode: "auto",
      })
      .where("id", "=", f.run.id)
      .execute();
    await expect(store.assertActiveGrant(authority)).resolves.toEqual({
      agentConnectionId: connection.id,
      taskOriginConnectionId: null,
    });
    await database
      .updateTable("agentConnections")
      .set({ cleanupMinimumGrantRevision: (connection.grantRevision ?? 1) + 1 })
      .where("id", "=", connection.id)
      .execute();
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({
      code: "forbidden",
      message: "Execution capability came from a stale or invalid binding",
    });
    await database
      .updateTable("agentConnections")
      .set({ cleanupMinimumGrantRevision: null, revokedAt: new Date() })
      .where("id", "=", connection.id)
      .execute();
    await expect(store.assertActiveGrant(authority)).rejects.toMatchObject({
      code: "forbidden",
      message:
        "This connected agent's access ended. The person can reconnect it from Connected agents.",
    });
    await database
      .updateTable("runs")
      .set({ connectionId: null, admittedGrantRevision: null, admittedAccessMode: null })
      .where("id", "=", f.run.id)
      .execute();
  });
});
