import { channelProviderCatalog } from "@opensteer/channel-core";
import { describe, expect, it } from "vitest";
import { runnerDescriptorProfileRefusal } from "./iphone-apps.js";
import { RunnerDescriptorSchema } from "./runner.js";

// Test-first admission matrix: schema recognition is not enrollment authority.
const raw = {
  bootId: "rbt_00000000-0000-4000-8000-000000000001",
  capabilities: [],
  device: { form: "phone", platform: "ios" },
  modules: { integrations: { computerAppApprovals: true, platform: "ios", protocolVersion: 1 } },
  name: "iPhone",
  runnerId: "rnr_00000000-0000-4000-8000-000000000002",
  runnerKind: "local",
  runtimeVersion: "test",
};
describe("immutable iPhone profile admission", () => {
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
    ...["loginText", "passwordSignIn", "ownerViewVersion", "macWindowVideoVersion"].map(
      (field) => ({ modules: { integrations: { ...raw.modules.integrations, [field]: 1 } } }),
    ),
    { modules: { integrations: { platform: "ios", protocolVersion: 1 } } },
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
  it("gives the dedicated upgrade reason for protocol mismatches", () => {
    for (const protocolVersion of [undefined, 2, 4]) {
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
