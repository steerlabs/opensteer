import { describe, expect, it } from "vitest";
import { createId, type AuthSessionSummary } from "@opensteer/core";
import { MachineSummarySchema, deviceAccess } from "@opensteer/protocol";
import { withDeviceSwitch } from "./device-access-request.js";
import {
  deviceAccessRows,
  deviceMembership,
  devicesView,
  type DeviceMembershipInput,
} from "./devices.js";
const base: DeviceMembershipInput = {
  applicable: true,
  hosting: false,
  authenticated: true,
  membership: null,
};
describe("device membership", () => {
  it("keeps removal ahead of session recovery and setup", () => {
    for (const state of ["removed", "leaving"] as const)
      expect(
        deviceMembership({
          ...base,
          authenticated: false,
          settingUp: true,
          membership: { state, runnerId: createId("runner"), generation: 2 },
        }),
      ).toEqual({ state: "removed" });
    expect(
      deviceMembership({
        ...base,
        authenticated: false,
        membership: { state: "active", runnerId: createId("runner"), generation: 2 },
      }),
    ).toEqual({ state: "sign-in-again" });
  });
  it("requires enrollment after a prepared attempt survives restart", () => {
    expect(
      deviceMembership({
        ...base,
        membership: { state: "active", runnerId: null, generation: 3, enrolled: false },
      }),
    ).toEqual({ state: "needs-setup" });
    expect(
      deviceMembership({
        ...base,
        membership: {
          state: "active",
          runnerId: createId("runner"),
          generation: 2,
          enrolled: false,
        },
      }),
    ).toEqual({ state: "finish-setup", reason: "This Mac has not finished joining" });
  });
  it("derives setup, blockers and applicability without storing state", () => {
    expect(deviceMembership(base)).toEqual({ state: "needs-setup" });
    expect(deviceMembership({ ...base, settingUp: true })).toEqual({ state: "setting-up" });
    expect(deviceMembership({ ...base, finishSetupReason: "Turn on Use from anywhere" })).toEqual({
      state: "finish-setup",
      reason: "Turn on Use from anywhere",
    });
    expect(
      deviceMembership({
        ...base,
        membership: { state: "active", runnerId: createId("runner"), generation: 1 },
      }),
    ).toEqual({ state: "ready" });
    expect(deviceMembership({ ...base, hosting: true })).toEqual({ state: "hosting" });
    expect(deviceMembership({ ...base, applicable: false })).toEqual({ state: "not-applicable" });
  });
});
const machine = (id: string, kind: "home" | "computer") =>
  MachineSummarySchema.parse({
    id,
    kind,
    name: id,
    ownership: kind === "home" ? "deployment" : "mine",
    allowedModules: ["agents"],
    modules: {},
    access: null,
    detail: null,
    enrollmentId: null,
    expiresAt: null,
    lastSeenAt: null,
    pinnedThreads: 0,
    revocable: kind !== "home",
    status: "online",
  });
const session = (
  id: string,
  deviceId?: string | null,
  deviceLabel = "Chrome on Mac",
): AuthSessionSummary =>
  ({
    id,
    deviceId,
    current: false,
    deviceLabel,
    form: "computer",
    absoluteExpiresAt: "2026-11-12T12:00:00Z",
    createdAt: "2026-11-12T12:00:00Z",
    expiresAt: "2026-11-12T12:00:00Z",
    lastSeenAt: "2026-11-12T12:00:00Z",
  }) as AuthSessionSummary;
