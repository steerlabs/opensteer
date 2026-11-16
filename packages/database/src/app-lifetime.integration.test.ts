import { createId, TabIdSchema } from "@opensteer/core";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { AppStore, appPortFirst } from "./app-store.js";
import { TabStore } from "./tab-store.js";
import { createDatabase } from "./connection.js";
import { seedPrivatePublisher } from "./private-publisher.test-support.js";
import type { DatabaseSchema } from "./schema.js";
import { cloneTestDatabase } from "./test-database.test-support.js";

it("keeps person-owned apps and their fixed port through versions, HTML conversion and real task/Run deletion", async () => {
  const clone = await cloneTestDatabase("host");
  const seed = createDatabase<DatabaseSchema>({ connectionString: clone.url });
  const database = createDatabase<DatabaseSchema>({ connectionString: clone.url });
  try {
    const p = await seedPrivatePublisher(seed);
    const store = new AppStore(database);
    const scope = {
      threadId: p.threadId,
      runId: p.runId,
      userId: p.userId,
      environmentId: p.environmentId,
    };
    const server = {
      folder: { ...p.agentHome, path: `${p.agentHome.path}/app` },
      command: "node s.js",
    };
    const reservation = await store.reserve({
      scope,
      creationKey: `${p.runId}:first`,
      name: "Notes",
      computerId: p.agentHome.computerId,
    });
    // An interrupted call recovers the same reservation, and it stays hidden until published.
    expect(
      await store.reserve({
        scope,
        creationKey: `${p.runId}:first`,
        name: "Notes",
        computerId: p.agentHome.computerId,
      }),
    ).toEqual(reservation);
    expect(reservation.port).toBeGreaterThanOrEqual(appPortFirst);
    expect(await store.list(p.userId)).toEqual([]);
    await expect(store.get(p.userId, reservation.appId)).rejects.toThrow("App not found");
    // Another app can never take a port the database already reserved on this computer.
    const other = await store.reserve({
      scope,
      creationKey: `${p.runId}:other`,
      name: "Other",
      computerId: p.agentHome.computerId,
    });
    expect(other.port).not.toBe(reservation.port);

    const first = await store.commit({
      scope,
      appId: reservation.appId,
      name: "Notes",
      publishKey: "first",
      server,
      serverGeneration: reservation.generation,
    });
    expect(first.version).toBe(1);
    expect(await store.publication(p.runId, "first")).toEqual({
      appId: reservation.appId,
      version: 1,
    });
    // A Stop between verification and commit wins: the verified generation is stale.
    const stopped = await store.setDesiredState(p.userId, reservation.appId, "stopped");
    await expect(
      store.commit({
        scope,
        appId: reservation.appId,
        name: "Notes",
        publishKey: "stale",
        server,
        serverGeneration: stopped.server.generation - 1,
      }),
    ).rejects.toThrow("changed while its server was starting");

    const html = await store.commit({
      scope,
      appId: reservation.appId,
      name: "Notes as HTML",
      publishKey: "html",
      html: { sha256: "a".repeat(64), sizeBytes: 10 },
    });
    expect(html.retiredServer).toEqual({ generation: stopped.server.generation + 1 });
    expect(await store.runtimeSet(p.agentHome.computerId)).toEqual([]);
    const again = await store.prepareServer({
      scope,
      appId: reservation.appId,
      computerId: p.agentHome.computerId,
    });
    expect(again.port).toBe(reservation.port);

    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", p.runId)
      .execute();
    await expect(
      store.commit({
        scope,
        appId: reservation.appId,
        name: "Late",
        publishKey: "late",
        html: { sha256: "b".repeat(64), sizeBytes: 10 },
      }),
    ).rejects.toThrow("no longer active");
    await expect(store.get(createId("user"), reservation.appId)).rejects.toThrow("App not found");
    expect((await store.abandonedReservations()).map((app) => app.id)).toEqual([other.appId]);

    // Deleting the origin chat for real only nulls provenance.
    await sql`delete from runs where id = ${p.runId}`.execute(database);
    await sql`delete from causal_chains where id = ${p.causalChainId}`.execute(database);
    await sql`delete from threads where id = ${p.threadId}`.execute(database);
    expect(
      await database.selectFrom("runs").select("id").where("id", "=", p.runId).execute(),
    ).toEqual([]);
    const survived = await store.get(p.userId, reservation.appId);
    expect(survived).toMatchObject({
      threadId: null,
      runId: null,
      name: "Notes as HTML",
      version: { version: 2 },
      server: { port: reservation.port },
    });
    expect(
      (await database.selectFrom("appVersions").select("createdByRun").execute()).map(
        (row) => row.createdByRun,
      ),
    ).toEqual([null, null]);

    const tabs = new TabStore(database);
    const tabId = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    await tabs.open(
      {
        id: tabId,
        kind: "app",
        appId: other.appId,
        ownerId: p.userId,
        computerId: p.agentHome.computerId,
        title: "Notes",
        openedBy: "person",
      },
      "open-app",
    );
    await tabs.close(p.userId, [tabId], "close-app");
    const deleting = await store.markDeleting(p.userId, other.appId, (tx, appId) =>
      tabs.removeTabs(tx, appId),
    );
    expect(deleting.deleting).toBe(true);
    expect(deleting.server?.desiredState).toBe("stopped");
    expect(await tabs.get(p.userId, tabId, true)).toBeNull();

    const removing: string[] = [];
    await store.remove(reservation.appId, async (tx, appId) => {
      // Tab removal joins the transaction that removes the record.
      expect(tx.isTransaction).toBe(true);
      removing.push(appId);
      return [];
    });
    expect(removing).toEqual([reservation.appId]);
    expect(
      await database
        .selectFrom("appServers")
        .select("appId")
        .where("appId", "=", reservation.appId)
        .execute(),
    ).toEqual([]);
  } finally {
    await database.destroy();
    await seed.destroy();
    await clone.drop();
  }
});
