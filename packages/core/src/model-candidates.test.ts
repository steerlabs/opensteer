import { SpecialistRegistrationViewSchema } from "./specialists.js";
import { describe, expect, it } from "vitest";
import {
  AutomaticModelConfigSchema,
  AutomaticModelWantSchema,
  ExactModelWantSchema,
  automaticModelWants,
  emptyAutomaticModelConfig,
  expandModelWants,
  ModelPolicyEntrySchema,
} from "./background-models.js";
import { createId } from "./ids.js";
import { HarnessIdSchema, ModelSelectionSchema } from "./models.js";
import {
  resolveModelCandidates,
  type AuthorizedModelAccountSnapshot,
  type OriginalModelSelection,
  type ResolveModelCandidatesInput,
} from "./model-candidates.js";
import { SpecialistManifestSchema } from "./specialists.js";
import {
  AutomaticModelConfigViewSchema,
  AutomaticModelRankViewSchema,
  ModelPolicyEntryViewSchema,
} from "./background-models.js";
import { catalogDefaultModelSelection } from "./model-candidates.js";
import { rankedChatModelSelection } from "./chat-models.js";
const selection = (modelId = "gpt-6-luna", options = {}) =>
  ModelSelectionSchema.parse({
    modelId,
    providerId: modelId.startsWith("claude") ? "anthropic" : "openai",
    options,
  });
