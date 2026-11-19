import { randomUUID } from "node:crypto";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import { personalInventoryLimits } from "./personal-inventory-limits.js";
import { personalReachableGrant } from "./runner-store.js";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";

/** Bytes PostgreSQL stores for a JSON value, the measure the limits use. */
async function storedBytes(database: StoreFixture["database"], value: unknown) {
  const result = await sql<{ bytes: number }>`
    select octet_length(${JSON.stringify(value)}::jsonb::text) as bytes`.execute(database);
  return Number(result.rows[0]!.bytes);
}

const continuationIdentity = {
  continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
  driverKind: "native",
} as const;

describeStore("Personal inventory limits", (it) => {
  it("admits computers and devices up to the limit and refuses the next with a clear conflict", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database, store } = storeFixture;
    const f = await createRunFixture("machine-limit");
    // Computers join only a Personal Deployment that other computers can reach.
    await database
      .insertInto("personalRemoteAccess")
      .values({
        singletonKey: "personal",
        mode: "private",
        generation: 1,
        routeOrigin: "https://devices.invalid",
        updatedAt: new Date(),
      })
      .onConflict((c) => c.column("singletonKey").doUpdateSet({ mode: "private" }))
      .execute();
    const held = await sql<{ count: string }>`
      select (select count(*) from devices where removed_at is null)
        + (select count(*) from runner_enrollments where consumed_at is null and expires_at > now())
        as count`.execute(database);
    const enroll = (index: number) =>
      store.createRunnerEnrollment({
        allowedModules: personalReachableGrant,
        createdBy: f.userId,
        expiresAt: new Date(Date.now() + 3_600_000),
        id: `ren_${randomUUID()}`,
        idempotencyKey: `machine-limit-${index}`,
        name: `Computer ${index}`,
        requestFingerprint: `machine-limit-${index}`,
        runnerKind: "local",
        tokenHash: `sha256:${randomUUID()}`,
      });
    const room = personalInventoryLimits.machines - Number(held.rows[0]!.count);
    for (let index = 0; index < room; index++) await enroll(index);
    await expect(enroll(room)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining(`maximum of ${personalInventoryLimits.machines}`),
    });
  });

  it("refuses an AI account past the account count or the settings budget", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database, store } = storeFixture;
    const f = await createRunFixture("harness-limit");
    const create = (name: string, config: Record<string, unknown>) =>
      store.createHarnessInstance({
        config,
        driverKind: f.harnessInstance.driverKind,
        environmentId: f.environmentId,
        name,
        sourceId: f.harnessInstance.sourceId,
        stateKind: "isolated",
      });
    const used = Number(
      (
        await sql<{ bytes: string }>`select sum(octet_length(config::text)) as bytes
          from harness_instances where removed_at is null`.execute(database)
      ).rows[0]!.bytes,
    );
    // A configuration that takes the total exactly to the budget fits; one byte more does not.
    const base = await storedBytes(database, { model: "test", padding: "" });
    const padding = (total: number) => ({ model: "test", padding: "x".repeat(total - base) });
    const room = personalInventoryLimits.harnessConfigBytes - used;
    await expect(create("Too large", padding(room + 1))).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("larger than this Opensteer can keep"),
    });
    const fits = await create("Fits", padding(room));
    await sql`update harness_instances set config = '{"model":"test"}'::jsonb where id = ${fits.id}`.execute(
      database,
    );
    // Fill the Deployment to its account count, then the next one is refused.
    const count = Number(
      (
        await sql<{ count: string }>`select count(*) as count from harness_instances
          where removed_at is null`.execute(database)
      ).rows[0]!.count,
    );
    await sql`insert into harness_instances
      select (jsonb_populate_record(null::harness_instances, to_jsonb(h)
        || jsonb_build_object('id', 'hin_' || gen_random_uuid(), 'is_default', false,
          'name', 'Seeded ' || n))).*
      from harness_instances h, generate_series(1, ${personalInventoryLimits.harnessInstances - count}) n
      where h.id = ${fits.id}`.execute(database);
    await expect(create("One more", { model: "test" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining(`maximum of ${personalInventoryLimits.harnessInstances}`),
    });
  });

  it("keeps a catalog past the Deployment's catalog budget as an account error", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database, store } = storeFixture;
    const f = await createRunFixture("catalog-limit");
    const catalog = HarnessInstanceCatalogSchema.parse({
      continuationIdentity,
      driverKind: f.harnessInstance.driverKind,
      harnessInstanceId: f.harnessInstance.id,
      models: [
        {
          displayName: "Test",
          isDefault: true,
          modelId: "test",
          options: [],
          providerId: "test",
        },
      ],
      status: "ready",
    });
    const own = await storedBytes(database, catalog);
    // Another account's catalog takes the rest of the budget, to the byte or one past it.
    const other = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: f.harnessInstance.driverKind,
      environmentId: f.environmentId,
      name: "Other",
      sourceId: f.harnessInstance.sourceId,
      stateKind: "isolated",
    });
    const base = await storedBytes(database, { padding: "" });
    const fill = async (bytes: number) => {
      await sql`insert into harness_catalogs(environment_id, harness_instance_id, catalog)
        values (${f.environmentId}, ${other.id}, ${JSON.stringify({ padding: "x".repeat(bytes - base) })}::jsonb)
        on conflict (environment_id, harness_instance_id) do update set catalog = excluded.catalog`.execute(
        database,
      );
    };
    const stored = async () => {
      await store.recordHarnessCatalogs({
        catalogs: [catalog],
        environmentId: f.environmentId,
        expectedRevisions: new Map([[f.harnessInstance.id, f.harnessInstance.runtimeRevision]]),
      });
      const row = await database
        .selectFrom("harnessCatalogs")
        .select("catalog")
        .where("harnessInstanceId", "=", f.harnessInstance.id)
        .executeTakeFirstOrThrow();
      return (row.catalog as { status: string }).status;
    };
    await fill(personalInventoryLimits.catalogBytes - own);
    expect(await stored()).toBe("ready");
    await fill(personalInventoryLimits.catalogBytes - own + 1);
    expect(await stored()).toBe("error");
  });
});
