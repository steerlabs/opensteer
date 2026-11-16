import { describe, expect, it } from "vitest";
import { MachineSummarySchema, hostApi } from "@opensteer/protocol";
import { computerTargetId, deviceMachine, machineSelfRunnerId } from "./device-projection.js";

const runner = "rnr_00000000-0000-4000-8000-000000000001";
const legacy = MachineSummarySchema.parse({
  id: runner,
  name: "Phone",
  access: null,
  allowedModules: ["browser"],
  detail: null,
  device: { platform: "ios", form: "phone", app: "opensteer" },
  enrollmentId: null,
  expiresAt: null,
  lastSeenAt: null,
  modules: {},
  ownership: "mine",
  pinnedThreads: 0,
  revocable: true,
  status: "offline",
  unlinkedLocalFolders: 0,
});

describe("new client on a v60 Host", () => {
  it("normalizes self identity once and never grants screen control from platform alone", () => {
    for (const platform of ["android", "ios"] as const) {
      const row = { ...legacy, device: { platform, form: "phone" as const } };
      const projected = deviceMachine(row);
      expect(machineSelfRunnerId(projected)).toBe(runner);
      expect(projected.capabilities?.browser.supported).toBe(true);
      expect(projected.capabilities?.apps.supported).toBe(false);
      expect(projected.phoneDisplay).toBeNull();
      expect(deviceMachine(row)).toBe(projected);
    }
    expect(deviceMachine({ ...legacy, kind: "agent-phone" }).phoneDisplay).toBeNull();
  });

  it("retains legacy Agent Phone display capability from Host kind and integration grant", () => {
    const projected = deviceMachine({
      ...legacy,
      kind: "agent-phone",
      allowedModules: ["browser", "integrations"],
    });
    expect(projected.phoneDisplay?.definitionId).toBe("android-phone");
    expect(projected.phoneDisplay?.control).toMatchObject({
      state: "unavailable",
      reason: { kind: "driver-offline" },
    });
  });

  it("keeps current Host capability facts, including an explicit absent display", () => {
    const current = { ...deviceMachine(legacy), kind: "agent-phone" as const, phoneDisplay: null };
    expect(deviceMachine(current)).toBe(current);
    expect(current.phoneDisplay).toBeNull();
  });

  it("reads legacy setup target fields through the existing shared target adapter", () => {
    const old = { runnerId: runner };
    expect(computerTargetId(old)).toBe(runner);
    expect(computerTargetId({ deviceId: runner })).toBe(runner);
    expect(hostApi["machines.list"].success.parse({ machines: [legacy] }).machines[0]?.id).toBe(
      runner,
    );
  });
});
