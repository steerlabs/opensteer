import { tabFixture, tabStoreFixture } from "../test-support/tab-fixtures.js";
import type { MachineSummary } from "@opensteer/protocol";
import { BrowserProfileIdSchema, RunnerIdSchema, TabIdSchema, type Tab } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type { HostSnapshot } from "./client.js";
import {
  linkOnComputerNetwork,
  linkPlaces,
  newTabProfiles,
  newTabTarget,
  recentProfileOn,
  replyLinkTarget,
} from "./link-places.js";
import type { StartPageProfileChoice } from "./start-page-model.js";

const phone = "rnr_00000000-0000-4000-8000-000000000001";
const mini = "rnr_00000000-0000-4000-8000-000000000002";
const studio = "rnr_00000000-0000-4000-8000-000000000003";
const shopping = "bpr_00000000-0000-4000-8000-0000000000a1";
const bank = "bpr_00000000-0000-4000-8000-0000000000a2";
const work = "bpr_00000000-0000-4000-8000-0000000000a3";
const design = "bpr_00000000-0000-4000-8000-0000000000a4";
const archive = "bpr_00000000-0000-4000-8000-0000000000a5";
const profileNames: Record<string, string> = {
  [shopping]: "Shopping",
  [bank]: "Bank",
  [work]: "Work",
};

function machine(id: string, name: string, overrides: Partial<MachineSummary> = {}) {
  return {
    allowedModules: ["browser"],
    device: id === phone ? { form: "phone", platform: "ios" } : null,
    id,
    modules: { browser: { checkedAt: null, detail: null, readiness: "ready" } },
    name,
    status: "online",
    ...overrides,
  } as MachineSummary;
}

let tabs = 0;
function page(runnerId: string, profileId: string | null, updatedAt: string): Tab {
  return tabFixture({
    tabId: TabIdSchema.parse(`page-${++tabs}`),
    computer: { computerId: RunnerIdSchema.parse(runnerId), name: runnerId },
    profile: profileId
      ? {
          profileId: BrowserProfileIdSchema.parse(profileId),
          name: profileNames[profileId] ?? profileId,
        }
      : null,
    updatedAt,
  });
}

type Source = Parameters<typeof linkPlaces>[0];

function world(overrides: Partial<Source> = {}): Source {
  return {
    browserProfileHomes: [phone, mini, studio],
    browserProfiles: [
      { homeRunnerId: phone, id: shopping, name: "Shopping" },
      { homeRunnerId: phone, id: bank, name: "Bank" },
      { homeRunnerId: mini, id: work, name: "Work" },
    ],
    tabs: tabStoreFixture([]),
    machines: [machine(studio, "Studio Mac"), machine(mini, "Mac mini"), machine(phone, "iPhone")],
    ...overrides,
  };
}

describe("linkOnComputerNetwork", () => {
  it.each([
    ["http://localhost:3000/", true],
    ["http://app.localhost/", true],
    ["http://127.0.0.1:8080", true],
    ["http://0.0.0.0:5173", true],
    ["http://10.0.0.4/", true],
    ["http://172.16.0.1/", true],
    ["http://172.31.255.255/", true],
    ["http://172.32.0.1/", false],
    ["http://192.168.1.20:8000/", true],
    ["http://169.254.1.1/", true],
    ["http://100.101.102.103/", true],
    ["http://[::1]:3000/", true],
    ["http://[fd12:3456::1]/", true],
    ["http://[fe80::1]/", true],
    ["http://[::ffff:192.168.1.1]/", true],
    ["http://[::ffff:8.8.8.8]/", false],
    ["http://[2001:db8::1]/", false],
    ["http://devbox:3000/", true],
    ["http://printer.local/", true],
    ["http://nas.home.arpa/", true],
    ["https://example.com/", false],
    ["https://8.8.8.8/", false],
    ["mailto:someone@localhost", false],
  ])("%s → %s", (href, expected) => {
    expect(linkOnComputerNetwork(href)).toBe(expected);
  });
});

describe("recentProfileOn", () => {
  it("chooses the profile most recently used on that device, from its own profiles only", () => {
    const snapshot = world({
      tabs: tabStoreFixture([
        page(phone, bank, "2026-11-10T09:00:00.000Z"),
        page(phone, shopping, "2026-11-10T10:00:00.000Z"),
        // Newer, but not this device's or not a profile at all.
        page(mini, work, "2026-11-10T11:00:00.000Z"),
        page(phone, null, "2026-11-10T12:00:00.000Z"),
      ]),
    });
    expect(recentProfileOn(snapshot, phone)).toBe(shopping);
    expect(recentProfileOn(snapshot, mini)).toBe(work);
    expect(recentProfileOn(snapshot, studio)).toBeNull();
  });

  it("counts asleep tabs and breaks a tie by name", () => {
    const at = "2026-11-10T09:00:00.000Z";
    const tied = world({
      tabs: tabStoreFixture([
        page(phone, shopping, at),
        { ...page(phone, bank, at), state: "asleep" },
      ]),
    });
    expect(recentProfileOn(tied, phone)).toBe(bank);
  });
});

