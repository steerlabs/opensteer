/**
 * A person's saved tabs in their order, with their groups. Every function here
 * keeps each group's members adjacent, as Chrome's tab strip does; the Host
 * and every client compute the same order from the same inputs, so a tab a
 * client learns of before the Host's layout lands where the Host will put it.
 */
export interface BrowserTabArrangement {
  readonly order: readonly string[];
  /** The group of each grouped tab. */
  readonly groupOf: ReadonlyMap<string, string>;
}

/** What placing a tab that has no saved place needs to know about it. */
export interface BrowserTabOrderTab {
  readonly id: string;
  /** The tab that opened it, always in the same lineage. */
  readonly openerId: string | null;
  /** When the Host recorded the tab. */
  readonly createdAt: string;
  readonly lineageCreatedAt: string;
  /** Its place within its lineage. */
  readonly order: number;
}

/** A move as `BrowserTabMoveSchema` parses it, with plain IDs. */
export interface BrowserTabMoveInput {
  readonly item: { readonly tabIds: readonly string[] } | { readonly groupId: string };
  readonly to: {
    readonly groupId: string | null;
    readonly before: { readonly tabId: string } | { readonly groupId: string } | null;
  };
}

export type BrowserTabMoveResult =
  | { readonly ok: true; readonly arrangement: BrowserTabArrangement }
  | {
      readonly ok: false;
      readonly code: "bad_request" | "conflict" | "not_found";
      readonly message: string;
    };

/**
 * The order of `tabs`: their saved places first, then each tab without one in
 * the order it was recorded — right after the tab that opened it (after that
 * tab's group when it is grouped, and after the tabs it opened before), else
 * at the end; a member of a group already present joins the end of that
 * group, or follows its opener there. `saved` must keep groups adjacent, as
 * every write here does.
 */
export function resolveBrowserTabOrder(
  saved: readonly string[] | undefined,
  tabs: readonly BrowserTabOrderTab[],
  groupOf: ReadonlyMap<string, string>,
): string[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const order: string[] = [];
  const placed = new Set<string>();
  for (const id of saved ?? []) {
    if (!byId.has(id) || placed.has(id)) continue;
    placed.add(id);
    order.push(id);
  }
  const unplaced = tabs.filter((tab) => !placed.has(tab.id)).sort(recorded);
  for (const tab of unplaced) {
    order.splice(placeOf(order, tab, byId, groupOf), 0, tab.id);
    placed.add(tab.id);
  }
  return order;
}

function placeOf(
  order: readonly string[],
  tab: BrowserTabOrderTab,
  byId: ReadonlyMap<string, BrowserTabOrderTab>,
  groupOf: ReadonlyMap<string, string>,
): number {
  const group = groupOf.get(tab.id);
  const openerAt = tab.openerId === null ? -1 : order.indexOf(tab.openerId);
  if (group !== undefined) {
    const run = groupRun(order, group, groupOf);
    if (run) {
      if (openerAt >= 0 && groupOf.get(tab.openerId!) === group)
        return chainEnd(order, openerAt, tab.openerId, group, byId, groupOf);
      return run[1];
    }
  }
  if (openerAt < 0) return order.length;
  const openerGroup = groupOf.get(tab.openerId!);
  const after =
    openerGroup === undefined ? openerAt : groupRun(order, openerGroup, groupOf)![1] - 1;
  return chainEnd(order, after, tab.openerId, undefined, byId, groupOf);
}

/** Past the tabs right after `at` that the same opener opened, never into another group. */
function chainEnd(
  order: readonly string[],
  at: number,
  openerId: string | null,
  group: string | undefined,
  byId: ReadonlyMap<string, BrowserTabOrderTab>,
  groupOf: ReadonlyMap<string, string>,
): number {
  let index = at + 1;
  while (index < order.length) {
    const id = order[index]!;
    if (groupOf.get(id) !== group || byId.get(id)?.openerId !== openerId) break;
    index++;
  }
  return index;
}

/** Where a group's adjacent members start and end (exclusive), or null when none is present. */
function groupRun(
  order: readonly string[],
  group: string,
  groupOf: ReadonlyMap<string, string>,
): readonly [number, number] | null {
  const start = order.findIndex((id) => groupOf.get(id) === group);
  if (start < 0) return null;
  let end = start + 1;
  while (end < order.length && groupOf.get(order[end]!) === group) end++;
  return [start, end];
}

function recorded(a: BrowserTabOrderTab, b: BrowserTabOrderTab): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    Date.parse(a.lineageCreatedAt) - Date.parse(b.lineageCreatedAt) ||
    a.order - b.order ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Moves tabs (keeping their relative order) or a whole group. Tabs take the
 * destination's group, or leave theirs for the top level. Refuses rather than
 * guessing: a group never goes inside a group, an anchor must be in the
 * destination and not itself moving.
 */
