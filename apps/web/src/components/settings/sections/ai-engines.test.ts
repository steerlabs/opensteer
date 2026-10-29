import {
  harnessCatalog,
  harnessKinds,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type {
  EnvironmentSummary,
  HarnessDriverSummary,
  HarnessSummary,
  ThreadPlacementOption,
} from "@opensteer/client/host";
import type { HarnessSourceDescriptor } from "@opensteer/protocol";
import {
  aiEngineAccountLine,
  aiEngineActions,
  createdHarnessSignInAction,
  endpointAccountName,
  engineGroups,
  nextAccountName,
} from "./ai-engines.js";

function placement(
  availability: ThreadPlacementOption["availability"],
  options: { readonly available?: boolean; readonly setupAvailable?: boolean } = {},
): ThreadPlacementOption {
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    accountName: "Codex",
    availability,
    available: options.available ?? false,
    continuationIdentity: null,
    detail: "Catalog state",
    defaultAccount: true,
    driverKind: "codex",
    engineName: "Codex",
    environmentId: "environment-main",
    environmentKind: "main",
    harnessAuthenticationAllowed: true,
    harnessInstanceId: "harness-cold",
    models: [],
    observedConnections: [],
    modelSelection: ModelSelectionSchema.parse({
      modelId: "unavailable",
      options: {},
      providerId: "unavailable",
    }),
    setupAvailable: options.setupAvailable ?? false,
    setupMethods: [],
    source: {
      fields: [],
      kind: "first-party",
      label: "OpenAI",
      quota: "windows",
      sourceId: "openai",
      stateKinds: ["ambient", "isolated"],
    },
    sourceId: "openai",
    whereLabel: "This computer",
  };
}

describe("sign in after creating an AI engine", () => {
  it("keeps the intent while the cold catalog is still starting", () => {
    expect(createdHarnessSignInAction(undefined, true)).toBe("wait");
    expect(createdHarnessSignInAction(placement("runtime-check"), true)).toBe("wait");
  });

  it("opens sign-in when the eventual catalog reports setup", () => {
    expect(
      createdHarnessSignInAction(
        placement("authentication-required", { setupAvailable: true }),
        true,
      ),
    ).toBe("authenticate");
  });

  it("finishes quietly when the new account is already usable", () => {
    expect(createdHarnessSignInAction(placement("configured", { available: true }), true)).toBe(
      "complete",
    );
  });

  it("stops waiting when the new account's server cannot be reached", () => {
    // An unreachable server is an error catalog, which the placement folds into
    // the same "runtime-check" a catalog that has not landed yet shows.
    expect(createdHarnessSignInAction(placement("runtime-check"), true, "error")).toBe("error");
    // Signing in cannot start a stopped server, so it is not offered as the fix.
    expect(
      createdHarnessSignInAction(placement("unavailable", { setupAvailable: true }), true),
    ).toBe("error");
  });
});

describe("models after connecting a new server", () => {
  it("opens the models when the server answered but none of them can run yet", () => {
    expect(createdHarnessSignInAction(placement("unavailable"), true, "ready", true)).toBe(
      "models",
    );
  });

  it("still reports a server with no runnable model when it has no model settings", () => {
    expect(createdHarnessSignInAction(placement("unavailable"), true, "ready", false)).toBe(
      "error",
    );
  });
});

describe("endpointAccountName", () => {
  const server: HarnessSourceDescriptor = {
    fields: [
      { id: "baseUrl", kind: "url", label: "Base URL" },
      {
        id: "runtime",
        kind: "select",
        label: "Server",
        options: [
          { label: "Ollama", value: "ollama" },
          { label: "Other", value: "generic" },
        ],
      },
    ],
    kind: "compatible-endpoint",
    label: "OpenAI-compatible endpoint",
    quota: "none",
    sourceId: "openai-compatible",
    stateKinds: ["isolated"],
  };

  it("names a known server on its own computer, and any other by its address", () => {
    expect(
      endpointAccountName(server, { baseUrl: "http://localhost:11434/v1", runtime: "ollama" }),
    ).toBe("Ollama");
    expect(
      endpointAccountName(server, { baseUrl: "http://localhost:11434/v1", runtime: "generic" }),
    ).toBe("localhost:11434");
    expect(
      endpointAccountName(server, { baseUrl: "http://10.0.0.5:11434/v1", runtime: "ollama" }),
    ).toBe("10.0.0.5:11434");
    expect(endpointAccountName(server, { baseUrl: "http://192.168.1.20:1234/v1" })).toBe(
      "192.168.1.20:1234",
    );
    expect(endpointAccountName(server, { baseUrl: "http://[::1]:8080/v1" })).toBe("[::1]:8080");
  });

  it("reads only url fields and leaves a scheme's default port out", () => {
    expect(endpointAccountName(server, { runtime: "ollama" })).toBeNull();
    expect(endpointAccountName(server, { baseUrl: "https://OpenRouter.ai/api/v1" })).toBe(
      "openrouter.ai",
    );
  });
});

