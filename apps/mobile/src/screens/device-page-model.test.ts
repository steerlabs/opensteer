import { withDeviceSwitch as withSwitch } from "@opensteer/client/computers";
import type { MachineAccessPolicy, MachineSummary } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { deviceRemoval, deviceSwitches, homeFixed } from "./device-page-model.js";

const policy: MachineAccessPolicy = {
  apps: false,
  browser: true,
  commands: false,
  forwarding: false,
  reach: "nobody",
  shares: [{ mode: "read", path: "/Users/alex/Projects" }],
};
const machine = (overrides: Partial<MachineSummary>) =>
  ({
    access: { activeSessions: [], ownerReachAvailable: true, policy, revision: 3 },
    allowedModules: ["browser", "integrations", "shell"],
    computerUse: null,
    name: "MacBook Pro (2)",
    ownership: "mine",
    revocable: true,
    status: "online",
    ...overrides,
  }) as MachineSummary;

describe("a device page's switches", () => {
  it("offers only what the enrollment's ceiling lends, with Home's fixed rows", () => {
    const phone = deviceSwitches(machine({ allowedModules: ["browser", "integrations"] }), {
      devicesAvailable: true,
      noun: "iPhone",
    });
    expect(phone.rows.map(({ key, value, detail }) => [key, value, detail])).toEqual([
      ["browser", true, "Open and use tabs on this iPhone"],
      ["apps", false, "See and control apps"],
    ]);
    const home = deviceSwitches(
      machine({
        allowedModules: ["agents", "browser", "integrations", "shell"],
        kind: "home",
        revocable: false,
      }),
      { devicesAvailable: true },
    );
    expect(home.rows.map(({ key, fixed, disabled }) => [key, fixed, disabled])).toEqual([
      ["browser", true, true],
      ["apps", false, false],
      ["files", true, true],
    ]);
    expect(home.rows[0]?.detail).toBe(homeFixed);
    expect(home.footer).toBe("Your Opensteer lives on this Mac, so it can't be removed.");
  });

  it("lets an older Host change only files", () => {
    const view = deviceSwitches(machine({}), { devicesAvailable: false });
    expect(view.rows.map(({ key, disabled }) => [key, disabled])).toEqual([
      ["browser", true],
      ["apps", true],
      ["files", false],
    ]);
    expect(view.footer).toBe("Update Opensteer on your Mac to change Browser and Apps.");
  });

  it("changes one switch and keeps everything else, so files off and on restores its folders", () => {
    expect(withSwitch(policy, "apps", true)).toMatchObject({
      commands: false,
      forwarding: false,
      apps: true,
    });
    const on = withSwitch(policy, "files", true);
    expect(on).toMatchObject({
      commands: false,
      forwarding: false,
      shares: policy.shares,
      reach: "owner",
    });
    expect(withSwitch(on, "files", false)).toEqual({ ...on, reach: "nobody" });
    expect(withSwitch({ ...on, reach: "deployment" }, "files", true).reach).toBe("owner");
  });
});

describe("removing a device", () => {
  it("says what removal does here and elsewhere, and never offers it for Home", () => {
    expect(deviceRemoval(machine({}), { noun: "iPhone", thisDevice: true })).toEqual({
      label: "Sign out and remove this iPhone",
      title: "Sign out and remove this iPhone?",
      message: "Your agent can no longer use this iPhone. Browser data kept here is deleted.",
    });
    expect(
      deviceRemoval(machine({ status: "offline" }), { noun: "iPhone", thisDevice: false }),
    ).toEqual({
      label: "Remove",
      title: "Remove MacBook Pro (2)?",
      message:
        "It is signed out and your agent can't use it. It finishes the next time it connects.",
    });
    expect(
      deviceRemoval(machine({ kind: "home" }), { noun: "iPhone", thisDevice: false }),
    ).toBeNull();
  });
});
