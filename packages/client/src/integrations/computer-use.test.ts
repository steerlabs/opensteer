import { RunIdSchema, RunnerIdSchema } from "@opensteer/core";
import { groupTranscriptEntries } from "../host/agent-activity-model.js";
import type { ToolEntry, TranscriptEntry } from "../host/client.js";
import type {
  ComputerAppSetupRequest,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummary,
} from "@opensteer/integration-core";
import type { ComputerUseSessionSummary, MachineSummary } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { computerAppRows } from "./computer-apps.js";
import {
  canWatchComputer,
  computerAppAccessApproval,
  computerUseNow,
  computerUseNowSummary,
  threadComputerUseNow,
  computerUseFirstRun,
  computerUseMachineLine,
  computerUseSessionTitle,
  computerUseState,
  computerUseStatusLine,
  computerUseTone,
  computerUseView,
  phoneUseStatusLine,
  phoneUseTone,
  phoneUseView,
  takeBackComputerUseApp,
  threadComputerSessions,
  type ComputerUseView,
  type PhoneUseView,
} from "./computer-use.js";

const mac = "rnr_11111111-1111-4111-8111-111111111111";
const pixel = "rnr_22222222-2222-4222-8222-222222222222";
const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: "APPLECOMP1" };
const calendar = { bundleId: "com.apple.iCal", displayName: "Calendar", teamId: "APPLECOMP1" };
/** Studio, seen from somewhere other than Studio. */
const studio = { here: false, machineName: "Studio" };

describe("a live Computer use line", () => {
  function step(kind: "app" | "phone", overrides: Partial<ToolEntry> = {}): ToolEntry {
    return {
      arguments: { arguments: { actions: [{ type: kind === "phone" ? "tap" : "type" }] } },
      callId: "call-now",
      completedAt: null,
      createdAt: "2026-09-21T00:00:00.000Z",
      id: "tool-now",
      integration: {
        account: "This computer",
        computerApp:
          kind === "app"
            ? {
                app: "Notes",
                bundleId: notes.bundleId,
                computer: "Studio",
                runnerId: RunnerIdSchema.parse(mac),
              }
            : null,
        effect: "write",
        integration: "Computer use",
        operation: { name: "act", title: "Act" },
        ...(kind === "phone"
          ? { phone: { computer: "Pixel", runnerId: RunnerIdSchema.parse(pixel) } }
          : {}),
      },
      isError: false,
      kind: "tool",
      output: undefined,
      runId: session([notes]).runId,
      state: "running",
      streamText: "",
      tool: { name: "integration_call", namespace: "opensteer.integrations" },
      ...overrides,
    };
  }
  function groups(steps: ToolEntry[]) {
    const entries: TranscriptEntry[] = [
      {
        createdAt: "2026-09-21T00:00:00.000Z",
        error: null,
        id: "run-now",
        kind: "run",
        replyMessageId: null,
        runId: session([notes]).runId,
        status: "running",
      },
      ...steps,
    ];
    return groupTranscriptEntries(entries);
  }
  function now(steps: ToolEntry[], machines: MachineSummary[]) {
    const turn = groups(steps).find((group) => group.kind === "turn");
    if (turn?.kind !== "turn") throw new Error("Expected a live turn");
    return computerUseNow(turn.turn, machines);
  }

  it("shows a whole display session with the Run and session that Stop ends", () => {
    const held = displaySession();
    const device = phone({ computerUse: report("ready", { sessions: [held] }) });
    const current = now([step("phone")], [device]);
    expect(current).toMatchObject({
      action: "Tapping",
      kind: "phone",
      machine: device,
      place: "On Pixel",
      session: held,
    });
    if (!current) throw new Error("Expected the phone line");
    expect(computerUseNowSummary(current)).toBe("Using Pixel");
    expect(threadComputerUseNow(groups([step("phone")]), [device])).toEqual(current);
    expect(
      now([step("phone", { output: { text: "Looked at Pixel" }, state: "done" })], [device]),
    ).toMatchObject({ action: "Using", place: "On Pixel" });
    const observing = step("phone");
    if (!observing.integration) throw new Error("Expected a phone subject");
    expect(
      now([{ ...observing, integration: { ...observing.integration, effect: "read" } }], [device]),
    ).toMatchObject({ action: "Looking", place: "On Pixel" });
    expect(
      now([step("phone")], [phone({ status: "offline", computerUse: device.computerUse })]),
    ).toBeNull();
    expect(
      now(
        [step("phone")],
        [
          phone({
            computerUse: report("ready", {
              sessions: [
                { ...held, runId: RunIdSchema.parse("run_00000000-0000-4000-8000-000000000002") },
              ],
            }),
          }),
        ],
      ),
    ).toBeNull();
    expect(now([step("phone")], [phone({ computerUse: report("ready") })])).toBeNull();
  });

  it("keeps Mac action, place and summary wording unchanged and follows the latest device", () => {
    const desktop = machine({
      computerUse: report("ready", { sessions: [session([notes, calendar])] }),
    });
    const device = phone({ computerUse: report("ready", { sessions: [displaySession()] }) });
    const current = now([step("app")], [desktop, device]);
    expect(current).toMatchObject({
      action: "Typing in Notes",
      app: "Notes",
      kind: "app",
      place: "On Studio · also using Calendar",
    });
    if (!current) throw new Error("Expected the Mac line");
    expect(computerUseNowSummary(current)).toBe("Using Notes on Studio");
    expect(now([step("app"), step("phone", { id: "phone-now" })], [desktop, device])).toMatchObject(
      { kind: "phone", machine: device, session: displaySession() },
    );
    expect(now([step("phone"), step("app", { id: "app-now" })], [desktop, device])).toMatchObject({
      kind: "app",
      machine: desktop,
    });
  });
});

