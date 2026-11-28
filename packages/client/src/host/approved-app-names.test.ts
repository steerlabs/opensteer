import { describe, expect, it } from "vitest";
import type { ApprovedComputerApp } from "@opensteer/protocol";
import { approvedAppNames, shownOperations, shownTarget } from "./approved-app-names.js";

const mac = "dev_00000000-0000-4000-8000-0000000000d1";
const other = "dev_00000000-0000-4000-8000-0000000000d2";
const approved = (machineId: string, bundleId: string, name: string) =>
  ({
    connectionId: "con_00000000-0000-4000-8000-0000000000c1",
    machineId,
    target: { kind: "app", app: { bundleId, displayName: name, teamId: null } },
    name,
    iconPng: null,
  }) as ApprovedComputerApp;
const app = (deviceId: string, bundleId: string, name = bundleId) => ({
  grant: {
    kind: "computer-app" as const,
    approvalId: "con_00000000-0000-4000-8000-0000000000c1",
    deviceId,
    app: { kind: "mac-app" as const, bundleId, teamId: null },
  },
  name,
  device: { id: deviceId, name: "Mac" },
});

describe("a Mac app as the person watching is shown it", () => {
  const names = approvedAppNames([approved(mac, "com.apple.Safari", "Safari")]);

  it("goes by the name they approved for that app on that device", () => {
    expect(shownTarget(app(mac, "com.apple.Safari"), names).name).toBe("Safari");
    expect(shownTarget(app(mac, "COM.APPLE.SAFARI"), names).name).toBe("Safari");
  });

  it("keeps its trusted name where no approved app on that device matches", () => {
    expect(shownTarget(app(other, "com.apple.Safari"), names).name).toBe("com.apple.Safari");
    expect(shownTarget(app(mac, "com.apple.Notes"), names).name).toBe("com.apple.Notes");
    expect(shownTarget(app(mac, "com.apple.Safari"), null).name).toBe("com.apple.Safari");
    const browser = {
      grant: { kind: "browser-profile" as const, profileId: "bpr_1" },
      name: "Work",
    };
    expect(shownTarget(browser, names)).toBe(browser);
  });

  it("changes only what is shown: the operations it was given stay as the Home sent them", () => {
    const operation = { id: "aop_1", target: app(mac, "com.apple.Safari") };
    const [shown] = shownOperations([operation], names);
    expect(shown?.target.name).toBe("Safari");
    expect(operation.target.name).toBe("com.apple.Safari");
  });
});
