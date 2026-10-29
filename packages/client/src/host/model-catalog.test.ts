import { describe, expect, it } from "vitest";
import { ModelSelectionSchema, ThreadAccessModeSchema } from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  HarnessModelDescriptorSchema,
  type HarnessModelDescriptor,
} from "@opensteer/protocol";
import {
  composerExecutionSelection,
  executionEngines,
  findRoute,
  placementAccountDetail,
  resolveExecutionSelection,
  searchRoutes,
} from "./model-catalog.js";
import {
  selectionForModel,
  threadPlacementOptions,
  type ThreadPlacementOption,
} from "./thread-placement.js";
import type { EnvironmentSummary, HarnessSummary } from "./client.js";

const gptOnCodex = model({
  displayName: "GPT-5.6-Sol",
  isDefault: true,
  modelId: "gpt-5.6-sol",
  providerId: "openai",
  options: [
    effortSelect(["minimal", "low", "medium", "high", "xhigh"], "medium"),
    { defaultValue: false, id: "web", label: "Web search", type: "toggle" },
  ],
});

const gptOnOpencode = model({
  displayName: "GPT-5.6-Sol",
  isDefault: false,
  modelId: "gpt-5.6-sol",
  providerId: "openai",
  options: [effortSelect(["low", "medium", "high"], "medium")],
});

const sonnetOnClaude = model({
  displayName: "Claude Sonnet 5",
  isDefault: true,
  modelId: "claude-sonnet-5",
  providerId: "anthropic",
  options: [effortSelect(["low", "medium", "high", "max"], "medium")],
});

const sonnetOnOpencode = model({
  displayName: "Claude Sonnet 5",
  isDefault: false,
  modelId: "claude-sonnet-5",
  providerId: "anthropic",
  options: [effortSelect(["low", "medium", "high"], "medium")],
});

const codexMain = placement({
  engineLabel: "Codex",
  environmentId: "environment-main",
  harnessInstanceId: "hin-codex",
  models: [gptOnCodex],
});
const opencodeMain = placement({
  engineLabel: "opencode",
  environmentId: "environment-main",
  harnessInstanceId: "hin-opencode",
  models: [gptOnOpencode, sonnetOnOpencode],
});
const claudeMain = placement({
  engineLabel: "Claude Code",
  environmentId: "environment-main",
  harnessInstanceId: "hin-claude",
  models: [sonnetOnClaude],
});

const gptTerra = model({
  displayName: "GPT-5.6-Terra",
  isDefault: false,
  modelId: "gpt-5.6-terra",
  providerId: "openai",
  options: [],
});
const personalConnection = {
  accountLabel: "alex@personal.test",
  billingLabel: "Plus",
  connectionSlot: "primary",
  label: "Codex",
  status: "connected" as const,
  usage: {
    limitReached: false,
    observedAt: "2026-09-15T09:00:00.000Z",
    windows: [{ label: "weekly", resetsAt: "2099-01-01T00:00:00.000Z", usedPercent: 98 }],
  },
};
const workConnection = {
  accountLabel: "alex@work.test",
  billingLabel: "Team",
  connectionSlot: "primary",
  label: "Codex",
  status: "connected" as const,
};
// Two accounts of one engine on one work location, each offering the same models.
const codexPersonal = placement({
  engineLabel: "Codex",
  environmentId: "environment-main",
  harnessInstanceId: "hin-codex-personal",
  models: [gptOnCodex, gptTerra],
  observedConnections: [personalConnection],
});
const codexWork = placement({
  accountName: "Codex 2",
  defaultAccount: false,
  engineLabel: "Codex",
  environmentId: "environment-main",
  harnessInstanceId: "hin-codex-work",
  models: [gptOnCodex, gptTerra],
  observedConnections: [workConnection],
});

// The same engine on the same machine, reaching the same model through a
// gateway it is billed by separately.
const codexOpenRouter = placement({
  accountName: "OpenRouter",
  defaultAccount: false,
  engineLabel: "Codex",
  environmentId: "environment-main",
  harnessInstanceId: "hin-codex-openrouter",
  models: [gptOnCodex],
  observedConnections: [{ ...workConnection, accountLabel: undefined, billingLabel: "API key" }],
  sourceId: "openai-compatible",
  sourceKind: "compatible-endpoint",
  sourceLabel: "OpenAI-compatible endpoint",
});

