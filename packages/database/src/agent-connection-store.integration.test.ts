import { expect } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { withDatabaseOperationSignal } from "./operation-budget.js";
import { describeStore } from "./store.integration.test-support.js";
import { createDatabase } from "./connection.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";
import { sql } from "kysely";

describeStore("connected agent authentication lifecycle", (it) => {
  it("cancels a blocked last-used update and returns its database checkout", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.createRunFixture("connection-auth-cancel");
    const { database } = await ownTestDatabaseProducer(storeFixture.databaseUrl, async () => {
      const database = createDatabase({
        connectionString: storeFixture.databaseUrl,
        maxConnections: 1,
      });
      return { database, close: () => database.destroy() };
    });
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Cancellation test",
      clientName: "Test",
      accessMode: "approval-required",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connections.activate(connection.id, "test-hash");
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = storeFixture.database.transaction().execute(async (tx) => {
      await tx
        .selectFrom("agentConnections")
        .select("id")
        .where("id", "=", connection.id)
        .forUpdate()
        .execute();
      locked.resolve();
      await withTimeout(release.promise, 3000, {
        timeoutError: () => new Error("Authentication blocker was not released"),
      });
    });
    void blocker.catch(locked.reject);
    let authenticating: Promise<unknown> | undefined;
    try {
      await withTimeout(locked.promise, 1000, {
        timeoutError: () => new Error("Connection row was not locked"),
      });
      authenticating = withDatabaseOperationSignal(AbortSignal.timeout(100), Date.now() + 100, () =>
        connections.authenticate("test-hash"),
      );
      await expect(
        withTimeout(authenticating, 1000, {
          timeoutError: () =>
            new Error("Authentication ignored cancellation while its row was locked"),
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(
        (
          await withTimeout(sql`select 1 as alive`.execute(database), 500, {
            timeoutError: () => new Error("Cancelled authentication retained the only checkout"),
          })
        ).rows,
      ).toEqual([{ alive: 1 }]);
    } finally {
      release.resolve();
      await withTimeout(Promise.all([blocker, authenticating?.catch(() => undefined)]), 1000, {
        timeoutError: () => new Error("Authentication did not release its database checkout"),
      });
    }
    await expect(
      withTimeout(connections.authenticate("test-hash"), 1000, {
        timeoutError: () => new Error("Authentication did not recover after cancellation"),
      }),
    ).resolves.toMatchObject({
      id: connection.id,
    });
  });
});
