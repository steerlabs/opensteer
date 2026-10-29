import { describe, expect, it } from "vitest";
import {
  computerNotReadyStatus,
  ownerViewComputerReadiness,
} from "../integrations/computer-reasons.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { HostSnapshot } from "./client.js";
import { placeList, samePlaceListSource } from "./places.js";
import {
  startPageIndex,
  startPageModel,
  startPageResults,
  detectStartPageInput,
  profileTint,
  profileBadgesVisible,
} from "./start-page-model.js";
const now = () => new Date("2026-10-19T12:00:00.000Z");
describe("start page projection", () => {
  it("joins authorized profile/computer/opener metadata and invalidates when metadata changes", () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = client.getSnapshot();
      const places = placeList(snapshot);
      const web = places.filter((place) => place.kind === "browser");
      expect(web.every((place) => place.identity && place.browser && place.device)).toBe(true);
      expect(
        new Set(
          web
            .filter((place) => place.identity?.kind === "guest")
            .map((place) => place.browser?.sessionId),
        ).size,
      ).toBeGreaterThanOrEqual(2);
      for (const key of new Set(web.map((place) => place.browser?.sessionId))) {
        const indexes = web.flatMap((place, i) => (place.browser?.sessionId === key ? [i] : []));
        expect(indexes.at(-1)! - indexes[0]! + 1).toBe(indexes.length);
      }
      expect(
        samePlaceListSource(snapshot, {
          ...snapshot,
          browserProfiles: [...snapshot.browserProfiles],
        }),
      ).toBe(false);
      expect(
        samePlaceListSource(snapshot, {
          ...snapshot,
          browserPlacements: [...snapshot.browserPlacements],
        }),
      ).toBe(false);
      const missing = placeList({ ...snapshot, browserProfiles: [] }).find(
        (place) => place.identity?.kind === "profile",
      );
      expect(missing?.identity).toMatchObject({ kind: "profile", available: false });
      expect(missing?.availability).toBe("unavailable");
      expect(profileTint("immutable")).toBe(profileTint("immutable"));
      expect(profileBadgesVisible(web)).toBe(true);
      expect(profileBadgesVisible(web.filter((place) => place.identity?.kind === "guest"))).toBe(
        false,
      );
    } finally {
      client.dispose();
    }
  });
  it("uses source identity then explicit choice then Guest; ranks explicit actions and groups local apps first", async () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      const snapshot = client.getSnapshot();
      const approved = await client.listApprovedComputerApps();
      const task = snapshot.browserSessions.find(
        (session) => session.opener?.kind === "task" && session.profileId,
      )!;
      const source = placeList(snapshot).find((place) => place.browser?.sessionId === task.id)!;
      const model = startPageModel({
        snapshot,
        approvedApps: approved,
        sourcePlace: source,
        lastChoice: { kind: "guest" },
        query: "calendar",
        localMachineId: approved[0]!.machineId,
      });
      expect(model.choice).toEqual({ kind: "profile", profileId: task.profileId });
      expect(
        model.results.some(
          (row) => row.action.kind === "open-computer-view" && row.label.startsWith("Open "),
        ),
      ).toBe(true);
      // A task holding the app gives no task view to switch to: the row opens the person's own
      // view in an independent row.
      const notes = startPageModel({ snapshot, approvedApps: approved, query: "notes" }).results;
      expect(notes[1]).toMatchObject({ kind: "app", action: { kind: "open-computer-view" } });
      expect(notes.filter((row) => row.title === "Notes")).toHaveLength(1);
      expect(model.groups[0]?.machineId).toBe(approved[0]!.machineId);
      expect(
        startPageModel({
          snapshot,
          query: "",
          lastChoice: { kind: "profile", profileId: "bpr_missing" },
        }).choice,
      ).toEqual({ kind: "profile", profileId: "bpr_missing" });
      expect(startPageModel({ snapshot, query: "" }).choice).toEqual({ kind: "guest" });
      const guest = placeList(snapshot).find(
        (place) => place.identity?.kind === "guest" && place.browser?.opener.kind === "task",
      )!;
      const explicit = { kind: "profile" as const, profileId: task.profileId! };
      expect(
        startPageModel({ snapshot, query: "", sourcePlace: guest, lastChoice: explicit }).choice,
      ).toEqual(explicit);
      // Word prefixes, not substrings: "otes" is inside "Notes" but begins no word.
      expect(
        startPageModel({ snapshot, approvedApps: approved, query: "otes" }).results.some(
          (row) => row.action.kind === "open-computer-view",
        ),
      ).toBe(false);
      // At most eight rows, including the default search.
      expect(
        startPageModel({ snapshot, approvedApps: approved, query: "a" }).results.length,
      ).toBeLessThanOrEqual(8);
      const title = source.title;
      expect(startPageModel({ snapshot, query: title }).results[0]?.action.kind).toBe("search-web");
    } finally {
      client.dispose();
    }
  });
  it("lists a computer that can't show its apps after every one that can, says why, and finds its apps last", async () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      await client.load();
      const approvedApps = await client.listApprovedComputerApps();
      const machine = (name: string) =>
        client.getSnapshot().machines.find((candidate) => candidate.name === name)!;
      const studio = machine("Studio Mac");
      const mini = machine("Mac mini");
      const pixel = machine("Pixel 7");
      const index = (snapshot = client.getSnapshot()) =>
        startPageIndex({ snapshot, approvedApps, localMachineId: mini.id });
      const groups = (snapshot?: HostSnapshot) =>
        index(snapshot).groups.map((group) => [group.label, group.readiness]);

      expect(groups()).toEqual([
        ["Mac mini", null],
        ["Studio Mac", null],
        ["Pixel 7", null],
      ]);

      // The view's own answer, before any view is asked for; the rows that open come first.
      client.setMachineStatus(studio.id, "offline");
      expect(groups()).toEqual([
        ["Mac mini", null],
        ["Pixel 7", null],
        ["Studio Mac", "offline"],
      ]);
      expect(
        index()
          .apps.filter((entry) => entry.group.machineId === studio.id)
          .every((entry) => !entry.available),
      ).toBe(true);
      expect(
        index()
          .apps.filter((entry) => entry.group.machineId !== studio.id)
          .every((entry) => entry.available),
      ).toBe(true);

      // Typing still finds the app, says why in place of what Enter does, and ranks it after
      // anything that opens — here a recent site — though never after the search.
      const keynote = startPageResults(index(), {
        query: "keynote",
        choice: { kind: "guest" },
        history: [
          {
            url: "https://keynote.example/",
            title: "",
            typedCount: 0,
            visitCount: 1,
            lastVisit: now().getTime(),
          },
        ],
      });
      expect(keynote.map((row) => [row.kind, row.title, row.label, row.available])).toEqual([
        ["search", "keynote", "Search the web · Guest", true],
        ["recent", "keynote.example", "Go to site · Guest", true],
        ["app", "Keynote", "Offline", false],
      ]);
      expect(keynote[2]).toMatchObject({
        notReady: "offline",
        action: { kind: "open-computer-view", machineId: studio.id },
      });

      // Every reason a Mac or phone gives its views, in a word or two its owner can act on.
      client.setMachineStatus(studio.id, "online");
      client.setComputerUseReadiness(studio.id, "permission-required");
      client.setMachineStatus(pixel.id, "update-pending");
      expect(groups()).toEqual([
        ["Mac mini", null],
        ["Studio Mac", "screen-recording-required"],
        ["Pixel 7", "update-pending"],
      ]);
      expect(computerNotReadyStatus("screen-recording-required")).toEqual({
        label: "Needs permission",
        tone: "attention",
      });
      expect(computerNotReadyStatus("update-pending")).toEqual({
        label: "Needs update",
        tone: "attention",
      });
      expect(computerNotReadyStatus("offline")).toEqual({ label: "Offline", tone: "away" });
      client.setComputerUseReadiness(studio.id, "unavailable");
      expect(index().groups.find((group) => group.machineId === studio.id)?.readiness).toBe(
        "native-unavailable",
      );

      // Back, each in its own place again.
      client.setComputerUseReadiness(studio.id, "ready");
      client.setMachineStatus(pixel.id, "online");
      expect(groups()).toEqual([
        ["Mac mini", null],
        ["Studio Mac", null],
        ["Pixel 7", null],
      ]);

      // Back but not yet saying what it can show — the Host's word for a computer the moment it
      // reattaches — is on its way, not out of date. Apps nobody may see are not that.
      const live = client.getSnapshot();
      const reattached = (machineId: string, apps: [] | null) => ({
        ...live,
        machines: live.machines.map((machine) =>
          machine.id === machineId
            ? {
                ...machine,
                apps,
                computerUse: machine.computerUse && {
                  ...machine.computerUse,
                  displayStreamSupported: false,
                  ownerViewVersion: undefined,
                  state: "unavailable" as const,
                },
              }
            : machine,
        ),
      });
      const readinessOf = (snapshot: HostSnapshot, machineId: string) =>
        index(snapshot).groups.find((group) => group.machineId === machineId)?.readiness;
      expect(readinessOf(reattached(studio.id, []), studio.id)).toBe("connecting");
      expect(readinessOf(reattached(pixel.id, []), pixel.id)).toBe("connecting");
      expect(readinessOf(reattached(studio.id, null), studio.id)).toBe("unsupported");
      expect(computerNotReadyStatus("connecting")).toEqual({ label: "Connecting…", tone: "away" });

      // A phone its owner paused can show nothing new, though a view already open sits it out.
      const paused = {
        ...live,
        machines: live.machines.map((machine) =>
          machine.id === pixel.id && machine.computerUse
            ? {
                ...machine,
                computerUse: {
                  ...machine.computerUse,
                  detail: "Paused on the phone",
                  state: "unavailable" as const,
                },
              }
            : machine,
        ),
      };
      expect(readinessOf(paused, pixel.id)).toBe("paused");
      expect(
        ownerViewComputerReadiness(
          paused.machines.find((machine) => machine.id === pixel.id),
          true,
        ),
      ).toBeNull();
      expect(computerNotReadyStatus("paused")).toEqual({ label: "Paused", tone: "away" });

      // Losing the Host is not the computers' doing: none folds, though none opens until it's back.
      const reconnecting = { ...client.getSnapshot(), connection: "connecting" as const };
      expect(groups(reconnecting)).toEqual([
        ["Mac mini", null],
        ["Studio Mac", null],
        ["Pixel 7", null],
      ]);
      expect(index(reconnecting).apps.some((entry) => entry.available)).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it("finds recent sites by their host's start and open tabs by any word, as the sidebar does", async () => {
    const client = new MockHostClient({ latencyMs: 0, now });
    try {
      await client.load();
      const index = startPageIndex({ snapshot: client.getSnapshot() });
      const history = [
        {
          url: "https://www.notion.so/",
          title: "",
          typedCount: 0,
          visitCount: 1,
          lastVisit: now().getTime(),
        },
      ];
      const recent = (query: string) =>
        startPageResults(index, { query, choice: { kind: "guest" }, history }).some(
          (row) => row.kind === "recent",
        );
      expect(recent("notion")).toBe(true);
      expect(recent("notion.s")).toBe(true);
      expect(recent("www.notion")).toBe(true);
      // A host is found by a word's start, never from inside one.
      expect(recent("otion")).toBe(false);
      const tab = index.places.find(
        (entry) => entry.place.kind === "browser" && entry.place.title.trim().includes(" "),
      )!.place;
      const words = tab.title.trim().split(/\s+/u);
      const switches = startPageResults(index, {
        query: [...words].reverse().join(" "),
        choice: { kind: "guest" },
      });
      expect(switches.some((row) => row.kind === "tab" && row.place?.key === tab.key)).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("distinguishes addresses from search without opening unsafe schemes", () => {
    expect(detectStartPageInput("example.com/path?q=x")).toEqual({
      kind: "url",
      url: "https://example.com/path?q=x",
    });
    expect(detectStartPageInput("localhost:3000/test")).toEqual({
      kind: "url",
      url: "http://localhost:3000/test",
    });
    expect(detectStartPageInput("two words")).toEqual({ kind: "search", query: "two words" });
    expect(detectStartPageInput("javascript:alert(1)").kind).toBe("invalid");
    expect(detectStartPageInput("https://me:secret@example.com").kind).toBe("invalid");
    expect(detectStartPageInput(" ")).toEqual({ kind: "empty" });
  });
});
