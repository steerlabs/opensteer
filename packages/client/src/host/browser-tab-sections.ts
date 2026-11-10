import type { MachineSummary } from "@opensteer/protocol";
import { computerGlyph, orderDevices, type ComputerGlyph } from "../computers/computers.js";
import type { BrowserTabStrip, BrowserTabStripRow } from "./browser-tab-strip.js";
import type { BrowserProfileSummary, PendingBrowserTab } from "./client.js";
import type { PlaceItem } from "./places.js";

/** The device a section of the tab list is headed by. */
export interface TabSectionDevice {
  readonly glyph: ComputerGlyph;
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
}

/**
 * One device's part of the tab list: its browser tabs in the strip's order,
 * then its apps. A group that spans devices stands under each with the
 * members that run there. Opensteer Apps run on no device: theirs is the one
 * section with no device, and it comes last.
 */
export interface TabSection {
  readonly key: string;
  readonly device: TabSectionDevice | null;
  readonly web: readonly BrowserTabStripRow[];
  readonly pending: readonly PendingBrowserTab[];
  readonly native: readonly PlaceItem[];
}

export interface TabSections {
  /**
   * Whether sections wear headings: as soon as anything runs on a device other
   * than the reader's. A reader that cannot say where it is is at none of them.
   */
  readonly headed: boolean;
  readonly sections: readonly TabSection[];
  /** Openings whose device only the Host will decide; they stand above every section. */
  readonly unplaced: readonly PendingBrowserTab[];
  /** Every place in the order the sections show them. */
  readonly ordered: readonly PlaceItem[];
}

export const opensteerAppsSectionKey = "opensteer-apps";

/** The tab list as sections by device, in `orderDevices` order. */
export function browserTabSections(input: {
  readonly strip: Pick<BrowserTabStrip, "web" | "native">;
  readonly machines: readonly MachineSummary[];
  readonly hereId: string | null;
  readonly pending?: readonly PendingBrowserTab[] | undefined;
  readonly profiles?: readonly BrowserProfileSummary[] | undefined;
}): TabSections {
  const { strip, machines, hereId } = input;
  const devices = new Map<
    string,
    {
      device: TabSectionDevice;
      web: BrowserTabStripRow[];
      pending: PendingBrowserTab[];
      native: PlaceItem[];
    }
  >();
  const sectionOf = (id: string, name: string) => {
    let section = devices.get(id);
    if (!section) {
      const machine = machines.find((value) => value.id === id);
      section = {
        device: {
          glyph: machine ? computerGlyph(machine) : "computer",
          id,
          name: machine?.name ?? name,
          online: machine?.status === "online",
        },
        web: [],
        pending: [],
        native: [],
      };
      devices.set(id, section);
    }
    return section;
  };
  const sessionDevices = new Map<string, PlaceItem["device"]>();
  for (const row of strip.web) {
    if (row.kind === "place") {
      if (row.place.device) {
        sectionOf(row.place.device.machineId, row.place.device.name).web.push(row);
        if (row.place.browser) sessionDevices.set(row.place.browser.sessionId, row.place.device);
      }
      continue;
    }
    const split = new Map<string, PlaceItem[]>();
    for (const place of row.places) {
      if (!place.device) continue;
      if (place.browser) sessionDevices.set(place.browser.sessionId, place.device);
      const members = split.get(place.device.machineId) ?? [];
      members.push(place);
      split.set(place.device.machineId, members);
    }
    for (const [id, places] of split)
      sectionOf(id, places[0]!.device!.name).web.push(
        split.size === 1 ? row : { kind: "group", group: row.group, places },
      );
  }
  const apps: PlaceItem[] = [];
  for (const place of strip.native) {
    if (place.device) sectionOf(place.device.machineId, place.device.name).native.push(place);
    else apps.push(place);
  }
  const unplaced: PendingBrowserTab[] = [];
  for (const pending of input.pending ?? []) {
    const id = pendingDevice(pending, sessionDevices, input.profiles ?? []);
    if (id === null) unplaced.push(pending);
    else sectionOf(id, "Computer unavailable").pending.push(pending);
  }
  const sections: TabSection[] = orderDevices(
    [...devices.values()].map((section) => ({ ...section, ...section.device })),
    hereId,
  ).map(({ device, web, pending, native }) => ({ key: device.id, device, web, pending, native }));
  if (apps.length > 0)
    sections.push({
      key: opensteerAppsSectionKey,
      device: null,
      web: [],
      pending: [],
      native: apps,
    });
  return {
    headed: [...devices.keys()].some((id) => id !== hereId),
    sections,
    unplaced,
    ordered: sections.flatMap((section) => [
      ...section.web.flatMap((row) => (row.kind === "place" ? [row.place] : row.places)),
      ...section.native,
    ]),
  };
}

function pendingDevice(
  pending: PendingBrowserTab,
  sessions: ReadonlyMap<string, PlaceItem["device"]>,
  profiles: readonly BrowserProfileSummary[],
): string | null {
  const target = pending.target;
  if ("sessionId" in target) return sessions.get(target.sessionId)?.machineId ?? null;
  if (target.placement) return target.placement.runnerId;
  if (target.identity.kind === "guest") return null;
  const { profileId } = target.identity;
  return profiles.find(({ id }) => id === profileId)?.homeRunnerId ?? null;
}

/* ------------------------------------------------------------------------- *
 * Folded sections
 * ------------------------------------------------------------------------- */

/** Where folds are kept: the reader's own device, never the Host. */
export interface TabSectionFoldStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TabSectionFoldScope {
  readonly deploymentId: string | null;
  readonly userId: string | null;
}

function foldKey(scope: TabSectionFoldScope): string | null {
  return scope.deploymentId && scope.userId
    ? `opensteer.tab-sections-folded.v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.userId)}`
    : null;
}

/** The devices this person folded on this Deployment; every section is open by default. */
export function readFoldedTabSections(
  storage: TabSectionFoldStorage,
  scope: TabSectionFoldScope,
): ReadonlySet<string> {
  const key = foldKey(scope);
  if (!key) return new Set();
  try {
    const stored: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return new Set(
      Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === "string").slice(0, 256)
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeFoldedTabSections(
  storage: TabSectionFoldStorage,
  scope: TabSectionFoldScope,
  folded: ReadonlySet<string>,
): void {
  const key = foldKey(scope);
  if (!key) return;
  try {
    storage.setItem(key, JSON.stringify([...folded]));
  } catch {
    // A fold that did not save costs one press next time.
  }
}
