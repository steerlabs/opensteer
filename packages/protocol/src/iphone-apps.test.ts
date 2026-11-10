import { channelProviderCatalog } from "@opensteer/channel-core";
import { describe, expect, it } from "vitest";
import { runnerDescriptorProfileRefusal } from "./iphone-apps.js";
import { RunnerDescriptorSchema } from "./runner.js";

// Test-first admission matrix: schema recognition is not enrollment authority.
const raw = {
  bootId: "rbt_00000000-0000-4000-8000-000000000001",
  capabilities: [],
  device: { form: "phone", platform: "ios" },
  modules: { integrations: { platform: "ios", protocolVersion: 2 } },
  name: "iPhone",
  runnerId: "rnr_00000000-0000-4000-8000-000000000002",
  runnerKind: "local",
  runtimeVersion: "test",
};
describe("immutable iPhone profile admission", () => {
  it("admits the Android browser under an ordinary non-iPhone Runner identity", () => {
    const descriptor = RunnerDescriptorSchema.parse({
      ...raw,
      device: { form: "phone", platform: "android" },
      modules: {
        browser: {
          runtimeId: "android-browser",
          wireVersion: 1,
          localProfileStorage: {
            storageInstanceId: "11111111-1111-4111-8111-111111111111",
            engine: "android-webview",
          },
          navigationVersion: 1,
          navigationAttributionVersion: 1,
          workspaceTabRestoreVersion: 1,
          popupFollowVersion: 1,
          sharedControl: 1,
          targetControl: 1,
          rasterDemand: 1,
          basicInput: 1,
          surfaceState: 1,
          cdpBoundary: 1,
          fileStaging: true,
        },
      },
    });
    expect(runnerDescriptorProfileRefusal(null, descriptor)).toBeNull();
    expect(descriptor.modules.browser).not.toHaveProperty("editing");
    expect(descriptor.modules.browser).not.toHaveProperty("clipboard");
  });
  it("admits the phone browser beside iPhone integrations without adding authority", () => {
    const descriptor = RunnerDescriptorSchema.parse({
      ...raw,
      modules: {
        ...raw.modules,
        browser: {
          runtimeId: "iphone-browser",
          wireVersion: 1,
          localProfileStorage: {
            storageInstanceId: "11111111-1111-4111-8111-111111111111",
            engine: "wkwebview",
          },
          navigationVersion: 1,
          navigationAttributionVersion: 1,
          workspaceTabRestoreVersion: 1,
          popupFollowVersion: 1,
          sharedControl: 1,
          targetControl: 1,
          rasterDemand: 1,
          basicInput: 1,
          surfaceState: 1,
          agentActions: 1,
        },
      },
    });
    expect(runnerDescriptorProfileRefusal("iphone", descriptor)).toBeNull();
    expect(runnerDescriptorProfileRefusal(null, descriptor)?.reason).toBe(
      "runner-device-profile-mismatch",
    );
    expect(descriptor.modules.browser).not.toHaveProperty("cdpBoundary");
    expect(descriptor.modules.browser).not.toHaveProperty("editing");
    expect(descriptor.modules.browser).not.toHaveProperty("clipboard");
  });
  it("recognizes iOS without granting it to old identities", () => {
    const descriptor = RunnerDescriptorSchema.parse(raw);
    expect(runnerDescriptorProfileRefusal("iphone", descriptor)).toBeNull();
    expect(runnerDescriptorProfileRefusal(null, descriptor)?.reason).toBe(
      "runner-device-profile-mismatch",
    );
  });
  it.each([
    { runnerKind: "managed" },
    { capabilities: ["browser-page-input-v1"] },
    { device: { form: "phone", platform: "android" } },
    { device: { form: "laptop", platform: "ios" } },
    { device: undefined },
    {
      modules: {
        integrations: { platform: "darwin", protocolVersion: 1, computerAppApprovals: true },
      },
    },
    ...(
      [
        ["loginText", 1],
        ["passwordSignIn", 2],
        ["ownerViewVersion", 1],
        ["macWindowVideoVersion", 1],
      ] as const
    ).map(([field, version]) => ({
      modules: { integrations: { ...raw.modules.integrations, [field]: version } },
    })),
    {
      modules: {
        integrations: raw.modules.integrations,
        messaging: {
          capabilities: [
            {
              provider: channelProviderCatalog[0]!.provider,
              manifest: channelProviderCatalog[0]!,
              transportKinds: channelProviderCatalog[0]!.transportKinds,
            },
          ],
        },
      },
    },
  ])("refuses incompatible metadata %j", (patch) => {
    expect(
      runnerDescriptorProfileRefusal("iphone", RunnerDescriptorSchema.parse({ ...raw, ...patch }))
        ?.reason,
    ).toBe("runner-device-profile-mismatch");
  });
  it("admits browser-capable phones while preserving the installed integrations-only descriptor", () => {
    for (const browser of [
      undefined,
      {
        runtimeId: "phone",
        agentActions: 1,
        localProfileStorage: {
          storageInstanceId: "11111111-1111-4111-8111-111111111111",
          engine: "wkwebview",
        },
      },
    ]) {
      const descriptor = RunnerDescriptorSchema.parse({
        ...raw,
        modules: { ...raw.modules, ...(browser ? { browser } : {}) },
      });
      expect(runnerDescriptorProfileRefusal("iphone", descriptor)).toBeNull();
    }
  });
  it("gives the dedicated upgrade reason for protocol mismatches", () => {
    for (const protocolVersion of [undefined, 1, 3, 4]) {
      expect(
        runnerDescriptorProfileRefusal(
          "iphone",
          RunnerDescriptorSchema.parse({
            ...raw,
            modules: { integrations: { ...raw.modules.integrations, protocolVersion } },
          }),
        )?.reason,
      ).toBe("iphone-app-outdated");
    }
  });
  it("pins either iOS claim without a profile and preserves old Mac/Android inputs", () => {
    for (const platform of ["android", "darwin"] as const) {
      const descriptor = RunnerDescriptorSchema.parse({
        ...raw,
        device: { form: "phone", platform: "android" },
        modules: { integrations: { platform, protocolVersion: platform === "android" ? 4 : 5 } },
      });
      expect(runnerDescriptorProfileRefusal(null, descriptor)).toBeNull();
      expect(
        runnerDescriptorProfileRefusal(null, {
          ...descriptor,
          device: { form: "phone", platform: "ios" },
        })?.reason,
      ).toBe("runner-device-profile-mismatch");
      expect(
        runnerDescriptorProfileRefusal(null, {
          ...descriptor,
          modules: RunnerDescriptorSchema.parse(raw).modules,
        })?.reason,
      ).toBe("runner-device-profile-mismatch");
    }
  });
});
