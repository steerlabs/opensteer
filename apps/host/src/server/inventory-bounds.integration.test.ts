import { HarnessIdSchema, utf8ByteLength } from "@opensteer/core";
import { HarnessInstanceCatalogSchema, type HarnessInstanceCatalog } from "@opensteer/protocol";
import { personalInventoryBound, type PersonalResourceKind } from "@opensteer/protocol/resources";
import { personalInventoryLimits } from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { sql } from "kysely";
import { expect, it } from "vitest";
import {
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../runtime/private-machine-host.test-support.js";

/** Every page of one complete read, measured exactly as the client measures it. */
async function readWhole(host: PrivateMachineHost, kind: PersonalResourceKind) {
  let cursor: string | undefined;
  let bytes = 0;
  const pages = [];
  for (;;) {
    const page = await host.api["resources.detail.get"]({ kind, ...(cursor ? { cursor } : {}) });
    if (!page.ok) throw new Error(page.error.message);
    bytes += utf8ByteLength(JSON.stringify(page.data.data));
    pages.push(page.data.data);
    if (!page.data.next) return { bytes, pages };
    cursor = page.data.next;
  }
}

async function withHost(run: (host: PrivateMachineHost) => Promise<void>) {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    await run(host);
  } finally {
    await host?.close();
    await database.drop();
  }
}

async function environmentOf(host: PrivateMachineHost) {
  const [environment] = await host.store.listEnvironmentsForUser(host.ownerId, 1);
  if (!environment) throw new Error("The fixture Host has no environment");
  return environment.id;
}

const continuationIdentity = {
  continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
  driverKind: HarnessIdSchema.parse("native"),
} as const;

/** A ready catalog of `count` models, each as large as an ordinary descriptor gets. */
function bigCatalog(harnessInstanceId: string, count: number): HarnessInstanceCatalog {
  return HarnessInstanceCatalogSchema.parse({
    continuationIdentity,
    driverKind: "native",
    harnessInstanceId,
    models: Array.from({ length: count }, (_, index) => ({
      description: "d".repeat(400),
      displayName: `Model ${index} ${"n".repeat(100)}`,
      isDefault: index === 0,
      modelId: `model-${index}-${"m".repeat(200)}`,
      options: [],
      providerId: "test",
    })),
    status: "ready",
  });
}

it("keeps the whole catalog inventory within the client's bound, and reports what it stored", async () => {
  await withHost(async (host) => {
    const environmentId = await environmentOf(host);
    const statuses: string[] = [];
    // Each catalog is about 6 MiB of models projected; the budget admits none past it.
    for (let index = 0; index < 3; index++) {
      const harness = await host.store.createHarnessInstance({
        config: { model: "test" },
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: `Account ${index}`,
        sourceId: "native",
        stateKind: "isolated",
      });
      const size = index === 0 ? 3_000 : 2_000;
      const [recorded] = await host.store.recordHarnessCatalogs({
        catalogs: [bigCatalog(harness.id, size)],
        environmentId,
        expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
      });
      const stored = await host.store.database
        .selectFrom("harnessCatalogs")
        .select("catalog")
        .where("harnessInstanceId", "=", harness.id)
        .executeTakeFirstOrThrow();
      // The caller learns what was committed, ready or kept as an error.
      expect(recorded?.status).toBe((stored.catalog as { status: string }).status);
      statuses.push(recorded!.status);
    }
    expect(statuses).toContain("ready");
    expect(statuses).toContain("error");
    const { bytes, pages } = await readWhole(host, "harness-catalog");
    expect(bytes).toBeLessThanOrEqual(personalInventoryBound("harness-catalog"));
    const refused = pages
      .flatMap((page) =>
        "environments" in page && page.kind === "harness-catalog" ? page.environments : [],
      )
      .flatMap(({ harnessCatalogs }) => harnessCatalogs)
      .find(({ status }) => status === "error");
    expect(refused?.detail).toContain("Remove an AI account");
  });
});