describe("computerUseView", () => {
  it("is null for a computer that never described computer use and has no apps", () => {
    expect(
      computerUseView({
        connections: [],
        definitions: [gui()],
        hostConnected: true,
        machine: machine({}),
      }),
    ).toBeNull();
  });

  it("lists one row per approved app, sorted by name, with in-use from any session", () => {
    const view = computerUseView({
      connections: [
        connection("con_1", notes, "read-write"),
        connection("con_2", calendar, "read"),
        // A revoked connection is not an approved app.
        { ...connection("con_3", notes, "read"), status: "revoked" },
        // Another Mac's approval is not this Mac's.
        {
          ...connection("con_4", calendar, "read"),
          computer: { access: "read", app: calendar, runnerId: "rnr_2" },
        } as unknown as IntegrationConnectionSummary,
      ],
      definitions: [gui()],
      hostConnected: true,
      machine: machine({
        computerUse: report("ready", { sessions: [session([notes])] }),
      }),
    });
    expect(view?.apps.map((row) => [row.identity.displayName, row.access, row.inUse])).toEqual([
      ["Calendar", "read", false],
      ["Notes", "read-write", true],
    ]);
    expect(view?.sessions).toHaveLength(1);
  });

  it("keeps approvals but clears reported activity when the Mac goes offline", () => {
    const view = computerUseView({
      connections: [connection("con_1", notes, "read-write")],
      definitions: [gui()],
      hostConnected: true,
      machine: machine({
        computerUse: report("ready", { sessions: [session([notes])] }),
        status: "offline",
      }),
    });
    expect(view?.apps.map((row) => [row.identity.displayName, row.inUse])).toEqual([
      ["Notes", false],
    ]);
    expect(view?.sessions).toEqual([]);
    expect(view && computerUseStatusLine(view, studio)).toBe("Studio is offline.");
  });

  it("does not show cached activity when the Host is disconnected", () => {
    const view = computerUseView({
      connections: [connection("con_1", notes, "read-write")],
      definitions: [gui()],
      hostConnected: false,
      machine: machine({ computerUse: report("ready", { sessions: [session([notes])] }) }),
    });
    expect(view?.apps[0]?.inUse).toBe(false);
    expect(view?.sessions).toEqual([]);
  });

  it("marks a blocked app and lists it after the apps agents can use", () => {
    const view = computerUseView({
      connections: [
        {
          ...connection("con_1", calendar, "read-write"),
          computer: {
            access: "read-write",
            app: calendar,
            blockedAt: "2026-09-21T00:00:00.000Z",
            policyRevision: 1,
            runnerId: mac,
          },
          status: "paused",
        } as unknown as IntegrationConnectionSummary,
        connection("con_2", notes, "read"),
      ],
      definitions: [gui()],
      hostConnected: true,
      machine: machine({ computerUse: report("ready", { appApproval: "automatic" }) }),
    });
    expect(view?.appApproval).toBe("automatic");
    expect(view?.apps.map((row) => [row.identity.displayName, row.blocked])).toEqual([
      ["Notes", false],
      ["Calendar", true],
    ]);
    expect(view && computerUseStatusLine(view, studio)).toBe("1 app approved.");
  });

  it("shows pending approvals for this Mac and this definition only", () => {
    const view = computerUseView({
      connections: [],
      definitions: [gui()],
      hostConnected: true,
      machine: machine({ computerUse: report("ready") }),
      setupRequests: [
        setupRequest({ app: calendar }),
        setupRequest({ app: notes, runnerId: "rnr_2" as ComputerAppSetupRequest["runnerId"] }),
        setupRequest({ app: null, definitionId: "apple-messages" }),
        // Turning automatic approval on is a question about the Mac, not an app.
        setupRequest({
          access: "read-write",
          app: null,
          id: "00000000-0000-4000-8000-000000000002",
          kind: "policy",
          policyAppApproval: "automatic",
        }),
      ],
    });
    expect(view?.pending.map((entry) => entry.identity.displayName)).toEqual(["Calendar"]);
  });

  it("leaves the GUI definition out of the generic app rows", () => {
    expect(
      computerAppRows({
        connections: [connection("con_1", notes, "read")],
        definitions: [gui()],
        machine: machine({ apps: [{ definitionId: "macos-app", operations: [] }] }),
      }),
    ).toEqual([]);
  });
});

