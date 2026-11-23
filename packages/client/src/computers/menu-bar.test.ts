import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MachineSummarySchema } from "@opensteer/protocol";
import { mockAgentIdentity } from "../mock/mock-connected-agents.js";
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
  stop: { phase: "running", stoppedAt: null, problem: null },
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
  const homes = (...ids: string[]) =>
    ids.map((id) => ({ ...office(), deploymentId: id, name: id.slice(4) }));

  it("adds up the Homes that answered and opens the first that has any", () => {
    const status = menuBarStatus({
      ...base,
      deviceHomes: homes("dep_home", "dep_office", "dep_lab"),
      needsYou: new Map([
        ["dep_home", 0],
        ["dep_office", 2],
        ["dep_lab", 1],
      ]),
    });
    expect(status.needsYou).toEqual({
      line: "3 need you",
      deploymentId: "dep_office",
      partial: false,
    });
    expect(status.icon.attention).toBe(true);
    expect(
      menuBarStatus({
        ...base,
        deviceHomes: homes("dep_home"),
        needsYou: new Map([["dep_home", 1]]),
      }).needsYou?.line,
    ).toBe("1 needs you");
  });

  it("says a count is partial while another Home has not answered or could not be read", () => {
    const deviceHomes = homes("dep_office", "dep_lab");
    expect(
      menuBarStatus({ ...base, deviceHomes, needsYou: new Map([["dep_office", 2]]) }).needsYou,
    ).toEqual({ line: "At least 2 need you", deploymentId: "dep_office", partial: true });
    expect(
      menuBarStatus({
        ...base,
        deviceHomes,
        needsYou: new Map([
          ["dep_office", 2],
          ["dep_lab", null],
        ]),
      }).needsYou?.line,
    ).toBe("At least 2 need you");
  });

  it("never turns a Home it could not read into a zero, and is silent when all answered none", () => {
    const deviceHomes = homes("dep_office", "dep_lab");
    const unread = menuBarStatus({
      ...base,
      deviceHomes,
      needsYou: new Map([
        ["dep_office", 0],
        ["dep_lab", null],
      ]),
    });
    expect(unread.needsYou).toEqual({
      line: "Couldn’t check lab for what needs you",
      deploymentId: "dep_lab",
      partial: true,
    });
    const clear = menuBarStatus({
      ...base,
      deviceHomes,
      needsYou: new Map([
        ["dep_office", 0],
        ["dep_lab", 0],
      ]),
    });
    expect(clear.needsYou).toBeNull();
    expect(clear.icon.attention).toBe(false);
  });
});

