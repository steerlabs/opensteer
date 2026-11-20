import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MachineSummarySchema } from "@opensteer/protocol";
import { mockDeviceMachine } from "../mock/mock-device-machine.js";
import { menuBarWords } from "./menu-bar-copy.js";
import { menuBarActivity, menuBarStatus, type MenuBarInput } from "./menu-bar.js";

const unreported = { checkedAt: null, detail: null, readiness: "unavailable" as const };
const thisMac = (input: { readonly home?: boolean; readonly sessions?: number } = {}) =>
  mockDeviceMachine(
    MachineSummarySchema.parse({
      id: "rnr_thismac",
      kind: input.home ? "home" : "computer",
      name: "Studio",
      ownership: input.home ? "deployment" : "mine",
      allowedModules: input.home ? ["agents", "browser"] : ["browser", "integrations", "shell"],
      modules: Object.fromEntries(
        ["browser", "integrations", "shell"].map((name) => [name, unreported]),
      ),
      access: {
        activeSessions: Array.from({ length: input.sessions ?? 0 }, (_, index) => ({
          bytesIn: 0,
          bytesOut: 0,
          callerMachineName: "Home",
          id: `shs_${crypto.randomUUID()}`,
          requestedBy: createId("user"),
          runId: createId("run"),
          startedAt: "2026-11-19T10:00:00.000Z",
          threadId: createId("thread"),
          threadTitle: `Task ${index}`,
        })),
        ownerReachAvailable: true,
        revision: 3,
        policy: { apps: true, reach: "nobody", commands: true, forwarding: true, shares: [] },
      },
      detail: null,
      device: { form: "laptop", platform: "macos" },
      enrollmentId: null,
      expiresAt: null,
      lastSeenAt: null,
      revocable: !input.home,
      status: "online",
    }),
  );

const base: MenuBarInput = {
  hostedHome: null,
  deviceHomes: [],
  stop: { stopped: false, stoppedAt: null, problem: null },
  thisMac: null,
  needsYou: new Map(),
  local: { apps: [], tabs: [] },
  homeWork: null,
  openAtLogin: { on: true, available: true },
};
const studio = (state: NonNullable<MenuBarInput["hostedHome"]>["state"] = "ready") => ({
  deploymentId: "dep_home",
  name: "MacBook Pro",
  state,
});
const office = (
  runner: MenuBarInput["deviceHomes"][number]["runner"] = "running",
  signedOut = false,
) => ({ deploymentId: "dep_office", name: "Office Mini", runner, signedOut });

