import {
  CloudComputerIdSchema,
  OrganizationIdSchema,
  WorkAssignmentIdSchema,
  defaultWorkPolicy,
  type CloudComputerView,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema } from "@opensteer/core";
import {
  MachineSummarySchema,
  type DesktopWorkHome,
  type MachineSummary,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { mockDeviceMachine } from "../mock/mock-device-machine.js";
import { mockIphoneScreenDevice } from "../mock/mock-screen-devices.js";
import { cloudSuggestionQuietMs } from "./cloud-computer.js";
import { computerStatus } from "./computers.js";
import { deviceWords, homeKeptWords } from "./devices-copy.js";
import {
  asleepGateLine,
  asleepToolFailure,
  cloudSuggestionDismissed,
  cloudSuggestionShown,
  cloudSuggestionVisible,
  deviceScreenRow,
  devicesScreen,
  homeKind,
  parseCloudSuggestionMemory,
  serverHomeFacts,
  type HomeKindFact,
} from "./devices-screen.js";

const now = new Date("2026-11-20T12:00:00.000Z");
const deploymentId = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001");

function machine(id: string, patch: Partial<MachineSummary> = {}): MachineSummary {
  return mockDeviceMachine(
    MachineSummarySchema.parse({
      id,
      kind: "computer",
      name: id,
      ownership: "mine",
      allowedModules: ["browser", "shell"],
      modules: { browser: { checkedAt: null, detail: null, readiness: "ready" } },
      access: null,
      detail: null,
      enrollmentId: null,
      expiresAt: null,
      lastSeenAt: "2026-11-20T11:00:00.000Z",
      revocable: true,
      status: "online",
      ...patch,
    }),
  );
}
const home = machine("Studio Mac", {
  kind: "home",
  ownership: "deployment",
  allowedModules: ["agents", "browser", "shell"],
  revocable: false,
});
const cloudView = (patch: Partial<CloudComputerView> = {}): CloudComputerView =>
  ({
    id: CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000002"),
    egress: "assigned",
    status: "ready",
    address: "https://k7q2.home.opensteer.com",
    deploymentId,
    ...patch,
  }) as CloudComputerView;
const workHome = (organizationName: string): DesktopWorkHome => ({
  home: {
    assignment: {
      organizationId: OrganizationIdSchema.parse("org_00000000-0000-4000-8000-000000000003"),
      organizationName,
      assignmentId: WorkAssignmentIdSchema.parse("was_00000000-0000-4000-8000-000000000004"),
      computerId: CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000005"),
      state: "active",
      homeStatus: "ready",
      reason: null,
      address: "https://acme.home.opensteer.com",
      policyRevision: 1,
      appliedRevision: 1,
      policyStatus: "Applied",
      signInCut: false,
      suspended: false,
      deleted: false,
      retainUntil: null,
    },
    policy: defaultWorkPolicy,
  },
  computer: cloudView({
    id: CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000005"),
  }),
});
const kindOf = (input: Partial<Parameters<typeof homeKind>[0]>): HomeKindFact =>
  homeKind({ exposure: "loopback", deploymentId, hostedHere: false, account: null, ...input });

describe("what kind of Home this is", () => {
  it("is this Mac, or a Mac elsewhere, for a loopback Home", () => {
    expect(kindOf({ hostedHere: true })).toEqual({
      kind: "this-mac",
      from: "this-device",
      organization: null,
    });
    expect(kindOf({})).toEqual({ kind: "mac", from: "exposure", organization: null });
  });

  it("is a server for a networked Home the Account doesn't list", () => {
    expect(kindOf({ exposure: "networked" })).toEqual({
      kind: "server",
      from: "exposure",
      organization: null,
    });
    expect(
      kindOf({
        exposure: "networked",
        account: { computers: [cloudView({ deploymentId: undefined })], work: [] },
      }),
    ).toMatchObject({ kind: "server" });
  });

  it("is a Cloud Computer when the Account's view for this deployment says so", () => {
    expect(
      kindOf({ exposure: "networked", account: { computers: [cloudView()], work: [] } }),
    ).toEqual({
      kind: "cloud",
      from: "account",
      organization: null,
    });
  });

  it("takes the Home's own word for its kind, before guessing from its exposure", () => {
    expect(kindOf({ exposure: "networked", homeKind: "cloud-computer" })).toEqual({
      kind: "cloud",
      from: "home",
      organization: null,
    });
    expect(kindOf({ exposure: "networked", homeKind: "server" })).toMatchObject({
      kind: "server",
      from: "home",
    });
    expect(kindOf({ homeKind: "mac" })).toMatchObject({ kind: "mac", from: "home" });
    expect(kindOf({ homeKind: "mac", hostedHere: true })).toMatchObject({
      kind: "this-mac",
      from: "home",
    });
    // A work Home is still the Account's to say.
    expect(
      kindOf({
        exposure: "networked",
        homeKind: "cloud-computer",
        account: { computers: [], work: [{ ...workHome("Acme"), computer: cloudView() }] },
      }),
    ).toMatchObject({ kind: "work", from: "account", organization: "Acme" });
  });

  it("is a work Home from the organization's assignment or the view's work marker", () => {
    expect(
      kindOf({
        exposure: "networked",
        account: { computers: [], work: [{ ...workHome("Acme"), computer: cloudView() }] },
      }),
    ).toEqual({ kind: "work", from: "account", organization: "Acme" });
    const marked = cloudView({
      work: {
        organizationId: OrganizationIdSchema.parse("org_00000000-0000-4000-8000-000000000003"),
        organizationName: "Globex",
        assignmentId: WorkAssignmentIdSchema.parse("was_00000000-0000-4000-8000-000000000004"),
      },
    });
    expect(
      kindOf({ exposure: "networked", account: { computers: [marked], work: [] } }),
    ).toMatchObject({
      kind: "work",
      organization: "Globex",
    });
  });
});

describe("the Devices screen", () => {
  const screen = (fact: HomeKindFact, machines = [home]) =>
    devicesScreen({
      machines,
      sessions: [],
      hereId: null,
      home: fact,
      deploymentName: "Opensteer",
      devicesAvailable: true,
      now,
    });

  it("says where Opensteer lives and what kind of Home it is", () => {
    const thisMac = screen({ kind: "this-mac", from: "this-device", organization: null });
    expect(thisMac.lead).toBe(
      "Your Opensteer lives on Studio Mac. Agents reach your other devices through it.",
    );
    expect(thisMac.home).toMatchObject({
      title: "Studio Mac",
      detail: "This Mac · Home · Running",
      symbol: "laptop",
    });
    expect(screen({ kind: "mac", from: "exposure", organization: null }).home.detail).toBe(
      "Home · Online",
    );
    expect(screen({ kind: "server", from: "exposure", organization: null }).home).toMatchObject({
      detail: "Home · Server · Online",
      symbol: "server",
    });
    const cloud = screen({ kind: "cloud", from: "account", organization: null });
    expect(cloud.home).toMatchObject({
      title: "Cloud Computer",
      detail: "Home · Always on",
      symbol: "cloud",
      badge: null,
    });
    expect(cloud.lead).toContain("lives on your Cloud Computer.");
    const work = screen({ kind: "work", from: "account", organization: "Acme" });
    expect(work.home).toMatchObject({
      title: "Work Home",
      badge: "Work · Acme",
      symbol: "cloud",
    });
    expect(work.lead).toContain("lives on your Acme work Home.");
  });

  it("lists every other Device, not the Home, in the Devices section", () => {
    const view = screen({ kind: "mac", from: "exposure", organization: null }, [
      home,
      machine("MacBook Air"),
    ]);
    expect(view.devices.map(({ title }) => title)).toEqual(["MacBook Air"]);
  });
});

describe("a Device's row", () => {
  const row = (target: MachineSummary) =>
    deviceScreenRow(target, { thisDevice: false, devicesAvailable: true, now });

  it("is online, then what is switched on, and says nothing of switches it can't read", () => {
    const policy = (browser: boolean, reach: "owner" | "nobody") =>
      ({
        activeSessions: [],
        ownerReachAvailable: true,
        revision: 1,
        policy: { apps: false, browser, reach, commands: true, forwarding: true, shares: [] },
      }) as unknown as MachineSummary["access"];
    expect(row(machine("MacBook Air", { access: policy(true, "owner") }))).toMatchObject({
      detail: "Online · Browser · Files and commands",
      tone: "online",
    });
    expect(row(machine("MacBook Air", { access: policy(false, "nobody") })).detail).toBe("Online");
    expect(row(machine("MacBook Air", { access: null })).detail).toBe("Online");
  });

  it("is asleep, with when it was seen", () => {
    expect(
      row(machine("MacBook Air", { status: "offline", asleepSince: "2026-11-20T10:00:00.000Z" })),
    ).toMatchObject({
      detail: expect.stringMatching(/^Asleep · seen /u),
      tone: "asleep",
    });
    expect(
      row(
        machine("MacBook Air", {
          status: "offline",
          asleepSince: "2026-11-20T10:00:00.000Z",
          lastSeenAt: null,
        }),
      ).detail,
    ).toMatch(/^Asleep · seen /u);
  });

  it("is offline, with when it was seen, or plainly offline", () => {
    expect(row(machine("MacBook Air", { status: "offline" }))).toMatchObject({
      detail: expect.stringMatching(/^Offline · seen /u),
      tone: "offline",
    });
    expect(row(machine("MacBook Air", { status: "offline", lastSeenAt: null })).detail).toBe(
      "Offline",
    );
  });

  it("asks for an update by name", () => {
    expect(row(machine("MacBook Air", { status: "needs-update" }))).toEqual(
      expect.objectContaining({ detail: "Update Opensteer on MacBook Air", tone: "attention" }),
    );
  });

  it("names the Mac an iPhone's screen goes through", () => {
    const phone = mockIphoneScreenDevice("ready");
    expect(row(phone).detail).toBe(
      `iPhone Screen · through ${phone.phoneDisplay?.setup.location === "driver-mac" ? phone.phoneDisplay.setup.driverRunnerName : ""}`,
    );
    expect(row(mockIphoneScreenDevice("driver-offline")).tone).toBe("offline");
  });

  it("keeps the Mac's own words when agents were stopped on it", () => {
    expect(
      row(machine("MacBook Air", { agentsStoppedSince: "2026-11-20T11:30:00.000Z" })).detail,
    ).toMatch(/^Stopped on MacBook Air · since /u);
  });

  it("shares its status words with computerStatus", () => {
    const asleep = machine("MacBook Air", {
      status: "offline",
      asleepSince: "2026-11-20T10:00:00.000Z",
    });
    expect(computerStatus(asleep, now).label).toBe(row(asleep).detail);
    expect(computerStatus(machine("x", { status: "offline", lastSeenAt: null }), now).label).toBe(
      deviceWords("devices.status.offlineNow"),
    );
  });
});

describe("the asleep moment", () => {
  const day = 86_400_000;
  const at = now.getTime();

  it("appears only for a Mac Home: never a Cloud Computer, a server or a work Home", () => {
    for (const kind of ["mac", "this-mac"] as const)
      expect(
        cloudSuggestionVisible({ homeKind: kind, memory: null, moment: "gate:1", now: at }),
      ).toBe(true);
    for (const kind of ["cloud", "server", "work", null] as const)
      expect(
        cloudSuggestionVisible({ homeKind: kind, memory: null, moment: "gate:1", now: at }),
      ).toBe(false);
    expect(asleepGateLine({ macName: "Studio Mac", homeKind: "mac" })).toBe(
      "Studio Mac isn’t reachable. It may be asleep or offline. Agents can’t use it until it’s back.",
    );
    expect(asleepGateLine({ macName: "Studio Mac", homeKind: "cloud" })).toBeNull();
    expect(asleepGateLine({ macName: "Studio Mac", homeKind: "server" })).toBeNull();
    expect(asleepGateLine({ macName: "Studio Mac", homeKind: "work" })).toBeNull();
  });

  it("shows at most once in 14 days, staying with the moment it first showed in", () => {
    const shown = cloudSuggestionShown(null, "gate:1", at);
    expect(cloudSuggestionShown(shown, "gate:1", at + day)).toBe(shown);
    expect(
      cloudSuggestionVisible({ homeKind: "mac", memory: shown, moment: "gate:1", now: at + day }),
    ).toBe(true);
    expect(
      cloudSuggestionVisible({
        homeKind: "mac",
        memory: shown,
        moment: "tool:7",
        now: at + 13 * day,
      }),
    ).toBe(false);
    expect(
      cloudSuggestionVisible({
        homeKind: "mac",
        memory: shown,
        moment: "tool:7",
        now: at + cloudSuggestionQuietMs,
      }),
    ).toBe(true);
  });

  it("goes with Not now, and stays quiet for 14 days after", () => {
    const dismissed = cloudSuggestionDismissed("gate:1", at);
    expect(
      cloudSuggestionVisible({
        homeKind: "mac",
        memory: dismissed,
        moment: "gate:1",
        now: at + 20 * day,
      }),
    ).toBe(false);
    expect(
      cloudSuggestionVisible({
        homeKind: "mac",
        memory: dismissed,
        moment: "gate:2",
        now: at + 13 * day,
      }),
    ).toBe(false);
    expect(
      cloudSuggestionVisible({
        homeKind: "mac",
        memory: dismissed,
        moment: "gate:2",
        now: at + 14 * day,
      }),
    ).toBe(true);
  });

  it("reads back only what it stored", () => {
    const memory = cloudSuggestionShown(null, "gate:1", at);
    expect(parseCloudSuggestionMemory(JSON.stringify(memory))).toEqual(memory);
    for (const text of [
      null,
      "",
      "{",
      "[]",
      JSON.stringify({ shownAt: "x", moment: "m", dismissed: false }),
    ])
      expect(parseCloudSuggestionMemory(text)).toBeNull();
  });

  it("reads the Home's computer_asleep code from a failed call, naming the Device it asked for", () => {
    const failed = (code: string, args: unknown = { computerId: "rnr_air" }) => ({
      state: "failed",
      arguments: args,
      output: {
        text: JSON.stringify({ error: { code, message: "MacBook Air is asleep.", next: null } }),
      },
    });
    const machines = [{ id: "rnr_air", name: "MacBook Air" }];
    expect(asleepToolFailure(failed("computer_asleep"), machines)).toEqual({
      device: "MacBook Air",
      line: "Couldn’t reach MacBook Air: asleep",
    });
    expect(asleepToolFailure(failed("computer_asleep", {}), machines)?.line).toBe(
      "Couldn’t reach a device: asleep",
    );
    // The Home named the Device in its refusal: that name, even when the call named none.
    const named = {
      state: "failed",
      arguments: {},
      output: {
        text: JSON.stringify({
          error: {
            code: "computer_asleep",
            message: "Device is asleep.",
            next: null,
            device: { id: "rnr_mini", name: "Studio Mac mini" },
          },
        }),
      },
    };
    expect(asleepToolFailure(named, machines)).toEqual({
      device: "Studio Mac mini",
      line: "Couldn’t reach Studio Mac mini: asleep",
    });
    expect(asleepToolFailure(failed("computer_offline"), machines)).toBeNull();
    expect(asleepToolFailure({ ...failed("computer_asleep"), state: "done" }, machines)).toBeNull();
    expect(
      asleepToolFailure({ state: "failed", arguments: {}, output: { text: "asleep" } }, machines),
    ).toBeNull();
  });
});

describe("a server Home's page", () => {
  it("shows its address, version and owner when known, and nothing it doesn't know", () => {
    expect(
      serverHomeFacts({
        publicOrigin: "https://opensteer.example.com",
        homeMachine: { runtimeVersion: "1.42.0" },
        personal: true,
      }),
    ).toEqual({
      address: { label: "Address", value: "https://opensteer.example.com" },
      version: { label: "Version", value: "1.42.0" },
      owner: "Signed in as owner",
    });
    expect(
      serverHomeFacts({
        publicOrigin: null,
        homeMachine: { runtimeVersion: null },
        personal: false,
      }),
    ).toEqual({
      address: null,
      version: null,
      owner: null,
    });
  });

  it("says who is signed in from the Home's session role, not from the deployment kind", () => {
    const facts = (role: "owner" | "member" | undefined, personal: boolean) =>
      serverHomeFacts({ publicOrigin: null, homeMachine: null, personal, role }).owner;
    expect(facts("owner", false)).toBe("Signed in as owner");
    expect(facts("member", true)).toBeNull();
    // An older Home says nothing: a personal Home has only an owner.
    expect(facts(undefined, true)).toBe("Signed in as owner");
  });
});

describe("why the Home's own device can't be removed", () => {
  it("names what the Home is, and calls only a Mac a Mac", () => {
    expect(homeKeptWords("this-mac")).toBe(
      "Your Opensteer lives on this Mac, so it can’t be removed.",
    );
    expect(homeKeptWords("mac")).toBe(homeKeptWords("this-mac"));
    expect(homeKeptWords("cloud")).toBe(
      "Your Opensteer lives on this Cloud Computer, so it can’t be removed.",
    );
    expect(homeKeptWords("work")).toBe(homeKeptWords("cloud"));
    expect(homeKeptWords("server")).toBe(
      "Your Opensteer lives on this server, so it can’t be removed.",
    );
  });
});
