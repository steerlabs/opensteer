import type { TabGroupColor, TabId, TabLayout } from "@opensteer/core";
import type { TabOrganizeInput } from "@opensteer/protocol";
import type { TabStrip, TabStripEntry } from "@opensteer/client/host";

type BrowserTabGroupColor = TabGroupColor;
/** A drop: one tab or a whole group, into a group or the top level, before a row or at the end. */
export interface TabMove {
  readonly item: { readonly tabIds: readonly string[] } | { readonly groupId: string };
  readonly to: {
    readonly groupId: string | null;
    readonly before: { readonly tabId: string } | { readonly groupId: string } | null;
  };
}

/**
 * The tab list as drag-and-drop sees it: the visible rows in layout order,
 * every kind alike, each tab with the group it sits in.
 */
export type SortRow =
  | {
      readonly kind: "tab";
      readonly key: string;
      readonly tabId: string;
      readonly group: SortGroup | null;
    }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly groupId: string;
      readonly color: BrowserTabGroupColor;
      readonly collapsed: boolean;
    };
export interface SortGroup {
  readonly id: string;
  readonly color: BrowserTabGroupColor;
}

/**
 * Where a lifted row can land: in the gap before row `gap` of the rows left
 * behind, or onto a collapsed group's header (`onto`, that row's key). `y` is
 * where the lifted row's centre stands when it sits there.
 */
export interface SortSlot {
  readonly gap: number | null;
  readonly group: SortGroup | null;
  readonly before: { readonly tabId: string } | { readonly groupId: string } | null;
  readonly onto: string | null;
  readonly y: number;
}

/** A row's place in the list at rest: its offset top and height, and the gap below it. */
export interface SortGeometry {
  readonly boxes: readonly { readonly top: number; readonly height: number }[];
  readonly rowGap: number;
}

/**
 * Every place the row at `from` can land. A tab lands at the top level or
 * inside a group; at the foot of an expanded group it lands first inside,
 * then, half a row on, after it; onto the middle of a collapsed header it
 * joins that group. A group lands only between top-level rows. Without
 * geometry (the keyboard) every `y` is 0.
 */
export function sortSlots(
  rows: readonly SortRow[],
  from: number,
  geometry: SortGeometry | null,
): SortSlot[] {
  const lifted = rows[from]!;
  const rest = rows.filter((_, index) => index !== from);
  // Where each other row stands once the lifted row's own space closes up.
  const step = geometry ? geometry.boxes[from]!.height + geometry.rowGap : 0;
  const half = geometry ? geometry.boxes[from]!.height / 2 : 0;
  const tops = geometry
    ? rows.flatMap((_, index) =>
        index === from ? [] : [geometry.boxes[index]!.top - (index > from ? step : 0)],
      )
    : rest.map(() => 0);
  const heights = geometry
    ? rows.flatMap((_, index) => (index === from ? [] : [geometry.boxes[index]!.height]))
    : rest.map(() => 0);
  const at = (gap: number) =>
    !geometry
      ? 0
      : gap < rest.length
        ? tops[gap]! + half
        : rest.length
          ? tops[rest.length - 1]! + heights[rest.length - 1]! + geometry.rowGap + half
          : geometry.boxes[from]!.top + half;
  const collapsed = (row: SortRow | undefined) => row?.kind === "group" && row.collapsed;
  // Rows below the lifted one, in the rest's numbering, sit one place further on in `rows`.
  const below = (index: number) => index >= from;
  // A group the lifted tab alone fills is gone once it leaves: land before what follows it.
  const anchorAt = (gap: number): SortSlot["before"] => {
    const next = rest[gap];
    const emptied =
      lifted.kind === "tab" &&
      next?.kind === "group" &&
      lifted.group?.id === next.groupId &&
      !rest.some((row) => row.kind === "tab" && row.group?.id === next.groupId);
    return anchor(emptied ? rest[gap + 1] : next);
  };
  const slots: SortSlot[] = [];
  for (let gap = 0; gap <= rest.length; gap++) {
    const previous = rest[gap - 1];
    const next = rest[gap];
    if (next?.kind === "tab" && next.group) {
      if (lifted.kind === "tab")
        slots.push({
          gap,
          group: next.group,
          before: { tabId: next.tabId },
          onto: null,
          y: at(gap),
        });
      continue;
    }
    if (lifted.kind === "group") {
      slots.push({ gap, group: null, before: anchor(next), onto: null, y: at(gap) });
      continue;
    }
    // Hovering a collapsed header holds the list still, so it stands where it always stood
    // and its middle drops into it. The gap past it, where the lifted row would take the
    // header's own place, moves half a row further out; the row's own place never moves.
    const y =
      at(gap) +
      (collapsed(previous) && below(gap - 1) ? step / 2 : 0) -
      (collapsed(next) && !below(gap) ? step / 2 : 0);
    // A group's foot: after its last member, or its expanded header when no member is left.
    const foot =
      previous?.kind === "tab"
        ? previous.group
        : previous?.kind === "group" && !previous.collapsed
          ? { id: previous.groupId, color: previous.color }
          : null;
    if (foot) slots.push({ gap, group: foot, before: null, onto: null, y: y - step / 4 });
    slots.push({
      gap,
      group: null,
      before: anchorAt(gap),
      onto: null,
      y: y + (foot ? step / 4 : 0),
    });
    if (next?.kind === "group" && next.collapsed)
      slots.push({
        gap: null,
        group: { id: next.groupId, color: next.color },
        before: null,
        onto: next.key,
        y: geometry ? geometry.boxes[below(gap) ? gap + 1 : gap]!.top + heights[gap]! / 2 : 0,
      });
  }
  return slots;
}

