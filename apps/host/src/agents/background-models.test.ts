import { expect, it } from "vitest";
import {
  emptyBackgroundModelPreferences,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  HarnessIdSchema,
  ModelSelectionSchema,
} from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import {
  inspectBackgroundCandidates,
  resolveBackgroundCandidates,
  type BackgroundAccountSnapshot,
  type BackgroundResolutionInput,
} from "./background-models.js";
import { namingCandidates } from "./thread-naming.js";
const selection = ModelSelectionSchema.parse({
  providerId: "anthropic",
  modelId: "claude-haiku-5-5",
  options: { effort: "low" },
});
function account(index = 1): BackgroundAccountSnapshot {
  const harnessInstanceId = HarnessInstanceIdSchema.parse(
    `hin_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  return {
    environmentId: EnvironmentIdSchema.parse(
      `env_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ),
    harnessInstanceId,
    harnessRevision: 1,
    driverKind: HarnessIdSchema.parse("claude"),
    enabled: true,
    available: true,
    canRun: true,
    isDefault: true,
    usageByProvider: {},
    catalog: HarnessInstanceCatalogSchema.parse({
      driverKind: "claude",
      harnessInstanceId,
      status: "ready",
      continuationIdentity: {
        driverKind: "claude",
        continuationKey: "runner:v1:" + "a".repeat(43),
      },
      models: [
        {
          ...selection,
          nativeModelId: "native-haiku",
          displayName: "Haiku",
          isDefault: true,
          options: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              values: [{ value: "low", label: "Low" }],
            },
          ],
        },
        {
          providerId: "anthropic",
          modelId: "claude-haiku-4-5",
          displayName: "Older",
          isDefault: false,
          options: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              values: [{ value: "low", label: "Low" }],
            },
          ],
        },
      ],
    }),
  };
}
function input(accounts = [account()]): BackgroundResolutionInput {
  return {
    accounts,
    preferences: structuredClone(emptyBackgroundModelPreferences),
    ownProviderId: "anthropic",
    now: 1000,
  };
}
it("ranks listed models, derives native IDs and emits only model selection fields", () => {
  const candidates = resolveBackgroundCandidates("light", input());
  expect(candidates.map((c) => c.modelSelection.modelId)).toEqual([
    "claude-haiku-5-5",
    "claude-haiku-4-5",
  ]);
  expect(candidates[0]?.modelSelection.nativeModelId).toBe("native-haiku");
  expect(ModelSelectionSchema.safeParse(candidates[0]?.modelSelection).success).toBe(true);
});
it("requires consent across providers, including memory without an own provider", () => {
  const value = { ...input(), ownProviderId: "openai" };
  expect(resolveBackgroundCandidates("light", value)).toEqual([]);
  expect(inspectBackgroundCandidates("light", value)[0]?.skipReason).toBe("consent-required");
  value.preferences.backgroundProviderConsent.push(selection.providerId);
  expect(resolveBackgroundCandidates("light", value)).toHaveLength(2);
});
it("runs a usage-limited model after unlimited ones, never skipping it", () => {
  const current = account();
  const usage = {
    limitReached: true,
    observedAt: "2026-01-01T00:00:00.000Z",
    windows: [
      {
        label: "daily",
        resetsAt: null,
        usedPercent: 100,
        scope: {
          kind: "model" as const,
          providerId: selection.providerId,
          modelId: selection.modelId,
        },
      },
    ],
  };
  const value = input([
    { ...current, usageByProvider: { anthropic: [usage], openai: [{ ...usage, windows: [] }] } },
  ]);
  const ids = (candidates: ReturnType<typeof resolveBackgroundCandidates>) =>
    candidates.map((c) => [c.modelSelection.modelId, c.reason]);
  // Naming tries the limited model last; a memory pass takes the first, unlimited one.
  expect(ids(resolveBackgroundCandidates("light", value))).toEqual([
    ["claude-haiku-4-5", "ranked"],
    ["claude-haiku-5-5", "ranked"],
  ]);
  expect(
    inspectBackgroundCandidates("light", value)
      .filter((decision) => decision.skipReason === null)
      .map((decision) => decision.usageLimited),
  ).toEqual([false, true]);
  // The task's own model still closes the list, after the demoted one.
  const withTask = resolveBackgroundCandidates("light", {
    ...value,
    taskModelFallback: { ...current, modelSelection: selection, reason: "task-model" },
  });
  expect(ids(withTask)).toEqual([
    ["claude-haiku-4-5", "ranked"],
    ["claude-haiku-5-5", "ranked"],
    ["claude-haiku-5-5", "task-model"],
  ]);
  expect(namingCandidates(withTask)).toHaveLength(2);
  // A pin keeps its place: the person chose it, and a reading is only an observation.
  value.preferences.backgroundModels.light = {
    kind: "pinned",
    selection: { ...current, modelSelection: selection },
  };
  expect(ids(resolveBackgroundCandidates("light", value))[0]).toEqual([
    "claude-haiku-5-5",
    "pinned",
  ]);
  // Another provider's reading limits nothing here.
  expect(
    inspectBackgroundCandidates(
      "light",
      input([{ ...current, usageByProvider: { openai: [usage] } }]),
    ).some((decision) => decision.usageLimited),
  ).toBe(false);
});
it("skips offline, unsupported, disabled and unavailable models", () => {
  for (const change of [
    { available: false },
    { canRun: false },
    { enabled: false },
    { catalog: null },
  ])
    expect(resolveBackgroundCandidates("light", input([{ ...account(), ...change }]))).toEqual([]);
  const current = account();
  if (current.catalog?.status !== "ready") throw new Error("ready fixture");
  current.catalog.models[0]!.unavailableReason = "retired";
  expect(resolveBackgroundCandidates("light", input([current]))).toHaveLength(1);
});
it("tries a pin first then continues through automatic ranking", () => {
  const current = account();
  const value = input([current]);
  value.preferences.backgroundModels.light = {
    kind: "pinned",
    selection: {
      ...current,
      modelSelection: {
        ...selection,
        modelId: ModelSelectionSchema.shape.modelId.parse("missing"),
      },
    },
  };

  expect(resolveBackgroundCandidates("light", value)).toHaveLength(2);
});
it("orders by rank, default account, origin and stable identity; always closes with the task model", () => {
  const a = account(1),
    b = account(2),
    c = { ...account(3), isDefault: false };
  const value = {
    ...input([c, a, b]),
    originatingEnvironmentId: b.environmentId,
    taskModelFallback: { ...a, modelSelection: selection, reason: "task-model" as const },
  };
  const candidates = resolveBackgroundCandidates("light", value);
  expect(candidates.slice(0, 3).map((c) => c.environmentId)).toEqual([
    b.environmentId,
    a.environmentId,
    c.environmentId,
  ]);
  // Six ranked; the task model repeats a's first and still closes the list.
  expect(candidates).toHaveLength(7);
  expect(candidates.at(-1)).toMatchObject({
    environmentId: a.environmentId,
    reason: "task-model",
    modelSelection: { modelId: selection.modelId },
  });
});