describe("Right now", () => {
  const plain = { verified: false, selfAsserted: false, providerId: null };
  const grok = mockAgentIdentity.selfNamed("Grok", "https://grok.com", false);
  const claude = mockAgentIdentity.verifiedPlatform("claude", "Claude", "https://claude.ai");

  it("shows an agent in an app as information, named by its task and the app", () => {
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
        actor: { label: "Book flights", name: "Book flights", ...plain },
        using: "Notes",
        opens: null,
      },
    ]);
    expect(Object.keys(status.rightNow[0]!)).not.toContain("stoppable");
  });

  it("calls an agent and an app it cannot name by honest generic names", () => {
    const [row] = menuBarStatus({
      ...base,
      local: { apps: [{ sessionId: "cus_1", threadTitle: null, app: null }], tabs: [] },
    }).rightNow;
    expect(row).toMatchObject({ actor: { label: "An agent" }, using: "An app" });
  });

  it("shows an agent's browser tab by what kind of session it is", () => {
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
    expect(status.rightNow.map((row) => [row.kind, row.using, row.opens])).toEqual([
      ["browser", "A browser profile", null],
      ["browser", "A new browser tab", null],
    ]);
  });

  it("names each row from the record it came from, after what this Mac itself knows", () => {
    const status = menuBarStatus({
      ...base,
      hostedHome: studio(),
      local: {
        apps: [],
        tabs: [],
        runs: [
          { deploymentId: "dep_office", runId: "run_1", engine: "Claude Code", purpose: "task" },
        ],
      },
      homeWork: {
        tasks: [{ threadId: "thr_2", title: "Book flights" }],
        shells: [{ id: "shs_1", threadTitle: "Clean up downloads", callerMachineName: "Home" }],
      },
    });
    expect(
      status.rightNow.map((row) => [row.id, row.kind, row.actor.label, row.using, row.opens]),
    ).toEqual([
      ["runner:dep_office:run_1", "task", "Claude Code", "Working on this Mac", null],
      [
        "home:thr_2",
        "task",
        "Book flights",
        "Working on this Mac",
        { deploymentId: "dep_home", threadId: "thr_2" },
      ],
      ["shell:shs_1", "files", "Clean up downloads", "Files and commands from Home", null],
    ]);
  });

  it("opens the task a record names, in the Home that runs it", () => {
    const status = menuBarStatus({
      ...base,
      local: {
        apps: [
          {
            sessionId: "cus_1",
            threadTitle: "Book flights",
            app: "Notes",
            task: { deploymentId: "dep_office", threadId: "thr_1" },
          },
        ],
        tabs: [],
        runs: [
          {
            deploymentId: "dep_office",
            runId: "run_1",
            engine: "Codex",
            purpose: "task",
            threadId: "thr_2",
            threadTitle: "Rename photos",
          },
        ],
      },
      homeWork: {
        tasks: [],
        shells: [
          {
            id: "shs_1",
            threadTitle: "Tidy",
            callerMachineName: "Office Mini",
            threadId: "thr_3",
            deploymentId: "dep_office",
          },
        ],
      },
    });
    expect(status.rightNow.map((row) => [row.actor.label, row.using, row.opens])).toEqual([
      ["Book flights", "Notes", { deploymentId: "dep_office", threadId: "thr_1" }],
      [
        "Codex",
        "Working on this Mac · Rename photos",
        { deploymentId: "dep_office", threadId: "thr_2" },
      ],
      [
        "Tidy",
        "Files and commands from Office Mini",
        { deploymentId: "dep_office", threadId: "thr_3" },
      ],
    ]);
  });

  it("names a connected agent as its connection proved it, never from its address", () => {
    const status = menuBarStatus({
      ...base,
      hostedHome: studio(),
      local: {
        apps: [],
        tabs: [
          {
            sessionId: "bsn_1",
            profile: true,
            threadTitle: "Friday dinner",
            agent: { clientName: "Grok", redirect: "https://grok.com", ...grok },
          },
          // An older Home sends no presentation: the name it gave itself, marked as such.
          {
            sessionId: "bsn_2",
            profile: false,
            agent: { clientName: "ChatGPT", redirect: "https://chatgpt.com/cb" },
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
    });
    expect(status.rightNow.map((row) => [row.actor, row.using])).toEqual([
      [
        {
          label: "Says it is “Grok”",
          name: "Grok",
          verified: false,
          selfAsserted: true,
          providerId: null,
        },
        "A browser profile · Friday dinner",
      ],
      [
        {
          label: "Says it is “ChatGPT”",
          name: "ChatGPT",
          verified: false,
          selfAsserted: true,
          providerId: null,
        },
        "A new browser tab",
      ],
      [
        {
          label: "Verified: “Claude”",
          name: "Claude",
          verified: true,
          selfAsserted: false,
          providerId: "anthropic",
        },
        "Working on this Mac · Compare flights",
      ],
    ]);
  });

  it("names a verification the Home withdrew plainly, without its mark", () => {
    const [row] = menuBarStatus({
      ...base,
      local: {
        apps: [],
        tabs: [
          {
            sessionId: "bsn_1",
            profile: true,
            agent: {
              clientName: "Claude",
              redirect: "https://claude.ai",
              ...claude,
              withdrawnAt: "2026-11-17T09:00:00.000Z",
            },
          },
        ],
      },
    }).rightNow;
    expect(row?.actor).toEqual({ label: "Claude", name: "Claude", ...plain });
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
      machineId: "rnr_thismac",
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
      ["browser", "Always on. Your own agents run here."],
      ["files", "Always on. Your own agents run here."],
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
      needsYou: new Map([["dep_office", 0]]),
      stop: { phase: "stopped", stoppedAt: "2026-11-20T10:42:00.000Z", problem: null },
    });
    expect(status.stop).toEqual({
      phase: "stopped",
      stoppedAt: "2026-11-20T10:42:00.000Z",
      offline: null,
      problem: null,
      confirmed: null,
    });
    expect(status.homes[0]?.status).toBe("Stopped on this Mac");
    expect(status.icon).toEqual({ attention: false, unreachable: false, stopped: true });
  });

  it("says the Home shows this Mac as stopped too, once its row for this Mac does", () => {
    const stop = {
      phase: "stopped" as const,
      stoppedAt: "2026-11-20T10:42:00.000Z",
      problem: null,
    };
    const reported = MachineSummarySchema.parse({
      ...thisMac(),
      agentsStoppedSince: "2026-11-20T10:42:00.000Z",
    });
    const confirmed = menuBarStatus({
      ...base,
      deviceHomes: [office()],
      stop,
      thisMac: { deploymentId: "dep_office", machine: reported, devicesAvailable: true },
    });
    expect(confirmed.stop.confirmed).toBe("Office Mini shows this Mac as stopped too.");
    const unconfirmed = menuBarStatus({
      ...base,
      deviceHomes: [office()],
      stop,
      thisMac: { deploymentId: "dep_office", machine: thisMac(), devicesAvailable: true },
    });
    expect(unconfirmed.stop.confirmed).toBeNull();
  });

  it("keeps a Home that cannot be reached unreachable when the person stops this Mac", () => {
    for (const home of [office("failed"), office("running", true)]) {
      const status = menuBarStatus({
        ...base,
        deviceHomes: [home],
        needsYou: new Map([["dep_office", null]]),
        stop: { phase: "stopped", stoppedAt: "2026-11-20T10:42:00.000Z", problem: null },
      });
      expect(status.homes[0]?.reachable).toBe(false);
      expect(status.icon.unreachable).toBe(true);
      expect(status.stop.offline).toBe("Works even while Office Mini is unreachable.");
    }
  });

  it("never says stopped while a Stop is still under way or did not finish", () => {
    for (const phase of ["stopping", "failed"] as const) {
      const status = menuBarStatus({
        ...base,
        stop: { phase, stoppedAt: "2026-11-20T10:42:00.000Z", problem: null },
      });
      expect(status.stop).toMatchObject({ phase, stoppedAt: null });
      expect(status.icon.stopped).toBe(true);
    }
  });

  it("shows the checking line while local Stop waits for Home confirmation, and the overdue alert line after 30 s", () => {
    const checking = menuBarStatus({
      ...base,
      hostedHome: studio("ready"),
      stop: { phase: "stopped", stoppedAt: null, problem: null, confirming: true },
    });
    expect(checking.stop.stoppedAt).toBeNull();
    expect(checking.stop.problem).toBeNull();
    expect(checking.stop.waiting).toBe(
      "Agents on this Mac are stopped. Checking that this Mac’s Home stopped everything too…",
    );
    expect(checking.stop.waitingOverdue).toBeUndefined();

    const overdue = menuBarStatus({
      ...base,
      hostedHome: studio("ready"),
      stop: {
        phase: "stopped",
        stoppedAt: null,
        problem: null,
        confirming: true,
        confirmOverdue: true,
      },
    });
    expect(overdue.stop.stoppedAt).toBeNull();
    expect(overdue.stop.problem).toBeNull();
    expect(overdue.stop.waiting).toBe(
      "Agents on this Mac are stopped. Couldn’t confirm yet that this Mac’s Home stopped everything. Still checking.",
    );
    expect(overdue.stop.waitingOverdue).toBe(true);
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
