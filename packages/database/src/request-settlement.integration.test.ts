import { withPersonalTransaction } from "./personal-transaction.js";
import { createId } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import "./connection.js";
import { readRequestSettlementActor, requestSettlementActor } from "./request-settlement.js";
import { describeStore } from "./store.integration.test-support.js";
describeStore("human settlement session fence", (it) => {
  it("rolls back domain writes when the session is revoked after provenance is read", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("settlement-session-fence");
    const sessionId = createId("authSession");
    const now = new Date();
    await database
      .insertInto("authSessions")
      .values({
        id: sessionId,
        userId: fixture.userId,
        token: randomUUID(),
        expiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 60_000),
        ipAddress: null,
        userAgent: null,
        deviceLabel: "Test phone",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    const before = await database
      .selectFrom("threads")
      .select("title")
      .where("id", "=", fixture.thread.id)
      .executeTakeFirstOrThrow();
    await expect(
      withPersonalTransaction(database, async (transaction) => {
        expect(await readRequestSettlementActor(transaction, fixture.userId, sessionId)).toEqual({
          sessionId,
          deviceLabel: "Test phone",
        });
        await transaction
          .updateTable("threads")
          .set({
            title: "Uncommitted approval",
          })
          .where("id", "=", fixture.thread.id)
          .executeTakeFirstOrThrow();
        await database
          .deleteFrom("authSessions")
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow();
        await requestSettlementActor(transaction, fixture.userId, sessionId);
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(
      await database
        .selectFrom("threads")
        .select("title")
        .where("id", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });
});
