import {
  ComputerAppConfigSchema,
  ComputerAppPresentationSchema,
  ComputerAppPresentationViewSchema,
  computerAppPresentation,
} from "@opensteer/integration-core/computer-app";
import {
  IntegrationDefinitionSchema,
  IntegrationDefinitionSummarySchema,
  IntegrationDefinitionSummaryViewSchema,
  integrationDefinitionSummary,
} from "@opensteer/integration-core/adapter";
import {
  IntegrationInstallManifestSummarySchema,
  IntegrationInstallManifestSummaryViewSchema,
} from "@opensteer/integration-core/models";
import { describe, expect, it } from "vitest";
import { HostBootstrapSchema } from "./bootstrap.js";
import { hostApi } from "./host-api.js";
import { MachineSummarySchema } from "./machines.js";
import { RunnerDeviceSchema } from "./runner-identity.js";
import { RunnerDescriptorSchema } from "./runner.js";

/*
 * Failure cases before adding another device platform:
 * - one unfamiliar presentation platform rejects every computer in bootstrap;
 * - the same value rejects a later machines.list refresh;
 * - a catalog's additional platform hides its still-supported Mac operations;
 * - response tolerance also admits unsupported authenticated Runner inputs;
 * - a catch over the whole device silently accepts malformed known facts.
 * - iOS is recognized by authoritative schemas but bypasses profile admission;
 * - an unknown form erases a known platform instead of only the form;
 * - an unknown platform keeps a misleading phone shape instead of no device;
 * - filtering unknown catalog platforms rejects an empty supported subset;
 * - platform tolerance hides malformed fields, operations or sibling entries;
 * - catalog summaries fail to use the same platform reader as presentations.
 */
const knownMachine = MachineSummarySchema.parse({
  access: null,
  allowedModules: ["integrations"],
  detail: null,
  device: { form: "laptop", platform: "macos" },
  enrollmentId: null,
  expiresAt: null,
  id: "known-computer",
  lastSeenAt: null,
  localWorkspaces: 0,
  modules: {},
  name: "Existing Mac",
  ownership: "mine",
  pinnedThreads: 0,
  revocable: true,
  status: "offline",
  unlinkedLocalFolders: 0,
});

const futureMachine = {
  ...knownMachine,
  id: "future-computer",
  name: "Another computer",
  device: { form: "phone", platform: "future-phone-os" },
};

const presentation = {
  accessLabels: { read: "Read", readWrite: "Read and write" },
  accessLevels: ["read"],
  accessSummaries: { read: "Read records", readWrite: "Change records" },
  operations: [{ effect: "read", name: "list" }],
  platforms: ["darwin", "future-phone-os"],
};

const config = {
  accessLabels: presentation.accessLabels,
  accessSummaries: presentation.accessSummaries,
  operations: [
    {
      description: "Read records",
      effect: "read",
      inputSchema: {},
      name: "list",
      outputSchema: null,
      title: "List records",
    },
  ],
  platforms: ["darwin"],
};
const definition = IntegrationDefinitionSchema.parse({
  adapter: "computer",
  authMethods: [{ id: "computer", kind: "computer", label: "This computer" }],
  config,
  description: "Read records on this computer",
  id: "example-app",
  name: "Example",
  provider: "example",
});
const summary = integrationDefinitionSummary(definition);
const descriptor = {
  bootId: "rbt_00000000-0000-4000-8000-000000000001",
  capabilities: [],
  device: knownMachine.device,
  modules: { integrations: { platform: "darwin", protocolVersion: 5 } },
  name: "Existing Mac",
  runnerId: "rnr_00000000-0000-4000-8000-000000000002",
  runnerKind: "local",
  runtimeVersion: "test",
};

