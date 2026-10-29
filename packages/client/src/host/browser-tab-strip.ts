import type { BrowserTabGroup, BrowserTabLayout } from "@opensteer/protocol";
import type { PlaceItem } from "./places.js";

export type BrowserTabStripRow =
  | {
      readonly kind: "group";
      readonly group: BrowserTabGroup;
      readonly places: readonly PlaceItem[];
    }
  | { readonly kind: "place"; readonly place: PlaceItem };
export interface BrowserTabStrip {
  readonly web: readonly BrowserTabStripRow[];
  readonly native: readonly PlaceItem[];
  readonly ordered: readonly PlaceItem[];
  readonly visible: readonly PlaceItem[];
}
const strips = new WeakMap<
  readonly PlaceItem[],
  { layout: BrowserTabLayout | undefined; strip: BrowserTabStrip }
>();

/** A group's first known member anchors its block; the catalog orders everything inside it. */
export function browserTabStrip(
  places: readonly PlaceItem[],
  layout?: BrowserTabLayout,
): BrowserTabStrip {
  const previous = strips.get(places);
  if (previous && previous.layout === layout) return previous.strip;
  const membership = new Map<string, BrowserTabGroup>();
  for (const group of layout?.groups ?? [])
    for (const id of group.tabIds) membership.set(id, group);
  const members = new Map<string, PlaceItem[]>();
  for (const place of places) {
    if (place.kind !== "browser" || place.destination.kind !== "browser") continue;
    const group = membership.get(place.destination.tabId ?? "");
    if (group) {
      const list = members.get(group.id) ?? [];
      list.push(place);
      members.set(group.id, list);
    }
  }
  const held = new Map(
    previous?.strip.web.map((row) => [row.kind === "group" ? row.group.id : row.place.key, row]),
  );
  const web: BrowserTabStripRow[] = [];
  const native: PlaceItem[] = [];
  const emitted = new Set<string>();
  for (const place of places) {
    if (place.kind !== "browser") {
      native.push(place);
      continue;
    }
    const group =
      place.destination.kind === "browser"
        ? membership.get(place.destination.tabId ?? "")
        : undefined;
    if (!group) {
      const old = held.get(place.key);
      web.push(old?.kind === "place" && old.place === place ? old : { kind: "place", place });
    } else if (!emitted.has(group.id)) {
      emitted.add(group.id);
      const list = members.get(group.id)!;
      const old = held.get(group.id);
      web.push(
        old?.kind === "group" &&
          old.group === group &&
          old.places.length === list.length &&
          old.places.every((item, i) => item === list[i])
          ? old
          : { kind: "group", group, places: list },
      );
    }
  }
  const strip = {
    web,
    native,
    ordered: [
      ...web.flatMap((row) => (row.kind === "place" ? [row.place] : row.places)),
      ...native,
    ],
    visible: [
      ...web.flatMap((row) =>
        row.kind === "place" ? [row.place] : row.group.collapsed ? [] : row.places,
      ),
      ...native,
    ],
  };
  strips.set(places, { layout, strip });
  return strip;
}