describe("linkPlaces", () => {
  const recent = world({
    tabs: tabStoreFixture([page(phone, shopping, "2026-11-10T10:00:00.000Z")]),
  });
  const read = (url: string, snapshot: Source = recent, hereId: string | null = phone) =>
    linkPlaces(snapshot, { conversationRunnerId: studio, hereId, url });

  it("opens a web link here, in the recent profile, and offers here, the conversation's computer, then the rest", () => {
    const places = read("https://example.com/");
    expect(places.tap).toMatchObject({
      id: phone,
      here: true,
      target: { identity: { kind: "profile", profileId: shopping } },
    });
    expect(places.hold.map(({ name }) => name)).toEqual(["iPhone", "Studio Mac", "Mac mini"]);
    expect(places.hold[1]!.target).toEqual({
      identity: { kind: "guest" },
      placement: { kind: "runner", runnerId: studio },
    });
  });

  it("opens a Guest here when no profile was used here", () => {
    expect(read("https://example.com/", world()).tap?.target).toEqual({
      identity: { kind: "guest" },
      placement: { kind: "runner", runnerId: phone },
    });
  });

  it("opens the computer's own network on the conversation's computer", () => {
    expect(read("http://localhost:3000/").tap?.id).toBe(studio);
    expect(read("http://[::1]:3000/").tap?.id).toBe(studio);
  });

  it("leaves a computer address as it was when the conversation's computer can't browse", () => {
    const away = world({
      machines: [machine(studio, "Studio Mac", { status: "offline" }), machine(phone, "iPhone")],
    });
    expect(read("http://localhost:3000/", away).tap).toBeNull();
  });

  it("leaves links as they were where this device is not one that lends a browser here", () => {
    const none = { tap: null, hold: [] };
    expect(read("https://example.com/", recent, null)).toEqual(none);
    const withoutBrowser = world({
      machines: [machine(studio, "Studio Mac"), machine(phone, "iPhone", { modules: {} })],
    });
    expect(read("https://example.com/", withoutBrowser)).toEqual(none);
    const offline = world({
      machines: [machine(studio, "Studio Mac"), machine(phone, "iPhone", { status: "offline" })],
    });
    expect(read("https://example.com/", offline)).toEqual(none);
    const notOffered = world({ browserProfileHomes: [studio, mini] });
    expect(read("https://example.com/", notOffered)).toEqual(none);
  });
});

describe("new tab", () => {
  const snapshot: Pick<HostSnapshot, "browserProfiles" | "machines" | "browserProfileHomes"> = {
    ...world(),
    browserProfiles: [
      ...world().browserProfiles,
      { homeRunnerId: studio, id: design, name: "Design" },
      { homeRunnerId: null, id: archive, name: "Archive" },
    ],
  };
  const choice = (identity: StartPageProfileChoice["identity"], name: string) =>
    ({ identity, presentation: { name } }) as StartPageProfileChoice;
  const profiles = [
    choice({ kind: "profile", profileId: work }, "Work"),
    choice({ kind: "profile", profileId: design }, "Design"),
    choice({ kind: "profile", profileId: archive }, "Archive"),
    choice({ kind: "profile", profileId: shopping }, "Shopping"),
    choice({ kind: "guest" }, "Guest"),
    choice({ kind: "profile", profileId: bank }, "Bank"),
  ];

  it("lists this device's profiles first, then each device's by name, then Guest", () => {
    expect(newTabProfiles(snapshot, profiles, phone).map((p) => p.presentation.name)).toEqual([
      "Bank",
      "Shopping",
      "Work",
      "Design",
      "Archive",
      "Guest",
    ]);
    expect(newTabProfiles(snapshot, profiles, studio).map((p) => p.presentation.name)).toEqual([
      "Design",
      "Bank",
      "Shopping",
      "Work",
      "Archive",
      "Guest",
    ]);
  });

  it("puts Guest on this device when it lends a browser, and lets the Host place it otherwise", () => {
    const guest = { kind: "guest" } as const;
    expect(newTabTarget(snapshot, guest, phone)).toEqual({
      identity: guest,
      placement: { kind: "runner", runnerId: phone },
    });
    expect(newTabTarget(snapshot, guest, null)).toEqual({ identity: guest });
    expect(newTabTarget(snapshot, profiles[0]!.identity, phone)).toEqual({
      identity: { kind: "profile", profileId: work },
    });
  });

  it("opens a reply link here, except an address on the agent's computer's own network", () => {
    const guest = { kind: "guest" } as const;
    expect(replyLinkTarget(snapshot, guest, studio, "https://example.com/a")).toEqual({
      identity: guest,
      placement: { kind: "runner", runnerId: studio },
    });
    for (const url of ["http://localhost:5173/", "http://192.168.1.20/", "http://nas.local/"])
      expect(replyLinkTarget(snapshot, guest, studio, url)).toEqual({ identity: guest });
  });
});
