import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@opensteer/database/connection";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it } from "vitest";
import { initializePersonalState } from "./personal-state.js";

it("rereads bootstrap once when the hosting computer first makes personal settings ready", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "personal-state-notice-")));
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const config = { agentHome: join(directory, "agent-home") };
    const personal = await seedPersonalFixture(database, config.agentHome);
    await database.deleteFrom("personalSettings").execute();
    await database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", personal.runnerId)
      .execute();
    const notices: Parameters<RealtimeHub["sendToUsers"]>[] = [];
    const committed: Promise<unknown>[] = [];
    const realtime: Pick<RealtimeHub, "sendToUsers"> = {
      sendToUsers: (...notice) => {
        notices.push(notice);
        committed.push(
          database.selectFrom("personalSettings").select("ownerId").executeTakeFirstOrThrow(),
        );
      },
    };
    const initialize = () =>
      initializePersonalState(
        database,
        { ...config, environmentId: personal.environmentId },
        realtime,
      );
    expect(await initialize()).toBeNull();
    expect(notices).toEqual([]);
    await database
      .updateTable("runners")
      .set({ revokedAt: null })
      .where("id", "=", personal.runnerId)
      .execute();
    const services = await Promise.all([initialize(), initialize()]);
    expect(services.every(Boolean)).toBe(true);
    expect(notices).toEqual([[[personal.userId], { type: "host.machines.changed" }]]);
    expect(await Promise.all(committed)).toEqual([{ ownerId: personal.userId }]);
    await initialize();
    expect(notices).toHaveLength(1);
    // Reconciling ready settings must not queue behind, or hold, the Deployment event fence.
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fence = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("deploymentEventState")
        .select("deploymentId")
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      held.resolve();
      await release.promise;
    });
    void fence.catch(held.reject);
    try {
      await held.promise;
      await withTimeout(initialize(), 2_000, {
        timeoutError: () => new Error("Reconciling ready settings waited on the event fence"),
      });
    } finally {
      release.resolve();
      await fence;
    }
    expect(notices).toHaveLength(1);
  } finally {
    await database.destroy();
    await clone.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