describe("computerUseState", () => {
  it("orders missing grants as the page and System Settings do", () => {
    expect(
      computerUseState(
        machine({
          computerUse: report("permission-required", {
            permissions: { accessibility: "denied", screenRecording: "denied" },
          }),
        }),
      ),
    ).toEqual({
      kind: "permission-required",
      missing: ["screen-recording", "accessibility"],
      permissions: { accessibility: "denied", screenRecording: "denied" },
    });
  });
});

describe("where the viewer is", () => {
  const unavailable = (detail: string | null) =>
    computerUseView({
      connections: [],
      definitions: [gui()],
      hostConnected: true,
      machine: machine({ computerUse: report("unavailable", { detail, permissions: null }) }),
    })!;

  it("keeps the Host's reason on the Mac and names the Mac everywhere else", () => {
    const detail = "Computer use needs the Opensteer desktop app on this Mac.";
    expect(computerUseStatusLine(unavailable(detail), { here: true, machineName: "Studio" })).toBe(
      detail,
    );
    expect(computerUseStatusLine(unavailable(detail), studio)).toBe(
      "Computer use needs the Opensteer desktop app on Studio.",
    );
    expect(
      computerUseStatusLine(
        unavailable("The Opensteer desktop app is not running on this Mac."),
        studio,
      ),
    ).toBe("The Opensteer desktop app is not running on Studio.");
  });
});