describe("placementAccountDetail", () => {
  it("details the source when it is not the lab itself, the plan, and what is left", () => {
    const now = Date.parse("2026-09-15T10:00:00.000Z");
    expect(placementAccountDetail(codexPersonal, now)).toMatch(/^Plus · Weekly 98% used · resets /);
    expect(placementAccountDetail(codexWork, now)).toBe("Team");
    expect(
      placementAccountDetail(
        {
          accountName: "OpenRouter",
          observedConnections: [
            { ...workConnection, accountLabel: undefined, billingLabel: "API key" },
          ],
          source: {
            fields: [],
            kind: "compatible-endpoint",
            label: "OpenAI-compatible endpoint",
            quota: "none",
            sourceId: "openai-compatible",
            stateKinds: ["isolated"],
          },
        },
        now,
      ),
    ).toBe("OpenAI-compatible endpoint · API key");
    expect(placementAccountDetail(codexMain, now)).toBeNull();
  });
});

describe("searchRoutes", () => {
  it("narrows account and source matches to the routes the search actually names", () => {
    const placements = [codexPersonal, codexWork, codexOpenRouter];
    const work = searchRoutes(placements, "work.test");
    expect(work).toEqual([
      { model: gptOnCodex, placement: codexWork },
      { model: gptTerra, placement: codexWork },
    ]);
    expect(searchRoutes(placements, "openrouter")).toEqual([
      { model: gptOnCodex, placement: codexOpenRouter },
    ]);
    expect(searchRoutes(placements, "gpt-5.6-sol")).toEqual([
      { model: gptOnCodex, placement: codexPersonal },
      { model: gptOnCodex, placement: codexWork },
      { model: gptOnCodex, placement: codexOpenRouter },
    ]);
  });

  it("finds lab labels and native model ids without depending on display spelling", () => {
    const glm = HarnessModelDescriptorSchema.parse({
      ...gptOnCodex,
      providerId: "zai",
      modelId: "glm-5.2",
      displayName: "GLM 5.2",
      nativeModelId: "vendor/private-glm",
    });
    const account = { ...codexMain, models: [glm] };
    expect(searchRoutes([account], "Z.ai")).toEqual([{ model: glm, placement: account }]);
    expect(searchRoutes([account], "private-glm")).toEqual([{ model: glm, placement: account }]);
  });

  it("matches display names, ids, providers, engines, and accounts case-insensitively", () => {
    const placements = [codexMain, claudeMain, opencodeMain];
    expect(searchRoutes([codexPersonal, codexWork], "WORK.TEST")).toEqual([
      { model: gptOnCodex, placement: codexWork },
      { model: gptTerra, placement: codexWork },
    ]);
    expect(searchRoutes(placements, "SONNET")).toEqual([
      { model: sonnetOnClaude, placement: claudeMain },
      { model: sonnetOnOpencode, placement: opencodeMain },
    ]);
    expect(searchRoutes(placements, "GPT-5.6-SOL")).toEqual([
      { model: gptOnCodex, placement: codexMain },
      { model: gptOnOpencode, placement: opencodeMain },
    ]);
    expect(searchRoutes(placements, "OPENAI")).toEqual([
      { model: gptOnCodex, placement: codexMain },
      { model: gptOnOpencode, placement: opencodeMain },
    ]);
    expect(searchRoutes(placements, "OPENCODE")).toEqual([
      { model: gptOnOpencode, placement: opencodeMain },
      { model: sonnetOnOpencode, placement: opencodeMain },
    ]);
    expect(searchRoutes(placements, "  ")).toEqual([]);
    expect(searchRoutes(placements, "no-such-model")).toEqual([]);
  });
});

describe("findRoute", () => {
  it("resolves the exact account and model of a selection", () => {
    const resolved = findRoute([codexPersonal, codexWork, opencodeMain], {
      environmentId: "environment-main",
      harnessInstanceId: "hin-codex-work",
      modelSelection: selectionForModel(gptOnCodex),
    });

    expect(resolved).toEqual({ model: gptOnCodex, placement: codexWork });
  });

  it("returns null when the account no longer offers the model", () => {
    expect(
      findRoute([codexMain, { ...opencodeMain, models: [sonnetOnOpencode] }], {
        environmentId: "environment-main",
        harnessInstanceId: "hin-opencode",
        modelSelection: selectionForModel(gptOnOpencode),
      }),
    ).toBeNull();
  });
});

