import { DeviceIdSchema, RunnerIdSchema } from "@opensteer/core";
import {
  DeviceMachineSummarySchema,
  ComputerUseSessionSummarySchema,
  type DeviceAvailability,
  type DeviceMachineSummary,
} from "@opensteer/protocol";

export const mockIphoneScreenDeviceId = DeviceIdSchema.parse(
  "dev_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
);
export const mockIphoneScreenDriverId = RunnerIdSchema.parse(
  "rnr_33333333-3333-4333-8333-333333333333",
);
export const mockIphoneScreenStates = [
  "ready",
  "detached",
  "driver-offline",
  "locked",
  "setup-needed",
  "read-only",
  "apps-off",
] as const;
export type MockIphoneScreenState = (typeof mockIphoneScreenStates)[number];

export function mockIphoneScreenDevice(
  state: MockIphoneScreenState = "ready",
): DeviceMachineSummary {
  const ready: DeviceAvailability = { state: "ready", reason: null };
  const kind =
    state === "detached"
      ? "not-connected"
      : state === "driver-offline"
        ? "driver-offline"
        : state === "locked"
          ? "locked"
          : state === "setup-needed"
            ? "setup-required"
            : state === "apps-off"
              ? "access-off"
              : null;
  const availability: DeviceAvailability = kind
    ? { state: kind === "access-off" ? "disabled" : "unavailable", reason: { kind } }
    : ready;
  const unsupported = {
    state: "unsupported",
    reason: { kind: "unsupported" },
    supported: false,
    configurable: false,
    enabled: false,
  };
  const driver = {
    role: "screen",
    runnerId: mockIphoneScreenDriverId,
    runnerName: "Alex’s MacBook Pro",
    generation: state === "detached" ? 2 : 1,
    attached: state !== "detached",
  };
  return DeviceMachineSummarySchema.parse({
    id: mockIphoneScreenDeviceId,
    name: "Work iPhone",
    kind: "phone",
    selfRunnerId: null,
    device: { form: "phone", platform: "ios" },
    drivers: [driver],
    capabilities: {
      browser: unsupported,
      files: unsupported,
      apps: { ...availability, supported: true, configurable: true, enabled: state !== "apps-off" },
    },
    phoneDisplay: {
      definitionId: "iphone-screen",
      driver,
      control: availability,
      view: state === "apps-off" ? ready : availability,
      input:
        state === "read-only"
          ? { state: "disabled", reason: { kind: "approval-required" } }
          : state === "apps-off"
            ? ready
            : availability,
      setup: {
        location: "driver-mac",
        driverRunnerId: driver.runnerId,
        driverRunnerName: driver.runnerName,
      },
      navigationButtons: [{ id: "home", label: "Home" }],
      actions: [
        "tap",
        "longPress",
        "swipe",
        "drag",
        "type",
        "clear",
        "navigate",
        "launch",
        "scroll",
        "wait",
      ],
      wake: false,
      lock: null,
    },
    access: {
      activeSessions: [],
      ownerReachAvailable: true,
      revision: 1,
      policy: {
        apps: state !== "apps-off",
        browser: false,
        commands: false,
        forwarding: false,
        reach: "nobody",
        shares: [],
      },
    },
    apps: [
      {
        definitionId: "iphone-screen",
        operations: ["observe", "act", "release"].map((operation) => ({
          operation,
          state: kind ? "unavailable" : "ready",
          detail: null,
          remedy: null,
        })),
      },
    ],
    computerUse: {
      appApproval: "ask",
      detail: null,
      permissions: null,
      sessions: [],
      ownerViews: [],
      state: kind ? "unavailable" : "ready",
      displayStreamSupported: true,
      ownerViewVersion: 1,
    },
    allowedModules: [],
    modules: {},
    enrollmentId: null,
    expiresAt: null,
    detail: null,
    fullDiskAccess: null,
    runtimeVersion: null,
    status: kind === "not-connected" || kind === "driver-offline" ? "offline" : "online",
    ownership: "mine",
    pinnedThreads: 0,
    revocable: true,
    lastSeenAt: null,
  });
}

export const mockIphoneScreenSession = ComputerUseSessionSummarySchema.parse({
  sessionId: "cus_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  runId: "run_00000000-0000-4000-8000-000000000001",
  threadId: "thr_00000000-0000-4000-8000-000000000001",
  threadTitle: "Build the new architecture",
  display: true,
  apps: [],
  actionCount: 0,
  openedAt: "2026-11-16T12:00:00.000Z",
});
export const mockIphoneScreenSource = {
  kind: "task-session" as const,
  sessionId: mockIphoneScreenSession.sessionId,
};
