import { describe, expect, it } from "vitest";
import {
  AgentHomeSettingsSchema,
  AutomaticModelRankSchema,
  BackgroundModelChoiceSchema,
  automaticModelDefaults,
  backgroundModelWants,
  type ModelWant,
} from "./background-models.js";
import { createId } from "./ids.js";
import { HarnessIdSchema, ModelSelectionSchema } from "./models.js";
import {
  resolveModelCandidates,
  type AuthorizedModelAccountSnapshot,
  type OriginalModelSelection,
  type ResolveModelCandidatesInput,
} from "./model-candidates.js";
import { catalogDefaultCandidate, catalogDefaultModelSelection } from "./model-candidates.js";
import { selectionForModelEffort } from "./model-effort.js";
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
const want = (engine = "codex", model?: string, effort?: string) =>
  BackgroundModelChoiceSchema.parse({ engine, model: model ?? "gpt-6-luna", effort });
const ranked = (effort: string) =>
  AutomaticModelRankSchema.parse({
    kind: "model",
    driverKind: "codex",
    providerId: "openai",
    modelId: "gpt-6-luna",
    effort,
  });
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
    const small = BackgroundModelChoiceSchema.parse({ engine: "codex" });
    expect(BackgroundModelChoiceSchema.safeParse({ engine: "codex", options: {} }).success).toBe(
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
    const light = {
      kind: "catalog-light",
      driverKind: HarnessIdSchema.parse("opencode"),
      effort: "low",
    } as const;
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
    expect(resolve([base], { wants: [ranked("max")] }).skipped).toMatchObject([
      { reason: "options-unavailable", detail: expect.stringContaining("it takes low, high") },
    ]);
    // Account readiness precedes option/model checks, and model unavailability precedes effort checks.
    expect(
      resolve([{ ...base, enabled: false }], { wants: [ranked("max")] }).skipped,
    ).toMatchObject([{ reason: "disabled" }]);
    expect(resolve([retired], { wants: [ranked("max")] }).skipped).toMatchObject([
      { reason: "model-unavailable", detail: "Not on your plan" },
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
  it("keeps an earlier want's priority when it matches the original, without duplicating it", () => {
    const a = account(),
      b = account();
    const result = resolve([a, b], {
      wants: [ranked("low"), want()],
      original: own(a),
    });
    expect(result.candidates.map((c) => c.harnessInstanceId)).toEqual([
      a.harnessInstanceId,
      b.harnessInstanceId,
    ]);
    expect(result.candidates.map((c) => c.original)).toEqual([true, false]);
    expect(result.candidates[0]?.storedModelSelection.options).toEqual({});
    expect(result.candidates[0]?.runModelSelection.options).toEqual({ effort: "low" });
    expect(result.candidates[0]?.storedModelSelection.nativeModelId).toBe("gateway/gpt-6-luna");
  });
  it("keeps an explicit deep choice or top default first even when it equals Chat's model", () => {
    const effortLadder = {
      id: "effort",
      type: "select" as const,
      defaultValue: "low",
      values: [{ value: "low" }, { value: "high" }, { value: "xhigh" }],
    };
    const codex = account("codex", {
      isDefault: true,
      catalog: {
        status: "ready",
        models: [
          {
            ...selection("gpt-6.1-sol"),
            displayName: "GPT-6.1-Sol",
            isDefault: true,
            options: [effortLadder],
          },
        ],
      },
    });
    const claude = account("claude", {
      isDefault: true,
      catalog: {
        status: "ready",
        models: [
          {
            ...selection("claude-opus-5-5"),
            displayName: "Claude Opus 5.5",
            isDefault: true,
            options: [effortLadder],
          },
        ],
      },
    });
    const settings = AgentHomeSettingsSchema.parse({
      backgroundModels: {
        deep: [
          {
            engine: "codex",
            account: codex.harnessInstanceId,
            model: "gpt-6.1-sol",
            effort: "xhigh",
          },
        ],
      },
    });
    const explicit = resolve([codex, claude], {
      wants: backgroundModelWants(settings, "deep"),
      original: {
        environmentId: codex.environmentId,
        harnessInstanceId: codex.harnessInstanceId,
        modelSelection: selection("gpt-6.1-sol", { effort: "xhigh" }),
      },
    });
    expect(
      explicit.candidates.map((c) => [
        c.harnessInstanceId,
        c.storedModelSelection.modelId,
        c.runModelSelection.options.effort,
        c.original,
      ]),
    ).toEqual([
      [codex.harnessInstanceId, "gpt-6.1-sol", "xhigh", true],
      [claude.harnessInstanceId, "claude-opus-5-5", "high", false],
      [codex.harnessInstanceId, "gpt-6.1-sol", "high", false],
    ]);
    // Even without settings.json, a default deep model matching Chat's model keeps its rank.
    const defaultMatch = resolve([codex, claude], {
      wants: backgroundModelWants({}, "deep"),
      original: {
        environmentId: claude.environmentId,
        harnessInstanceId: claude.harnessInstanceId,
        modelSelection: selection("claude-opus-5-5", { effort: "high" }),
      },
    });
    expect(
      defaultMatch.candidates.map((c) => [
        c.harnessInstanceId,
        c.storedModelSelection.modelId,
        c.original,
      ]),
    ).toEqual([
      [claude.harnessInstanceId, "claude-opus-5-5", true],
      [codex.harnessInstanceId, "gpt-6.1-sol", false],
    ]);
  });
  it.each(["excluded", "removed", "disabled", "unauthorized", "unsupported-access-mode"] as const)(
    "drops an ineligible original: %s",
    (reason) => {
      const a = account();
      const accounts =
        reason === "unauthorized"
          ? []
          : [
              {
                ...a,
                removed: reason === "removed",
                enabled: reason !== "disabled",
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
    },
  );
  it("never trusts a past Run's arbitrary endpoint, unless the person bound it", () => {
    const endpoint = account("codex", { sourceId: "openai-compatible" });
    const past = { wants: [], original: { ...own(endpoint), fromPastRun: true } };
    const refused = resolve([endpoint], past);
    expect(refused.candidates).toEqual([]);
    expect(refused.skipped[0]?.reason).toBe("endpoint-binding-required");
    expect(resolve([endpoint], { ...past, original: own(endpoint) }).candidates).toHaveLength(1);
    expect(
      resolve([account()], { ...past, original: { ...own(account()), fromPastRun: true } })
        .candidates,
    ).toEqual([]);
    const bound = { ...want(), account: endpoint.harnessInstanceId };
    expect(resolve([endpoint], { ...past, wants: [bound] }).candidates).toMatchObject([
      { harnessInstanceId: endpoint.harnessInstanceId, original: false },
    ]);
  });
  it("matches a canonical provider/model pair for a lab outside the vendor table", () => {
    const a = account("opencode");
    const model = (providerId: string) => ({
      ...a.catalog!.models[0]!,
      providerId: ModelSelectionSchema.shape.providerId.parse(providerId),
      modelId: ModelSelectionSchema.shape.modelId.parse("union-alpha"),
      nativeModelId: `${providerId}/union-alpha@2`,
      options: [],
    });
    const unlisted = { ...a, catalog: { status: "ready", models: [model("union-labs")] } };
    const picked = (accounts: AuthorizedModelAccountSnapshot[], name: string) =>
      resolve(accounts, { wants: [want("opencode", name)] }).candidates.map(
        (c) => c.storedModelSelection,
      );
    for (const name of ["union-alpha", "union-labs/union-alpha"])
      expect(picked([unlisted], name)).toEqual([
        {
          providerId: "union-labs",
          modelId: "union-alpha",
          nativeModelId: "union-labs/union-alpha@2",
          options: {},
        },
      ]);
    // Two labs serve the same ID: only the pair says which.
    const shared = {
      ...a,
      catalog: { status: "ready", models: [model("union-labs"), model("opencode")] },
    };
    expect(picked([shared], "union-alpha")).toEqual([]);
    expect(picked([shared], "opencode/union-alpha")).toEqual([
      expect.objectContaining({ providerId: "opencode", nativeModelId: "opencode/union-alpha@2" }),
    ]);
    // Distinct catalog rows sharing a modelId under different providers never collide on dedup.
    const dual = {
      ...a,
      catalog: {
        status: "ready",
        models: [
          {
            ...model("openai"),
            modelId: ModelSelectionSchema.shape.modelId.parse("llama-3"),
            nativeModelId: "openai/llama-3",
          },
          {
            ...model("meta"),
            modelId: ModelSelectionSchema.shape.modelId.parse("llama-3"),
            nativeModelId: "meta/llama-3",
          },
        ],
      },
    };
    const both = resolve([dual], {
      wants: [want("opencode", "openai/llama-3"), want("opencode", "meta/llama-3")],
      original: {
        environmentId: dual.environmentId,
        harnessInstanceId: dual.harnessInstanceId,
        modelSelection: ModelSelectionSchema.parse({
          providerId: "meta",
          modelId: "llama-3",
          options: {},
        }),
      },
    });
    expect(
      both.candidates.map((c) => [
        c.storedModelSelection.providerId,
        c.storedModelSelection.modelId,
        c.original,
      ]),
    ).toEqual([
      ["openai", "llama-3", false],
      ["meta", "llama-3", true],
    ]);
  });
  it("records a skip when a pinned account is missing from authorized accounts", () => {
    const missing = createId("harnessInstance");
    const pinned = BackgroundModelChoiceSchema.parse({
      engine: "codex",
      account: missing,
      model: "gpt-6-luna",
    });
    const result = resolve([account()], { wants: [pinned] });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([
      { want: pinned, harnessInstanceId: missing, reason: "unauthorized" },
    ]);
  });
  it("requires explicit binding for each arbitrary endpoint", () => {
    const a = account("codex", { sourceId: "openai-compatible" });
    const b = account("codex", { sourceId: "openai-compatible" });
    expect(resolve([a, b]).skipped.map((s) => s.reason)).toEqual([
      "endpoint-binding-required",
      "endpoint-binding-required",
    ]);
    const result = resolve([a, b], {
      wants: [{ ...want(), account: b.harnessInstanceId }],
    });
    expect(result.candidates.map((c) => c.harnessInstanceId)).toEqual([b.harnessInstanceId]);
    expect(
      resolve([a], {
        wants: [{ ...want("claude", "claude-haiku-5-5"), account: a.harnessInstanceId }],
      }).candidates,
    ).toEqual([]);
  });
  it("demotes relevant exhausted usage, keeps priority order, and ignores expired/unrelated facts", () => {
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
    // A healthy original fallback beats an exhausted want rather than failing on a spent account.
    const healthyFallback = account("claude");
    expect(
      resolve([a, healthyFallback], {
        wants: [want()],
        original: {
          ...healthyFallback,
          modelSelection: selection("claude-haiku-5-5"),
        },
      }).candidates.map((c) => [c.harnessInstanceId, c.usageLimited, c.original]),
    ).toEqual([
      [healthyFallback.harnessInstanceId, false, true],
      [a.harnessInstanceId, true, false],
    ]);
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
  it("runs the person's list first, then the recommended order, without repeats", () => {
    const settings = AgentHomeSettingsSchema.parse({
      backgroundModels: { light: [{ engine: "codex", model: "gpt-6-luna" }] },
    });
    const light = [want(), ...automaticModelDefaults.light];
    expect(backgroundModelWants(settings, "light")).toEqual(light);
    expect(backgroundModelWants(settings, "deep")).toEqual(automaticModelDefaults.deep);
    expect(backgroundModelWants({}, "naming")).toEqual(automaticModelDefaults.naming);
    const codex = account("codex", {
      catalog: {
        ...account().catalog!,
        models: [
          ...account().catalog!.models,
          { ...account().catalog!.models[0]!, modelId: selection("gpt-5.6-luna").modelId },
        ],
      },
    });
    const ordered = resolve([codex], {
      wants: backgroundModelWants(
        AgentHomeSettingsSchema.parse({
          backgroundModels: { naming: [{ engine: "codex", model: "gpt-5.6-luna" }] },
        }),
        "naming",
      ),
    }).candidates.map((c) => c.storedModelSelection.modelId);
    expect(ordered).toEqual(["gpt-5.6-luna", "gpt-6-luna"]);
    expect(
      resolve([account("opencode")], {
        wants: [
          { kind: "catalog-light", driverKind: HarnessIdSchema.parse("opencode"), effort: "low" },
        ],
      }).candidates,
    ).toEqual([]);
  });
  it("uses catalog-light native selections at the role's effort", () => {
    const a = account("pi");
    const lightModel = selection("gpt-6-luna", { effort: "low" });
    const result = resolve([{ ...a, catalog: { ...a.catalog!, lightModel } }], {
      wants: [{ kind: "catalog-light", driverKind: a.driverKind, effort: "high" }],
    });
    expect(result.candidates[0]?.storedModelSelection).toMatchObject({
      nativeModelId: "gateway/gpt-6-luna",
      options: { effort: "high" },
    });
  });
  it("runs a person's effort on that model's own ladder, or moves past a model without it", () => {
    const a = account();
    const options = (...wants: ModelWant[]) =>
      resolve([a], { wants }).candidates.map((c) => c.storedModelSelection.options);
    expect(options(want("codex", undefined, "high"))).toEqual([{ effort: "high" }]);
    // The model's default and "default" both leave the engine to state it.
    expect(options(want("codex", undefined, "low"))).toEqual([{}]);
    expect(options(want("codex", undefined, "default"))).toEqual([{}]);
    const fallback = resolve([a], { wants: [want("codex", undefined, "xhigh"), ranked("high")] });
    expect(fallback.skipped).toMatchObject([
      { reason: "options-unavailable", detail: "Model has no xhigh effort; it takes low, high" },
    ]);
    expect(fallback.candidates[0]?.storedModelSelection.options).toEqual({ effort: "high" });
    // An effort replaces the small model's own, and a model with no ladder has one effort.
    const small = {
      ...a,
      catalog: { ...a.catalog!, lightModel: selection("gpt-6-luna", { effort: "low" }) },
    };
    const smallWant = BackgroundModelChoiceSchema.parse({ engine: "codex", effort: "high" });
    expect(
      resolve([small], { wants: [smallWant] }).candidates[0]?.storedModelSelection.options,
    ).toEqual({
      effort: "high",
    });
    const flat = {
      ...a,
      catalog: { ...a.catalog!, models: [{ ...a.catalog!.models[0]!, options: [] }] },
    };
    expect(resolve([flat], { wants: [ranked("high")] }).candidates).toHaveLength(1);
  });
  it("shares catalog and Chat empty-choice defaults", () => {
    const a = account();
    expect(catalogDefaultModelSelection(a.catalog)?.options).toEqual({});
    expect(catalogDefaultModelSelection(null)).toBeNull();
    const preferred = { ...a.catalog!.models[0]!, modelId: selection("gpt-6.1-terra").modelId };
    expect(selectionForModelEffort(preferred, "high").options).toEqual({
      effort: "high",
    });
  });
  it("picks a catalog default in the shared account order, never from an ineligible account", () => {
    const other = account("claude");
    const fallback = account();
    const preferred = account("codex", { isDefault: true });
    const unready = account("codex", {
      isDefault: true,
      catalog: { status: "signed-out", models: [] },
    });
    const choose = (excludedAccounts: AuthorizedModelAccountSnapshot["harnessInstanceId"][] = []) =>
      catalogDefaultCandidate({
        accounts: [other, fallback, unready, preferred],
        excludedAccounts,
        canRun: (candidate) =>
          candidate.driverKind === "claude"
            ? { ok: false, reason: "unsupported-capability" }
            : { ok: true },
      })?.account.harnessInstanceId;
    expect(choose()).toBe(preferred.harnessInstanceId);
    expect(choose([preferred.harnessInstanceId])).toBe(fallback.harnessInstanceId);
    expect(choose([preferred.harnessInstanceId, fallback.harnessInstanceId])).toBeUndefined();
    const endpoint = account("codex", { sourceId: "openai-compatible" });
    const pick = (accounts: AuthorizedModelAccountSnapshot[]) =>
      catalogDefaultCandidate({ accounts, excludedAccounts: [], canRun: () => ({ ok: true }) })
        ?.account.harnessInstanceId;
    expect(pick([endpoint])).toBeUndefined();
    // `isDefault` is assigned to the first enabled account, so it is no explicit choice.
    expect(pick([{ ...endpoint, isDefault: true }])).toBeUndefined();
    expect(pick([{ ...endpoint, isDefault: true }, fallback])).toBe(fallback.harnessInstanceId);
  });
});
it("accepts settings.json as written and rejects anything else", () => {
  const account = createId("harnessInstance");
  for (const valid of [
    {},
    { backgroundModels: {} },
    { backgroundModels: { naming: [], light: [], deep: [], excludedAccounts: [] } },
    {
      backgroundModels: {
        light: [
          { engine: "codex" },
          { engine: "claude", model: "anthropic/claude-haiku-5-5", account },
        ],
        excludedAccounts: [account],
      },
    },
  ])
    expect(AgentHomeSettingsSchema.safeParse(valid).success).toBe(true);
  for (const invalid of [
    { theme: "dark" },
    { backgroundModels: { quick: [] } },
    { backgroundModels: { light: [{ engine: "nope" }] } },
    { backgroundModels: { light: [{ engine: "codex", options: { effort: "low" } }] } },
    { backgroundModels: { light: [{ engine: "codex", model: "" }] } },
    { backgroundModels: { excludedAccounts: ["not-an-account"] } },
    { backgroundModels: { light: Array.from({ length: 17 }, () => ({ engine: "codex" })) } },
  ])
    expect(AgentHomeSettingsSchema.safeParse(invalid).success).toBe(false);
});
