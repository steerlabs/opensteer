import type { HarnessObservedConnection, HarnessObservedUsageWindow } from "@opensteer/protocol";

/**
 * The model a reader is planning around. A reader that has one only counts
 * windows that could constrain it; a reader with none — settings, listing an
 * account rather than a route — counts every window the account reported.
 */
export interface UsageModelScope {
  readonly modelId: string;
  readonly providerId: string;
}

/**
 * The connection whose account the reader is actually working through. A
 * profile can advertise more than one slot, but only a connected one names an
 * account a person can recognise.
 */
export function observedAccountConnection(
  connections: readonly HarnessObservedConnection[],
): HarnessObservedConnection | null {
  return connections.find((connection) => connection.status === "connected") ?? null;
}

/** What a connection's last reading still says about it at a given moment. */
export interface CurrentConnectionUsage {
  /**
   * The window closest to running out — the one a reader has to plan around.
   * Null for a limit the provider stated without any window to age it by.
   */
  readonly constrainingWindow: HarnessObservedUsageWindow | null;
  readonly limitReached: boolean;
  /** The reported windows that have not yet reset, in the order reported. */
  readonly windows: readonly HarnessObservedUsageWindow[];
}

/**
 * A usage reading with time applied to it — the one place that decides what a
 * Runner's last observation still means.
 *
 * A window that has passed its reset is not a smaller number, it is no longer
 * knowledge: the provider has handed the capacity back and nobody has looked
 * since. So elapsed windows are dropped rather than aged, and `limitReached`
 * survives only while some window it could still be about remains. Null means
 * unknown, which is why nothing here ever falls back to zero used.
 */
export function currentConnectionUsage(
  connection: HarnessObservedConnection,
  now: number = Date.now(),
  model?: UsageModelScope,
): CurrentConnectionUsage | null {
  const usage = connection.usage;
  if (!usage) return null;
  const scoped = usage.windows.filter((window) => windowAppliesTo(window, model));
  const windows = scoped.filter((window) => !hasReset(window.resetsAt, now));
  const constrainingWindow = mostConstrainingWindow(windows);
  // A limit reported with no window at all has nothing to expire it, so it
  // stands as the provider's word until the next inspection replaces it.
  if (!constrainingWindow && (scoped.length > 0 || !usage.limitReached)) return null;
  return { constrainingWindow, limitReached: usage.limitReached, windows };
}

/**
 * One compact line about a connection's remaining capacity, or null when
 * nothing is currently known. Absent or elapsed usage is never rendered as
 * zero used: an engine that says nothing about its plan must read as unknown.
 */
export function describeConnectionUsage(
  connection: HarnessObservedConnection,
  now: number = Date.now(),
  model?: UsageModelScope,
): string | null {
  const usage = currentConnectionUsage(connection, now, model);
  if (!usage) return null;
  const head = usage.limitReached
    ? "Limit reached"
    : usage.constrainingWindow
      ? `${windowLabel(usage.constrainingWindow.label)} ${Math.round(usage.constrainingWindow.usedPercent)}% used`
      : null;
  if (head === null) return null;
  const resets = describeConnectionReset(connection, now, model);
  return resets === null ? head : `${head} · resets ${resets}`;
}

/**
 * When the constraining window comes back, on its own — the recovery notice
 * says it in its own sentence rather than repeating the whole usage line.
 */
export function describeConnectionReset(
  connection: HarnessObservedConnection,
  now: number = Date.now(),
  model?: UsageModelScope,
): string | null {
  const resetsAt =
    currentConnectionUsage(connection, now, model)?.constrainingWindow?.resetsAt ?? null;
  if (resetsAt === null) return null;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return null;
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    reset,
  );
  // A weekday alone stops identifying a day once it is more than a week out,
  // which a monthly window easily is.
  const withinTheWeek = reset.getTime() - now < 6 * 24 * 60 * 60 * 1_000;
  const day = new Intl.DateTimeFormat(
    undefined,
    withinTheWeek ? { weekday: "short" } : { day: "numeric", month: "short" },
  ).format(reset);
  return `${day} ${time}`;
}

/**
 * The account behind an engine and, when it is known, how much of its plan is
 * left — the one line both the model picker and the settings rows show.
 */
export function describeConnectionAccount(
  connections: readonly HarnessObservedConnection[],
  now: number = Date.now(),
): string | null {
  const connection = observedAccountConnection(connections);
  if (!connection) return null;
  const parts = [connection.accountLabel, describeConnectionUsage(connection, now)].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Whether a window says anything about the work in hand. A provider that
 * meters one model separately is describing capacity another model never
 * spends, so that window is not a reader's to plan around unless it is that
 * model they are planning. A reader with no model is describing the account
 * itself, and every window the account reported is part of that answer.
 */
function windowAppliesTo(
  window: HarnessObservedUsageWindow,
  model: UsageModelScope | undefined,
): boolean {
  const scope = window.scope;
  if (scope === undefined || scope.kind === "account" || model === undefined) return true;
  return scope.providerId === model.providerId && scope.modelId === model.modelId;
}

/**
 * A reset the clock has already passed. An unknown or unparseable reset cannot
 * be shown to have elapsed, so the reading it belongs to is kept.
 */
function hasReset(resetsAt: string | null, now: number): boolean {
  if (resetsAt === null) return false;
  const reset = new Date(resetsAt).getTime();
  return !Number.isNaN(reset) && reset <= now;
}

/** The window closest to running out is the one a reader has to plan around. */
function mostConstrainingWindow(
  windows: readonly HarnessObservedUsageWindow[],
): HarnessObservedUsageWindow | null {
  let constraining: HarnessObservedUsageWindow | null = null;
  for (const window of windows) {
    if (!constraining || window.usedPercent > constraining.usedPercent) constraining = window;
  }
  return constraining;
}

/** Provider window names are terse ("5h", "weekly"); only word labels are titled. */
function windowLabel(label: string): string {
  const first = label[0];
  if (first === undefined || !/\p{L}/u.test(first)) return label;
  return `${first.toLocaleUpperCase()}${label.slice(1)}`;
}