export function moveBrowserTabs(
  arrangement: BrowserTabArrangement,
  move: BrowserTabMoveInput,
): BrowserTabMoveResult {
  const { order, groupOf } = arrangement;
  const target = move.to.groupId;
  const before = move.to.before;
  let moving: string[];
  if ("groupId" in move.item) {
    const group = move.item.groupId;
    moving = order.filter((id) => groupOf.get(id) === group);
    if (!moving.length) return refuse("not_found", "Tab group not found.");
    if (target !== null) return refuse("bad_request", "A tab group can't go inside a group.");
  } else {
    const at = new Map(order.map((id, index) => [id, index]));
    moving = [...new Set(move.item.tabIds)];
    if (moving.some((id) => !at.has(id)))
      return refuse("not_found", "A tab is not one of your saved tabs.");
    moving.sort((a, b) => at.get(a)! - at.get(b)!);
  }
  const moved = new Set(moving);
  if (target !== null && !order.some((id) => groupOf.get(id) === target))
    return refuse("not_found", "Tab group not found.");
  const rest = order.filter((id) => !moved.has(id));
  let index: number;
  if (before === null) {
    const run = target === null ? null : groupRun(rest, target, groupOf);
    if (target === null) index = rest.length;
    else if (run) index = run[1];
    // Every member is moving within its own group: the group stays where it was.
    else index = order.slice(0, order.indexOf(moving[0]!)).filter((id) => !moved.has(id)).length;
  } else if ("tabId" in before) {
    if (moved.has(before.tabId)) return refuse("bad_request", "A tab can't land before itself.");
    index = rest.indexOf(before.tabId);
    if (index < 0)
      return order.includes(before.tabId)
        ? refuse("bad_request", "Tabs can't land before a tab of the group that is moving.")
        : refuse("not_found", "The tab to land before is not one of your saved tabs.");
    if (groupOf.get(before.tabId) !== (target ?? undefined))
      return refuse("conflict", "The tab to land before is no longer in that place.");
  } else {
    if (target !== null)
      return refuse("bad_request", "Inside a group, tabs land before a tab, never a group.");
    if ("groupId" in move.item && move.item.groupId === before.groupId)
      return refuse("bad_request", "A group can't land before itself.");
    const run = groupRun(rest, before.groupId, groupOf);
    if (!run)
      return order.some((id) => groupOf.get(id) === before.groupId)
        ? refuse("bad_request", "Tabs can't land before the group they are all leaving.")
        : refuse("conflict", "The group to land before is no longer there.");
    index = run[0];
  }
  const nextOrder = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  if ("groupId" in move.item) return { ok: true, arrangement: { order: nextOrder, groupOf } };
  const nextGroupOf = new Map(groupOf);
  for (const id of moving) {
    if (target === null) nextGroupOf.delete(id);
    else nextGroupOf.set(id, target);
  }
  return { ok: true, arrangement: { order: nextOrder, groupOf: nextGroupOf } };
}

/**
 * Puts tabs in a group. Joining an existing group takes them to its end; a new
 * group forms where its earliest tab was, or right after the group that tab
 * leaves when it sat inside one. Tabs not in the arrangement are ignored.
 */
export function groupBrowserTabs(
  arrangement: BrowserTabArrangement,
  tabIds: readonly string[],
  groupId: string,
): BrowserTabArrangement {
  const { order, groupOf } = arrangement;
  const joining = order.filter((id) => tabIds.includes(id) && groupOf.get(id) !== groupId);
  if (!joining.length) return arrangement;
  if (order.some((id) => groupOf.get(id) === groupId)) {
    const result = moveBrowserTabs(arrangement, {
      item: { tabIds: joining },
      to: { groupId, before: null },
    });
    return result.ok ? result.arrangement : arrangement;
  }
  const joined = new Set(joining);
  const rest = order.filter((id) => !joined.has(id));
  let index = order.slice(0, order.indexOf(joining[0]!)).filter((id) => !joined.has(id)).length;
  const split = index > 0 && index < rest.length ? groupOf.get(rest[index - 1]!) : undefined;
  if (split !== undefined && groupOf.get(rest[index]!) === split)
    index = groupRun(rest, split, groupOf)![1];
  const nextGroupOf = new Map(groupOf);
  for (const id of joining) nextGroupOf.set(id, groupId);
  return {
    order: [...rest.slice(0, index), ...joining, ...rest.slice(index)],
    groupOf: nextGroupOf,
  };
}

/**
 * Takes tabs out of their groups. A whole group's tabs stay where they are;
 * some of a group's tabs go right after what remains of it.
 */
export function ungroupBrowserTabs(
  arrangement: BrowserTabArrangement,
  tabIds: readonly string[],
): BrowserTabArrangement {
  let order = [...arrangement.order];
  const groupOf = new Map(arrangement.groupOf);
  const leaving = new Set(tabIds.filter((id) => groupOf.has(id)));
  const groups = new Set([...leaving].map((id) => groupOf.get(id)!));
  for (const group of groups) {
    const members = order.filter((id) => groupOf.get(id) === group);
    const out = members.filter((id) => leaving.has(id));
    for (const id of out) groupOf.delete(id);
    if (out.length === members.length) continue;
    const rest = order.filter((id) => !out.includes(id));
    const end = groupRun(rest, group, groupOf)![1];
    order = [...rest.slice(0, end), ...out, ...rest.slice(end)];
  }
  return { order, groupOf };
}

function refuse(
  code: "bad_request" | "conflict" | "not_found",
  message: string,
): BrowserTabMoveResult {
  return { ok: false, code, message };
}