describe("menu bar header", () => {
  it("says this Mac has no Home yet, with no icon alarm", () => {
    const status = menuBarStatus(base);
    expect(status.title).toBe("Opensteer");
    expect(status.homes).toEqual([]);
    expect(status.noHome).toBe("This Mac isn’t connected to a Home yet.");
    expect(status.icon).toEqual({ attention: false, unreachable: false, stopped: false });
    expect(status.thisMacNote).toBeNull();
  });

  it.each([
    ["ready", "This Mac is your Home · Running", true],
    ["starting", "This Mac is your Home · Starting…", true],
    ["degraded", "This Mac is your Home · Needs attention", false],
    ["stopped", "This Mac is your Home · Stopped", false],
  ] as const)("says a local Home that is %s", (state, line, reachable) => {
    const status = menuBarStatus({ ...base, hostedHome: studio(state) });
    expect(status.homes).toEqual([
      expect.objectContaining({ line: "Home: MacBook Pro", status: line, reachable }),
    ]);
    expect(status.icon.unreachable).toBe(!reachable);
  });

  it.each([
    ["running", false, "Connected", true],
    ["starting", false, "Reconnecting…", false],
    ["failed", false, "Can’t reach Office Mini", false],
    ["running", true, "Sign in to Office Mini again", false],
  ] as const)("says a remote Home whose Runner is %s", (runner, signedOut, line, reachable) => {
    const status = menuBarStatus({ ...base, deviceHomes: [office(runner, signedOut)] });
    expect(status.homes).toEqual([
      expect.objectContaining({ line: "Home: Office Mini", status: line, reachable }),
    ]);
    expect(status.stop.offline).toBe(
      reachable ? null : "Works even while Office Mini is unreachable.",
    );
  });

  it("shows both Homes when this Mac hosts one and serves another, without a list", () => {
    const status = menuBarStatus({
      ...base,
      hostedHome: studio(),
      deviceHomes: [{ ...office(), deploymentId: "dep_home" }, office("failed")],
    });
    expect(status.homes.map((home) => [home.line, home.status])).toEqual([
      ["Home: MacBook Pro", "This Mac is your Home · Running"],
      ["Home: Office Mini", "Can’t reach Office Mini"],
    ]);
    expect(status.icon.unreachable).toBe(false);
    expect(status.stop.offline).toBe("Works even while Office Mini is unreachable.");
  });

  it("folds Homes past three into a count", () => {
    const many = ["a", "b", "c", "d"].map((id) => ({ ...office(), deploymentId: `dep_${id}` }));
    const status = menuBarStatus({ ...base, deviceHomes: many });
    expect(status.homes).toHaveLength(3);
    expect(status.moreHomes).toBe("+1 more");
  });

  it("draws the slash only when no Home can be reached", () => {
    expect(menuBarStatus({ ...base, deviceHomes: [office("failed")] }).icon.unreachable).toBe(true);
  });
});

describe("Needs you", () => {
  it("adds up the Homes that answered and opens the first that has any", () => {
    const status = menuBarStatus({
      ...base,
      needsYou: new Map([
        ["dep_home", 0],
        ["dep_office", 2],
        ["dep_lab", 1],
      ]),
    });
    expect(status.needsYou).toEqual({ line: "3 need you", deploymentId: "dep_office" });
    expect(status.icon.attention).toBe(true);
    expect(menuBarStatus({ ...base, needsYou: new Map([["dep_home", 1]]) }).needsYou?.line).toBe(
      "1 needs you",
    );
  });

  it("says nothing, not zero, when no Home could be read or none has any", () => {
    expect(menuBarStatus({ ...base, needsYou: new Map([["dep_home", null]]) }).needsYou).toBe(null);
    expect(menuBarStatus({ ...base, needsYou: new Map([["dep_home", 0]]) }).needsYou).toBe(null);
    expect(menuBarStatus({ ...base, needsYou: new Map([["dep_home", null]]) }).icon.attention).toBe(
      false,
    );
  });
});

describe("Right now", () => {
  it("shows an agent in an app with a Stop, named by its task and the app", () => {
    const status = menuBarStatus({
      ...base,
      local: {
        apps: [{ sessionId: "cus_1", threadTitle: "Book flights", app: "Notes" }],
        tabs: [],
      },
    });
    expect(status.rightNow).toEqual([
      {
        id: "apps:cus_1",
        kind: "apps",
        actor: { label: "Book flights", name: null, markOrigin: null },
        using: "Notes",
        stoppable: true,
      },
    ]);
  });

  it("calls an agent and an app it cannot name by honest generic names", () => {
    const [row] = menuBarStatus({
      ...base,
      local: { apps: [{ sessionId: "cus_1", threadTitle: null, app: null }], tabs: [] },
    }).rightNow;
    expect(row).toMatchObject({ actor: { label: "An agent" }, using: "An app" });
  });

  it("shows an agent's browser tab without a Stop this Mac could not do as the Home does", () => {
    const status = menuBarStatus({
      ...base,
      local: {
        apps: [],
        tabs: [
          { sessionId: "bsn_1", profile: true },
          { sessionId: "bsn_2", profile: false },
        ],
      },
    });
    expect(status.rightNow.map((row) => [row.kind, row.using, row.stoppable])).toEqual([
      ["browser", "A browser profile", false],
      ["browser", "A new browser tab", false],
    ]);
  });

  it("adds files and commands a readable Home reports, after what this Mac knows", () => {
    const status = menuBarStatus({
      ...base,
      local: { apps: [{ sessionId: "cus_1", threadTitle: "Sort inbox", app: "Mail" }], tabs: [] },
      homeWork: {
        runningTasks: ["Book flights", "Pay bills"],
        sessions: [{ threadId: "thr_1", threadTitle: "Clean up downloads" }],
      },
    });
    expect(status.rightNow.map((row) => [row.kind, row.actor.label, row.using])).toEqual([
      ["apps", "Sort inbox", "Mail"],
      ["files", "Clean up downloads", "Files and commands"],
      ["files", "Book flights", "Files and commands"],
    ]);
    expect(status.rightNow.every((row) => row.kind === "apps" || !row.stoppable)).toBe(true);
  });

  it("is empty when nothing uses this Mac", () => {
    expect(menuBarStatus(base).rightNow).toEqual([]);
  });
});

