/* Failure modes: headings appear when everything is here, or vanish for a reader that is nowhere;
 * sections reorder by status; a group spanning devices loses members or lands under one device;
 * apps sit apart from their device's tabs; openings land under the wrong device; folds leak
 * across Deployments or people. */
import { describe, expect, it } from "vitest";
import type { BrowserTabGroup, MachineSummary } from "@opensteer/protocol";
import { BrowserTabGroupIdSchema } from "@opensteer/core";
import type { BrowserTabStripRow } from "./browser-tab-strip.js";
import type { PendingBrowserTab } from "./client.js";
import type { PlaceItem } from "./places.js";
import {
  browserTabSections,
  readFoldedTabSections,
  writeFoldedTabSections,
} from "./browser-tab-sections.js";

const machine = (id: string, name: string, status: MachineSummary["status"] = "online") =>
  ({ id, name, status, device: { form: "laptop", platform: "macos" } }) as MachineSummary;
const machines = [
  machine("mini", "Mac mini"),
  machine("studio", "Studio Mac"),
  machine("imac", "Studio iMac", "offline"),
  machine("aphone", "Agent Phone"),
];
const nameOf = (id: string) => machines.find((value) => value.id === id)?.name ?? id;
const tab = (id: string, device: string): PlaceItem =>
  ({
    key: `browser:s-${device}:${id}`,
    kind: "browser",
    destination: { kind: "browser", sessionId: `s-${device}`, tabId: id },
    browser: { sessionId: `s-${device}`, opener: { kind: "you" }, documentId: null },
    device: { machineId: device, name: nameOf(device) },
  }) as unknown as PlaceItem;
const app = (id: string, device: string | null, kind: PlaceItem["kind"] = "app"): PlaceItem =>
  ({
    key: `${kind}:${id}`,
    kind,
    destination: { kind: "phone", machineId: device ?? "" },
    browser: null,
    device: device ? { machineId: device, name: nameOf(device) } : null,
  }) as unknown as PlaceItem;
const row = (place: PlaceItem): BrowserTabStripRow => ({ kind: "place", place });
const group: BrowserTabGroup = {
  id: BrowserTabGroupIdSchema.parse("btg_00000000-0000-4000-8000-000000000001"),
  title: "Trip",
  color: "blue",
  collapsed: false,
  tabIds: [],
};
const pending = (key: string, target: PendingBrowserTab["target"]): PendingBrowserTab => ({
  idempotencyKey: key,
  target,
  state: "opening",
});
const keys = (sections: ReturnType<typeof browserTabSections>) =>
  sections.sections.map((section) => section.key);

