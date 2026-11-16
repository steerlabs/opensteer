import { createId, DeviceIdSchema } from "@opensteer/core";
import { machineAccessPolicyDefault } from "@opensteer/protocol";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "./connection.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";
import { seedPrivatePublisher } from "./private-publisher.test-support.js";
import { OpensteerStore } from "./store.js";
import { jsonValue } from "./store-primitives.js";
let clone: TestDatabase;
let db: ReturnType<typeof createDatabase>;
let store: OpensteerStore;
let fixture: Awaited<ReturnType<typeof seedPrivatePublisher>>;
beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  db = createDatabase({ connectionString: clone.url });
  fixture = await seedPrivatePublisher(db);
  store = new OpensteerStore(db);
});
afterEach(async () => {
  try {
    await db?.destroy();
  } finally {
    await clone?.drop();
  }
});
async function phone() {
  const deviceId = DeviceIdSchema.parse(createId("device"));
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      deploymentId: fixture.deploymentId,
      ownerKind: "user",
      ownerUserId: fixture.userId,
      name: "iPhone",
      kind: "phone",
      platform: "ios",
      form: "phone",
      accessPolicy: jsonValue({ ...machineAccessPolicyDefault, apps: false, browser: false }),
    })
    .execute();
  return deviceId;
}
it("keeps independent Device Stops on one Run and clears only the removed Device", async () => {
  const first = await phone(),
    second = await phone();
  await store.recordComputerUseStop({ runId: fixture.runId, deviceId: first });
  await store.recordComputerUseStop({ runId: fixture.runId, deviceId: first });
  await store.recordComputerUseStop({ runId: fixture.runId, deviceId: second });
  expect(await store.activeComputerUseStops()).toHaveLength(2);
  await store.removeDevice(first, fixture.userId);
  expect(await store.activeComputerUseStops()).toEqual([
    { runId: fixture.runId, deviceId: second },
  ]);
  await store.recordComputerUseStop({ runId: fixture.runId, deviceId: first });
  expect(await store.activeComputerUseStops()).toHaveLength(1);
  await db.deleteFrom("runs").where("id", "=", fixture.runId).execute();
  await store.recordComputerUseStop({ runId: fixture.runId, deviceId: second });
  expect(await store.activeComputerUseStops()).toEqual([]);
});
it("a delayed Stop cannot be reinserted after Device removal commits", async () => {
  const deviceId = await phone();
  let writing: Promise<void> | undefined;
  await db.transaction().execute(async (transaction) => {
    await transaction
      .selectFrom("devices")
      .select("id")
      .where("id", "=", deviceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    writing = store.recordComputerUseStop({ runId: fixture.runId, deviceId });
    await vi.waitFor(
      async () => {
        const waiting = await sql<{
          count: string;
        }>`select count(*)::text from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from "devices"%'`.execute(
          db,
        );
        expect(
          Number(waiting.rows[0]!.count),
          "Stop never waited on the Device removal fence",
        ).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    await transaction
      .updateTable("devices")
      .set({ removedAt: new Date() })
      .where("id", "=", deviceId)
      .execute();
    await transaction.deleteFrom("computerUseStops").where("deviceId", "=", deviceId).execute();
  });
  await writing;
  expect(await store.activeComputerUseStops()).toEqual([]);
});
