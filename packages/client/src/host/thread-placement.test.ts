import { describe, expect, it } from "vitest";
import { ThreadAccessModeSchema, type ThreadAccessMode } from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import type { EnvironmentSummary, HarnessSummary } from "./client.js";
import {
  compatibleThreadPlacements,
  defaultThreadPlacement,
  resolveThreadPlacement,
  threadPlacementOptions,
} from "./thread-placement.js";

const harnesses: HarnessSummary[] = [
  {
    driverKind: "codex",
    enabled: true,
    environmentId: "environment-main",
    id: "hin_00000000-0000-4000-8000-000000000001",
    name: "Codex",
    isDefault: true,
    runtimeRevision: 1,
    sourceId: "openai",
    stateKind: "isolated",
  },
  {
    driverKind: "claude",
    enabled: true,
    environmentId: "environment-cloud",
    id: "hin_00000000-0000-4000-8000-000000000007",
    name: "Claude Code",
    isDefault: true,
    runtimeRevision: 1,
    sourceId: "anthropic",
    stateKind: "isolated",
  },
  {
    driverKind: "claude",
    enabled: true,
    environmentId: "environment-main",
    id: "hin_00000000-0000-4000-8000-000000000002",
    name: "Claude Code",
    isDefault: true,
    runtimeRevision: 1,
    sourceId: "anthropic",
    stateKind: "isolated",
  },
  {
    driverKind: "codex",
    enabled: true,
    environmentId: "environment-local",
    id: "hin_00000000-0000-4000-8000-000000000003",
    name: "Codex",
    isDefault: true,
    runtimeRevision: 1,
    sourceId: "openai",
    stateKind: "ambient",
  },
  {
    driverKind: "codex",
    enabled: true,
    environmentId: "environment-managed",
    id: "hin_00000000-0000-4000-8000-000000000004",
    name: "Codex",
    isDefault: true,
    runtimeRevision: 1,
    sourceId: "openai",
    stateKind: "isolated",
  },
  {
    driverKind: "claude",
    enabled: true,
    environmentId: "environment-managed",
    id: "hin_00000000-0000-4000-8000-000000000005",
    name: "Claude Code",
    isDefault: true,
    runtimeRevision: 1,
    sourceId: "anthropic",
    stateKind: "isolated",
  },
  {
    driverKind: "codex",
    enabled: true,
    environmentId: "environment-cloud",
    id: "hin_00000000-0000-4000-8000-000000000006",
    name: "Codex",
    isDefault: true,
    runtimeRevision: 1,
    sourceId: "openai",
    stateKind: "isolated",
  },
];