it("keeps the whole AI account inventory within the client's bound at the account and settings caps", async () => {
  await withHost(async (host) => {
    const environmentId = await environmentOf(host);
    const first = await host.store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "n".repeat(120),
      sourceId: "native",
      stateKind: "isolated",
    });
    const { count } = await host.store.database
      .selectFrom("harnessInstances")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("removedAt", "is", null)
      .executeTakeFirstOrThrow();
    // Fill to the account cap with the longest names.
    await sql`insert into harness_instances
      select (jsonb_populate_record(null::harness_instances, to_jsonb(h)
        || jsonb_build_object('id', 'hin_' || gen_random_uuid(), 'is_default', false))).*
      from harness_instances h, generate_series(1, ${personalInventoryLimits.harnessInstances - Number(count)})
      where h.id = ${first.id}`.execute(host.store.database);
    // Spend the settings budget on saved model settings, which the resource shows twice: one
    // account at its own limit, every other sharing the rest.
    const settings = (count: number, width: number) => ({
      model: "test",
      models: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `model-${String(index).padStart(4, "0")}-${"k".repeat(width)}`,
          { contextWindow: 100_000 },
        ]),
      ),
    });
    let large = 1;
    while (
      Buffer.byteLength(JSON.stringify(settings(large + 1, 200))) <=
      personalInventoryLimits.harnessConfigBytesPerAccount
    )
      large++;
    await host.store.updateHarnessInstance({ id: first.id, config: settings(large, 200) });
    const rest = await sql<{ bytes: string; count: string }>`
      select sum(octet_length(config::text)) as bytes, count(*) as count
      from harness_instances where removed_at is null and id <> ${first.id}`.execute(
      host.store.database,
    );
    const share = Math.floor(
      (personalInventoryLimits.harnessConfigBytes -
        Number(
          (
            await sql<{ bytes: string }>`select octet_length(config::text) as bytes
              from harness_instances where id = ${first.id}`.execute(host.store.database)
          ).rows[0]!.bytes,
        )) /
        Number(rest.rows[0]!.count),
    );
    let small = 1;
    while (
      (
        await sql<{
          bytes: number;
        }>`select octet_length(${JSON.stringify(settings(small + 1, 20))}::jsonb::text) as bytes`.execute(
          host.store.database,
        )
      ).rows[0]!.bytes <= share
    )
      small++;
    await sql`update harness_instances set config = ${JSON.stringify(settings(small, 20))}::jsonb
      where removed_at is null and id <> ${first.id}`.execute(host.store.database);
    const total = await sql<{ bytes: string }>`select sum(octet_length(config::text)) as bytes
      from harness_instances where removed_at is null`.execute(host.store.database);
    expect(Number(total.rows[0]!.bytes)).toBeLessThanOrEqual(
      personalInventoryLimits.harnessConfigBytes,
    );
    expect(Number(total.rows[0]!.bytes)).toBeGreaterThan(
      personalInventoryLimits.harnessConfigBytes * 0.95,
    );
    const { bytes } = await readWhole(host, "harness");
    expect(bytes).toBeLessThanOrEqual(personalInventoryBound("harness"));
  });
});

it("serves a catalog whose models are each larger than a page, every option value intact", async () => {
  await withHost(async (host) => {
    const environmentId = await environmentOf(host);
    const harness = await host.store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Large options",
      sourceId: "native",
      stateKind: "isolated",
    });
    // Every option and value at its declared limit: each model is over 100 KB.
    const options = Array.from({ length: 16 }, (_, index) => ({
      id: `option-${index}`,
      label: `Option ${index}`,
      type: "select" as const,
      values: Array.from({ length: 32 }, (_, value) => ({
        label: `Value ${value}`,
        value: `${value}`.padEnd(255, "x"),
      })),
    }));
    const catalog = HarnessInstanceCatalogSchema.parse({
      continuationIdentity,
      driverKind: "native",
      harnessInstanceId: harness.id,
      models: Array.from({ length: 4 }, (_, index) => ({
        displayName: `Large ${index}`,
        isDefault: index === 0,
        modelId: `large-${index}`,
        options,
        providerId: "test",
      })),
      status: "ready",
    });
    const [recorded] = await host.store.recordHarnessCatalogs({
      catalogs: [catalog],
      environmentId,
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });
    expect(recorded?.status).toBe("ready");
    const { bytes, pages } = await readWhole(host, "harness-catalog");
    expect(bytes).toBeLessThanOrEqual(personalInventoryBound("harness-catalog"));
    const models = pages
      .flatMap((page) => (page.kind === "harness-catalog" ? page.environments : []))
      .flatMap(({ harnessCatalogs }) => harnessCatalogs)
      .filter(({ harnessInstanceId }) => harnessInstanceId === harness.id)
      .flatMap((served) => (served.status === "ready" ? served.models : []));
    expect(models.map(({ modelId }) => modelId)).toEqual([
      "large-0",
      "large-1",
      "large-2",
      "large-3",
    ]);
    for (const model of models) expect(model.options).toEqual(catalog.models[0]!.options);
  });
});
