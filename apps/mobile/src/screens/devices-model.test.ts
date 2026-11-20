import type { AuthSessionSummary } from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { mockDeviceMachine, mockIphoneScreenDevice } from "@opensteer/client/mock";
import type { HomeKindFact } from "@opensteer/client/computers";
import { deviceListSections } from "./devices-model.js";

const macHome: HomeKindFact = { kind: "mac", from: "exposure", organization: null };
const common = { home: macHome, deploymentName: "Opensteer", devicesAvailable: true };
const flat = (sections: ReturnType<typeof deviceListSections>) =>
  sections.map((section) => ({
    title: section.title,
    rows: section.rows.map(({ title, detail }) => `${title} — ${detail}`),
  }));

const home = "rnr_11111111-1111-4111-8111-111111111111";
const phone = "rnr_22222222-2222-4222-8222-222222222222";
const laptop = "rnr_33333333-3333-4333-8333-333333333333";

const machine = (overrides: Partial<MachineSummary>) =>
  ({
    access: null,
    allowedModules: ["browser", "integrations"],
    apps: null,
    computerUse: null,
    device: null,
    expiresAt: null,
    lastSeenAt: null,
    modules: {},
    ownerName: null,
    ownership: "mine",
    status: "online",
    ...overrides,
  }) as MachineSummary;

const machines = [
  machine({
    allowedModules: ["agents", "browser", "shell"],
    id: "rnr_44444444-4444-4444-8444-444444444444",
    kind: "computer",
    name: "Studio Mac",
    ownership: "deployment",
  }),
  machine({
    id: laptop,
    kind: "computer",
    name: "MacBook Pro (2)",
    device: { form: "laptop", platform: "macos" },
  }),
  machine({
    id: phone,
    kind: "phone",
    name: "Alex's iPhone",
    device: { form: "phone", platform: "ios" },
  }),
  machine({
    allowedModules: ["agents", "browser", "shell"],
    device: { form: "compact", platform: "macos" },
    id: home,
    kind: "home",
    name: "Mac mini",
    ownership: "deployment",
  }),
];

const session = (overrides: Partial<Omit<AuthSessionSummary, "id">> & { readonly id?: string }) =>
  ({
    absoluteExpiresAt: "2026-12-12T00:00:00.000Z",
    createdAt: "2026-11-12T00:00:00.000Z",
    current: false,
    deviceId: null,
    deviceLabel: "Chrome on Mac",
    expiresAt: "2026-11-19T00:00:00.000Z",
    form: "computer",
    id: "ses_1",
    lastSeenAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  }) as AuthSessionSummary;

