import { browserStoreFixture } from "../test-support/browser-snapshot.js";
import type { BrowserGroupRow } from "@opensteer/protocol/browser-tabs";
import type { MachineSummary } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import type { BrowserSessionSummary, HostSnapshot } from "./client.js";
import {
  linkOnComputerNetwork,
  linkPlaces,
  newTabProfiles,
  newTabTarget,
  recentProfileOn,
} from "./link-places.js";
import type { StartPageProfileChoice } from "./start-page-model.js";

const phone = "rnr_00000000-0000-4000-8000-000000000001";
const mini = "rnr_00000000-0000-4000-8000-000000000002";
const studio = "rnr_00000000-0000-4000-8000-000000000003";

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

function session(
  runnerId: string,
  profileId: string | null,
  updatedAt: string,
): BrowserSessionSummary {
  return {
    id: `bsn_${runnerId}_${profileId}_${updatedAt}`,
    placement: { kind: "runner", runnerId },
    profileId,
    updatedAt,
  } as BrowserSessionSummary;
}

type Source = Parameters<typeof linkPlaces>[0];

function world(overrides: Partial<Source> = {}): Source {
  return {
    browserProfileHomes: [phone, mini, studio],
    browserProfiles: [
      { homeRunnerId: phone, id: "bpr_shopping", name: "Shopping" },
      { homeRunnerId: phone, id: "bpr_bank", name: "Bank" },
      { homeRunnerId: mini, id: "bpr_work", name: "Work" },
    ],
    browserSessions: [],
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
      browserSessions: [
        session(phone, "bpr_bank", "2026-11-10T09:00:00.000Z"),
        session(phone, "bpr_shopping", "2026-11-10T10:00:00.000Z"),
        // Newer, but not this device's or not a profile at all.
        session(mini, "bpr_work", "2026-11-10T11:00:00.000Z"),
        session(phone, null, "2026-11-10T12:00:00.000Z"),
      ],
    });
    expect(recentProfileOn(snapshot, phone)).toBe("bpr_shopping");
    expect(recentProfileOn(snapshot, mini)).toBe("bpr_work");
    expect(recentProfileOn(snapshot, studio)).toBeNull();
  });

  it("counts saved tabs and breaks a tie by name", () => {
    const at = "2026-11-10T09:00:00.000Z";
    const tied = world({ browserSessions: [session(phone, "bpr_shopping", at)] });
    const saved = {
      ...tied,
      browserTabs: browserStoreFixture(
        [
          {
            ...session(phone, "bpr_bank", at),
            sessionId: "saved",
            id: "saved",
          } as unknown as BrowserGroupRow,
        ],
        [],
      ),
    } as unknown as Source;
    expect(recentProfileOn(saved, phone)).toBe("bpr_bank");
  });
});

describe("linkPlaces", () => {
  const recent = world({
    browserSessions: [session(phone, "bpr_shopping", "2026-11-10T10:00:00.000Z")],
  });
  const read = (url: string, snapshot: Source = recent, hereId: string | null = phone) =>
    linkPlaces(snapshot, { conversationRunnerId: studio, hereId, url });

  it("opens a web link here, in the recent profile, and offers here, the conversation's computer, then the rest", () => {
    const places = read("https://example.com/");
    expect(places.tap).toMatchObject({
      id: phone,
      here: true,
      target: { identity: { kind: "profile", profileId: "bpr_shopping" } },
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
      { homeRunnerId: studio, id: "bpr_design", name: "Design" },
      { homeRunnerId: null, id: "bpr_old", name: "Archive" },
    ],
  };
  const choice = (identity: StartPageProfileChoice["identity"], name: string) =>
    ({ identity, presentation: { name } }) as StartPageProfileChoice;
  const profiles = [
    choice({ kind: "profile", profileId: "bpr_work" }, "Work"),
    choice({ kind: "profile", profileId: "bpr_design" }, "Design"),
    choice({ kind: "profile", profileId: "bpr_old" }, "Archive"),
    choice({ kind: "profile", profileId: "bpr_shopping" }, "Shopping"),
    choice({ kind: "guest" }, "Guest"),
    choice({ kind: "profile", profileId: "bpr_bank" }, "Bank"),
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
    const guest = profiles[4]!;
    expect(newTabTarget(snapshot, guest, phone)).toEqual({
      identity: { kind: "guest" },
      placement: { kind: "runner", runnerId: phone },
    });
    expect(newTabTarget(snapshot, guest, null)).toEqual({ identity: { kind: "guest" } });
    expect(newTabTarget(snapshot, profiles[0]!, phone)).toEqual({
      identity: { kind: "profile", profileId: "bpr_work" },
    });
  });
});
