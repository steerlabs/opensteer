import {
  backgroundModelWants,
  createId,
  HarnessIdSchema,
  ModelSelectionSchema,
  type AgentHomeSettings,
  type EnvironmentId,
  type Thread,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { HarnessInstanceRecord } from "@opensteer/database";
import {
  HarnessInstanceCatalogSchema,
  type AgentHomeSettingsFileView,
  type HarnessObservedConnection,
} from "@opensteer/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  personalExecution,
  readAutomaticModelPreview,
  resolveAutomaticModels,
  type AutomaticModelDependencies,
} from "./automatic-models.js";
const userId = createId("user");
let main = createId("environment");
const laptop = createId("environment");
let owner: Awaited<
  ReturnType<typeof import("../runtime/personal-owner.test-support.js").createPersonalOwnerFixture>
>;
beforeAll(async () => {
  owner = await (
    await import("../runtime/personal-owner.test-support.js")
  ).createPersonalOwnerFixture(userId);
  main = owner.resources!.environmentId;
});
beforeEach(async () => {
  await owner.database
    .updateTable("personalSettings")
    .set({ executionPreferences: { accessMode: "full-access", history: [] } })
    .execute();
});
afterAll(async () => {
  await owner?.close();
});
const effort = {
  id: "effort",
  label: "Effort",
  type: "select" as const,
  defaultValue: "medium",
  values: [
    {
      value: "low",
      label: "Low",
    },
    {
      value: "medium",
      label: "Medium",
    },
    {
      value: "high",
      label: "High",
    },
  ],
};
interface AccountSpec {
  readonly driverKind?: string;
  readonly environmentId?: EnvironmentId;
  readonly isDefault?: boolean;
  readonly sourceId?: string;
  readonly models: readonly (readonly [providerId: string, modelId: string])[];
  readonly connections?: readonly HarnessObservedConnection[];
  /** The catalog's own small model. */
  readonly light?: readonly [providerId: string, modelId: string];
}
function world(
  specs: readonly AccountSpec[],
  options: {
    settings?: AgentHomeSettings;
    file?: AgentHomeSettingsFileView;
    /** Indexes of accounts the person excluded. */
    exclude?: readonly number[];
    accessModes?: readonly ThreadAccessMode[];
    chat?: Pick<Thread, "environmentId" | "harnessInstanceId" | "modelSelection" | "accessMode">;
  } = {},
) {
  const harnesses = specs.map((spec, index): HarnessInstanceRecord => ({
    config: {},
    driverKind: HarnessIdSchema.parse(spec.driverKind ?? "claude"),
    enabled: true,
    environmentId: spec.environmentId ?? main,
    id: createId("harnessInstance"),
    isDefault: spec.isDefault ?? index === 0,
    name: `Account ${index + 1}`,
    removedAt: null,
    runtimeRevision: 1,
    sourceId: spec.sourceId ?? spec.driverKind ?? "claude",
    stateKind: "isolated",
  }));
  const catalogs = harnesses.map((harness, index) => ({
    environmentId: harness.environmentId,
    harnessInstanceId: harness.id,
    catalog: HarnessInstanceCatalogSchema.parse({
      driverKind: harness.driverKind,
      harnessInstanceId: harness.id,
      status: "ready",
      continuationIdentity: {
        driverKind: harness.driverKind,
        continuationKey: "runner:v1:" + "a".repeat(43),
      },
      connections: specs[index]!.connections ?? [],
      ...(specs[index]!.light
        ? {
            lightModel: {
              providerId: specs[index]!.light[0],
              modelId: specs[index]!.light[1],
              options: {},
            },
          }
        : {}),
      models: specs[index]!.models.map(([providerId, modelId]) => ({
        providerId,
        modelId,
        nativeModelId: `native/${modelId}`,
        displayName: `Display ${modelId}`,
        isDefault: false,
        options: [effort],
      })),
    }),
  }));
  const settings: AgentHomeSettings = {
    backgroundModels: {
      ...options.settings?.backgroundModels,
      excludedAccounts: (options.exclude ?? []).map((index) => harnesses[index]!.id),
    },
  };
  const file = options.file ?? { status: "valid" };
  const dependencies = {
    store: {
      database: owner.database,
      getAgentHomeSettings: async () => ({ settings, file }),
      listEnvironmentsForUser: async () => [
        {
          id: main,
          name: "Studio Mac",
        },
        {
          id: laptop,
          name: "Laptop",
        },
      ],
      listHarnessInstances: async () => harnesses,
      listHarnessCatalogs: async () => catalogs,
      getThreadForOwner: async () => options.chat ?? null,
    },
    runners: {
      isAvailable: () => true,
      canRunHarness: () => true,
      harnessAccessModes: () => options.accessModes ?? ["full-access"],
      identityForEnvironment: () => ({ capabilities: ["background-text-v1"] }),
    },
  } as unknown as AutomaticModelDependencies &
    Parameters<typeof readAutomaticModelPreview>[0] & {
      readonly runners: Parameters<typeof personalExecution>[0];
    };
  return {
    dependencies,
    harnesses,
  };
}
const anyAccount = () =>
  ({
    ok: true,
  }) as const;