describe("nextAccountName", () => {
  it("takes the engine's own name first, then the lowest free number", () => {
    expect(nextAccountName("Codex", [])).toBe("Codex");
    expect(nextAccountName("Codex", ["Codex"])).toBe("Codex 2");
    expect(nextAccountName("Codex", ["Codex", "Codex 3"])).toBe("Codex 2");
    expect(nextAccountName("Codex", ["Work", "Codex 2"])).toBe("Codex");
  });
});

describe("engineGroups", () => {
  const environment: EnvironmentSummary = {
    capabilities: [],
    connected: true,
    harnessAuthenticationAllowed: true,
    harnessCatalogs: [],
    harnessDrivers: [
      {
        accessModes: [...ThreadAccessModeSchema.options],
        driverKind: "claude",
        readiness: "runtime-check",
        sources: [
          {
            fields: [],
            kind: "first-party",
            label: "Anthropic",
            quota: "windows",
            sourceId: "anthropic",
            stateKinds: ["ambient", "isolated"],
          },
        ],
      },
      {
        accessModes: [...ThreadAccessModeSchema.options],
        driverKind: "codex",
        readiness: "runtime-check",
        sources: [
          {
            fields: [],
            kind: "first-party",
            label: "OpenAI",
            quota: "windows",
            sourceId: "openai",
            stateKinds: ["ambient", "isolated"],
          },
        ],
      },
      ...["opencode", "pi", "cursor"].map((driverKind): HarnessDriverSummary => ({
        accessModes: ["approval-required", "auto-accept-edits", "full-access"],
        driverKind,
        readiness: "runtime-check",
        sources: [
          {
            fields: [],
            kind: "gateway",
            label: driverKind,
            quota: "none",
            sourceId: driverKind,
            stateKinds: ["isolated"],
          },
        ],
      })),
      // A driver kind the product no longer ships, still reported by the Runner.
      { driverKind: "legacy-engine", readiness: "unavailable", reason: "Not installed" },
    ],
    id: "environment-main",
    kind: "main",
    name: "Main",
    providerStateModes: ["ambient", "isolated"],
    runnerId: "runner-main",
    status: "connected",
    workspaceBackings: ["local-directory"],
  };
  const account = (driverKind: string, name: string): HarnessSummary => ({
    driverKind,
    enabled: true,
    environmentId: "environment-main",
    id: `hin-${name}`,
    isDefault: false,
    name,
    runtimeRevision: 1,
    sourceId: driverKind === "claude" ? "anthropic" : "openai",
    stateKind: "isolated",
  });

  it("lists every usable engine in catalog order with its accounts, whether or not it has any", () => {
    const groups = engineGroups(environment, [account("claude", "Claude Code")]);

    // The work location advertises the engines in its own order; the card list
    // is the catalog's, which is the order every other surface shows.
    expect(
      groups.map((group) => [group.driverKind, group.engineName, group.profiles.length]),
    ).toEqual(
      harnessCatalog.map((entry) => [entry.kind, entry.label, entry.kind === "claude" ? 1 : 0]),
    );
    expect(groups.every((group) => group.addable)).toBe(true);
  });

  it("lists the default account first, then the rest in creation order", () => {
    const [codex] = engineGroups(environment, [
      account("codex", "Codex"),
      account("codex", "Codex 3"),
      { ...account("codex", "Codex 2"), isDefault: true },
    ]);

    expect(codex?.profiles.map((profile) => profile.name)).toEqual(["Codex 2", "Codex", "Codex 3"]);
  });

  it("keeps an engine the Runner no longer offers only while an account of it exists", () => {
    const groups = engineGroups(environment, [account("retired-engine", "retired")]);

    expect(groups.map((group) => group.driverKind)).toEqual([...harnessKinds, "retired-engine"]);
    expect(groups.find((group) => group.driverKind === "retired-engine")?.addable).toBe(false);
  });

  // An engine the person has not installed is reported unavailable with the
  // Runner's own sentence, and an account already added for it has nothing
  // else worth saying.
  it("carries the Runner's reason for an engine it cannot run", () => {
    const groups = engineGroups(environment, [account("legacy-engine", "Legacy")]);

    expect(groups.find((group) => group.driverKind === "legacy-engine")).toMatchObject({
      addable: false,
      sources: [],
      unavailableReason: "Not installed",
    });
    expect(
      groups
        .filter((group) => group.driverKind !== "legacy-engine")
        .every((group) => group.unavailableReason === null),
    ).toBe(true);
  });

  it("offers no adding where the work location cannot hold a private sign-in", () => {
    const groups = engineGroups({ ...environment, providerStateModes: ["ambient"] }, []);

    expect(groups.some((group) => group.addable)).toBe(false);
  });

  it("offers only the sources that can hold a private account", () => {
    const [codex] = engineGroups(
      {
        ...environment,
        harnessDrivers: [
          {
            accessModes: [...ThreadAccessModeSchema.options],
            driverKind: "codex",
            readiness: "runtime-check",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "OpenAI",
                quota: "windows",
                sourceId: "openai",
                stateKinds: ["ambient", "isolated"],
              },
              {
                detail: "Whatever the CLI on this computer is already signed in as.",
                fields: [],
                kind: "first-party",
                label: "The Codex CLI's own sign-in",
                quota: "windows",
                sourceId: "openai-cli",
                stateKinds: ["ambient"],
              },
            ],
          },
        ],
      },
      [],
    );

    expect(codex?.sources.map((source) => source.sourceId)).toEqual(["openai"]);
    expect(codex?.addable).toBe(true);
  });

  it("cannot add an account for an engine whose only source is the CLI's own", () => {
    const [codex] = engineGroups(
      {
        ...environment,
        harnessDrivers: [
          {
            accessModes: [...ThreadAccessModeSchema.options],
            driverKind: "codex",
            readiness: "runtime-check",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "The Codex CLI's own sign-in",
                quota: "windows",
                sourceId: "openai-cli",
                stateKinds: ["ambient"],
              },
            ],
          },
        ],
      },
      [],
    );

    expect(codex?.sources).toEqual([]);
    expect(codex?.addable).toBe(false);
  });

  it("offers no source for a driver the Runner reports unavailable", () => {
    const groups = engineGroups(environment, [account("legacy-engine", "legacy")]);
    const legacy = groups.find((group) => group.driverKind === "legacy-engine");

    expect(legacy?.sources).toEqual([]);
    expect(legacy?.addable).toBe(false);
  });
});

