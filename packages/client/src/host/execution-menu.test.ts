import { describe, expect, it } from "vitest";
import { ModelSelectionSchema, ThreadAccessModeSchema } from "@opensteer/core";
import { HarnessModelDescriptorSchema, type HarnessModelDescriptor } from "@opensteer/protocol";
import type { ExecutionSelection } from "./execution-preferences.js";
import { executionAccounts, executionMenu } from "./execution-menu.js";
import { selectionForModel, type ThreadPlacementOption } from "./thread-placement.js";

const now = Date.parse("2026-10-30T12:00:00Z");
const terra = model("gpt-6.1-terra", "GPT-6.1 Terra", "Smartest, for long and hard work");
const sol = model("gpt-6.1-sol", "GPT-6.1 Sol");
const opus = model("claude-opus-5-5", "Opus 5.5", undefined, "anthropic");

const codexPro = placement({
  accountLabel: "tim@example.com",
  driverKind: "codex",
  engineName: "Codex",
  id: "codex-pro",
  models: [terra, sol],
});
const claude = placement({
  driverKind: "claude",
  engineName: "Claude Code",
  id: "claude",
  models: [opus],
});
const cursor = placement({
  availability: "authentication-required",
  driverKind: "cursor",
  engineName: "Cursor",
  id: "cursor",
  models: [],
});
const onTerra = choose(codexPro, terra, { effort: "high" });

describe("execution menu", () => {
  it("opens on the AI in use, its account's models, and the settings of the model in force", () => {
    const menu = executionMenu({
      browsing: null,
      history: [],
      placements: [codexPro, claude, cursor],
      selection: onTerra,
    });
    expect(menu.ready.map((engine) => [engine.name, engine.inUse])).toEqual([
      ["Codex", true],
      ["Claude Code", false],
    ]);
    expect(menu.unavailable).toEqual([
      expect.objectContaining({ name: "Cursor", note: "Sign in" }),
    ]);
    expect(menu.browsed?.name).toBe("Codex");
    expect(menu.models.map((row) => [row.name, row.description, row.checked])).toEqual([
      ["GPT-6.1 Terra", "Smartest, for long and hard work", true],
      ["GPT-6.1 Sol", null, false],
    ]);
    expect(menu.settings).toEqual([expect.objectContaining({ kind: "ladder", step: 2 })]);
    expect(menu.blocked).toBeNull();
  });

  it("looks at another AI without touching the choice in force, and shows no settings there", () => {
    const menu = executionMenu({
      browsing: "claude",
      history: [],
      placements: [codexPro, claude],
      selection: onTerra,
    });
    expect(menu.browsed).toMatchObject({ inUse: false, name: "Claude Code" });
    expect(menu.models.map((row) => [row.name, row.checked])).toEqual([["Opus 5.5", false]]);
    expect(menu.settings).toEqual([]);
    expect(menu.current?.model.modelId).toBe("gpt-6.1-terra");
  });

  it("keeps an account that can no longer run as the one shown, so its reason and fix are what the person sees", () => {
    const signedOut = {
      ...codexPro,
      availability: "authentication-required",
      available: false,
    } as const;
    const menu = executionMenu({
      browsing: null,
      history: [],
      placements: [signedOut, claude],
      selection: onTerra,
    });
    expect(menu.browsed).toMatchObject({ inUse: true, name: "Codex", note: "Sign in" });
    expect(menu.blocked).toBe(signedOut);
    expect(menu.models).toEqual([]);
    expect(menu.current).toBeNull();
  });

  it("searches every AI and says where each match runs", () => {
    const menu = executionMenu({
      browsing: null,
      history: [],
      placements: [codexPro, claude],
      query: "opus",
      selection: onTerra,
    });
    expect(menu.results?.map((row) => [row.name, row.description])).toEqual([
      ["Opus 5.5", "Claude Code · Claude Code"],
    ]);
  });
});