const exhausted = (usedPercent: number): HarnessObservedConnection => ({
  connectionSlot: "primary",
  label: "Subscription",
  status: "connected",
  usage: {
    limitReached: usedPercent >= 100,
    observedAt: "2026-11-01T00:00:00.000Z",
    windows: [
      {
        label: "weekly",
        resetsAt: null,
        usedPercent,
      },
    ],
  },
});
const haiku = ["anthropic", "claude-haiku-5-5"] as const;
const sonnet = ["anthropic", "claude-sonnet-5-5"] as const;
const selection = (modelId: string) =>
  ModelSelectionSchema.parse({
    providerId: "anthropic",
    modelId,
    options: {},
  });
describe("automatic model resolution on the Host", () => {
  it("considers a secondary configured account after the engine's default account", async () => {
    const { dependencies, harnesses } = world([
      {
        models: [sonnet],
      },
      {
        models: [haiku],
      },
    ]);
    const { candidates } = await resolveAutomaticModels(dependencies, {
      userId,
      wants: (current) => backgroundModelWants(current, "light"),
      canRun: anyAccount,
    });
    expect(candidates.map((candidate) => candidate.harnessInstanceId)).toEqual([harnesses[1]!.id]);
  });
  it("keeps the task's own model last despite a stale 100% reading, and demotes ranked models on it", async () => {
    const { dependencies, harnesses } = world([
      {
        models: [haiku, sonnet],
        connections: [exhausted(100)],
      },
      {
        models: [haiku],
        isDefault: false,
      },
    ]);
    const { candidates } = await resolveAutomaticModels(dependencies, {
      userId,
      wants: (current) => backgroundModelWants(current, "light"),
      original: {
        environmentId: main,
        harnessInstanceId: harnesses[0]!.id,
        modelSelection: selection("claude-sonnet-5-5"),
      },
      canRun: anyAccount,
    });
    expect(
      candidates.map((candidate) => [
        candidate.harnessInstanceId,
        candidate.storedModelSelection.modelId,
        candidate.usageLimited,
      ]),
    ).toEqual([
      [harnesses[1]!.id, "claude-haiku-5-5", false],
      [harnesses[0]!.id, "claude-haiku-5-5", true],
      [harnesses[0]!.id, "claude-sonnet-5-5", true],
    ]);
    expect(candidates.at(-1)?.original).toBe(true);
  });
  it("runs a memory pass only on the task's computer, on an engine that enforces its access mode", async () => {
    const resolve = async (offered: ReturnType<typeof world>) => {
      const { candidates, skipped } = await resolveAutomaticModels(offered.dependencies, {
        userId,
        wants: (current) => backgroundModelWants(current, "light"),
        canRun: personalExecution(offered.dependencies.runners, {
          environmentId: main,
          accessMode: "full-access",
        }),
      });
      return { candidates: candidates.length, reasons: skipped.map((skip) => skip.reason) };
    };
    expect(await resolve(world([{ models: [haiku], environmentId: laptop }]))).toMatchObject({
      candidates: 0,
      reasons: expect.arrayContaining(["wrong-computer"]),
    });
    expect(
      await resolve(world([{ models: [haiku] }], { accessModes: ["approval-required"] })),
    ).toMatchObject({
      candidates: 0,
      reasons: expect.arrayContaining(["unsupported-access-mode"]),
    });
    expect((await resolve(world([{ models: [haiku] }]))).candidates).toBe(1);
  });
  it("drops the task's own model when the person excluded its account", async () => {
    const { dependencies, harnesses } = world(
      [
        {
          models: [haiku, sonnet],
        },
      ],
      {
        exclude: [0],
      },
    );
    const own = harnesses[0]!.id;
    const { candidates, skipped } = await resolveAutomaticModels(dependencies, {
      userId,
      wants: (current) => backgroundModelWants(current, "light"),
      original: {
        environmentId: main,
        harnessInstanceId: own,
        modelSelection: selection("claude-sonnet-5-5"),
      },
      canRun: anyAccount,
    });
    expect(candidates).toEqual([]);
    expect(skipped).toContainEqual(
      expect.objectContaining({
        want: null,
        harnessInstanceId: own,
        reason: "excluded",
      }),
    );
  });
  it("shows what runs each background job: naming anywhere, memory on the hosting computer", async () => {
    const error = {
      path: "/Users/alex/Opensteer/settings.json",
      line: 3,
      column: 5,
      message: "Expected double-quoted property name",
    };
    const { dependencies, harnesses } = world(
      [
        {
          models: [["anthropic", "claude-opus-5-5"]],
          environmentId: laptop,
        },
        {
          driverKind: "codex",
          sourceId: "openai",
          models: [["openai", "gpt-6.1-terra"]],
        },
      ],
      {
        accessModes: ["full-access"],
        settings: {
          backgroundModels: {
            naming: [
              {
                engine: HarnessIdSchema.parse("claude"),
                model: selection("claude-opus-5-5").modelId,
              },
            ],
          },
        },
        file: { status: "invalid", error },
      },
    );
    await owner.store.rememberExecutionChoice(userId, {
      accessMode: "full-access",
      selection: {
        environmentId: main,
        harnessInstanceId: harnesses[1]!.id,
        modelSelection: ModelSelectionSchema.parse({
          providerId: "openai",
          modelId: "gpt-6.1-terra",
          options: {},
        }),
      },
    });
    // Opus lives on the laptop: naming may use it, memory may not, so nightly memory ends with Chat's model.
    expect(await readAutomaticModelPreview(dependencies, userId)).toEqual({
      file: { status: "invalid", error },
      excludedAccounts: [],
      naming: {
        harnessInstanceId: harnesses[0]!.id,
        accountDisplayName: "Account 1",
        computerDisplayName: "Laptop",
        modelDisplayName: "Display claude-opus-5-5",
        effortDisplayName: "Medium",
        usageLimited: false,
      },
      light: null,
      deep: {
        harnessInstanceId: harnesses[1]!.id,
        accountDisplayName: "Account 2",
        computerDisplayName: "Studio Mac",
        modelDisplayName: "Display gpt-6.1-terra",
        effortDisplayName: "Medium",
        usageLimited: false,
      },
    });
  });
});
describe("Settings preview under concurrent account changes", () => {
  it("resolves both roles over one snapshot, so a removal between reads can't crash it", async () => {
    const { dependencies, harnesses } = world([
      {
        models: [haiku],
        light: haiku,
      },
      {
        driverKind: "codex",
        sourceId: "openai",
        models: [["openai", "gpt-6.1-terra"]],
      },
    ]);
    const listHarnessInstances = vi
      .fn()
      .mockResolvedValueOnce(harnesses)
      .mockResolvedValue(harnesses.slice(1));
    const getAgentHomeSettings = vi.fn(dependencies.store.getAgentHomeSettings);
    const view = await readAutomaticModelPreview(
      {
        ...dependencies,
        store: {
          ...dependencies.store,
          getAgentHomeSettings,
          listHarnessInstances,
        } as never,
      },
      userId,
    );
    expect(listHarnessInstances).toHaveBeenCalledTimes(1);
    expect(getAgentHomeSettings).toHaveBeenCalledTimes(1);
    expect(view.naming?.harnessInstanceId).toBe(harnesses[0]!.id);
  });
});
