import { randomUUID } from "node:crypto";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import { personalInventoryLimits, projectedCatalogBytes } from "./personal-inventory-limits.js";
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
    // One account: settings exactly at its limit fit; one byte more do not.
    const base = Buffer.byteLength(JSON.stringify({ model: "test", padding: "" }));
    const padding = (total: number) => ({ model: "test", padding: "x".repeat(total - base) });
    const perAccount = personalInventoryLimits.harnessConfigBytesPerAccount;
    await expect(create("Too large", padding(perAccount + 1))).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("for one account"),
    });
    const fits = await create("Fits", padding(perAccount));
    // Every account together: fill the Deployment's settings to just under its budget.
    const storedPadding = await storedBytes(database, padding(perAccount));
    const used = Number(
      (
        await sql<{ bytes: string }>`select sum(octet_length(config::text)) as bytes
          from harness_instances where removed_at is null`.execute(database)
      ).rows[0]!.bytes,
    );
    const copies = Math.floor((personalInventoryLimits.harnessConfigBytes - used) / storedPadding);
    await sql`insert into harness_instances
      select (jsonb_populate_record(null::harness_instances, to_jsonb(h)
        || jsonb_build_object('id', 'hin_' || gen_random_uuid(), 'is_default', false,
          'name', 'Copy ' || n))).*
      from harness_instances h, generate_series(1, ${copies}) n
      where h.id = ${fits.id}`.execute(database);
    const left =
      personalInventoryLimits.harnessConfigBytes -
      Number(
        (
          await sql<{ bytes: string }>`select sum(octet_length(config::text)) as bytes
            from harness_instances where removed_at is null`.execute(database)
        ).rows[0]!.bytes,
      );
    const stored = (config: unknown) => storedBytes(database, config);
    const small = { model: "test", padding: "" };
    const atLeft = { model: "test", padding: "x".repeat(left - (await stored(small))) };
    await expect(
      create("Over the budget", { ...atLeft, padding: `${atLeft.padding}x` }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("larger than this Opensteer can keep"),
    });
    const last = await create("At the budget", atLeft);
    await sql`update harness_instances set config = '{"model":"test"}'::jsonb
      where id = ${last.id} or name like 'Copy %'`.execute(database);
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

  it("keeps a catalog past the Deployment's projected catalog budget as an account error, and says so", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database, store } = storeFixture;
    const f = await createRunFixture("catalog-limit");
    const model = (index: number, description: string) => ({
      description,
      displayName: `Model ${index}`,
      isDefault: index === 0,
      modelId: `model-${index}`,
      options: [],
      providerId: "test",
    });
    const ready = (harnessInstanceId: string, models: ReturnType<typeof model>[]) =>
      HarnessInstanceCatalogSchema.parse({
        continuationIdentity,
        driverKind: f.harnessInstance.driverKind,
        harnessInstanceId,
        models,
        status: "ready",
      });
    const record = async (catalog: ReturnType<typeof ready>, harness: typeof f.harnessInstance) => {
      const [returned] = await store.recordHarnessCatalogs({
        catalogs: [catalog],
        environmentId: f.environmentId,
        expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
      });
      const row = await database
        .selectFrom("harnessCatalogs")
        .select("catalog")
        .where("harnessInstanceId", "=", harness.id)
        .executeTakeFirstOrThrow();
      const stored = row.catalog as { status: string; detail?: string };
      // The caller learns what was committed.
      expect(returned?.status).toBe(stored.status);
      return stored;
    };
    // Another account's catalog takes most of the budget, priced as the module prices it.
    const other = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: f.harnessInstance.driverKind,
      environmentId: f.environmentId,
      name: "Other",
      sourceId: f.harnessInstance.sourceId,
      stateKind: "isolated",
    });
    // This account's catalog: four models whose descriptions share `extra` characters, so its
    // projected size moves one byte at a time.
    const own = (extra: number) => {
      const lengths = [0, 1, 2, 3].map((slot) => Math.max(1, Math.min(500, extra - slot * 500)));
      const catalog = ready(
        f.harnessInstance.id,
        lengths.map((length, index) => model(index, "x".repeat(length))),
      );
      const { models, ...header } = catalog;
      return {
        catalog,
        bytes: projectedCatalogBytes(
          Buffer.byteLength(JSON.stringify(header)),
          Buffer.byteLength(JSON.stringify(models)),
        )!,
      };
    };
    // Another account's catalog takes the rest but for a room this account can match exactly.
    const sample = ready(other.id, [model(1_000_000, "d".repeat(400))]);
    const { models: sampleModels, ...sampleHeader } = sample;
    const header = await storedBytes(database, sampleHeader);
    const perModel = await storedBytes(database, sampleModels);
    const left = (count: number) =>
      personalInventoryLimits.catalogBytes - projectedCatalogBytes(header, count * perModel)!;
    let count = 1;
    while (left(count + 1) >= own(1_000).bytes) count++;
    const filler = Array.from({ length: count }, (_, index) =>
      model(1_000_000 + index, "d".repeat(400)),
    );
    expect((await record(ready(other.id, filler), other)).status).toBe("ready");
    const priced = await sql<{ header: number; models: number }>`
      select octet_length((catalog - 'models')::text) as header,
        octet_length((catalog->'models')::text) as models
      from harness_catalogs where harness_instance_id = ${other.id}`.execute(database);
    const room =
      personalInventoryLimits.catalogBytes -
      projectedCatalogBytes(Number(priced.rows[0]!.header), Number(priced.rows[0]!.models))!;
    let length = 4;
    while (own(length).bytes < room) length++;
    expect(own(length).bytes).toBe(room);
    expect((await record(own(length).catalog, f.harnessInstance)).status).toBe("ready");
    const refused = await record(own(length + 1).catalog, f.harnessInstance);
    expect(refused.status).toBe("error");
    expect(refused.detail).toContain("Remove an AI account");
  });
});