describe("tab sections by device", () => {
  it("heads sections only once something runs elsewhere, and always for a reader that is nowhere", () => {
    const strip = { web: [row(tab("a", "mini"))], native: [app("notes", "mini")] };
    const here = browserTabSections({ strip, machines, hereId: "mini" });
    expect(here.headed).toBe(false);
    expect(here.sections).toHaveLength(1);
    expect(here.sections[0]!.native).toEqual(strip.native);
    expect(browserTabSections({ strip, machines, hereId: null }).headed).toBe(true);
    // Opensteer Apps run on no device, so they never call for headings.
    const apps = { ...strip, native: [...strip.native, app("site", null, "opensteer-app")] };
    const withApps = browserTabSections({ strip: apps, machines, hereId: "mini" });
    expect(withApps.headed).toBe(false);
    expect(keys(withApps)).toEqual(["mini", "opensteer-apps"]);
    const elsewhere = browserTabSections({
      strip: { ...strip, native: [...strip.native, app("phone", "aphone", "phone")] },
      machines,
      hereId: "mini",
    });
    expect(elsewhere.headed).toBe(true);
    expect(elsewhere.sections[1]).toMatchObject({
      device: { id: "aphone", name: "Agent Phone", online: true },
    });
  });

  it("orders here first then by name, whatever is online, with each device's tabs before its apps", () => {
    const strip = {
      web: [row(tab("x", "studio")), row(tab("y", "imac")), row(tab("z", "mini"))],
      native: [app("keynote", "studio"), app("site", null, "opensteer-app"), app("notes", "mini")],
    };
    const fromStudio = browserTabSections({ strip, machines, hereId: "studio" });
    expect(keys(fromStudio)).toEqual(["studio", "mini", "imac", "opensteer-apps"]);
    expect(fromStudio.sections[2]!.device).toMatchObject({ name: "Studio iMac", online: false });
    expect(fromStudio.ordered.map((place) => place.key)).toEqual([
      "browser:s-studio:x",
      "app:keynote",
      "browser:s-mini:z",
      "app:notes",
      "browser:s-imac:y",
      "opensteer-app:site",
    ]);
    const nowhere = browserTabSections({ strip, machines, hereId: null });
    expect(keys(nowhere)).toEqual(["mini", "imac", "studio", "opensteer-apps"]);
    const offline = machines.map((value) => ({ ...value, status: "offline" as const }));
    expect(keys(browserTabSections({ strip, machines: offline, hereId: null }))).toEqual(
      keys(nowhere),
    );
  });

  it("stands a group spanning devices under each with its members there, and keeps an unsplit group's row", () => {
    const [a, b, c] = [tab("a", "mini"), tab("b", "studio"), tab("c", "mini")];
    const split: BrowserTabStripRow = { kind: "group", group, places: [a, b, c] };
    const whole: BrowserTabStripRow = {
      kind: "group",
      group: { ...group, id: BrowserTabGroupIdSchema.parse("btg_00000000-0000-4000-8000-000000000002") },
      places: [tab("d", "studio")],
    };
    const sections = browserTabSections({
      strip: { web: [row(tab("e", "studio")), split, whole], native: [] },
      machines,
      hereId: "mini",
    });
    const [mini, studio] = sections.sections;
    expect(mini!.web).toEqual([{ kind: "group", group, places: [a, c] }]);
    expect(studio!.web).toEqual([
      row(tab("e", "studio")),
      { kind: "group", group, places: [b] },
      whole,
    ]);
    expect(studio!.web[2]).toBe(whole);
  });

  it("puts an opening under the device it opens on, and one only the Host can place above them all", () => {
    const strip = { web: [row(tab("a", "studio"))], native: [] };
    const sections = browserTabSections({
      strip,
      machines,
      hereId: "mini",
      profiles: [{ id: "travel", name: "Travel", homeRunnerId: "imac" }],
      pending: [
        pending("in-session", { sessionId: "s-studio" }),
        pending("profile", { identity: { kind: "profile", profileId: "travel" } }),
        pending("chosen", {
          identity: { kind: "guest" },
          placement: { kind: "runner", runnerId: "mini" },
        }),
        pending("guest", { identity: { kind: "guest" } }),
      ],
    });
    expect(keys(sections)).toEqual(["mini", "imac", "studio"]);
    expect(sections.sections.map((section) => section.pending.map((value) => value.idempotencyKey))).toEqual([
      ["chosen"],
      ["profile"],
      ["in-session"],
    ]);
    expect(sections.unplaced.map((value) => value.idempotencyKey)).toEqual(["guest"]);
  });
});

describe("folded tab sections", () => {
  it("are kept per Deployment and person, open by default", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const alex = { deploymentId: "dep-1", userId: "alex" };
    expect(readFoldedTabSections(storage, alex).size).toBe(0);
    writeFoldedTabSections(storage, alex, new Set(["studio"]));
    expect([...readFoldedTabSections(storage, alex)]).toEqual(["studio"]);
    expect(readFoldedTabSections(storage, { ...alex, userId: "sam" }).size).toBe(0);
    expect(readFoldedTabSections(storage, { ...alex, deploymentId: "dep-2" }).size).toBe(0);
    // No reader, nothing kept for anyone.
    writeFoldedTabSections(storage, { deploymentId: "dep-1", userId: null }, new Set(["mini"]));
    expect(store.size).toBe(1);
    store.set([...store.keys()][0]!, "not json");
    expect(readFoldedTabSections(storage, alex).size).toBe(0);
  });
});