function anchor(row: SortRow | undefined): SortSlot["before"] {
  if (!row) return null;
  return row.kind === "group" ? { groupId: row.groupId } : { tabId: row.tabId };
}

/** The slot the row already stands in. */
export function homeSlot(rows: readonly SortRow[], from: number, slots: readonly SortSlot[]) {
  const lifted = rows[from]!;
  const group = lifted.kind === "tab" ? (lifted.group?.id ?? null) : null;
  return slots.findIndex((slot) => slot.gap === from && (slot.group?.id ?? null) === group);
}

/**
 * The slot nearest the lifted row's centre `y`. Changing slots needs a margin
 * of a sixth of a row, and joining or leaving a group at its foot two fifths,
 * so a slot never flickers on its edge and a tab never slips into a group.
 */
export function nearestSlot(
  slots: readonly SortSlot[],
  current: number,
  y: number,
  rowStep: number,
): number {
  let best = current;
  for (const [index, slot] of slots.entries())
    if (Math.abs(y - slot.y) < Math.abs(y - slots[best]!.y)) best = index;
  if (best === current) return current;
  const sameGap = slots[best]!.gap !== null && slots[best]!.gap === slots[current]!.gap;
  const margin = rowStep * (sameGap ? 0.4 : 1 / 6);
  return Math.abs(y - slots[best]!.y) + margin < Math.abs(y - slots[current]!.y) ? best : current;
}

/** The move a drop on `slot` makes, or null when everything would stay where it is. */
export function slotMove(
  rows: readonly SortRow[],
  from: number,
  slots: readonly SortSlot[],
  slot: number,
): TabMove | null {
  const target = slots[slot];
  if (!target || slot === homeSlot(rows, from, slots)) return null;
  const lifted = rows[from]!;
  return {
    item: lifted.kind === "group" ? { groupId: lifted.groupId } : { tabIds: [lifted.tabId] },
    to: { groupId: target.group?.id ?? null, before: target.before },
  };
}

/**
 * The Host's organize command for a drop. A group anchor stands for its first
 * member that is not moving, which the Host reads as that group's place in
 * the top level; a whole group moves as all its members, in order, as one
 * block, and with no anchor goes to the end. A drop before a group with no
 * member left to name it cannot be said, so it moves nothing.
 */
export function organizeInput(move: TabMove, layout: TabLayout): TabOrganizeInput | null {
  const group = (groupId: string) => {
    const item = layout.items.find(
      (item) => item.kind === "group" && item.group.groupId === groupId,
    );
    return item?.kind === "group" ? item.group : undefined;
  };
  const lifted = "groupId" in move.item ? group(move.item.groupId) : undefined;
  if ("groupId" in move.item && !lifted?.tabIds.length) return null;
  const tabIds = ("tabIds" in move.item ? move.item.tabIds : (lifted?.tabIds ?? [])).map(
    (id) => id as TabId,
  );
  const before = move.to.before;
  const beforeTabId =
    before && "groupId" in before
      ? group(before.groupId)?.tabIds.find((id) => !tabIds.includes(id))
      : (before?.tabId as TabId | undefined);
  if (before && !beforeTabId) return null;
  const anchor = beforeTabId ? { beforeTabId } : {};
  if (lifted) return { tabIds, group: { groupId: lifted.groupId }, ...anchor };
  return {
    tabIds,
    group: move.to.groupId
      ? {
          groupId: move.to.groupId as Extract<
            TabOrganizeInput["group"],
            { groupId: unknown }
          >["groupId"],
        }
      : null,
    ...anchor,
  };
}