describe("the block's presentation", () => {
  const base: ComputerUseView = {
    appApproval: "ask",
    approvalKeyId: `sha256:${"A".repeat(43)}`,
    apps: [],
    definition: gui(),
    pending: [],
    sessions: [],
    state: { kind: "ready" },
  };
  const row = (blocked: boolean) => ({
    access: "read" as const,
    blocked,
    connectionId: "con_1",
    identity: notes,
    inUse: false,
  });

  it("gives the agent at work its own tone and everything else a quieter one", () => {
    expect(computerUseTone({ ...base, sessions: [session([notes])] })).toBe("live");
    expect(computerUseTone(base)).toBe("ready");
    expect(
      computerUseTone({
        ...base,
        state: { kind: "permission-required", missing: ["accessibility"], permissions: null },
      }),
    ).toBe("attention");
    expect(computerUseTone({ ...base, state: { kind: "offline" } })).toBe("idle");
    expect(computerUseTone({ ...base, approvalKeyId: null })).toBe("attention");
    expect(computerUseStatusLine({ ...base, approvalKeyId: null }, studio)).toBe(
      "Needs app approval setup.",
    );
  });

  it("asks the policy as a question only on a Mac with nothing in it yet", () => {
    expect(computerUseFirstRun(base)).toBe(true);
    expect(computerUseFirstRun({ ...base, appApproval: "automatic" })).toBe(false);
    expect(computerUseFirstRun({ ...base, apps: [row(false)] })).toBe(false);
    expect(computerUseFirstRun({ ...base, state: { kind: "offline" } })).toBe(false);
    expect(computerUseFirstRun({ ...base, approvalKeyId: null })).toBe(false);
  });
});

describe("a list of Macs", () => {
  it("says each Mac's state, what is live, and otherwise its policy", () => {
    expect(computerUseMachineLine(machine({ computerUse: report("ready") }), true)).toBe(
      "Ask for each app",
    );
    expect(
      computerUseMachineLine(
        machine({ computerUse: report("ready", { appApproval: "automatic" }) }),
        true,
      ),
    ).toBe("Allow any app automatically");
    expect(
      computerUseMachineLine(
        machine({
          computerUse: report("ready", {
            sessions: [session([notes]), session([notes, calendar])],
          }),
        }),
        true,
      ),
    ).toBe("Using Notes and Calendar now");
    expect(
      computerUseMachineLine(
        machine({ computerUse: report("permission-required"), status: "online" }),
        true,
      ),
    ).toBe("Needs macOS permissions");
    expect(computerUseMachineLine(machine({ computerUse: report("unavailable") }), true)).toBe(
      "Not set up",
    );
    expect(
      computerUseMachineLine(machine({ computerUse: report("ready"), status: "offline" }), true),
    ).toBe("Offline");
    expect(
      computerUseMachineLine(
        machine({ computerUse: report("ready", { sessions: [session([notes])] }) }),
        false,
      ),
    ).toBe("Status unavailable");
  });
});

/*
 * An Android phone is a computer agents use whole, through the Agent Phone
 * app on it. The ways its presentation can fail, each held by a test below:
 * - it is described as a Mac: the desktop app, app approvals, the policy;
 * - it claims access from a connection that is revoked, blocked or another
 *   computer's;
 * - it shows a task holding it while it is offline or the Host is unreachable;
 * - a session holding its whole screen reads as holding no app ("Using ");
 * - its status hides what stands in the way: a pause on the phone, setup that
 *   never finished, an approval waiting there;
 * - an access Request about it names a Mac, or this Mac, as where to approve.
 */
