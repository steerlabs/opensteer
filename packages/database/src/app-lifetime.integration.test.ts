import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { AppStore } from "./app-store.js";
import { createDatabase } from "./connection.js";
import { seedPrivatePublisher } from "./private-publisher.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";

it("keeps published apps and personal tabs after the publisher is Done, with idempotent versions", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const p = await seedPrivatePublisher(database);
    const store = new AppStore(database);
    const input = {
      threadId: p.threadId,
      runId: p.runId,
      environmentId: p.environmentId,
      userId: p.userId,
      title: "Personal app",
      sha256: "a".repeat(64),
      sizeBytes: 123,
      publishKey: "first-publication",
    };
    const first = await store.publish(input);
    expect(first.version).toBe(1);
    expect(await store.publish(input)).toEqual({ appId: first.appId, version: 1, event: null });
    await store.openTab(first.appId, p.userId);
    await store.openTab(first.appId, p.userId);
    expect(await store.listTabs(p.userId)).toHaveLength(1);
    await expect(store.get(first.appId, createId("user"))).rejects.toThrow();
    for (const [publishKey, folder] of [
      ["wrong-computer", { computerId: createId("runner"), path: `${p.agentHome.path}/app` }],
      ["outside-home", { ...p.agentHome, path: `${p.agentHome.path}/../elsewhere` }],
    ] as const)
      await expect(
        store.publish({ ...input, publishKey, server: { folder, command: "pnpm dev" } }),
      ).rejects.toThrow("inside Agent home");
    await database
      .updateTable("runs")
      .set({ accessMode: "approval-required" })
      .where("id", "=", p.runId)
      .execute();
    await expect(
      store.publish({
        ...input,
        publishKey: "server",
        server: {
          folder: p.agentHome,
          command: "pnpm dev",
        },
      }),
    ).rejects.toThrow("full-access");
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", p.runId)
      .execute();
    await database
      .updateTable("threads")
      .set({ doneAt: new Date() })
      .where("id", "=", p.threadId)
      .execute();
    expect((await store.listOwned(p.userId)).map((app) => app.id)).toEqual([first.appId]);
    expect((await store.listTabs(p.userId)).map((tab) => tab.appId)).toEqual([first.appId]);
    expect((await store.latest(first.appId, p.userId)).version).toMatchObject({ version: 1 });
    await expect(store.publish({ ...input, publishKey: "after-done" })).rejects.toThrow(
      "no longer active",
    );
    await store.closeTab(first.appId, p.userId);
    expect(await store.listTabs(p.userId)).toEqual([]);
    expect((await store.latest(first.appId, p.userId)).app.latestVersion).toBe(1);
    await sql`insert into apps(id,thread_id,run_id,title,latest_version,tab_opened_at)
      select 'app_' || gen_random_uuid(),${p.threadId},${p.runId},'Open app',1,now() from generate_series(1,50)`.execute(
      database,
    );
    await expect(store.openTab(first.appId, p.userId)).rejects.toThrow("50 open app tabs");
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
