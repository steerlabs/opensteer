import { describe, expect, it } from "vitest";
import { createId, type AuthSessionSummary } from "@opensteer/core";
import { MachineSummarySchema, deviceAccess } from "@opensteer/protocol";
import { deviceMembership, devicesView, type DeviceMembershipInput } from "./devices.js";
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
const session = (id: string, deviceId?: string | null): AuthSessionSummary =>
  ({
    id,
    deviceId,
    current: false,
    deviceLabel: "Chrome on Mac",
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
    sessions: [session("a", "here"), session("b", "here"), session("web", null), session("legacy")],
    hereId: "here",
    otherDevices: [plugin],
  });
  expect(view.devices.map((row) => row.label)).toEqual(["here", "home", "other"]);
  expect(view.devices[0]?.sessions.map((row) => row.id)).toEqual(["a", "b"]);
  expect(view.alsoSignedIn.map((row) => row.session.id)).toEqual(["web", "legacy"]);
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
