import { menuBarStatus, type MenuBarInput, type MenuBarStatus } from "@opensteer/client/computers";
import { mockAgentIdentity, mockDeviceMachine } from "@opensteer/client/mock";
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

const grok = mockAgentIdentity.selfNamed("Grok", "https://grok.com", false);
const claude = mockAgentIdentity.verifiedPlatform("claude", "Claude", "https://claude.ai");

const nothing: MenuBarInput = {
  hostedHome: null,
  deviceHomes: [],
  stop: { phase: "running", stoppedAt: null, problem: null },
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
      tasks: [{ threadId: "thr_1", title: "Clean up downloads" }],
      shells: [],
    },
  }),
  /**
   * Outside agents using this Mac, named as their connections proved them, and
   * a Device's Run with its task; each row opens its task.
   */
  agents: menuBarStatus({
    ...nothing,
    ...studio,
    deviceHomes: [office("running")],
    local: {
      apps: [],
      tabs: [
        {
          sessionId: "bsn_1",
          profile: true,
          threadTitle: "Friday dinner",
          task: { deploymentId: "dep_home", threadId: "thr_2" },
          agent: { clientName: "Grok", redirect: "https://grok.com", ...grok },
        },
      ],
      runs: [
        {
          deploymentId: "dep_office",
          runId: "run_1",
          engine: "Claude Code",
          purpose: "task",
          threadId: "thr_3",
          threadTitle: "Rename photos",
        },
      ],
    },
    homeWork: {
      tasks: [
        {
          threadId: "thr_1",
          title: "Compare flights",
          agent: { clientName: "Claude", redirect: "https://claude.ai", ...claude },
        },
      ],
      shells: [],
    },
  }),
  stopping: menuBarStatus({
    ...nothing,
    ...studio,
    stop: { phase: "stopping", stoppedAt: null, problem: null },
  }),
  stopFailed: menuBarStatus({
    ...nothing,
    ...studio,
    stop: {
      phase: "failed",
      stoppedAt: null,
      problem:
        "Some agent work on this Mac didn’t stop (tasks on this Mac’s Home). Press Stop everything to try again.",
    },
  }),
  stopped: menuBarStatus({
    ...nothing,
    ...studio,
    // The Home's own row for this Mac says it is stopped too.
    thisMac: {
      deploymentId: "dep_home",
      machine: { ...thisMac(false), agentsStoppedSince: "2026-11-20T18:42:00.000Z" },
      devicesAvailable: true,
    },
    stop: { phase: "stopped", stoppedAt: "2026-11-20T18:42:00.000Z", problem: null },
  }),
} satisfies Record<string, MenuBarStatus>;

export type MenuBarStateName = keyof typeof menuBarStates;