describe("Thread placement", () => {
  it("defaults to a compatible Main pair and permits an explicit local pair", () => {
    const environments: EnvironmentSummary[] = [
      environment("environment-local", "local", "Alex’s Mac", [
        { driverKind: "codex", readiness: "runtime-check" },
      ]),
      environment("environment-main", "main", "Hosted Runner", [
        { driverKind: "codex", readiness: "runtime-check" },
        { driverKind: "claude", readiness: "runtime-check" },
      ]),
    ];

    expect(resolveThreadPlacement(environments, harnesses, {})).toMatchObject({
      accountName: "Codex",
      environmentId: "environment-main",
      harnessInstanceId: "hin_00000000-0000-4000-8000-000000000001",
      whereLabel: "Main",
    });
    expect(
      resolveThreadPlacement(environments, harnesses, {
        environmentId: "environment-local",
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000000003",
      }),
    ).toMatchObject({
      accountName: "Codex",
      environmentId: "environment-local",
      harnessInstanceId: "hin_00000000-0000-4000-8000-000000000003",
      whereLabel: "Alex’s Mac",
    });
    expect(compatibleThreadPlacements(environments, harnesses)).toHaveLength(3);
  });

  it("names the engine, carries the default flag, and lists the default account first", () => {
    const environments: EnvironmentSummary[] = [
      environment("environment-main", "main", "Hosted Runner", [
        { driverKind: "codex", readiness: "runtime-check" },
      ]),
    ];
    const second: HarnessSummary = {
      driverKind: "codex",
      enabled: true,
      environmentId: "environment-main",
      id: "hin_00000000-0000-4000-8000-000000000011",
      isDefault: true,
      name: "Codex 2",
      runtimeRevision: 1,
      sourceId: "openai",
      stateKind: "isolated",
    };
    // Creation order says the original comes first; the default flag says
    // otherwise, and the flag wins so renaming never reorders accounts.
    const options = threadPlacementOptions(environments, [
      { ...harnesses[0]!, isDefault: false },
      second,
    ]);

    expect(options.map((option) => option.accountName)).toEqual(["Codex 2", "Codex"]);
    expect(options[0]).toMatchObject({ defaultAccount: true, engineName: "Codex" });
    expect(options[1]).toMatchObject({ defaultAccount: false, engineName: "Codex" });
  });

  it("keeps disconnected and explicitly unavailable combinations visible but unselectable", () => {
    const environments: EnvironmentSummary[] = [
      environment("environment-main", "main", "Hosted Runner", [
        { driverKind: "codex", readiness: "unavailable", reason: "Sign in to Codex" },
        { driverKind: "claude", readiness: "runtime-check" },
      ]),
      {
        ...environment("environment-local", "local", "Local runner", []),
        connected: false,
        status: "disconnected",
      },
    ];

    expect(threadPlacementOptions(environments, harnesses)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availability: "unavailable",
          available: false,
          detail: "Sign in to Codex",
          accountName: "Codex",
          whereLabel: "Main",
        }),
        expect.objectContaining({
          availability: "disconnected",
          available: false,
          whereLabel: "Local runner",
        }),
      ]),
    );
    expect(() =>
      resolveThreadPlacement(environments, harnesses, {
        environmentId: "environment-main",
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow(/Sign in to Codex/);
    expect(() =>
      resolveThreadPlacement(environments, harnesses, { environmentId: "environment-main" }),
    ).toThrow(/Choose both where work runs and the AI engine/);
  });

  it("carries the engine's declared access modes, and says nothing when it has not declared", () => {
    const environments: EnvironmentSummary[] = [
      environment("environment-main", "main", "Hosted Runner", [
        {
          accessModes: ["approval-required", "full-access"],
          driverKind: "codex",
          readiness: "runtime-check",
        },
        { driverKind: "claude", readiness: "unavailable", reason: "Not installed" },
      ]),
    ];
    const placements = threadPlacementOptions(environments, harnesses).filter(
      (option) => option.environmentId === "environment-main",
    );

    expect(placements.find(({ driverKind }) => driverKind === "codex")?.accessModes).toEqual([
      "approval-required",
      "full-access",
    ]);
    // A driver that cannot run advertises no modes at all; null is the client
    // saying it does not know, which is not the same as knowing none.
    expect(placements.find(({ driverKind }) => driverKind === "claude")?.accessModes).toBeNull();
  });

  it("projects authentication and its remote action independently from engine availability", () => {
    const managedCodex = harnesses.find(
      (harness) =>
        harness.environmentId === "environment-managed" && harness.driverKind === "codex",
    )!;
    const localCodex = harnesses.find(
      (harness) => harness.environmentId === "environment-local" && harness.driverKind === "codex",
    )!;
    const catalog = HarnessInstanceCatalogSchema.parse({
      detail: "Sign in to Codex",
      driverKind: "codex",
      harnessInstanceId: managedCodex.id,
      models: [],
      setupMethods: [
        {
          connectionSlot: "primary",
          kind: "device-code",
          label: "Subscription",
          methodId: "subscription",
        },
      ],
      status: "authentication-required",
    });
    const managed = {
      ...environment("environment-managed", "managed", "Managed Runner", [
        { driverKind: "codex", readiness: "runtime-check" },
        { driverKind: "claude", readiness: "runtime-check" },
      ]),
      harnessCatalogs: [
        catalog,
        ...environment("environment-managed", "managed", "Managed Runner", [
          { driverKind: "claude", readiness: "runtime-check" },
        ]).harnessCatalogs,
      ],
    };
    const local = {
      ...managed,
      harnessCatalogs: [
        HarnessInstanceCatalogSchema.parse({
          detail: "Sign in to Codex",
          driverKind: "codex",
          harnessInstanceId: localCodex.id,
          models: [],
          setupMethods: [],
          status: "authentication-required",
        }),
      ],
      id: "environment-local",
      kind: "local" as const,
      name: "This Mac",
    };

    expect(threadPlacementOptions([managed], harnesses)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availability: "authentication-required",
          accountName: "Codex",
          setupAvailable: true,
        }),
        expect.objectContaining({ available: true, accountName: "Claude Code" }),
      ]),
    );
    expect(threadPlacementOptions([local], harnesses)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availability: "authentication-required",
          accountName: "Codex",
          setupAvailable: false,
        }),
      ]),
    );
  });

  it("keeps a preparing engine unavailable for execution and sign-in", () => {
    const location = environment("environment-main", "main", "This computer", [
      { driverKind: "codex", readiness: "runtime-check" },
    ]);
    const catalog = HarnessInstanceCatalogSchema.parse({
      driverKind: "codex",
      harnessInstanceId: harnesses[0]?.id,
      models: [],
      status: "preparing",
      detail: "Preparing Codex…",
    });
    const [placement] = threadPlacementOptions(
      [{ ...location, harnessCatalogs: [catalog] }],
      [harnesses[0]!],
    );
    expect(placement).toMatchObject({
      availability: "preparing",
      available: false,
      detail: "Preparing Codex…",
      setupAvailable: false,
      models: [],
    });
  });

  it("names a work location \u201cthis computer\u201d only by verified Runner identity", () => {
    const environments: EnvironmentSummary[] = [
      environment("environment-main", "main", "Hosted Runner", [
        { driverKind: "codex", readiness: "runtime-check" },
      ]),
      environment("environment-local", "local", "Alex\u2019s Mac environment", [
        { driverKind: "codex", readiness: "runtime-check" },
      ]),
    ];
    const localOf = (options: readonly { readonly environmentId: string }[]) =>
      options.find((option) => option.environmentId === "environment-local");

    expect(localOf(threadPlacementOptions(environments, harnesses))).toMatchObject({
      whereLabel: "Alex\u2019s Mac environment",
    });
    expect(
      localOf(
        threadPlacementOptions(environments, harnesses, {
          label: "This Mac",
          runnerId: "runner-environment-local",
        }),
      ),
    ).toMatchObject({ whereLabel: "This Mac" });
    // A Runner that is not this computer keeps the durable name, however the
    // work location happens to be spelled.
    expect(
      localOf(
        threadPlacementOptions(environments, harnesses, {
          label: "This Mac",
          runnerId: "runner-somewhere-else",
        }),
      ),
    ).toMatchObject({ whereLabel: "Alex\u2019s Mac environment" });
  });

  it("never falls back from an unavailable Main to local execution implicitly", () => {
    const environments: EnvironmentSummary[] = [
      {
        ...environment("environment-main", "main", "Hosted Runner", [
          { driverKind: "codex", readiness: "runtime-check" },
        ]),
        connected: false,
        status: "disconnected",
      },
      environment("environment-local", "local", "Alex’s Mac", [
        { driverKind: "codex", readiness: "runtime-check" },
      ]),
    ];

    expect(defaultThreadPlacement(environments, harnesses)).toBeUndefined();
    expect(compatibleThreadPlacements(environments, harnesses)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ environmentId: "environment-local", available: true }),
      ]),
    );
    expect(() => resolveThreadPlacement(environments, harnesses, {})).toThrow(
      /Main cannot start this Thread/,
    );
  });
});