describe("conversation accounts", () => {
  it("tells apart accounts that sign in as the same person, and marks the one that has run out", () => {
    const spent = placement({
      accountLabel: "tim@example.com",
      driverKind: "codex",
      engineName: "Codex",
      environmentId: "mini",
      id: "codex-mini",
      limitReached: true,
      models: [terra],
      whereLabel: "Mac mini",
    });
    const accounts = executionAccounts([codexPro, spent, claude], onTerra, now);
    expect(accounts.map((account) => [account.title, account.selected, account.exhausted])).toEqual(
      [
        ["tim@example.com", true, false],
        ["tim@example.com", false, true],
      ],
    );
    expect(accounts.map((account) => account.detail?.split(" · ")[0])).toEqual([
      "This Mac",
      "Mac mini",
    ]);
  });

  it("marks only accounts whose current model has reached its usage limit", () => {
    const spent = { ...codexPro, observedConnections: connection(true) };
    const choices = executionAccounts([spent, codexPro, claude], choose(spent, terra, {}), now);
    expect(choices.map((choice) => choice.exhausted)).toEqual([true, false]);
    expect(executionAccounts([codexPro], onTerra, now)[0]?.exhausted).toBe(false);
  });
});

function model(
  modelId: string,
  displayName: string,
  description?: string,
  providerId = "openai",
): HarnessModelDescriptor {
  return HarnessModelDescriptorSchema.parse({
    ...(description ? { description } : {}),
    displayName,
    isDefault: modelId === "gpt-6.1-terra" || providerId !== "openai",
    modelId,
    options: [
      {
        defaultValue: "medium",
        id: "effort",
        label: "Reasoning",
        type: "select",
        values: ["low", "medium", "high"].map((value) => ({ label: value, value })),
      },
    ],
    providerId,
  });
}

function connection(limitReached: boolean): ThreadPlacementOption["observedConnections"] {
  return [
    {
      accountLabel: "tim@example.com",
      authKind: "subscription",
      billingLabel: "Pro",
      connectionSlot: "chatgpt",
      label: "ChatGPT",
      status: "connected",
      usage: {
        limitReached,
        observedAt: "2026-10-30T11:00:00Z",
        windows: [{ label: "weekly", resetsAt: "2026-11-01T01:35:00Z", usedPercent: 100 }],
      },
    },
  ];
}

function placement(input: {
  accountLabel?: string;
  availability?: ThreadPlacementOption["availability"];
  defaultAccount?: boolean;
  driverKind: string;
  engineName: string;
  environmentId?: string;
  id: string;
  limitReached?: boolean;
  models: HarnessModelDescriptor[];
  whereLabel?: string;
}): ThreadPlacementOption {
  const available = (input.availability ?? "configured") === "configured";
  const first = input.models[0];
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    accountName: input.engineName,
    availability: input.availability ?? "configured",
    available,
    continuationIdentity: null,
    defaultAccount: input.defaultAccount ?? true,
    detail: available ? "Ready" : "Sign in to use this account",
    driverKind: input.driverKind,
    engineName: input.engineName,
    environmentId: input.environmentId ?? "main",
    environmentKind: "main",
    harnessAuthenticationAllowed: true,
    harnessInstanceId: input.id,
    models: input.models,
    modelSelection: first
      ? selectionForModel(first)
      : ModelSelectionSchema.parse({ modelId: "none", options: {}, providerId: "none" }),
    observedConnections: input.accountLabel
      ? connection(input.limitReached ?? false).map((entry) => ({
          ...entry,
          accountLabel: input.accountLabel!,
        }))
      : [],
    setupAvailable: false,
    setupMethods: [],
    source: null,
    sourceId: input.driverKind,
    whereLabel: input.whereLabel ?? "This Mac",
  };
}

function choose(
  account: ThreadPlacementOption,
  chosen: HarnessModelDescriptor,
  options: Record<string, string>,
): ExecutionSelection {
  return {
    environmentId: account.environmentId,
    harnessInstanceId: account.harnessInstanceId,
    modelSelection: selectionForModel(chosen, options),
  };
}