describe("the account line under an AI engine row", () => {
  const apiKeySource: HarnessSourceDescriptor = {
    fields: [],
    kind: "compatible-endpoint",
    label: "OpenAI-compatible endpoint",
    quota: "none",
    sourceId: "openai-compatible",
    stateKinds: ["isolated"],
  };

  it("leaves usage out of a source that cannot report windows", () => {
    expect(
      aiEngineAccountLine(
        {
          accountLabel: "work@example.test",
          authKind: "subscription",
          billingLabel: "Pro",
          connectionSlot: "primary",
          label: "Codex",
          status: "connected",
          usage: {
            limitReached: false,
            observedAt: "2026-09-05T00:00:00.000Z",
            windows: [{ label: "5h", resetsAt: null, usedPercent: 40 }],
          },
        },
        apiKeySource,
      ),
    ).toBe("work@example.test · Pro");
  });

  it("adds what is left of a plan the source does meter", () => {
    expect(
      aiEngineAccountLine(
        {
          accountLabel: "work@example.test",
          authKind: "subscription",
          billingLabel: "Pro",
          connectionSlot: "primary",
          label: "Codex",
          status: "connected",
          usage: {
            limitReached: false,
            observedAt: "2026-09-05T00:00:00.000Z",
            windows: [{ label: "5h", resetsAt: null, usedPercent: 40 }],
          },
        },
        { ...apiKeySource, quota: "windows" },
      ),
    ).toBe("work@example.test · Pro · 5h 40% used");
  });
});

