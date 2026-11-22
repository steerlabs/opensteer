import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("a Runner that goes away mid-work", (it) => {
  it("marks every connection's live attempt on that boot contact-lost, rows taken in order", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const first = await storeFixture.startRunFixture(`lost-${randomUUID().slice(0, 8)}`);
    const second = await storeFixture.startRunFixture(`lost-${randomUUID().slice(0, 8)}`);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: first.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    // Two Runs started by the connection, both still working on the same boot of one Runner.
    const bootId = `boot-${randomUUID()}`;
    const runIds = [first.run.id, second.run.id];
    // Each Run's current attempt, as dispatch makes it.
    for (const runId of [first.run.id, second.run.id])
      if (
        !(await database
          .selectFrom("runAttempts")
          .select("id")
          .where("runId", "=", runId)
          .executeTakeFirst())
      )
        await database
          .insertInto("runAttempts")
          .values({
            id: createId("runAttempt"),
            ordinal: 1,
            reason: "initial",
            runId,
            status: "current",
          })
          .execute();
    await database
      .updateTable("runAttempts")
      .set({
        connectionId: connection.id,
        runnerId: first.runnerId,
        runnerBootId: bootId,
        terminalEvidenceAt: null,
        contactLostAt: null,
      })
      .where("runId", "in", runIds)
      .execute();
    expect(
      await database.selectFrom("runAttempts").select("id").where("runId", "in", runIds).execute(),
    ).toHaveLength(2);
    await store.markConnectionAttemptsContactLost({
      runnerId: first.runnerId,
      runnerBootId: bootId,
    });
    const marked = await database
      .selectFrom("runAttempts")
      .select("contactLostAt")
      .where("runId", "in", runIds)
      .execute();
    expect(marked.map((row) => row.contactLostAt !== null)).toEqual([true, true]);
  });

  it("marks every shared-Chrome attempt a restart cut off contact-lost, rows taken in order", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const f = await storeFixture.startRunFixture(`cdp-${randomUUID().slice(0, 8)}`);
    const runner = await storeFixture.enrollBrowserRunner(
      f.userId,
      `Browser ${randomUUID().slice(0, 4)}`,
    );
    const sessions: string[] = [];
    for (const name of ["One", "Two"]) {
      const profile = await store.createBrowserProfile({
        name: `${name} ${randomUUID().slice(0, 4)}`,
        ownerId: f.userId,
        homeRunnerId: runner,
        idempotencyKey: randomUUID(),
      });
      const id = `bsn_${randomUUID()}`;
      await database
        .insertInto("browserSessions")
        .values({
          id,
          tabGroupId: id,
          origin: "agent",
          profileId: profile.id,
          placementKey: id,
          runnerId: f.runnerId,
          runtimeId: "runtime",
          state: "ready",
          standardCdpAttempts: JSON.stringify({
            [`cdp-${name}`]: { connectionId: "conn_parity" },
          }),
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never)
        .execute();
      sessions.push(id);
    }
    await store.recoverConnectionCdpAttempts();
    const rows = await database
      .selectFrom("browserSessions")
      .select("standardCdpAttempts")
      .where("id", "in", sessions as never)
      .execute();
    for (const row of rows)
      for (const witness of Object.values(row.standardCdpAttempts as Record<string, object>))
        expect(witness).toHaveProperty("contactLostAt");
  });
});