it("groups bound sessions without losing legacy sessions or plugin equipment", () => {
  const plugin = {
    pluginId: "lights",
    name: "Lamp",
    kind: "light" as const,
    computer: null,
    issue: null,
    setupThreadId: null,
  };
  const view = devicesView({
    machines: [machine("other", "computer"), machine("home", "home"), machine("here", "computer")],
    sessions: [
      session("a", "here"),
      session("b", "here"),
      session("web", null),
      session("legacy"),
      session("phone", null, "Opensteer for iPhone"),
      session("gone", "removed-device"),
    ],
    hereId: "here",
    otherDevices: [plugin],
  });
  // A session is never a device row: only machines are, and every session lands once.
  expect(view.devices.map((row) => row.label)).toEqual(["here", "home", "other"]);
  expect(view.devices[0]?.sessions.map((row) => row.id)).toEqual(["a", "b"]);
  expect(view.alsoSignedIn.map((row) => [row.session.id, row.status])).toEqual([
    ["web", "Signed in"],
    ["legacy", "Signed in"],
    ["phone", "Update to finish setup"],
    ["gone", "Signed in"],
  ]);
  expect(view.otherDevices).toEqual([plugin]);
});
it("reads legacy switches without widening files access", () => {
  expect(deviceAccess({ reach: "nobody" })).toEqual({ browser: true, apps: true, files: false });
  expect(deviceAccess({ reach: "owner", browser: false, apps: false })).toEqual({
    browser: false,
    apps: false,
    files: true,
  });
});
it("turns a switch off and on again without widening what was saved underneath", () => {
  const saved = {
    browser: true,
    apps: true,
    reach: "owner" as const,
    commands: false,
    forwarding: false,
    shares: [{ path: "/Users/person/Projects", mode: "read" as const }],
  };
  const off = withDeviceSwitch(saved, "files", false);
  expect(off).toEqual({
    reach: "nobody",
    commands: false,
    forwarding: false,
    shares: saved.shares,
  });
  expect(withDeviceSwitch(off, "files", true)).toEqual({
    reach: "owner",
    commands: false,
    forwarding: false,
    shares: saved.shares,
  });
  // The other optional switch stays out, so the Host keeps whatever it is now.
  expect(withDeviceSwitch(saved, "browser", false)).toEqual({
    reach: "owner",
    commands: false,
    forwarding: false,
    shares: saved.shares,
    browser: false,
  });
});

describe("device access rows", () => {
  const unreported = { checkedAt: null, detail: null, readiness: "unavailable" as const };
  const device = (input: {
    readonly allowedModules: readonly string[];
    readonly modules: readonly string[];
    readonly device: { readonly form: string; readonly platform: string; readonly app?: string };
    readonly status?: "online" | "offline";
  }) =>
    MachineSummarySchema.parse({
      ...machine("rnr_device", "computer"),
      access: {
        activeSessions: [],
        ownerReachAvailable: true,
        revision: 1,
        policy: { apps: false, reach: "owner", commands: true, forwarding: true, shares: [] },
      },
      allowedModules: input.allowedModules,
      device: input.device,
      modules: Object.fromEntries(input.modules.map((name) => [name, unreported])),
      status: input.status ?? "online",
    });
  const rows = (summary: ReturnType<typeof device>) =>
    deviceAccessRows(summary, true).map((row) => row.capability);

  it("offers Apps only where integrations are advertised, not merely granted", () => {
    const phone = { form: "phone", platform: "android", app: "opensteer" };
    expect(
      rows(
        device({
          allowedModules: ["browser", "integrations"],
          modules: ["browser"],
          device: phone,
        }),
      ),
    ).toEqual(["browser"]);
    expect(
      rows(
        device({
          allowedModules: ["browser", "integrations"],
          modules: ["browser", "integrations"],
          device: { ...phone, platform: "ios" },
        }),
      ),
    ).toEqual(["browser", "apps"]);
    expect(
      rows(
        device({
          allowedModules: ["browser", "integrations"],
          modules: ["integrations"],
          device: { form: "phone", platform: "android" },
        }),
      ),
    ).toEqual(["browser", "apps"]);
    const server = device({
      allowedModules: ["integrations", "shell"],
      modules: ["integrations", "shell"],
      device: { form: "server", platform: "linux" },
      status: "offline",
    });
    expect(deviceAccessRows(server, true)).toEqual([
      { capability: "apps", kind: "switch", on: false },
      { capability: "files", kind: "switch", on: true },
    ]);
  });
});