describe("selectionForModel", () => {
  it("carries valid option values, clamps invalid ones, and drops unknown keys", () => {
    const carried = { effort: "xhigh", stale: "value", web: true };
    const kept = selectionForModel(gptOnCodex, carried);
    expect(kept.options).toEqual({ effort: "xhigh", web: true });

    // The opencode variant of the same model has no "xhigh" level or toggle,
    // so nothing carried survives and the model's defaults apply.
    const clamped = selectionForModel(gptOnOpencode, carried);
    expect(clamped.options).toEqual({});
  });

  it("names only what differs from the model's defaults", () => {
    // A default is never frozen into a Thread as a choice: the engine's
    // default at the time a Run starts applies, and choosing the default
    // again clears an earlier choice.
    expect(selectionForModel(gptOnCodex).options).toEqual({});
    expect(selectionForModel(gptOnCodex, { effort: "medium", web: false }).options).toEqual({});
    expect(selectionForModel(gptOnCodex, { effort: "low", web: false }).options).toEqual({
      effort: "low",
    });
  });

  it("clears an earlier Claude effort and fast-mode choice when returning to defaults", () => {
    const claude = model({
      displayName: "Claude Sonnet",
      isDefault: true,
      modelId: "claude-sonnet",
      providerId: "anthropic",
      options: [
        {
          defaultValue: "default",
          id: "effort",
          label: "Reasoning",
          type: "select",
          values: [
            { label: "Default", value: "default" },
            { label: "High", value: "high" },
          ],
        },
        { defaultValue: false, id: "fast", label: "Fast mode", type: "toggle" },
      ],
    });
    expect(selectionForModel(claude, { effort: "high", fast: true }).options).toEqual({
      effort: "high",
      fast: true,
    });
    expect(selectionForModel(claude, { effort: "default", fast: false }).options).toEqual({});
  });
});

describe("resolveExecutionSelection", () => {
  it("re-clamps a stale selection against the live descriptors", () => {
    const resolved = resolveExecutionSelection(
      {
        environmentId: "environment-main",
        harnessInstanceId: "hin-opencode",
        modelSelection: ModelSelectionSchema.parse({
          modelId: "gpt-5.6-sol",
          options: { effort: "xhigh" },
          providerId: "openai",
        }),
      },
      [opencodeMain],
    );

    expect(resolved?.modelSelection.options).toEqual({});
  });

  it("returns null when the placement or model is gone", () => {
    const selection = {
      environmentId: "environment-main",
      harnessInstanceId: "hin-codex",
      modelSelection: selectionForModel(gptOnCodex),
    };

    expect(resolveExecutionSelection(selection, [claudeMain])).toBeNull();
    expect(resolveExecutionSelection(null, [codexMain])).toBeNull();
  });
});

describe("composerExecutionSelection", () => {
  const onCodex = {
    environmentId: "environment-main",
    harnessInstanceId: "hin-codex",
    modelSelection: selectionForModel(gptOnCodex),
  };
  const onClaude = {
    environmentId: "environment-main",
    harnessInstanceId: "hin-claude",
    modelSelection: selectionForModel(sonnetOnClaude),
  };

  it("blocks rather than falling back when an explicit choice stops resolving", () => {
    const codexOff = placement({
      available: false,
      engineLabel: "Codex",
      environmentId: "environment-main",
      harnessInstanceId: "hin-codex",
      models: [gptOnCodex],
    });

    expect(
      composerExecutionSelection({
        chosen: onCodex,
        defaultPlacement: claudeMain,
        placements: [codexOff, claudeMain],
        remembered: onClaude,
      }),
    ).toBeNull();
  });

  it("keeps an explicit choice that still resolves", () => {
    expect(
      composerExecutionSelection({
        chosen: onCodex,
        defaultPlacement: claudeMain,
        placements: [codexMain, claudeMain],
        remembered: onClaude,
      })?.harnessInstanceId,
    ).toBe("hin-codex");
  });

  it("starts from the remembered choice when nothing was picked this visit", () => {
    expect(
      composerExecutionSelection({
        chosen: null,
        defaultPlacement: claudeMain,
        placements: [codexMain, claudeMain],
        remembered: onCodex,
      })?.harnessInstanceId,
    ).toBe("hin-codex");
  });

  it("blocks on a remembered choice that stopped resolving rather than defaulting", () => {
    expect(
      composerExecutionSelection({
        chosen: null,
        defaultPlacement: claudeMain,
        placements: [claudeMain],
        remembered: onCodex,
      }),
    ).toBeNull();
  });

  it("uses the default placement only when nothing was ever chosen", () => {
    expect(
      composerExecutionSelection({
        chosen: null,
        defaultPlacement: claudeMain,
        placements: [claudeMain],
        remembered: null,
      })?.harnessInstanceId,
    ).toBe("hin-claude");
    expect(
      composerExecutionSelection({
        chosen: null,
        defaultPlacement: undefined,
        placements: [claudeMain],
        remembered: null,
      }),
    ).toBeNull();
  });
});

function model(input: {
  displayName: string;
  isDefault: boolean;
  modelId: string;
  options: unknown[];
  providerId: string;
}): HarnessModelDescriptor {
  return HarnessModelDescriptorSchema.parse(input);
}

function effortSelect(levels: string[], defaultValue: string): unknown {
  return {
    defaultValue,
    id: "effort",
    label: "Reasoning",
    type: "select",
    values: levels.map((level) => ({ label: level, value: level })),
  };
}

