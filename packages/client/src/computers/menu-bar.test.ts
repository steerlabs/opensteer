import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MachineSummarySchema } from "@opensteer/protocol";
import { mockDeviceMachine } from "../mock/mock-device-machine.js";
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
const idle = { appSessions: 0, browserTabs: 0 };
const base: MenuBarInput = {
  hostedHome: null,
  deviceHomes: [],
  machines: new Map(),
  runningTasks: [],
  local: idle,
  stopped: false,
  stopProblem: null,
  openAtLogin: { on: true, available: true },
};

describe("menu bar status", () => {
  it.each([
    ["ready", "ok", "This Mac is your Home — running"],
    ["starting", "busy", "This Mac is your Home — starting"],
    ["checking", "busy", "This Mac is your Home — starting"],
    ["degraded", "attention", "This Mac is your Home — needs attention"],
    ["repair-required", "attention", "This Mac is your Home — needs attention"],
    ["update-required", "attention", "This Mac is your Home — needs attention"],
    ["stopped", "off", "This Mac is your Home — stopped"],
  ] as const)("says a hosted Home that is %s", (state, tone, line) => {
    const status = menuBarStatus({ ...base, hostedHome: { deploymentId: "dep_home", state } });
    expect(status.homes).toEqual([
      {
        deploymentId: "dep_home",
        role: "home",
        tone,
        line,
        switches: [],
        editable: false,
        revision: null,
      },
    ]);
  });

  it.each([
    ["running", false, false, "ok", "Connected to Office"],
    ["starting", false, false, "busy", "Connecting to Office…"],
    ["failed", false, false, "busy", "Reconnecting to Office…"],
    ["disabled", false, false, "busy", "Reconnecting to Office…"],
    ["running", true, false, "attention", "Signed out of Office"],
    ["disabled", false, true, "off", "Office — stopped on this Mac"],
  ] as const)(
    "says a remote Home whose Runner is %s (signed out %s, stopped %s)",
    (runner, signedOut, stopped, tone, line) => {
      const status = menuBarStatus({
        ...base,
        stopped,
        deviceHomes: [{ deploymentId: "dep_office", name: "Office", runner, signedOut }],
      });
      expect(status.homes.map(({ line, role, tone }) => ({ line, role, tone }))).toEqual([
        { line, role: "device", tone },
      ]);
      expect(status.stopped).toBe(stopped);
    },
  );

  it("shows both roles when this Mac hosts a Home and is a Device of another", () => {
    const status = menuBarStatus({
      ...base,
      hostedHome: { deploymentId: "dep_home", state: "ready" },
      deviceHomes: [
        { deploymentId: "dep_home", name: "Studio", runner: "running", signedOut: false },
        { deploymentId: "dep_office", name: "Office", runner: "running", signedOut: false },
      ],
    });
    expect(status.homes.map(({ deploymentId, role }) => [deploymentId, role])).toEqual([
      ["dep_home", "home"],
      ["dep_office", "device"],
    ]);
  });

  it("shows this Mac's switches as Devices does, from the Host's policy", () => {
    const status = menuBarStatus({
      ...base,
      deviceHomes: [
        { deploymentId: "dep_office", name: "Office", runner: "running", signedOut: false },
      ],
      machines: new Map([["dep_office", { machine: thisMac(), devicesAvailable: true }]]),
    });
    expect(status.homes[0]).toMatchObject({
      editable: true,
      revision: 3,
      switches: [
        { capability: "browser", label: "Browser", on: true, fixed: false },
        { capability: "apps", label: "Apps", on: true, fixed: false },
        { capability: "files", label: "Files and commands", on: false, fixed: false },
      ],
    });
  });

  it("keeps the Home's own switches fixed where Devices does", () => {
    const status = menuBarStatus({
      ...base,
      hostedHome: { deploymentId: "dep_home", state: "ready" },
      machines: new Map([
        ["dep_home", { machine: thisMac({ home: true }), devicesAvailable: true }],
      ]),
    });
    const fixed = status.homes[0]?.switches.filter((item) => item.fixed);
    expect(fixed?.map((item) => item.capability)).toEqual(["browser", "files"]);
    expect(fixed?.every((item) => item.on && item.detail.startsWith("Always on"))).toBe(true);
  });

  it("lists what is using this Mac and counts it as active work", () => {
    const input: MenuBarInput = {
      ...base,
      machines: new Map([
        ["dep_office", { machine: thisMac({ sessions: 1 }), devicesAvailable: true }],
      ]),
      runningTasks: ["Book flights", "Sort inbox", "Pay bills"],
      local: { appSessions: 1, browserTabs: 2 },
    };
    expect(menuBarStatus(input).activity).toEqual([
      "3 tasks running: Book flights, Sort inbox",
      "“Task 0” is using this Mac",
      "An agent is using apps on this Mac",
      "An agent has 2 tabs open on this Mac",
    ]);
    expect(menuBarActivity(base)).toEqual([]);
    expect(menuBarStatus(base).activity).toEqual([]);
  });

  it("says what Stop does, and that it holds until resumed", () => {
    expect(menuBarStatus(base).stopLine).toMatch(/^Stop cuts agents off/);
    expect(menuBarStatus({ ...base, stopped: true }).stopLine).toMatch(/until you resume/);
  });
});
