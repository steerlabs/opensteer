import { createId, HarnessIdSchema } from "@opensteer/core";
import { EnvironmentListInputSchema, HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import type { HarnessInstanceRecord } from "@opensteer/database";
import { describe, expect, it, vi } from "vitest";
import { delegationEngines } from "./delegation-placement.js";

/* Failure cases: search after limiting, OR instead of all words, reordered models,
 * lost boolean/default values, stale/cross-engine/cross-query cursors, no-match
 * mistaken for unavailable, duplicate accounts collapsed, disabled/disconnected
 * catalogs exposed as ready, global budget exceeded. */
describe("environment model discovery", () => {
  const environmentId = createId("environment");
  const harness = (name = "Account"): HarnessInstanceRecord => ({
    id: createId("harnessInstance"),
    environmentId,
    driverKind: HarnessIdSchema.parse("native"),
    enabled: true,
    name,
    sourceId: "openai",
    isDefault: false,
    config: {},
    runtimeRevision: 1,
    stateKind: "isolated",
    removedAt: null,
  });
  const models = Array.from({ length: 50 }, (_, index) => ({
    modelId: `model-${index}`,
    providerId: "openai",
    displayName: index > 40 ? `Sol ${index}` : `Model ${index}`,
    isDefault: false,
    options: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        defaultValue: "max",
        values: [{ label: "Max", value: "max" }],
      },
      { id: "thinking", label: "Thinking", type: "toggle", defaultValue: false },
    ],
  }));
  function fixture(accounts = [harness()]) {
    const catalogs = accounts.map((account) => ({
      environmentId,
      capturedAt: new Date("2026-10-27T00:00:00.000Z"),
      harnessInstanceId: account.id,
      catalog: HarnessInstanceCatalogSchema.parse({
        driverKind: "native",
        harnessInstanceId: account.id,
        status: "ready",
        continuationIdentity: {
          driverKind: "native",
          continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        },
        models,
      }),
    }));
    return { accounts, catalogs, store: { listHarnessCatalogs: vi.fn(async () => catalogs) } };
  }
  it("normalizes blank search at both boundaries and shares unfiltered cursors", async () => {
    const tool = toolsForCapabilityProfile("main").find(({ name }) => name === "environment_list")!;
    const variants = [{}, { query: "" }, { query: " \t\n " }];
    const f = fixture();
    const id = f.accounts[0]!.id;
    const discover = (input: ReturnType<typeof EnvironmentListInputSchema.parse>) =>
      delegationEngines(f.store, f.accounts, { input, connected: () => true, canRun: () => true });
    const firstPages: Awaited<ReturnType<typeof delegationEngines>> = [];
    for (const variant of variants) {
      const input = { ...variant, harnessInstanceId: id };
      const parsed = EnvironmentListInputSchema.parse(input);
      expect(parsed.query).toBeUndefined();
      expect(tool.inputSchema.parse(input)).toEqual(parsed);
      firstPages.push((await discover(parsed))[0]!);
    }
    for (const page of firstPages) {
      expect(page).toEqual(firstPages[0]);
      expect(page.models).toHaveLength(8);
      expect(page.modelsOmitted).toBe(42);
      for (const variant of variants) {
        const input = { ...variant, harnessInstanceId: id, cursor: page.modelsNextCursor };
        const parsed = EnvironmentListInputSchema.parse(input);
        expect(parsed.query).toBeUndefined();
        expect(tool.inputSchema.parse(input)).toEqual(parsed);
        const next = (await discover(parsed))[0]!;
        expect(next.models[0]?.modelId).toBe("model-8");
        expect(next.modelsOmitted).toBe(34);
      }
    }
    for (const query of [null, 42, {}, "x".repeat(257)]) {
      expect(EnvironmentListInputSchema.safeParse({ query }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ query }).success).toBe(false);
    }
    for (const variant of variants) {
      expect(
        EnvironmentListInputSchema.safeParse({
          ...variant,
          cursor: firstPages[0]!.modelsNextCursor,
        }).success,
      ).toBe(false);
    }
  });
  it("searches the complete catalog, keeps account identity and compact typed options", async () => {
    const f = fixture([harness(), harness()]);
    const result = await delegationEngines(f.store, f.accounts, {
      input: { query: "SOL openai" },
      connected: () => true,
      canRun: () => true,
    });
    expect(result.map(({ id }) => id)).toEqual(f.accounts.map(({ id }) => id));
    expect(result[0]?.models.map(({ modelId }) => modelId)).toEqual(
      models.slice(41, 49).map(({ modelId }) => modelId),
    );
    expect(result[0]?.modelsOmitted).toBe(1);
    expect(result[0]?.models[0]?.options).toEqual([
      { id: "effort", values: ["max"], default: "max" },
      { id: "thinking", values: [false, true], default: false },
    ]);
    const none = await delegationEngines(f.store, f.accounts, {
      input: { query: "Sol nonexistent" },
      connected: () => true,
      canRun: () => true,
    });
    expect(none[0]).toMatchObject({ status: "ready", models: [], modelsOmitted: 0 });
  });
  it("pages in catalog order and rejects stale and mismatched cursors", async () => {
    const f = fixture();
    const id = f.accounts[0]!.id;
    const first = (
      await delegationEngines(f.store, f.accounts, {
        input: { harnessInstanceId: id },
        connected: () => true,
        canRun: () => true,
      })
    )[0]!;
    const cursor = first.modelsNextCursor!;
    expect(first.models).toHaveLength(8);
    const second = (
      await delegationEngines(f.store, f.accounts, {
        input: { harnessInstanceId: id, cursor },
        connected: () => true,
        canRun: () => true,
      })
    )[0]!;
    expect(second.models[0]?.modelId).toBe("model-8");
    await expect(
      delegationEngines(f.store, f.accounts, {
        input: { cursor },
        connected: () => true,
        canRun: () => true,
      }),
    ).rejects.toThrow();
    await expect(
      delegationEngines(f.store, f.accounts, {
        input: { harnessInstanceId: id, cursor, query: "sol" },
        connected: () => true,
        canRun: () => true,
      }),
    ).rejects.toThrow();
    f.catalogs[0]!.catalog.models.reverse();
    await expect(
      delegationEngines(f.store, f.accounts, {
        input: { harnessInstanceId: id, cursor },
        connected: () => true,
        canRun: () => true,
      }),
    ).rejects.toThrow();
  });
  it("bounds the total and distinguishes unavailable profiles", async () => {
    const f = fixture(Array.from({ length: 8 }, () => harness()));
    const result = await delegationEngines(f.store, f.accounts, {
      input: {},
      connected: () => true,
      canRun: () => true,
    });
    expect(result.reduce((count, row) => count + row.models.length, 0)).toBe(40);
    f.accounts[0] = { ...f.accounts[0]!, enabled: false };
    expect(
      (
        await delegationEngines(f.store, f.accounts, {
          input: {},
          connected: () => true,
          canRun: () => true,
        })
      )[0],
    ).toMatchObject({
      status: "disabled",
      models: [],
    });
    expect(
      (
        await delegationEngines(f.store, f.accounts, {
          input: {},
          connected: () => false,
          canRun: () => true,
        })
      )[1],
    ).toMatchObject({
      status: "disconnected",
      models: [],
    });
    f.catalogs.splice(0);
    expect(
      (
        await delegationEngines(f.store, f.accounts, {
          input: {},
          connected: () => true,
          canRun: () => true,
        })
      )[1],
    ).toMatchObject({
      status: "unreported",
      models: [],
    });
  });
});