/**
 * The strip as a move leaves it, read as the Host's organize reads it: what
 * the list shows from the drop until the Host answers. A group its last tab
 * leaves stays, empty, as the Host's organize keeps it; a top-level anchor
 * stands for the block that holds it. A move whose anchor or group is gone
 * leaves the strip as it is, as the Host refuses it. Applied to the Host's
 * answer, it changes nothing.
 */
export function movedStrip(strip: TabStrip, move: TabMove): TabStrip {
  const liftedGroup =
    "groupId" in move.item
      ? strip.entries.find(
          (entry) =>
            entry.kind === "group" &&
            entry.group.groupId === (move.item as { groupId: string }).groupId,
        )
      : undefined;
  if ("groupId" in move.item && !liftedGroup) return strip;
  const tabIds = "tabIds" in move.item ? move.item.tabIds.map((tabId) => tabId as TabId) : [];
  const moving = new Set<string>(tabIds);
  const entries = strip.entries.flatMap((entry): TabStripEntry[] => {
    if (entry === liftedGroup) return [];
    if (entry.kind === "tab") return moving.has(entry.tabId) ? [] : [entry];
    if (!entry.tabIds.some((tabId) => moving.has(tabId))) return [entry];
    return [
      withMembers(
        entry,
        entry.tabIds.filter((tabId) => !moving.has(tabId)),
      ),
    ];
  });
  const before = move.to.before;
  if (liftedGroup || move.to.groupId === null) {
    const at =
      before === null
        ? entries.length
        : entries.findIndex((entry) =>
            "groupId" in before
              ? entry.kind === "group" && entry.group.groupId === before.groupId
              : entry.kind === "tab"
                ? entry.tabId === before.tabId
                : entry.tabIds.includes(before.tabId as TabId),
          );
    if (at < 0) return strip;
    entries.splice(
      at,
      0,
      ...(liftedGroup ? [liftedGroup] : tabIds.map((tabId) => ({ kind: "tab" as const, tabId }))),
    );
  } else {
    const index = entries.findIndex(
      (entry) => entry.kind === "group" && entry.group.groupId === move.to.groupId,
    );
    const target = entries[index];
    if (target?.kind !== "group" || (before !== null && !("tabId" in before))) return strip;
    const members = [...target.tabIds];
    const at = before === null ? members.length : members.indexOf(before.tabId as TabId);
    if (at < 0) return strip;
    members.splice(at, 0, ...tabIds);
    entries[index] = withMembers(target, members);
  }
  const ordered = entries.flatMap((entry) => (entry.kind === "tab" ? [entry.tabId] : entry.tabIds));
  const visible = entries.flatMap((entry) =>
    entry.kind === "tab" ? [entry.tabId] : entry.group.collapsed ? [] : entry.tabIds,
  );
  return { entries, ordered, visible };
}

/** A group's entry drawing these of its members, in this order. */
function withMembers(
  entry: Extract<TabStripEntry, { kind: "group" }>,
  tabIds: readonly TabId[],
): TabStripEntry {
  return { ...entry, tabIds };
}

/** One keyboard step to the neighbouring gap; collapsed groups are stepped over, as Chrome's are. */
export function stepSlot(
  rows: readonly SortRow[],
  from: number,
  direction: -1 | 1,
): { readonly slots: readonly SortSlot[]; readonly slot: number } | null {
  const slots = sortSlots(rows, from, null).filter((slot) => slot.onto === null);
  const target = homeSlot(rows, from, slots) + direction;
  return target >= 0 && target < slots.length ? { slots, slot: target } : null;
}

/** Where a slot is, in words, for the live region. */
export function slotWords(
  rows: readonly SortRow[],
  from: number,
  slot: SortSlot,
  title: (row: SortRow) => string,
): string {
  const rest = rows.filter((_, index) => index !== from);
  if (slot.onto !== null) {
    const target = rest.find((row) => row.key === slot.onto);
    return target ? `Into ${title(target)}` : "";
  }
  if (slot.group) {
    const id = slot.group.id;
    const inGroup = (row: SortRow) => row.kind === "tab" && row.group?.id === id;
    const header = rest.find((row) => row.kind === "group" && row.groupId === id);
    const position = rest.slice(0, slot.gap!).filter(inGroup).length + 1;
    return `In ${header ? title(header) : "the group"}, ${position} of ${rest.filter(inGroup).length + 1}`;
  }
  const next = rest[slot.gap!];
  return next ? `Before ${title(next)}` : "At the end";
}