function account(
  engine = "codex",
  overrides: Partial<AuthorizedModelAccountSnapshot> = {},
): AuthorizedModelAccountSnapshot {
  const chosen = selection(engine === "claude" ? "claude-haiku-5-5" : "gpt-6-luna");
  return {
    environmentId: createId("environment"),
    harnessInstanceId: createId("harnessInstance"),
    harnessRevision: 1,
    driverKind: HarnessIdSchema.parse(engine),
    sourceId: engine,
    sourceBoundary: engine,
    enabled: true,
    removed: false,
    available: true,
    isDefault: false,
    usage: [],
    catalog: {
      status: "ready",
      models: [
        {
          ...chosen,
          nativeModelId: `gateway/${chosen.modelId}`,
          displayName: "Model",
          isDefault: true,
          options: [
            {
              id: "effort",
              type: "select",
              defaultValue: "low",
              values: [{ value: "low" }, { value: "high" }],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}
const want = (engine = "codex", model = "gpt-6-luna", options?: Record<string, string>) =>
  ExactModelWantSchema.parse({ engine, model, ...(options ? { options } : {}) });
function resolve(
  accounts: readonly AuthorizedModelAccountSnapshot[],
  extra: Partial<ResolveModelCandidatesInput> = {},
) {
  return resolveModelCandidates({
    accounts,
    wants: [want()],
    excludedAccounts: [],
    now: 1000,
    canRun: () => ({ ok: true }),
    ...extra,
  });
}
function own(account: AuthorizedModelAccountSnapshot): OriginalModelSelection {
  return { ...account, modelSelection: selection() };
}
describe("automatic model resolver", () => {
  it("lets a person keep an engine's own small model in their list", () => {
    const small = AutomaticModelWantSchema.parse({ engine: "codex" });
    expect(AutomaticModelWantSchema.safeParse({ engine: "codex", options: {} }).success).toBe(
      false,
    );
    const lightAccount = account("codex", {
      catalog: {
        ...account().catalog!,
        lightModel: selection(),
      },
    });
    expect(resolve([lightAccount], { wants: [small] }).candidates).toMatchObject([
      { storedModelSelection: { modelId: "gpt-6-luna" } },
    ]);
    expect(resolve([account()], { wants: [small] }).skipped).toMatchObject([
      { reason: "model-unavailable", detail: "This account has no small model" },
    ]);
  });
  it("says why an account or model was skipped, account readiness first", () => {
    const signedOut = account("opencode", {
      catalog: { status: "authentication-required", detail: "Sign in to OpenCode Go", models: [] },
    });
    const light = { kind: "catalog-light", driverKind: HarnessIdSchema.parse("opencode") } as const;
    expect(resolve([signedOut], { wants: [light] }).skipped).toMatchObject([
      { reason: "catalog-not-ready", detail: "Sign in to OpenCode Go" },
    ]);
    const base = account();
    const retired = account("codex", {
      catalog: {
        status: "ready",
        models: base.catalog!.models.map((model) => ({
          ...model,
          unavailableReason: "Not on your plan",
        })),
      },
    });
    expect(resolve([retired]).skipped).toMatchObject([
      { reason: "model-unavailable", detail: "Not on your plan" },
    ]);
    expect(
      resolve([base], { wants: [want("codex", "gpt-6-luna", { effort: "max" })] }).skipped,
    ).toMatchObject([
      { reason: "options-unavailable", detail: expect.stringContaining("it takes low, high") },
    ]);
  });
  it("keeps cross-engine want order and puts default first within each want", () => {
    const secondary = account(),
      defaultAccount = account("codex", { isDefault: true }),
      claude = account("claude", { isDefault: true });
    expect(
      resolve([secondary, claude, defaultAccount], {
        wants: [want(), want("claude", "claude-haiku-5-5")],
      }).candidates.map((c) => c.harnessInstanceId),
    ).toEqual([
      defaultAccount.harnessInstanceId,
      secondary.harnessInstanceId,
      claude.harnessInstanceId,
    ]);
  });
  it("reserves the original effective key even when an earlier want specifies the default", () => {
    const a = account(),
      b = account();
    const result = resolve([a, b], {
      wants: [want("codex", "gpt-6-luna", { effort: "low" }), want()],
      original: own(a),
    });
    expect(result.candidates.map((c) => c.harnessInstanceId)).toEqual([
      b.harnessInstanceId,
      a.harnessInstanceId,
    ]);
    expect(result.candidates.map((c) => c.original)).toEqual([false, true]);
    expect(result.candidates[1]?.storedModelSelection.options).toEqual({});
    expect(result.candidates[1]?.runModelSelection.options).toEqual({ effort: "low" });
    expect(result.candidates[1]?.storedModelSelection.nativeModelId).toBe("gateway/gpt-6-luna");
  });
  it.each([
    "excluded",
    "removed",
    "disabled",
    "unauthorized",
    "endpoint-changed",
    "unsupported-access-mode",
  ] as const)("drops an ineligible original: %s", (reason) => {
    const a = account();
    const accounts =
      reason === "unauthorized"
        ? []
        : [
            {
              ...a,
              removed: reason === "removed",
              enabled: reason !== "disabled",
              sourceBoundary: reason === "endpoint-changed" ? "changed" : a.sourceBoundary,
            },
          ];
    const result = resolve(accounts, {
      wants: [],
      original: own(a),
      excludedAccounts: reason === "excluded" ? [a.harnessInstanceId] : [],
      canRun: () => (reason === "unsupported-access-mode" ? { ok: false, reason } : { ok: true }),
    });
    expect(result.candidates).toEqual([]);
    expect(result.skipped[0]?.reason).toBe(reason);
  });
  it("requires explicit binding for each arbitrary endpoint", () => {
    const a = account("codex", { sourceId: "openai-compatible", sourceBoundary: "endpoint-a" });
    const b = account("codex", { sourceId: "openai-compatible", sourceBoundary: "endpoint-b" });
    expect(resolve([a, b]).skipped.map((s) => s.reason)).toEqual([
      "endpoint-binding-required",
      "endpoint-binding-required",
    ]);
    const result = resolve([a, b], {
      wants: [{ ...want(), harnessInstanceId: b.harnessInstanceId }],
    });
    expect(result.candidates.map((c) => c.harnessInstanceId)).toEqual([b.harnessInstanceId]);
    expect(
      resolve([a], {
        wants: [{ ...want("claude", "claude-haiku-5-5"), harnessInstanceId: a.harnessInstanceId }],
      }).candidates,
    ).toEqual([]);
  });
  it("demotes relevant exhausted usage, keeps the original last, ignores expired/unrelated facts", () => {
    const usage = [{ providerId: "openai", exhausted: true, resetsAt: null }];
    const a = account("codex", { isDefault: true, usage }),
      b = account(),
      c = account("codex", { usage });
    const result = resolve([a, b, c], { original: own(c) });
    expect(result.candidates.map((c) => [c.harnessInstanceId, c.usageLimited])).toEqual([
      [b.harnessInstanceId, false],
      [a.harnessInstanceId, true],
      [c.harnessInstanceId, true],
    ]);
    expect(result.skipped).toEqual([]);
    expect(
      resolve([
        {
          ...a,
          usage: [
            { ...usage[0]!, resetsAt: 999 },
            { ...usage[0]!, modelId: "other" },
          ],
        },
      ]).candidates[0]?.usageLimited,
    ).toBe(false);
  });
  it("expands roles in place; exact-only lists have no automatic tail; reset follows defaults", () => {
    const config = AutomaticModelConfigSchema.parse({
      roles: { light: [want()] },
      excludedAccounts: [],
    });
    const exact = want("claude", "claude-haiku-5-5");
    expect(expandModelWants([exact, { role: "light" }, exact], config)).toEqual([
      exact,
      want(),
      exact,
    ]);
    expect(expandModelWants([exact], config)).toEqual([exact]);
    expect(automaticModelWants(config, "light")).toEqual([want()]);
    expect(
      automaticModelWants(emptyAutomaticModelConfig, "light").some(
        (w) => "kind" in w && w.kind === "catalog-light",
      ),
    ).toBe(true);
    expect(
      resolve([account("opencode")], {
        wants: [{ kind: "catalog-light", driverKind: HarnessIdSchema.parse("opencode") }],
      }).candidates,
    ).toEqual([]);
  });
  it("uses catalog-light native selections", () => {
    const a = account("pi");
    const result = resolve([{ ...a, catalog: { ...a.catalog!, lightModel: selection() } }], {
      wants: [{ kind: "catalog-light", driverKind: a.driverKind }],
    });
    expect(result.candidates[0]?.storedModelSelection.nativeModelId).toBe("gateway/gpt-6-luna");
  });
  it("shares catalog and Chat empty-choice defaults", () => {
    const a = account();
    expect(catalogDefaultModelSelection(a.catalog)?.options).toEqual({});
    expect(catalogDefaultModelSelection(null)).toBeNull();
    const preferred = { ...a.catalog!.models[0]!, modelId: selection("gpt-6.1-terra").modelId };
    expect(rankedChatModelSelection([{ models: [preferred] }])?.modelSelection.options).toEqual({
      effort: "high",
    });
  });
});
it("strict executable policies reject mixed/account-bound entries; presentation preserves unknown siblings", () => {
  expect(ModelPolicyEntrySchema.safeParse({ ...want(), role: "light" }).success).toBe(false);
  expect(
    ModelPolicyEntrySchema.safeParse({ ...want(), harnessInstanceId: createId("harnessInstance") })
      .success,
  ).toBe(false);
  expect(
    AutomaticModelConfigSchema.safeParse({ roles: { light: [] }, excludedAccounts: [] }).success,
  ).toBe(false);
  expect(
    AutomaticModelConfigSchema.safeParse({ roles: {}, excludedAccounts: [], consent: [] }).success,
  ).toBe(false);
  expect(
    SpecialistManifestSchema.parse({ version: 1, models: [{ role: "light" }] }).models,
  ).toEqual([{ role: "light" }]);
  const unknown = { role: "future" };
  expect(ModelPolicyEntryViewSchema.array().parse([want(), unknown, { role: "deep" }])).toEqual([
    want(),
    { unknown },
    { role: "deep" },
  ]);
});

it("reads newer Host responses tolerantly while executable input stays strict", () => {
  expect(ModelPolicyEntryViewSchema.parse({ ...want(), futureField: true })).toEqual(want());
  expect(AutomaticModelRankViewSchema.parse({ kind: "future-rank", driverKind: "codex" })).toEqual({
    unknown: { kind: "future-rank", driverKind: "codex" },
  });
  expect(
    AutomaticModelConfigViewSchema.parse({
      roles: { light: [{ ...want(), futureField: 1 }, { future: true }], newRole: [] },
      excludedAccounts: [],
      futureSetting: true,
    }),
  ).toEqual({ roles: { light: [want(), { unknown: { future: true } }] }, excludedAccounts: [] });
  expect(
    AutomaticModelConfigSchema.safeParse({ roles: {}, excludedAccounts: [], futureSetting: true })
      .success,
  ).toBe(false);
});

it("keeps role-only and unknown entries in the registration presentation", () => {
  const view = {
    id: "s",
    workspaceId: "w",
    pluginId: "p",
    pluginVersionId: "v",
    ownerUserId: "u",
    plugin: "p",
    version: "1",
    status: "ready",
    models: [{ role: "light" }, { future: true }, want()],
    fallback: "none",
    access: [],
  };
  expect(SpecialistRegistrationViewSchema.parse(view).models).toEqual([
    { role: "light" },
    { unknown: { future: true } },
    want(),
  ]);
  expect(
    SpecialistRegistrationViewSchema.parse({ ...view, models: [{ role: "deep" }] }).models,
  ).toEqual([{ role: "deep" }]);
});
