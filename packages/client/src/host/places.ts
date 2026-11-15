import type { Tab, TabId, TabKind } from "@opensteer/core";
import type { PlaceOccupant } from "@opensteer/protocol";
import { browserIdentity, displayAddress, type PlaceBrowserIdentity } from "./start-page-model.js";
import { searchText, type SearchField } from "./search.js";
import type { HostSnapshot } from "./client.js";
import type { TabDestination } from "./surfaces.js";
import type { TabStrip } from "./tab-strip.js";
export type { PlaceOccupant } from "@opensteer/protocol";

export type PlaceIcon =
  | { readonly kind: "opensteer-app" }
  | { readonly kind: "site"; readonly ref: string | null; readonly url: string | null }
  | {
      readonly kind: "app";
      readonly bundleId: string;
      readonly name: string;
      readonly machineId: string;
    }
  | { readonly kind: "phone" };

/**
 * One tab as every surface draws it: the Host's row plus what this device
 * derives for display. Any kind is closable, groupable and reopenable alike.
 */
export interface PlaceItem {
  readonly key: TabId;
  readonly tab: Tab;
  readonly kind: TabKind;
  readonly destination: TabDestination;
  readonly identity: PlaceBrowserIdentity | null;
  readonly title: string;
  /** A page's host name; null for other kinds and blank pages. */
  readonly site: string | null;
  readonly icon: PlaceIcon;
  readonly device: { readonly machineId: string; readonly name: string };
  readonly occupants: readonly PlaceOccupant[];
  readonly availability: "ready" | "unavailable";
  /** Why the tab cannot be shown now, as the Host words it ("Window closed", "App stopped"). */
  readonly unavailableReason: string | null;
  readonly asleep: boolean;
}

export function placeHasAgents(place: Pick<PlaceItem, "occupants">): boolean {
  return place.occupants.length > 0;
}
/**
 * What a tab is found by: its title most (part of a word will do), then its
 * site, its group, who it browses as and the computer it is on.
 */
export function placeSearchFields(place: PlaceItem, groupTitle: string | null): SearchField[] {
  return [
    { text: searchText(place.title), weight: 1, inside: true, name: "title" },
    { text: searchText(place.site ? displayAddress(place.site) : ""), weight: 0.8, name: "site" },
    { text: searchText(groupTitle ?? ""), weight: 0.6, name: "group" },
    {
      text: searchText(place.identity?.name ?? place.tab.appName ?? ""),
      weight: 0.5,
      name: "profile",
    },
    { text: searchText(place.device.name), weight: 0.5, name: "computer" },
  ];
}

export type PlaceListSource = Pick<HostSnapshot, "tabs" | "browserProfiles">;
export function samePlaceListSource(a: PlaceListSource, b: PlaceListSource): boolean {
  return a.tabs === b.tabs && a.browserProfiles === b.browserProfiles;
}

function siteOf(url: string | undefined): string | null {
  if (!url || url === "about:blank") return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
function fallbackTitle(tab: Tab): string {
  switch (tab.kind) {
    case "page":
      return siteOf(tab.url) ?? "New tab";
    case "window":
      return tab.appName ?? "Window";
    case "phone":
      return tab.computer.name || "Phone";
    case "app":
      return "App";
  }
}
function iconOf(tab: Tab): PlaceIcon {
  switch (tab.kind) {
    case "page":
      return { kind: "site", ref: tab.iconRef ?? null, url: tab.url ?? null };
    case "window":
      return {
        kind: "app",
        bundleId: tab.bundleId ?? "",
        name: tab.appName ?? "",
        machineId: tab.computer.computerId,
      };
    case "phone":
      return { kind: "phone" };
    case "app":
      return { kind: "opensteer-app" };
  }
}

const places = new WeakMap<Tab, { profiles: unknown; place: PlaceItem }>();
/** The display row of one tab; the same object returns until the tab or its profile changes. */
export function placeOf(tab: Tab, profiles: HostSnapshot["browserProfiles"]): PlaceItem {
  const held = places.get(tab);
  const profile =
    tab.kind === "page" && tab.profile
      ? profiles.find((item) => item.id === tab.profile!.profileId)
      : undefined;
  if (held && held.profiles === profile) return held.place;
  let identity: PlaceBrowserIdentity | null = null;
  if (tab.kind === "page") {
    identity = browserIdentity(tab.profile?.profileId ?? null, profiles);
    // A deleted or unread profile keeps the name the tab recorded.
    if (identity.kind === "profile" && !profile && tab.profile)
      identity = { ...identity, name: tab.profile.name };
  }
  const unavailable = tab.state === "unavailable";
  const place: PlaceItem = {
    key: tab.tabId,
    tab,
    kind: tab.kind,
    destination: { kind: "tab", tabId: tab.tabId },
    identity,
    title: tab.title.trim() || fallbackTitle(tab),
    site: tab.kind === "page" ? siteOf(tab.url) : null,
    icon: iconOf(tab),
    device: { machineId: tab.computer.computerId, name: tab.computer.name },
    occupants: tab.usedBy.map((holder) => ({
      threadId: holder.taskId,
      holding: true,
      acting: false,
      lastActiveAt: tab.updatedAt,
    })),
    availability: unavailable ? "unavailable" : "ready",
    unavailableReason: unavailable ? (tab.unavailableReason ?? "Unavailable") : null,
    asleep: tab.state === "asleep",
  };
  places.set(tab, { profiles: profile, place });
  return place;
}

const lists = new WeakMap<TabStrip, { rows: unknown; profiles: unknown; list: PlaceItem[] }>();
/** Every known tab in the one layout order. */
export function placeList(source: PlaceListSource): readonly PlaceItem[] {
  const strip = source.tabs.strip;
  const held = lists.get(strip);
  if (held && held.rows === source.tabs.rows && held.profiles === source.browserProfiles)
    return held.list;
  const next = strip.ordered.flatMap((id) => {
    const tab = source.tabs.get(id);
    return tab ? [placeOf(tab, source.browserProfiles)] : [];
  });
  const list =
    held && held.list.length === next.length && next.every((place, i) => place === held.list[i])
      ? held.list
      : next;
  lists.set(strip, { rows: source.tabs.rows, profiles: source.browserProfiles, list });
  return list;
}
export function placeByKey(source: PlaceListSource, key: string): PlaceItem | undefined {
  const tab = source.tabs.get(key as TabId);
  return tab ? placeOf(tab, source.browserProfiles) : undefined;
}

/**
 * Whether a destination is gone from this device's list. A tab still listed
 * is not ended, whatever its state: an unavailable tab says why instead.
 */
export function placeDestinationEnded(
  source: Pick<HostSnapshot, "tabs">,
  destination: TabDestination,
): boolean {
  return source.tabs.complete && !source.tabs.get(destination.tabId as TabId);
}
