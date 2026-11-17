import { describe, expect, it } from "vitest";
import { MachineSummarySchema, hostApi } from "@opensteer/protocol";
import { computerTargetId, deviceDriverKey, machineSelfRunnerId } from "./device-projection.js";

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

describe("scoped device facts", () => {
  it("uses the Host's explicit device identity and attached driver generation", () => {
    expect(machineSelfRunnerId(legacy)).toBeNull();
    expect(deviceDriverKey(legacy)).toBeNull();
    const current = MachineSummarySchema.parse({
      ...legacy,
      kind: "computer",
      selfRunnerId: runner,
      phoneDisplay: null,
      drivers: [
        { role: "self", runnerId: runner, runnerName: "Phone", generation: 4, attached: true },
      ],
    });
    expect(machineSelfRunnerId(current)).toBe(runner);
    expect(deviceDriverKey(current)).toBe(JSON.stringify([runner, runner, 4, true]));
  });

  it("reads the typed target from the shared setup request", () => {
    expect(computerTargetId({ deviceId: runner })).toBe(runner);
    expect(hostApi["machines.list"].success.parse({ machines: [legacy] }).machines[0]?.id).toBe(
      runner,
    );
  });
});