describe("an AI engine row's actions", () => {
  const server: HarnessSourceDescriptor = {
    fields: [],
    kind: "compatible-endpoint",
    label: "OpenAI-compatible endpoint",
    modelSettings: true,
    quota: "none",
    sourceId: "openai-compatible",
    stateKinds: ["isolated"],
  };
  const environment = {
    capabilities: [],
    connected: true,
    harnessAuthenticationAllowed: true,
    harnessCatalogs: [],
    harnessDrivers: [],
    id: "environment-main",
    kind: "main",
    name: "Main",
    providerStateModes: ["isolated"],
    runnerId: "runner-main",
    status: "connected",
    workspaceBackings: ["local-directory"],
  } satisfies EnvironmentSummary;
  const profile: HarnessSummary = {
    driverKind: "opencode",
    enabled: true,
    environmentId: "environment-main",
    id: "hin-server",
    isDefault: true,
    name: "localhost:11434",
    runtimeRevision: 1,
    sourceId: "openai-compatible",
    stateKind: "isolated",
  };
  const model = (modelId: string, unavailableReason?: string) => ({
    displayName: modelId,
    isDefault: false,
    modelId,
    options: [],
    providerId: "custom",
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(unavailableReason === "Effective context window is unknown"
      ? { needsContextWindow: true as const }
      : {}),
  });
  const ready = (models: ReturnType<typeof model>[]) =>
    ({
      connections: [],
      continuationIdentity: null,
      driverKind: "opencode",
      harnessInstanceId: "hin-server",
      models,
      setupMethods: [],
      status: "ready",
    }) as unknown as EnvironmentSummary["harnessCatalogs"][number];
  const preparing = {
    connections: [],
    detail: "Reading models",
    driverKind: "opencode",
    harnessInstanceId: "hin-server",
    models: [],
    setupMethods: [],
    status: "preparing",
  } as unknown as EnvironmentSummary["harnessCatalogs"][number];
  const labels = (actions: ReturnType<typeof aiEngineActions>) => ({
    menu: actions.menu.map(({ id }) => id),
    primary: actions.primary?.id ?? null,
  });

  it("leads with setting up models only when a context size would make one usable", () => {
    const stuck = aiEngineActions({
      catalog: ready([model("qwen3:8b", "Effective context window is unknown")]),
      environment,
      profile,
      setupOpenable: true,
      source: server,
    });
    expect(labels(stuck).primary).toBe("models");
    expect(stuck.primary?.label).toBe("Set up models");

    const partly = aiEngineActions({
      catalog: ready([model("llama3:8b"), model("embed", "Ollama reports no tool support")]),
      environment,
      profile,
      setupOpenable: true,
      source: server,
    });
    expect(labels(partly).primary).toBeNull();
    expect(labels(partly).menu).toContain("models");

    // Beside models that already run, one waiting on a size still leads.
    const mixed = aiEngineActions({
      catalog: ready([
        model("llama3:8b"),
        model("qwen3:8b", "Effective context window is unknown"),
      ]),
      environment,
      profile,
      setupOpenable: true,
      source: server,
    });
    expect(labels(mixed).primary).toBe("models");
  });

  it("keeps saved limits reachable while the server is re-read or its computer is offline", () => {
    const saved = { ...profile, modelSettings: { "qwen3:8b": { contextWindow: 8_192 } } };
    for (const [catalog, connected] of [
      [preparing, true],
      [preparing, false],
    ] as const) {
      expect(
        labels(
          aiEngineActions({
            catalog,
            environment: { ...environment, connected },
            profile: saved,
            setupOpenable: true,
            source: server,
          }),
        ).menu,
      ).toContain("models");
    }
    // Nothing saved and nothing read: there is nothing to show.
    expect(
      labels(
        aiEngineActions({
          catalog: preparing,
          environment,
          profile,
          setupOpenable: true,
          source: server,
        }),
      ).menu,
    ).not.toContain("models");
  });
});