describe("an Android phone", () => {
  const ready = () => report("ready", { permissions: null });

  it("is never described as a Mac, and a Mac never as a phone", () => {
    expect(
      computerUseView({
        connections: [],
        definitions: [gui(), display()],
        hostConnected: true,
        machine: phone({ computerUse: ready() }),
      }),
    ).toBeNull();
    expect(
      phoneUseView({
        connections: [],
        definitions: [gui(), display()],
        hostConnected: true,
        machine: machine({ computerUse: report("ready") }),
      }),
    ).toBeNull();
  });

  it("takes its access only from its own live connection", () => {
    const view = (connections: IntegrationConnectionSummary[]) =>
      phoneUseView({
        connections,
        definitions: [gui(), display()],
        hostConnected: true,
        machine: phone({ computerUse: ready() }),
      });
    expect(view([phoneConnection("read-write")])).toMatchObject({
      access: "read-write",
      connectionId: "con_phone",
    });
    expect(
      view([
        { ...phoneConnection("read-write"), status: "revoked" },
        phoneConnection("read-write", { runnerId: mac }),
        phoneConnection("read-write", { blockedAt: "2026-09-21T00:00:00.000Z" }),
      ]),
    ).toMatchObject({ access: null, connectionId: null });
  });

  it("shows the task holding it only while it is online and the Host answers", () => {
    const held = phone({
      computerUse: report("ready", {
        displayStreamSupported: true,
        sessions: [displaySession()],
      }),
    });
    const view = (machine: MachineSummary, hostConnected: boolean) =>
      phoneUseView({
        connections: [phoneConnection("read-write")],
        definitions: [display()],
        hostConnected,
        machine,
      });
    expect(view(held, true)?.session?.threadTitle).toBe("Plan the week");
    expect(view(held, false)?.session).toBeNull();
    const away = view({ ...held, status: "offline" }, true);
    expect(away?.session).toBeNull();
    expect(away && phoneUseStatusLine(away, "Pixel")).toBe("Pixel is offline.");
  });

  it("says what stands between agents and the phone", () => {
    const base: PhoneUseView = {
      access: "read-write",
      connectionId: "con_phone",
      definition: display(),
      session: null,
      state: { kind: "ready" },
    };
    expect(phoneUseStatusLine(base, "Pixel")).toBe("Agents can see and control it.");
    expect(phoneUseStatusLine({ ...base, access: "read" }, "Pixel")).toBe("Agents can see it.");
    expect(phoneUseStatusLine({ ...base, access: null }, "Pixel")).toBe("Access is off.");
    expect(phoneUseStatusLine({ ...base, session: displaySession() }, "Pixel")).toBe("In use now.");
    expect(
      phoneUseStatusLine(
        { ...base, state: { detail: "Paused on the phone", kind: "unavailable" } },
        "Pixel",
      ),
    ).toBe("Paused on the phone");

    expect(phoneUseTone({ ...base, session: displaySession() })).toBe("live");
    expect(phoneUseTone(base)).toBe("ready");
    expect(phoneUseTone({ ...base, access: null })).toBe("idle");
    expect(phoneUseTone({ ...base, state: { kind: "offline" } })).toBe("idle");
  });

  it("reads the phone's own pause and an unreported phone from the Host's summary", () => {
    const state = (machine: MachineSummary) =>
      phoneUseView({ connections: [], definitions: [display()], hostConnected: true, machine })
        ?.state;
    expect(
      state(phone({ computerUse: report("unavailable", { detail: "Paused on the phone" }) })),
    ).toEqual({ detail: "Paused on the phone", kind: "unavailable" });
    expect(state(phone({ computerUse: null }))).toEqual({
      detail: "Waiting for the phone to report.",
      kind: "unavailable",
    });
    expect(state(phone({ computerUse: report("permission-required", { detail: null }) }))).toEqual({
      detail: "Turn on Opensteer Agent Phone in the phone’s Accessibility settings.",
      kind: "permission-required",
    });
  });

  it("offers Watch for online phones with a live display and holds their whole display", () => {
    const held = phone({
      computerUse: report("ready", {
        displayStreamSupported: true,
        sessions: [displaySession()],
      }),
    });
    expect(canWatchComputer(held)).toBe(true);
    expect(canWatchComputer({ ...held, status: "offline" })).toBe(false);
    expect(
      canWatchComputer(phone({ computerUse: report("ready", { displayStreamSupported: false }) })),
    ).toBe(false);
    expect(
      threadComputerSessions({
        hostConnected: true,
        machines: [held],
        threadId: "thr_00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual([{ machine: held, session: displaySession() }]);
    expect(
      threadComputerSessions({
        hostConnected: false,
        machines: [held],
        threadId: displaySession().threadId,
      }),
    ).toEqual([]);
    expect(
      canWatchComputer(machine({ computerUse: report("ready", { displayStreamSupported: true }) })),
    ).toBe(true);
  });

  it("calls a session that holds the whole screen what it is", () => {
    expect(computerUseSessionTitle(displaySession())).toBe("Using the whole screen");
    expect(computerUseSessionTitle(session([notes]))).toBe("Using Notes");
  });

  it("says each phone's state in a list of computers", () => {
    const line = (overrides: Partial<MachineSummary>, hostConnected = true) =>
      computerUseMachineLine(phone(overrides), hostConnected);
    expect(line({ computerUse: ready() })).toBe("Ready");
    expect(line({ computerUse: report("ready", { sessions: [displaySession()] }) })).toBe(
      "In use now",
    );
    expect(line({ computerUse: report("unavailable", { detail: "Paused on the phone" }) })).toBe(
      "Paused on the phone",
    );
    expect(line({ computerUse: report("permission-required") })).toBe("Needs Accessibility");
    expect(line({ computerUse: ready(), status: "offline" })).toBe("Offline");
    expect(line({ computerUse: ready() }, false)).toBe("Status unavailable");
  });
});

describe("where an app access Request is answered", () => {
  const machines = [
    { id: mac, name: "Studio" },
    { id: pixel, name: "Pixel" },
  ];

  it("names the Mac, or this Mac to a reader sitting at it", () => {
    expect(
      computerAppAccessApproval({
        definitionId: "macos-app",
        machines,
        onThatMac: false,
        runnerId: mac,
      }),
    ).toEqual({
      approveOn: "Approve on Studio",
      detail: "Opensteer shows the approval on Studio by itself.",
    });
    expect(
      computerAppAccessApproval({
        definitionId: "macos-app",
        machines,
        onThatMac: true,
        runnerId: mac,
      }).approveOn,
    ).toBe("Approve on this Mac");
    expect(
      computerAppAccessApproval({
        definitionId: "macos-app",
        machines: [],
        onThatMac: false,
        runnerId: mac,
      }).approveOn,
    ).toBe("Approve on that Mac");
  });

  it("says phone access can be allowed from this client", () => {
    expect(
      computerAppAccessApproval({
        definitionId: "android-phone",
        machines,
        onThatMac: true,
        runnerId: pixel,
      }),
    ).toEqual({
      approveOn: "Allow on this device",
      detail: "You can give agents access to Pixel here.",
    });
  });
});

describe("commands", () => {
  it("removes under ask and blocks under automatic", async () => {
    const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
    await takeBackComputerUseApp({ dispatch } as never, {
      appApproval: "ask",
      connectionId: "con_1",
    });
    await takeBackComputerUseApp({ dispatch } as never, {
      appApproval: "automatic",
      connectionId: "con_1",
    });
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "integration.disconnect",
      "integration.computer.app.block",
    ]);
  });

  it("refuses to report a change the Host did not make", async () => {
    const dispatch = vi.fn(async () => ({ type: "something.else" }));
    await expect(
      takeBackComputerUseApp({ dispatch } as never, { appApproval: "ask", connectionId: "c" }),
    ).rejects.toThrow("The app was not changed.");
  });
});

function gui(): IntegrationDefinitionSummary {
  return {
    adapter: "computer",
    computerApp: {
      accessLabels: { read: "Can see", readWrite: "Can see and control" },
      accessLevels: ["read", "read-write"],
      accessSummaries: { read: "See.", readWrite: "See and control." },
      kind: "gui",
      operations: [
        { effect: "read", name: "observe" },
        { effect: "write", name: "act" },
      ],
      platforms: ["darwin"],
    },
    id: "macos-app",
    name: "Computer use",
  } as unknown as IntegrationDefinitionSummary;
}

/** The Android phone's catalog definition: its whole display, named by no app. */
function display(): IntegrationDefinitionSummary {
  return {
    adapter: "computer",
    computerApp: {
      accessLabels: { read: "Can see", readWrite: "Can see and control" },
      accessLevels: ["read", "read-write"],
      accessSummaries: { read: "See.", readWrite: "See and operate." },
      kind: "display",
      operations: [
        { effect: "read", name: "observe" },
        { effect: "write", name: "act" },
        { effect: "read", name: "release" },
      ],
      platforms: ["android"],
    },
    id: "android-phone",
    name: "Android phone",
  } as unknown as IntegrationDefinitionSummary;
}

function phone(overrides: Partial<MachineSummary>): MachineSummary {
  return machine({
    device: { form: "phone", platform: "android" },
    id: pixel,
    name: "Pixel",
    ...overrides,
  });
}

function phoneConnection(
  access: "read" | "read-write",
  computer: { readonly blockedAt?: string; readonly runnerId?: string } = {},
): IntegrationConnectionSummary {
  return {
    computer: {
      access,
      app: null,
      blockedAt: null,
      policyRevision: null,
      runnerId: pixel,
      ...computer,
    },
    definitionId: "android-phone",
    id: "con_phone",
    status: "connected",
  } as unknown as IntegrationConnectionSummary;
}

function displaySession(): ComputerUseSessionSummary {
  return { ...session([]), display: true };
}

function connection(
  id: string,
  app: typeof notes,
  access: "read" | "read-write",
): IntegrationConnectionSummary {
  return {
    computer: { access, app, blockedAt: null, policyRevision: null, runnerId: mac },
    definitionId: "macos-app",
    id,
    status: "connected",
  } as unknown as IntegrationConnectionSummary;
}

function session(apps: (typeof notes)[]): ComputerUseSessionSummary {
  return {
    actionCount: 3,
    apps,
    display: false,
    openedAt: "2026-09-21T00:00:00.000Z",
    runId: "run_00000000-0000-4000-8000-000000000001",
    sessionId: "cus_00000000-0000-4000-8000-000000000001",
    threadId: "thr_00000000-0000-4000-8000-000000000001",
    threadTitle: "Plan the week",
  } as unknown as ComputerUseSessionSummary;
}

function report(
  state: "ready" | "permission-required" | "unavailable",
  extra: Partial<NonNullable<MachineSummary["computerUse"]>> = {},
): NonNullable<MachineSummary["computerUse"]> {
  return {
    displayStreamSupported: false,
    approvalKeyId: `sha256:${"A".repeat(43)}`,
    appApproval: "ask",
    detail: null,
    permissions: { accessibility: "granted", screenRecording: "granted" },
    sessions: [],
    state,
    ...extra,
  };
}

function machine(overrides: Partial<MachineSummary>): MachineSummary {
  return {
    apps: null,
    id: mac,
    name: "Studio",
    status: "online",
    ...overrides,
  } as unknown as MachineSummary;
}

function setupRequest(overrides: Partial<ComputerAppSetupRequest>): ComputerAppSetupRequest {
  return {
    access: "read-write",
    app: notes,
    createdAt: "2026-09-21T00:00:00.000Z",
    definitionDigest: "d".repeat(43),
    definitionId: "macos-app",
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    expiresAt: "2026-09-22T00:00:00.000Z",
    id: "00000000-0000-4000-8000-000000000001",
    kind: "app",
    ownerUserId: "usr_00000000-0000-4000-8000-000000000001",
    policyAppApproval: null,
    reason: null,
    runnerId: mac,
    threadId: null,
    threadTitle: null,
    workspaceId: null,
    ...overrides,
  } as ComputerAppSetupRequest;
}