describe("Devices on the phone", () => {
  it("lists this phone and Home first, then other devices, then sessions that run nothing", () => {
    const sections = deviceListSections({
      ...common,
      here: { state: "member", runnerId: phone },
      machines: [
        ...machines,
        // Both Android: only the Host's kind marks the Agent Phone, never the shape.
        machine({
          id: "rnr_55555555-5555-4555-8555-555555555555",
          kind: "phone",
          name: "Pixel 9",
          device: { app: "opensteer", form: "phone", platform: "android" },
        }),
        mockDeviceMachine(
          machine({
            id: "rnr_66666666-6666-4666-8666-666666666666",
            kind: "agent-phone",
            name: "Pixel 7",
            device: { form: "phone", platform: "android" },
          }),
        ),
        // A Mac-driven iPhone names its Mac only as the controller, never as an Agent Phone.
        mockIphoneScreenDevice("ready"),
      ],
      noun: "iPhone",
      sessions: [
        session({
          current: true,
          deviceId: phone,
          id: "ses_here",
          deviceLabel: "Opensteer for iPhone",
        }),
        session({ id: "ses_web" }),
        session({ id: "ses_old", deviceLabel: "Opensteer for iPhone", form: "mobile" }),
      ],
    });
    expect(flat(sections)).toEqual([
      { title: "Home", rows: ["Mac mini — Home · Online"] },
      {
        title: "Devices",
        rows: [
          "Alex's iPhone — This iPhone · Online",
          "Studio Mac — Online",
          "MacBook Pro (2) — Online",
          "Pixel 9 — Online",
          "Pixel 7 — Agent Phone · Connecting…",
          "Work iPhone — iPhone Screen · through Alex’s MacBook Pro",
        ],
      },
      {
        title: "Also signed in",
        rows: ["Chrome on Mac — Signed in", "Opensteer for iPhone — Update to finish setup"],
      },
    ]);
    expect(sections[0]?.footer).toBe(
      "Your Opensteer lives on Mac mini. Agents reach your other devices through it.",
    );
    expect(sections[2]?.footer).toBe("These run nothing. Your agent can't use them.");
    expect(sections[0]?.rows.map(({ symbol }) => symbol)).toEqual(["macmini"]);
    expect(sections[1]?.rows[0]?.symbol).toBe("smartphone");
  });

  it("offers an explicit move for a phone set up with another Opensteer, never a second device row", () => {
    const sections = deviceListSections({
      ...common,
      here: { state: "elsewhere", deploymentId: "dep_home", deploymentName: "Home" },
      machines: machines.filter(({ id }) => id !== phone),
      noun: "iPhone",
      sessions: [session({ current: true, id: "ses_here", deviceLabel: "Opensteer for iPhone" })],
    });
    expect(sections[1]?.rows[0]).toMatchObject({
      title: "This iPhone",
      detail: "Set up with Home",
      opens: { kind: "use-here", elsewhere: "dep_home", elsewhereName: "Home" },
    });
    // Its own session here is the phone, not something else signed in.
    expect(sections.some((section) => section.key === "signed-in")).toBe(false);
  });

  it("leads a phone not yet set up here back into setup", () => {
    const [, first] = deviceListSections({
      ...common,
      here: { state: "needs-setup", deviceName: "Alex's iPhone" },
      machines: machines.filter(({ id }) => id !== phone),
      noun: "iPhone",
      sessions: [],
    });
    expect(first?.rows[0]).toMatchObject({
      detail: "This iPhone · Finish setting up",
      opens: { kind: "set-up" },
    });
  });

  it("shows Asleep with seen time for a sleeping Mac and names it for its screen-driven iPhone", () => {
    const now = new Date("2026-04-12T10:35:00.000Z");
    const asleepSince = "2026-04-12T10:15:00.000Z";
    const sleepingMac = {
      ...machines.find(({ name }) => name === "Studio Mac")!,
      asleepSince,
      lastSeenAt: asleepSince,
      status: "offline" as const,
    };
    const iphone = mockIphoneScreenDevice();
    const sleepingPhone = {
      ...iphone,
      phoneDisplay: {
        ...iphone.phoneDisplay!,
        control: { reason: { kind: "driver-asleep" as const }, state: "unavailable" as const },
      },
    };
    const sections = deviceListSections({
      ...common,
      here: { state: "none" },
      machines: [sleepingMac, sleepingPhone],
      noun: "iPhone",
      now,
      sessions: [],
    });
    const devices = sections.find(({ key }) => key === "devices");
    expect(devices?.rows.map(({ title, detail }) => `${title} — ${detail}`)).toEqual([
      "Studio Mac — Asleep · seen 20m",
      "Work iPhone — Asleep on Alex’s MacBook Pro",
    ]);
    expect(devices?.rows.map(({ tone }) => tone)).toEqual(["attention", undefined]);
  });

  it("shows a Mac whose person stopped agents on it as stopped, Home or not, and its iPhone too", () => {
    const now = new Date("2026-11-20T11:00:00");
    const agentsStoppedSince = new Date("2026-11-20T10:42:00").toISOString();
    const time = new Date(agentsStoppedSince).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    const stoppedHome = {
      ...machines.find(({ name }) => name === "Studio Mac")!,
      kind: "home" as const,
      agentsStoppedSince,
    };
    const iphone = mockIphoneScreenDevice();
    const stoppedPhone = {
      ...iphone,
      phoneDisplay: {
        ...iphone.phoneDisplay!,
        control: { reason: { kind: "driver-stopped" as const }, state: "unavailable" as const },
      },
    };
    const sections = deviceListSections({
      ...common,
      here: { state: "none" },
      machines: [stoppedHome, stoppedPhone],
      noun: "iPhone",
      now,
      sessions: [],
    });
    expect(
      sections.flatMap(({ rows }) => rows.map(({ title, detail }) => `${title} — ${detail}`)),
    ).toEqual([
      `Studio Mac — Stopped on Studio Mac · since ${time}`,
      "Work iPhone — Stopped on Alex’s MacBook Pro",
    ]);
  });

  it("says what kind of Home it is, for every kind the phone can tell", () => {
    const home = (fact: HomeKindFact) =>
      deviceListSections({
        ...common,
        home: fact,
        here: { state: "none" },
        machines,
        noun: "iPhone",
        sessions: [],
      })[0];
    expect(home({ kind: "mac", from: "exposure", organization: null })?.rows[0]).toMatchObject({
      title: "Mac mini",
      detail: "Home · Online",
      symbol: "macmini",
      opens: { kind: "device", machineId: "rnr_11111111-1111-4111-8111-111111111111" },
    });
    expect(home({ kind: "server", from: "exposure", organization: null })?.rows[0]).toMatchObject({
      detail: "Home · Server · Online",
      symbol: "server.rack",
    });
    const cloud = home({ kind: "cloud", from: "account", organization: null });
    expect(cloud?.rows[0]).toMatchObject({
      title: "Cloud Computer",
      detail: "Home · Always on",
      symbol: "cloud",
    });
    expect(cloud?.footer).toContain("lives on your Cloud Computer.");
    const work = home({ kind: "work", from: "account", organization: "Acme" });
    expect(work?.rows[0]).toMatchObject({ title: "Work Home", symbol: "cloud" });
    expect(work?.footer).toContain("lives on your Acme work Home.");
  });

  it("marks a Device asleep or needing an update in amber, and says which", () => {
    const sections = deviceListSections({
      ...common,
      here: { state: "none" },
      machines: [
        machines[3]!,
        machine({ id: laptop, kind: "computer", name: "Air", status: "needs-update" }),
        machine({ id: phone, kind: "computer", name: "Mini", status: "offline", lastSeenAt: null }),
      ],
      noun: "iPhone",
      sessions: [],
    });
    expect(sections[1]?.rows.map(({ detail, tone }) => [detail, tone])).toEqual([
      ["Update Opensteer on Air", "attention"],
      ["Offline", undefined],
    ]);
  });
});
