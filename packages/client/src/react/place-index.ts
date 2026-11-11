import type { HostClient } from "../host/client.js";
import {
  placeList,
  samePlaceListSource,
  type PlaceItem,
  type PlaceListSource,
  type PlaceSlot,
} from "../host/places.js";

/**
 * Every reader of one client shares one place list, derived once per change
 * of its sources. Unchanged places keep their objects, and `slots` keeps its
 * array while nothing is added, removed, reordered or moved between devices.
 */
export interface PlaceIndex {
  readonly items: readonly PlaceItem[];
  readonly byKey: ReadonlyMap<string, PlaceItem>;
  readonly slots: readonly PlaceSlot[];
}

interface Held extends PlaceIndex {
  readonly source: PlaceListSource;
  readonly json: ReadonlyMap<string, string>;
  readonly slotsByKey: ReadonlyMap<string, PlaceSlot>;
}

const indexes = new WeakMap<HostClient, Held>();

export function readPlaceIndex(hostClient: HostClient): PlaceIndex {
  const source = hostClient.getSnapshot();
  const held = indexes.get(hostClient);
  if (held && samePlaceListSource(held.source, source)) return held;
  const next = derivePlaceIndex(source, held);
  indexes.set(hostClient, next);
  return next;
}

export function derivePlaceIndex(source: PlaceListSource, previous?: PlaceIndex): Held {
  const before = previous as Held | undefined;
  const byKey = new Map<string, PlaceItem>();
  const json = new Map<string, string>();
  const slotsByKey = new Map<string, PlaceSlot>();
  let itemsChanged = false;
  let slotsChanged = false;
  const items = placeList(source).map((item, index) => {
    const text = JSON.stringify(item);
    const kept = before?.json.get(item.key) === text ? before.byKey.get(item.key)! : item;
    byKey.set(item.key, kept);
    json.set(item.key, text);
    if (kept !== before?.items[index]) itemsChanged = true;
    return kept;
  });
  const slots = items.map((item, index) => {
    const held = before?.slotsByKey.get(item.key);
    const slot = held && sameSlot(held, item) ? held : placeSlot(item);
    slotsByKey.set(item.key, slot);
    if (slot !== before?.slots[index]) slotsChanged = true;
    return slot;
  });
  return {
    source,
    items: itemsChanged || items.length !== before?.items.length ? items : before.items,
    byKey,
    json,
    slots: slotsChanged || slots.length !== before?.slots.length ? slots : before.slots,
    slotsByKey,
  };
}

function placeSlot(item: PlaceItem): PlaceSlot {
  return {
    key: item.key,
    kind: item.kind,
    destination: item.destination,
    device: item.device,
    browser: item.browser ? { sessionId: item.browser.sessionId } : null,
    ...(item.workspaceTab ? { workspaceTab: { id: item.workspaceTab.id } } : {}),
  };
}

function sameSlot(slot: PlaceSlot, item: PlaceItem): boolean {
  return (
    slot.key === item.key &&
    slot.kind === item.kind &&
    (slot.destination === item.destination ||
      JSON.stringify(slot.destination) === JSON.stringify(item.destination)) &&
    slot.device?.machineId === item.device?.machineId &&
    slot.device?.name === item.device?.name &&
    slot.browser?.sessionId === item.browser?.sessionId &&
    slot.workspaceTab?.id === item.workspaceTab?.id
  );
}
