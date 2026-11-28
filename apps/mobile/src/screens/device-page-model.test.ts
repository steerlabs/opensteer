import { RunnerIdSchema } from "@opensteer/core";
import { withDeviceSwitch as withSwitch } from "@opensteer/client/computers";
import { mockDeviceMachine } from "@opensteer/client/mock";
import type { MachineAccessPolicy, MachineSummary } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  deviceReachChoices,
  deviceRemoval,
  deviceSwitches,
  deviceSwitchesFooter,
  homeFixed,
} from "./device-page-model.js";

const policy: MachineAccessPolicy = {
  apps: false,
  browser: true,
  commands: false,
  forwarding: false,
  reach: "nobody",
  shares: [{ mode: "read", path: "/Users/alex/Projects" }],
};
const machine = (overrides: Partial<MachineSummary>) =>
  mockDeviceMachine({
    access: { activeSessions: [], ownerReachAvailable: true, policy, revision: 3 },
    allowedModules: ["browser", "integrations", "shell"],
    computerUse: null,
    modules: {
      browser: { checkedAt: null, detail: null, readiness: "ready" },
      integrations: { checkedAt: null, detail: null, readiness: "ready" },
      shell: { checkedAt: null, detail: null, readiness: "ready" },
    },
    name: "MacBook Pro (2)",
    ownership: "mine",
    revocable: true,
    status: "online",
    ...overrides,
  } as MachineSummary);

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
    expect(home.footer).toBe("Your Opensteer lives on this Mac, so it can’t be removed.");
  });

  it("never tells a Cloud Computer or a server that it is a Mac", () => {
    const home = machine({
      kind: "home",
      ownership: "deployment",
      allowedModules: ["agents", "browser", "shell"],
    });
    for (const [homeKind, footer] of [
      ["cloud", "Your Opensteer lives on this Cloud Computer, so it can’t be removed."],
      ["server", "Your Opensteer lives on this server, so it can’t be removed."],
    ] as const) {
      const view = deviceSwitches(home, { devicesAvailable: true, homeKind });
      expect(view.footer).toBe(footer);
      expect(view.footer).not.toContain("Mac");
    }
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

describe("under a device's switches", () => {
  it("says connected agents also need a profile or app chosen, and why switches can't change", () => {
    const switches = deviceSwitches(machine({}), { devicesAvailable: true });
    expect(deviceSwitchesFooter(switches)).toBe(
      "Connected agents also need you to choose this device’s profile or app for them.",
    );
    const older = deviceSwitches(machine({}), { devicesAvailable: false });
    expect(deviceSwitchesFooter(older)).toBe(
      "Update Opensteer on your Mac to change Browser and Apps. Connected agents also need you to choose this device’s profile or app for them.",
    );
    const home = deviceSwitches(
      machine({
        kind: "home",
        ownership: "deployment",
        allowedModules: ["agents", "browser", "shell"],
      }),
      { devicesAvailable: true },
    );
    // A Home Mac's Apps switch is real, so the footer belongs under it too.
    expect(home.rows.some(({ fixed }) => !fixed)).toBe(true);
    expect(deviceSwitchesFooter(home)).toBe(
      "Your Opensteer lives on this Mac, so it can’t be removed. Connected agents also need you to choose this device’s profile or app for them.",
    );
  });

  it("offers exactly the Reach values the Host reads, with my agents only where it can", () => {
    expect(deviceReachChoices({ ownerReachAvailable: true }).map(({ value }) => value)).toEqual([
      "nobody",
      "owner",
      "deployment",
    ]);
    expect(deviceReachChoices({ ownerReachAvailable: false }).map(({ value }) => value)).toEqual([
      "nobody",
      "deployment",
    ]);
  });
});

describe("removing a device", () => {
  it("says what removal does here and elsewhere, and never offers it for Home", () => {
    const none = { noun: "iPhone", profiles: [], thisDevice: false };
    expect(deviceRemoval(machine({}), { ...none, thisDevice: true })).toEqual({
      label: "Sign out and remove this iPhone",
      title: "Sign out and remove this iPhone?",
      message:
        "Your own agents can no longer use this iPhone. Browser profiles kept here are deleted.",
    });
    expect(deviceRemoval(machine({ status: "offline" }), none)).toEqual({
      label: "Remove",
      title: "Remove MacBook Pro (2)?",
      message:
        "It is signed out and your own agents can't use it. It finishes the next time it connects. Browser profiles kept on it are deleted.",
    });
    // The profiles it holds are named, and an away device erases them when it next connects.
    expect(
      deviceRemoval(
        machine({
          id: "dev_11111111-1111-4111-8111-111111111111",
          selfRunnerId: RunnerIdSchema.parse("rnr_11111111-1111-4111-8111-111111111111"),
          status: "offline",
        }),
        {
          ...none,
          profiles: [
            { homeRunnerId: "rnr_11111111-1111-4111-8111-111111111111", name: "Work" },
            { homeRunnerId: "rnr_other", name: "Personal" },
          ],
        },
      )?.message,
    ).toBe(
      "It is signed out and your own agents can't use it. It finishes the next time it connects. Its browser profile Work and its sign-ins are deleted. MacBook Pro (2) erases it the next time it connects.",
    );
    expect(deviceRemoval(machine({ kind: "home" }), none)).toBeNull();
  });

  it("explains asleep devices calmly and hides the notice for online or offline ones", async () => {
    const { deviceAsleepDetail } = await import("./device-page-model.js");
    expect(
      deviceAsleepDetail(machine({ asleepSince: "2026-04-12T10:15:00.000Z", status: "offline" })),
    ).toBe("Its tabs and apps wait until it wakes. Agents can’t use it meanwhile.");
    expect(deviceAsleepDetail(machine({ status: "offline" }))).toBeNull();
    expect(
      deviceAsleepDetail(machine({ asleepSince: "2026-04-12T10:15:00.000Z", status: "online" })),
    ).toBeNull();
  });
});