function environment(
  id: string,
  kind: EnvironmentSummary["kind"],
  name: string,
  drivers: readonly (
    | {
        accessModes?: ThreadAccessMode[];
        driverKind: string;
        readiness: "configured" | "runtime-check";
      }
    | { driverKind: string; readiness: "unavailable"; reason: string }
  )[],
): EnvironmentSummary {
  const harnessDrivers: EnvironmentSummary["harnessDrivers"] = drivers.map((driver) =>
    driver.readiness === "unavailable"
      ? driver
      : {
          ...driver,
          accessModes: driver.accessModes ?? [...ThreadAccessModeSchema.options],
          sources: [source(driver.driverKind)],
        },
  );
  return {
    capabilities: ["filesystem"],
    connected: true,
    harnessAuthenticationAllowed: true,
    workspaceBackings: ["local-directory"],
    harnessCatalogs: harnessDrivers.map((driver) => {
      const harness = harnesses.find(
        (candidate) => candidate.environmentId === id && candidate.driverKind === driver.driverKind,
      );
      if (!harness) throw new Error(`Missing test harness for ${driver.driverKind}`);
      if (driver.readiness === "unavailable") {
        return HarnessInstanceCatalogSchema.parse({
          detail: driver.reason,
          driverKind: driver.driverKind,
          harnessInstanceId: harness.id,
          models: [],
          status: "unavailable",
        });
      }
      const codex = driver.driverKind === "codex";
      return HarnessInstanceCatalogSchema.parse({
        continuationIdentity: {
          continuationKey: codex
            ? "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo"
            : "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
          driverKind: driver.driverKind,
        },
        driverKind: driver.driverKind,
        harnessInstanceId: harness.id,
        models: [
          {
            displayName: codex ? "GPT-5.6-Sol" : "Claude Sonnet",
            isDefault: true,
            modelId: codex ? "gpt-5.6-sol" : "sonnet",
            options: [],
            providerId: codex ? "openai" : "anthropic",
          },
        ],
        status: "ready",
      });
    }),
    harnessDrivers,
    id,
    kind,
    name,
    providerStateModes: ["ambient", "isolated"],
    runnerId: `runner-${id}`,
    status: "connected",
  };
}

function source(
  driverKind: string,
): EnvironmentSummary["harnessDrivers"][number] extends infer D
  ? D extends { sources: (infer S)[] }
    ? S
    : never
  : never {
  const sourceId = driverKind === "claude" ? "anthropic" : "openai";
  return {
    fields: [],
    kind: "first-party",
    label: driverKind === "claude" ? "Anthropic" : "OpenAI",
    quota: "windows",
    sourceId,
    stateKinds: ["ambient", "isolated"],
  };
}
