import {
  automaticModelWants,
  createId,
  emptyAutomaticModelConfig,
  HarnessIdSchema,
  ModelSelectionSchema,
  SpecialistManifestSchema,
  type AutomaticModelConfig,
  type EnvironmentId,
  type HarnessInstanceId,
  type SpecialistManifest,
  type Thread,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import type { HarnessInstanceRecord } from "@opensteer/database";
import { HarnessInstanceCatalogSchema, type HarnessObservedConnection } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  readAutomaticModelPreview,
  resolveAutomaticModels,
  type AutomaticModelDependencies,
} from "./automatic-models.js";
import { specialistPlacement } from "./specialist-placement.js";

const userId = createId("user");
const main = createId("environment");
const laptop = createId("environment");
const effort = {
  id: "effort",
  label: "Effort",
  type: "select" as const,
  defaultValue: "medium",
  values: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
  ],
};
interface AccountSpec {
  readonly driverKind?: string;
  readonly environmentId?: EnvironmentId;
  readonly isDefault?: boolean;
  readonly sourceId?: string;
  readonly models: readonly (readonly [providerId: string, modelId: string])[];
  readonly connections?: readonly HarnessObservedConnection[];
}
function world(
  specs: readonly AccountSpec[],
  options: {
    config?: AutomaticModelConfig;
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
  const config = options.config ?? structuredClone(emptyAutomaticModelConfig);
  config.excludedAccounts.push(...(options.exclude ?? []).map((index) => harnesses[index]!.id));
  const homeThreadId = createId("thread");
  const dependencies = {
    store: {
      getAutomaticModelConfig: async () => config,
      listEnvironmentsForUser: async () => [
        { id: main, name: "Studio Mac" },
        { id: laptop, name: "Laptop" },
      ],
      listHarnessInstances: async () => harnesses,
      listHarnessCatalogs: async () => catalogs,
      findMainWorkspaceForOwner: async () => ({
        homeThreadId,
        backing: { kind: "local-directory", ownerEnvironmentId: main },
      }),
      getThreadForOwner: async () => options.chat ?? null,
    },
    runners: {
      isAvailable: () => true,
      canRunHarness: () => true,
      harnessAccessModes: () => options.accessModes ?? ["full-access"],
    },
  } as unknown as AutomaticModelDependencies &
    Parameters<typeof readAutomaticModelPreview>[0] &
    Parameters<typeof specialistPlacement>[0];
  return { dependencies, harnesses, config };
}
const anyAccount = () => ({ ok: true }) as const;
const exhausted = (usedPercent: number): HarnessObservedConnection => ({
  connectionSlot: "primary",
  label: "Subscription",
  status: "connected",
  usage: {
    limitReached: usedPercent >= 100,
    observedAt: "2026-11-01T00:00:00.000Z",
    windows: [{ label: "weekly", resetsAt: null, usedPercent }],
  },
});
const haiku = ["anthropic", "claude-haiku-5-5"] as const;
const sonnet = ["anthropic", "claude-sonnet-5-5"] as const;
const selection = (modelId: string) =>
  ModelSelectionSchema.parse({ providerId: "anthropic", modelId, options: {} });

describe("automatic model resolution on the Host", () => {
  it("considers a secondary configured account after the engine's default account", async () => {
    const { dependencies, harnesses } = world([{ models: [sonnet] }, { models: [haiku] }]);
    const { candidates } = await resolveAutomaticModels(dependencies, {
      userId,
      wants: (config) => automaticModelWants(config, "light"),
      canRun: anyAccount,
    });
    expect(candidates.map((candidate) => candidate.harnessInstanceId)).toEqual([harnesses[1]!.id]);
  });

  it("keeps the task's own model last despite a stale 100% reading, and demotes ranked models on it", async () => {
    const { dependencies, harnesses } = world([
      { models: [haiku, sonnet], connections: [exhausted(100)] },
      { models: [haiku], isDefault: false },
    ]);
    const { candidates } = await resolveAutomaticModels(dependencies, {
      userId,
      wants: (config) => automaticModelWants(config, "light"),
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

  it("drops the task's own model when the person excluded its account", async () => {
    const { dependencies, harnesses } = world([{ models: [haiku, sonnet] }], { exclude: [0] });
    const own = harnesses[0]!.id;
    const { candidates, skipped } = await resolveAutomaticModels(dependencies, {
      userId,
      wants: (config) => automaticModelWants(config, "light"),
      original: {
        environmentId: main,
        harnessInstanceId: own,
        modelSelection: selection("claude-sonnet-5-5"),
      },
      canRun: anyAccount,
    });
    expect(candidates).toEqual([]);
    expect(skipped).toContainEqual(
      expect.objectContaining({ want: null, harnessInstanceId: own, reason: "excluded" }),
    );
  });

  it("previews light as the general preference and deep within Main's computer, ending with Chat", async () => {
    const { dependencies, harnesses } = world(
      [
        { models: [["anthropic", "claude-opus-5-5"]], environmentId: laptop },
        { driverKind: "codex", sourceId: "openai", models: [["openai", "gpt-6.1-terra"]] },
      ],
      { accessModes: ["full-access"] },
    );
    const view = await readAutomaticModelPreview(
      {
        ...dependencies,
        store: {
          ...dependencies.store,
          getThreadForOwner: async () => ({
            environmentId: main,
            harnessInstanceId: harnesses[1]!.id,
            accessMode: "full-access",
            modelSelection: ModelSelectionSchema.parse({
              providerId: "openai",
              modelId: "gpt-6.1-terra",
              options: {},
            }),
          }),
        } as never,
      },
      userId,
    );
    expect(view.light.label).toBe("General preference");
    expect(view.light.candidates).toEqual([]);
    // Opus is ranked for deep but lives on the laptop, so only Chat's model qualifies.
    expect(view.deep.candidates).toEqual([
      expect.objectContaining({
        harnessInstanceId: harnesses[1]!.id,
        original: true,
        modelDisplayName: "Display gpt-6.1-terra",
        accountDisplayName: "Account 2",
        computerDisplayName: "Studio Mac",
        providerDisplayName: "OpenAI",
      }),
    ]);
    expect(view.deep.skipped).toContainEqual(
      expect.objectContaining({
        harnessInstanceId: harnesses[0]!.id,
        reason: "wrong-computer",
        computerDisplayName: "Laptop",
      }),
    );
    expect(view.accounts.map((account) => account.eligible)).toEqual([true, true]);
  });
});

describe("specialist placement", () => {
  const exact = (modelId: string, options?: Record<string, string>) => ({
    engine: HarnessIdSchema.parse("claude"),
    model: ModelSelectionSchema.shape.modelId.parse(modelId),
    ...(options ? { options } : {}),
  });
  const place = (
    dependencies: Parameters<typeof specialistPlacement>[0],
    specialist: Pick<SpecialistManifest, "models" | "fallback">,
    extra: { caller?: Thread; accessMode?: ThreadAccessMode } = {},
  ) =>
    specialistPlacement(dependencies, {
      userId: userId as UserId,
      environmentId: main,
      accessMode: extra.accessMode ?? "full-access",
      specialist,
      caller: extra.caller,
    });
  const light = (modelId: string) => ({
    roles: { light: [exact(modelId)] },
    excludedAccounts: [] as HarnessInstanceId[],
  });

  it("expands a role in place between exact entries, from the caller's own config", async () => {
    const models = [
      exact("claude-opus-5-5"),
      { role: "light" as const },
      exact("claude-sonnet-5-5"),
    ];
    const offered = world([{ models: [haiku, sonnet] }], { config: light("claude-haiku-5-5") });
    await expect(place(offered.dependencies, { models, fallback: "none" })).resolves.toMatchObject({
      modelSelection: { modelId: "claude-haiku-5-5" },
    });
    // The role's model unavailable: the next exact entry follows, nothing is appended.
    const missing = world([{ models: [sonnet] }], { config: light("claude-haiku-5-5") });
    await expect(place(missing.dependencies, { models, fallback: "none" })).resolves.toMatchObject({
      modelSelection: { modelId: "claude-sonnet-5-5" },
    });
  });

  it("never appends the maintained ranking to an exact-only list", async () => {
    // Haiku leads the maintained light ranking and is offered, yet the manifest never asked for it.
    const { dependencies } = world([{ models: [haiku] }]);
    await expect(
      place(dependencies, { models: [exact("claude-opus-5-5")], fallback: "none" }),
    ).rejects.toThrow(/No specialist model can run: claude\/claude-opus-5-5: model-unavailable/);
  });

  it("can neither bind an account nor use one the caller excluded", async () => {
    expect(
      SpecialistManifestSchema.safeParse({
        version: 1,
        models: [{ ...exact("claude-haiku-5-5"), harnessInstanceId: createId("harnessInstance") }],
      }).success,
    ).toBe(false);
    const { dependencies } = world([{ models: [haiku] }], { exclude: [0] });
    await expect(
      place(dependencies, { models: [exact("claude-haiku-5-5")], fallback: "none" }),
    ).rejects.toThrow(/excluded/);
  });

  it("stores only the options asked for, with the target catalog's native id", async () => {
    const { dependencies, harnesses } = world([{ models: [haiku] }]);
    await expect(
      place(dependencies, { models: [exact("claude-haiku-5-5")], fallback: "none" }),
    ).resolves.toEqual({
      harnessInstanceId: harnesses[0]!.id,
      modelSelection: {
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        nativeModelId: "native/claude-haiku-5-5",
        options: {},
      },
    });
    await expect(
      place(dependencies, {
        models: [exact("claude-haiku-5-5", { effort: "low" })],
        fallback: "none",
      }),
    ).resolves.toMatchObject({ modelSelection: { options: { effort: "low" } } });
  });

  it("runs only on the Workspace's computer, on an engine that enforces its access mode", async () => {
    const elsewhere = world([{ models: [haiku], environmentId: laptop }]);
    await expect(
      place(elsewhere.dependencies, { models: [exact("claude-haiku-5-5")], fallback: "none" }),
    ).rejects.toThrow(/wrong-computer/);
    const unsupported = world([{ models: [haiku] }], { accessModes: ["approval-required"] });
    await expect(
      place(unsupported.dependencies, { models: [exact("claude-haiku-5-5")], fallback: "none" }),
    ).rejects.toThrow(/unsupported-access-mode/);
  });

  it("ends with the caller's model only for fallback: caller", async () => {
    const { dependencies, harnesses } = world([{ models: [sonnet] }]);
    const caller = {
      environmentId: main,
      harnessInstanceId: harnesses[0]!.id,
      modelSelection: selection("claude-sonnet-5-5"),
    } as Thread;
    const models = [exact("claude-opus-5-5")];
    await expect(place(dependencies, { models, fallback: "none" }, { caller })).rejects.toThrow(
      "No specialist model can run",
    );
    await expect(
      place(dependencies, { models, fallback: "caller" }, { caller }),
    ).resolves.toMatchObject({
      harnessInstanceId: harnesses[0]!.id,
      modelSelection: { modelId: "claude-sonnet-5-5" },
    });
  });
});
