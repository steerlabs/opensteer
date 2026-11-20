import { menuBarStatus, type MenuBarInput, type MenuBarStatus } from "@opensteer/client/computers";
import { mockDeviceMachine } from "@opensteer/client/mock";
import { MachineSummarySchema } from "@opensteer/protocol";

/** This Mac's row in a Home, as Devices reads it: Browser and Files on, Apps off. */
function thisMac(home: boolean) {
  const unreported = { checkedAt: null, detail: null, readiness: "unavailable" as const };
  return mockDeviceMachine(
    MachineSummarySchema.parse({
      id: "rnr_00000000-0000-4000-8000-000000000001",
      kind: home ? "home" : "computer",
      name: "MacBook Pro",
      ownership: home ? "deployment" : "mine",
      allowedModules: ["browser", "integrations", "shell"],
      modules: Object.fromEntries(
        ["browser", "integrations", "shell"].map((name) => [name, unreported]),
      ),
      access: {
        activeSessions: [],
        ownerReachAvailable: true,
        revision: 7,
        policy: { apps: false, reach: "owner", commands: true, forwarding: true, shares: [] },
      },
      detail: null,
      device: { form: "laptop", platform: "macos" },
      enrollmentId: null,
      expiresAt: null,
      lastSeenAt: null,
      revocable: !home,
      status: "online",
    }),
  );
}

const nothing: MenuBarInput = {
  hostedHome: null,
  deviceHomes: [],
  stop: { stopped: false, stoppedAt: null, problem: null },
  thisMac: null,
  needsYou: new Map(),
  local: { apps: [], tabs: [] },
  homeWork: null,
  openAtLogin: { on: true, available: false },
};
const studio = {
  hostedHome: { deploymentId: "dep_home", name: "MacBook Pro", state: "ready" as const },
  thisMac: { deploymentId: "dep_home", machine: thisMac(false), devicesAvailable: true },
  openAtLogin: { on: true, available: true },
};
const office = (runner: "running" | "failed") => ({
  deploymentId: "dep_office",
  name: "Office Mini",
  runner,
  signedOut: false,
});

/** Every popover state, through the same view model desktop main uses. */
export const menuBarStates = {
  noHome: menuBarStatus(nothing),
  localHome: menuBarStatus({ ...nothing, ...studio, needsYou: new Map([["dep_home", 0]]) }),
  remoteHome: menuBarStatus({
    ...nothing,
    deviceHomes: [office("running")],
    thisMac: { deploymentId: "dep_office", machine: thisMac(false), devicesAvailable: true },
    openAtLogin: { on: true, available: true },
  }),
  twoHomes: menuBarStatus({
    ...nothing,
    ...studio,
    deviceHomes: [office("failed")],
    needsYou: new Map([
      ["dep_home", 0],
      ["dep_office", null],
    ]),
  }),
  unreachable: menuBarStatus({
    ...nothing,
    deviceHomes: [office("failed")],
    needsYou: new Map([["dep_office", null]]),
    openAtLogin: { on: true, available: true },
  }),
  needsYou: menuBarStatus({
    ...nothing,
    ...studio,
    deviceHomes: [office("running")],
    needsYou: new Map([
      ["dep_home", 2],
      ["dep_office", 1],
    ]),
  }),
  active: menuBarStatus({
    ...nothing,
    ...studio,
    local: {
      apps: [{ sessionId: "cus_1", threadTitle: "Book flights", app: "Notes" }],
      tabs: [{ sessionId: "bsn_1", profile: true }],
    },
    homeWork: {
      runningTasks: [],
      sessions: [{ threadId: "thr_1", threadTitle: "Clean up downloads" }],
    },
  }),
  stopped: menuBarStatus({
    ...nothing,
    ...studio,
    stop: { stopped: true, stoppedAt: "2026-11-20T18:42:00.000Z", problem: null },
  }),
} satisfies Record<string, MenuBarStatus>;

export type MenuBarStateName = keyof typeof menuBarStates;
