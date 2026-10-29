import {
  BrowserTabMoveSchema,
  type BrowserTabGroupColor,
  type BrowserTabMove,
} from "@opensteer/protocol";

/**
 * The tab list as drag-and-drop sees it: the visible rows of saved web tabs
 * in order, each tab with the group it sits in. Rows that cannot move (live
 * tabs a browser does not save) are not part of it; they follow it.
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
): BrowserTabMove | null {
  const target = slots[slot];
  if (!target || slot === homeSlot(rows, from, slots)) return null;
  const lifted = rows[from]!;
  return BrowserTabMoveSchema.parse({
    item: lifted.kind === "group" ? { groupId: lifted.groupId } : { tabIds: [lifted.tabId] },
    to: { groupId: target.group?.id ?? null, before: target.before },
  });
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