describe("This Mac and Stop everything", () => {
  it("shows this Mac's switches as Devices does, with the revision they were read at", () => {
    const status = menuBarStatus({
      ...base,
      deviceHomes: [office()],
      thisMac: { deploymentId: "dep_office", machine: thisMac(), devicesAvailable: true },
    });
    expect(status.thisMac).toMatchObject({
      deploymentId: "dep_office",
      editable: true,
      revision: 3,
      switches: [
        { capability: "browser", label: "Browser", on: true, detail: "Open and use tabs" },
        { capability: "apps", label: "Apps", on: true, detail: "See and control apps" },
        { capability: "files", label: "Files and commands", on: false },
      ],
    });
    expect(status.thisMacNote).toBeNull();
  });

  it("keeps the Home's own switches fixed where Devices does", () => {
    const status = menuBarStatus({
      ...base,
      hostedHome: studio(),
      thisMac: {
        deploymentId: "dep_home",
        machine: thisMac({ home: true }),
        devicesAvailable: true,
      },
    });
    const fixed = status.thisMac?.switches.filter((item) => item.fixed);
    expect(fixed?.map((item) => [item.capability, item.detail])).toEqual([
      ["browser", "Always on. Your agent runs here."],
      ["files", "Always on. Your agent runs here."],
    ]);
  });

  it("points to the app when the switches could not be read", () => {
    expect(menuBarStatus({ ...base, hostedHome: studio() }).thisMacNote).toBe(
      "Open Opensteer to change what agents can use on this Mac.",
    );
  });

  it("says when everything was stopped and keeps a remote Home's line honest", () => {
    const status = menuBarStatus({
      ...base,
      deviceHomes: [office("disabled")],
      stop: { stopped: true, stoppedAt: "2026-11-20T10:42:00.000Z", problem: null },
    });
    expect(status.stop).toEqual({
      stopped: true,
      stoppedAt: "2026-11-20T10:42:00.000Z",
      offline: null,
      problem: null,
    });
    expect(status.homes[0]?.status).toBe("Stopped on this Mac");
    expect(status.icon).toEqual({ attention: false, unreachable: false, stopped: true });
  });
});

it("keeps quit's activity lines for its question", () => {
  expect(
    menuBarActivity({
      machines: new Map([
        ["dep_office", { machine: thisMac({ sessions: 1 }), devicesAvailable: true }],
      ]),
      runningTasks: ["Book flights"],
      local: { appSessions: 1, browserTabs: 2 },
    }),
  ).toEqual([
    "Running: Book flights",
    "“Task 0” is using this Mac",
    "An agent is using apps on this Mac",
    "An agent has 2 tabs open on this Mac",
  ]);
});

it("fills the design's placeholders", () => {
  expect(menuBarWords("menubar.stopped", { time: "10:42" })).toBe(
    "Stopped everything on this Mac at 10:42.",
  );
});