function placement(input: {
  accountName?: string;
  available?: boolean;
  defaultAccount?: boolean;
  engineLabel: string;
  environmentId: string;
  harnessInstanceId: string;
  models: HarnessModelDescriptor[];
  observedConnections?: ThreadPlacementOption["observedConnections"];
  sourceId?: string;
  sourceKind?: NonNullable<ThreadPlacementOption["source"]>["kind"];
  sourceLabel?: string;
  whereLabel?: string;
}): ThreadPlacementOption {
  const first = input.models[0];
  const sourceId = input.sourceId ?? input.engineLabel.toLowerCase();
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    accountName: input.accountName ?? input.engineLabel,
    availability: input.available === false ? "unavailable" : "runtime-check",
    available: input.available ?? true,
    continuationIdentity: null,
    defaultAccount: input.defaultAccount ?? true,
    detail: input.available === false ? "Sign in first" : "Ready",
    driverKind: input.engineLabel.toLowerCase(),
    engineName: input.engineLabel,
    environmentId: input.environmentId,
    environmentKind: "main",
    harnessAuthenticationAllowed: false,
    harnessInstanceId: input.harnessInstanceId,
    models: input.models,
    observedConnections: input.observedConnections ?? [],
    modelSelection: first
      ? selectionForModel(first)
      : ModelSelectionSchema.parse({
          modelId: "unavailable",
          options: {},
          providerId: "unavailable",
        }),
    setupAvailable: false,
    setupMethods: [],
    source: {
      fields: [],
      kind: input.sourceKind ?? "first-party",
      label: input.sourceLabel ?? input.engineLabel,
      quota: "windows",
      sourceId,
      stateKinds: ["ambient", "isolated"],
    },
    sourceId,
    whereLabel: input.whereLabel ?? "Main",
  };
}

describe("model server routing", () => {
  it("keeps two compatible accounts as distinct selectable destinations", () => {
    const placements = serverPlacements([
      { name: "Mac server", models: [gptOnOpencode] },
      { name: "Gateway", models: [gptOnOpencode] },
    ]);
    const engines = executionEngines(placements);
    expect(engines).toHaveLength(1);
    expect(engines[0]?.accounts).toEqual(placements);
    expect(engines[0]?.accounts.map((account) => account.accountName)).toEqual([
      "Mac server",
      "Gateway",
    ]);
    for (const account of placements) {
      expect(
        findRoute(placements, {
          environmentId: account.environmentId,
          harnessInstanceId: account.harnessInstanceId,
          modelSelection: selectionForModel(gptOnOpencode),
        }),
      ).toEqual({ model: gptOnOpencode, placement: account });
    }
  });

  it("does not expose unconfigured models in the composer", () => {
    const unavailable = { ...gptOnOpencode, unavailableReason: "Set the context length" };
    const placements = serverPlacements([{ name: "Mac server", models: [unavailable] }]);
    expect(
      executionEngines(placements).flatMap((engine) =>
        engine.accounts.filter((account) => account.available).flatMap((account) => account.models),
      ),
    ).toEqual([]);
    expect(searchRoutes(placements, "gpt")).toEqual([]);
    expect(
      findRoute(placements, {
        environmentId: "environment-main",
        harnessInstanceId: placements[0]!.harnessInstanceId,
        modelSelection: selectionForModel(unavailable),
      }),
    ).toBeNull();
  });
});

function serverPlacements(
  accounts: readonly { readonly name: string; readonly models: HarnessModelDescriptor[] }[],
): ThreadPlacementOption[] {
  const harnesses: HarnessSummary[] = accounts.map((account, index) => ({
    driverKind: "opencode",
    enabled: true,
    environmentId: "environment-main",
    id: `hin_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    isDefault: index === 0,
    name: account.name,
    runtimeRevision: 1,
    sourceId: "openai-compatible",
    stateKind: "isolated",
  }));
  const environment: EnvironmentSummary = {
    capabilities: ["filesystem"],
    connected: true,
    harnessAuthenticationAllowed: true,
    workspaceBackings: ["local-directory"],
    harnessCatalogs: harnesses.map((harness, index) =>
      HarnessInstanceCatalogSchema.parse({
        continuationIdentity: {
          continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
          driverKind: "opencode",
        },
        driverKind: "opencode",
        harnessInstanceId: harness.id,
        models: accounts[index]!.models,
        status: "ready",
      }),
    ),
    harnessDrivers: [
      {
        accessModes: [...ThreadAccessModeSchema.options],
        driverKind: "opencode",
        readiness: "configured",
        sources: [
          {
            fields: [],
            kind: "compatible-endpoint",
            label: "OpenAI-compatible endpoint",
            quota: "none",
            sourceId: "openai-compatible",
            stateKinds: ["isolated"],
          },
        ],
      },
    ],
    id: "environment-main",
    kind: "main",
    name: "Main",
    providerStateModes: ["isolated"],
    runnerId: "runner-main",
    status: "connected",
  };
  return threadPlacementOptions([environment], harnesses);
}