it("honors a usable pin before ranking, then deduplicates it", () => {
  const current = account();
  const value = input([current]);
  const older = {
    ...selection,
    modelId: ModelSelectionSchema.shape.modelId.parse("claude-haiku-4-5"),
  };
  value.preferences.backgroundModels.light = {
    kind: "pinned",
    selection: {
      environmentId: current.environmentId,
      harnessInstanceId: current.harnessInstanceId,
      modelSelection: older,
    },
  };
  const candidates = resolveBackgroundCandidates("light", value);
  expect(candidates.map((candidate) => candidate.reason)).toEqual(["pinned", "ranked"]);
  expect(candidates[0]?.modelSelection.modelId).toBe(older.modelId);
});
it("drops expired usage limits and rejects invalid pinned options", () => {
  const current = account();
  const value = input([
    {
      ...current,
      usageByProvider: {
        anthropic: [
          {
            observedAt: "2026-01-01T00:00:00.000Z",
            limitReached: true,
            windows: [{ label: "daily", usedPercent: 100, resetsAt: "1970-01-01T00:00:00.000Z" }],
          },
        ],
      },
    },
  ]);
  value.preferences.backgroundModels.light = {
    kind: "pinned",
    selection: {
      environmentId: current.environmentId,
      harnessInstanceId: current.harnessInstanceId,
      modelSelection: { ...selection, options: { effort: "invalid" } },
    },
  };
  expect(inspectBackgroundCandidates("light", value)[0]?.skipReason).toBe("option-unavailable");
  expect(resolveBackgroundCandidates("light", value)).toHaveLength(2);
  expect(inspectBackgroundCandidates("light", value).some((d) => d.usageLimited)).toBe(false);
});

it("closes with the task model as its catalog runs it, deduplicated by one key", () => {
  const current = account();
  if (current.catalog?.status !== "ready") throw new Error("ready fixture");
  current.catalog.models[0]!.options[0]!.defaultValue = "low";
  const candidates = resolveBackgroundCandidates("light", {
    ...input([current]),
    taskModelFallback: {
      ...current,
      modelSelection: { ...selection, options: {} },
      reason: "task-model",
    },
  });
  expect(candidates.at(-1)).toMatchObject({
    reason: "task-model",
    modelSelection: { options: { effort: "low" } },
  });
  expect(namingCandidates(candidates)).toHaveLength(2);
});