describe("device platform presentation compatibility", () => {
  it("keeps the computer list in bootstrap readable beside a future platform", () => {
    const machines = HostBootstrapSchema.shape.machines.parse([knownMachine, futureMachine]);
    expect(machines[0]).toEqual(knownMachine);
    expect(machines[1]).toMatchObject({ id: futureMachine.id, revocable: true });
  });

  it("keeps a later computers refresh readable beside a future platform", () => {
    const result = hostApi["machines.list"].success.parse({
      machines: [knownMachine, futureMachine],
    });
    expect(result.machines[0]).toEqual(knownMachine);
    expect(result.machines[1]).toMatchObject({ id: futureMachine.id, revocable: true });
  });

  it("retains understood catalog platforms and operations", () => {
    const result = ComputerAppPresentationViewSchema.parse(presentation);
    expect(result.platforms).toEqual(["darwin"]);
    expect(result.operations).toEqual(presentation.operations);
  });

  it("still rejects unsupported platform values at authoritative inputs", () => {
    expect(RunnerDeviceSchema.safeParse(knownMachine.device).success).toBe(true);
    expect(RunnerDeviceSchema.safeParse(futureMachine.device).success).toBe(false);
    const config = {
      accessLabels: presentation.accessLabels,
      accessSummaries: presentation.accessSummaries,
      operations: [
        {
          description: "Read records",
          effect: "read",
          inputSchema: {},
          name: "list",
          outputSchema: null,
          title: "List records",
        },
      ],
      platforms: ["darwin"],
    };
    expect(ComputerAppConfigSchema.safeParse(config).success).toBe(true);
    expect(
      ComputerAppConfigSchema.safeParse({ ...config, platforms: presentation.platforms }).success,
    ).toBe(false);
  });

  it("does not hide malformed known device or catalog facts", () => {
    for (const device of [
      { form: 7, platform: "macos" },
      { form: "phone", platform: 7 },
      { form: "phone" },
    ]) {
      expect(MachineSummarySchema.safeParse({ ...knownMachine, device }).success).toBe(false);
    }
    expect(
      ComputerAppPresentationViewSchema.safeParse({
        ...presentation,
        platforms: ["darwin", 7],
      }).success,
    ).toBe(false);
  });

  it.each(["macos", "linux", "windows", "android", "ios"])(
    "retains the known %s platform and all known forms in machine views",
    (platform) => {
      for (const form of ["laptop", "desktop", "compact", "server", "phone", null]) {
        const device = { form, platform };
        const machine = { ...knownMachine, device };
        expect(MachineSummarySchema.parse(machine)).toEqual(machine);
        expect(HostBootstrapSchema.shape.machines.parse([knownMachine, machine])).toEqual([
          knownMachine,
          machine,
        ]);
        expect(
          hostApi["machines.list"].success.parse({ machines: [knownMachine, machine] }),
        ).toEqual({
          machines: [knownMachine, machine],
        });
      }
    },
  );

  it("forgets only an unknown form on a known platform, including iOS", () => {
    for (const platform of ["macos", "linux", "windows", "android", "ios"]) {
      expect(
        MachineSummarySchema.parse({
          ...knownMachine,
          device: { form: "folding", platform, futureFact: true },
        }).device,
      ).toEqual({ form: null, platform });
    }
  });

  it("forgets the whole device for an unknown string platform", () => {
    for (const form of ["phone", "folding", null]) {
      expect(
        MachineSummarySchema.parse({
          ...futureMachine,
          device: { form, platform: "future-phone-os" },
        }),
      ).toEqual({ ...futureMachine, device: null });
    }
    expect(MachineSummarySchema.parse({ ...knownMachine, device: null }).device).toBeNull();
    const { device: _device, ...olderMachine } = knownMachine;
    expect(MachineSummarySchema.parse(olderMachine).device).toBeNull();
  });

  it("requires well-formed device fields even when the platform is unknown", () => {
    for (const platform of ["macos", "ios", "future-phone-os"]) {
      for (const form of [undefined, 7, true, {}, []]) {
        expect(
          MachineSummarySchema.safeParse({ ...knownMachine, device: { form, platform } }).success,
        ).toBe(false);
      }
      expect(
        MachineSummarySchema.safeParse({ ...knownMachine, device: { platform } }).success,
      ).toBe(false);
    }
    for (const platform of [undefined, null, 7, true, {}, []]) {
      expect(
        MachineSummarySchema.safeParse({
          ...knownMachine,
          device: { form: "phone", platform },
        }).success,
      ).toBe(false);
    }
    expect(
      MachineSummarySchema.safeParse({ ...futureMachine, status: "future-status" }).success,
    ).toBe(false);
  });

  it.each([
    {
      platforms: ["android", "darwin", "ios", "linux", "win32"],
      expected: ["android", "darwin", "ios", "linux", "win32"],
    },
    { platforms: ["future-phone-os", "darwin", "ios", "another-os"], expected: ["darwin", "ios"] },
    { platforms: ["future-phone-os"], expected: [] },
    { platforms: [], expected: [] },
    { platforms: Array.from({ length: 16 }, () => "future-phone-os"), expected: [] },
  ])(
    "filters catalog platform strings $platforms to $expected in both views",
    ({ platforms, expected }) => {
      const view = { ...presentation, platforms };
      expect(ComputerAppPresentationViewSchema.parse(view)).toEqual({
        ...view,
        platforms: expected,
      });
      expect(
        IntegrationDefinitionSummaryViewSchema.parse({ ...summary, computerApp: view }),
      ).toEqual({ ...summary, computerApp: { ...view, platforms: expected } });
      const catalog = [
        {
          definition: { ...summary, computerApp: view },
          digest: "a".repeat(43),
          installationId: null,
        },
      ];
      const dashboard = hostApi["integration.platform.get"].success.parse({
        authorizationSurface: "canonical",
        catalog,
        connections: [],
        installations: [],
      });
      expect(dashboard.catalog[0]?.definition.computerApp).toEqual({
        ...view,
        platforms: expected,
      });
    },
  );

  it("rejects malformed and oversized catalog platforms before filtering", () => {
    for (const platforms of [
      undefined,
      null,
      "darwin",
      ["darwin", 7],
      [null],
      [true],
      [{}],
      Array.from({ length: 17 }, () => "future-phone-os"),
    ]) {
      const view = { ...presentation, platforms };
      expect(ComputerAppPresentationViewSchema.safeParse(view).success).toBe(false);
      expect(
        IntegrationDefinitionSummaryViewSchema.safeParse({ ...summary, computerApp: view }).success,
      ).toBe(false);
    }
    for (const malformed of [
      { operations: [{ effect: "future-effect", name: "list" }] },
      { operations: [] },
      { accessLabels: { read: 7, readWrite: "Write" } },
      { kind: "future-kind" },
    ]) {
      const view = { ...presentation, platforms: ["future-phone-os"], ...malformed };
      expect(ComputerAppPresentationViewSchema.safeParse(view).success).toBe(false);
      expect(
        IntegrationDefinitionSummaryViewSchema.safeParse({ ...summary, computerApp: view }).success,
      ).toBe(false);
    }
  });

  it("recognizes iOS inputs while rejecting future platforms (admission pins the stored profile)", () => {
    expect(RunnerDescriptorSchema.safeParse(descriptor).success).toBe(true);
    for (const platform of ["ios", "future-phone-os"]) {
      const device = { form: "phone", platform };
      expect(RunnerDeviceSchema.safeParse(device).success).toBe(platform === "ios");
      expect(RunnerDescriptorSchema.safeParse({ ...descriptor, device }).success).toBe(
        platform === "ios",
      );
      expect(
        RunnerDescriptorSchema.safeParse({
          ...descriptor,
          modules: { integrations: { platform, protocolVersion: 1 } },
        }).success,
      ).toBe(platform === "ios");
      expect(ComputerAppConfigSchema.safeParse({ ...config, platforms: [platform] }).success).toBe(
        platform === "ios",
      );
      expect(
        ComputerAppPresentationSchema.safeParse({ ...presentation, platforms: [platform] }).success,
      ).toBe(platform === "ios");
      expect(
        IntegrationDefinitionSchema.safeParse({
          ...definition,
          config: { ...config, platforms: [platform] },
        }).success,
      ).toBe(platform === "ios");
      expect(
        IntegrationDefinitionSummarySchema.safeParse({
          ...summary,
          computerApp: { ...presentation, platforms: [platform] },
        }).success,
      ).toBe(platform === "ios");
    }
    expect(computerAppPresentation(ComputerAppConfigSchema.parse(config)).platforms).toEqual([
      "darwin",
    ]);
    expect(integrationDefinitionSummary(definition)).toEqual(summary);
  });

  // Catalog consent is parsed again from an unknown Request payload. It must
  // not lose its name/access review on iOS, nor stop validating its digest.
  it("reads catalog consent manifests through the same response definition reader", () => {
    const manifest = {
      kind: "catalog",
      digest: "a".repeat(43),
      definition: {
        ...summary,
        computerApp: { ...presentation, platforms: ["darwin", "ios", "future-phone-os"] },
      },
    };
    expect(
      IntegrationInstallManifestSummaryViewSchema.parse({ ...manifest, futureFact: true }),
    ).toEqual({
      ...manifest,
      definition: {
        ...summary,
        computerApp: { ...presentation, platforms: ["darwin", "ios"] },
      },
    });
    expect(IntegrationInstallManifestSummarySchema.safeParse(manifest).success).toBe(false);
    for (const malformed of [
      { ...manifest, digest: "invalid" },
      { ...manifest, kind: "future-kind" },
      { ...manifest, definition: { ...manifest.definition, name: 7 } },
    ]) {
      expect(IntegrationInstallManifestSummaryViewSchema.safeParse(malformed).success).toBe(false);
    }
  });
});
