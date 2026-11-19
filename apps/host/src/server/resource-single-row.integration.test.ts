import { HarnessIdSchema, utf8ByteLength } from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import {
  personalResourcePageBytes,
  personalResourceSingleRowBytes,
  type PersonalResourceKind,
} from "@opensteer/protocol/resources";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { expect, it } from "vitest";
import {
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../runtime/private-machine-host.test-support.js";

/** Every page of one complete read, as the client reads it. */
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
    const { pages } = await readWhole(host, "harness-catalog");
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

it("serves an AI account whose settings are larger than a page alone on its page, and refuses only a row past the ceiling", async () => {
  await withHost(async (host) => {
    const environmentId = await environmentOf(host);
    const models = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `model-${String(index).padStart(5, "0")}-${"k".repeat(200)}`,
          { contextWindow: 100_000 },
        ]),
      );
    // About 150 KiB of saved model settings, shown twice in the account's row.
    const large = await host.store.createHarnessInstance({
      config: { model: "test", models: models(600) },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Many saved models",
      sourceId: "native",
      stateKind: "isolated",
    });
    const { pages } = await readWhole(host, "harness");
    const served = pages
      .flatMap((page) => (page.kind === "harness" ? page.harnesses : []))
      .find(({ id }) => id === large.id);
    expect(Object.keys(served?.modelSettings ?? {})).toHaveLength(600);
    expect(utf8ByteLength(JSON.stringify(served))).toBeGreaterThan(personalResourcePageBytes);
    // Past the one ceiling a single row is refused, with the error the screen offers to retry.
    await host.store.updateHarnessInstance({
      id: large.id,
      config: { model: "test", models: models(Math.ceil(personalResourceSingleRowBytes / 450)) },
    });
    const refused = await host.api["resources.detail.get"]({ kind: "harness" });
    expect(refused).toMatchObject({ ok: false, error: { code: "resource_exhausted" } });
  });
});
