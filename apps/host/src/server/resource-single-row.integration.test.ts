import { HarnessIdSchema, utf8ByteLength } from "@opensteer/core";
import { HarnessInstanceCatalogSchema, maxHarnessModelsPerCatalog } from "@opensteer/protocol";
import {
  personalResourcePageBytes,
  type PersonalResourceKind,
} from "@opensteer/protocol/resources";
import { HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
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

it("serves an AI account of several MB alone and the client installs it", async () => {
  await withHost(async (host) => {
    const environmentId = await environmentOf(host);
    // The most saved model settings an account can hold, each id near its longest: about 2.2 MB,
    // shown twice in the account's row.
    const models = Object.fromEntries(
      Array.from({ length: maxHarnessModelsPerCatalog }, (_, index) => [
        `model-${String(index).padStart(6, "0")}-${"k".repeat(227)}`,
        { contextWindow: 100_000 },
      ]),
    );
    const large = await host.store.createHarnessInstance({
      config: { model: "test", models },
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
    expect(Object.keys(served?.modelSettings ?? {})).toHaveLength(maxHarnessModelsPerCatalog);
    expect(utf8ByteLength(JSON.stringify(served))).toBeGreaterThan(4 * 1024 * 1024);

    // The client a person runs reads it under its own limits and installs it.
    const client = new HttpHostClient({
      baseUrl: host.origin,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), ...host.ownerHeaders },
        }),
      webSocketFactory: (url) =>
        new WebSocket(url, { headers: host.ownerHeaders }) as unknown as WebSocketClient,
    });
    try {
      await client.load();
      const stop = client.watchPersonalResource("harness", () => undefined);
      await vi.waitFor(
        () => {
          const installed = client.getSnapshot().harnesses.find(({ id }) => id === large.id);
          expect(Object.keys(installed?.modelSettings ?? {})).toHaveLength(
            maxHarnessModelsPerCatalog,
          );
        },
        { timeout: 15_000, interval: 50 },
      );
      expect(client.getSnapshot().unreadableResources ?? []).not.toContain("harness");
      stop();
    } finally {
      client.dispose();
    }
  });
});
