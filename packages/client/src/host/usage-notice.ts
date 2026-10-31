import { harnessUsageLimitFailureCode, type ModelSelection } from "@opensteer/core";
import {
  currentConnectionUsage,
  describeConnectionReset,
  observedAccountConnection,
} from "./connection-usage.js";
import { placementAccountTitle, placementForSelection } from "./model-catalog.js";
import type { ThreadPlacementOption } from "./thread-placement.js";
import type { TranscriptEntry } from "./client.js";

/**
 * The one line under a composer whose AI has run out of plan capacity: which
 * engine, and when it comes back. It is information only — it never switches,
 * retries or blocks anything — so dismissing it hides it and nothing else.
 */
export interface UsageLimitNotice {
  /**
   * One limit, on one account, for one person on one Deployment. A dismissal
   * is kept under it, so a later limit — or the same account's next window —
   * is a different key and is shown again.
   */
  readonly key: string;
  /** The account, as the reader knows it: for a tooltip, never the line itself. */
  readonly accountTitle: string;
  readonly engineName: string;
  /** "Wed 1:35 AM", or null when the provider did not say. */
  readonly resetsAt: string | null;
}

export interface UsageLimitNoticeInput {
  /** The authenticated person on that Deployment, whose dismissals these are. */
  readonly scope: { readonly deploymentId: string; readonly userId: string };
  readonly placements: readonly ThreadPlacementOption[];
  /** The choice in force: a Thread's own, or a first message's. */
  readonly selection: {
    readonly environmentId: string;
    readonly harnessInstanceId: string;
    readonly modelSelection: Pick<ModelSelection, "modelId" | "providerId">;
  } | null;
  /** A Thread's transcript: a latest Run refused for want of capacity says so too. */
  readonly entries?: readonly TranscriptEntry[];
  readonly now?: number;
}

/**
 * Whether the account in force is out of capacity: its Runner's reading says
 * so for this model, or the Thread's latest Run was refused for it. A reading
 * whose window has since reset says nothing, so a limit lifts on its own.
 */
export function usageLimitNotice(input: UsageLimitNoticeInput): UsageLimitNotice | null {
  const { selection } = input;
  if (!selection) return null;
  const placement = placementForSelection(input.placements, selection);
  if (!placement) return null;
  const now = input.now ?? Date.now();
  const model = selection.modelSelection;
  const connection = observedAccountConnection(placement.observedConnections);
  const usage = connection ? currentConnectionUsage(connection, now, model) : null;
  const refusedRun = latestUsageLimitRun(input.entries ?? []);
  // A refusal from an expired window must not keep that window alive.
  const refusalExpired =
    refusedRun !== null &&
    connection !== null &&
    usage === null &&
    currentConnectionUsage(
      connection,
      Date.parse(refusedRun.endedAt ?? refusedRun.createdAt),
      model,
    )?.limitReached === true;
  // Only a reading made after the refusal can confirm that capacity is back.
  const refusalRecovered =
    refusedRun !== null &&
    usage?.limitReached === false &&
    connection?.usage !== undefined &&
    Date.parse(connection.usage.observedAt) >=
      Date.parse(refusedRun.endedAt ?? refusedRun.createdAt);
  const episode =
    usage?.limitReached === true
      ? // The window's reset names the episode; a limit stated without one is
        // known only by the reading that stated it.
        (usage.constrainingWindow?.resetsAt ?? connection?.usage?.observedAt ?? "limit")
      : refusedRun !== null && !refusalExpired && !refusalRecovered
        ? `run:${refusedRun.runId ?? refusedRun.id}`
        : null;
  if (episode === null) return null;
  return {
    accountTitle: placementAccountTitle(placement),
    engineName: placement.engineName,
    key: [
      input.scope.deploymentId,
      input.scope.userId,
      placement.environmentId,
      placement.harnessInstanceId,
      connection?.accountLabel ?? "",
      episode,
    ].join("/"),
    resetsAt: connection ? describeConnectionReset(connection, now, model) : null,
  };
}

/** The line itself, the same words on every surface. */
export function usageLimitNoticeText(notice: UsageLimitNotice): string {
  return notice.resetsAt === null
    ? `${notice.engineName} usage limit reached`
    : `${notice.engineName} usage limit · Resets ${notice.resetsAt}`;
}

/**
 * Whether the provider has refused this account more work on this model until
 * a window resets. Asks the time-aware reading, so a limit whose window has
 * since passed no longer counts.
 */
export function usageLimitReached(
  placement: Pick<ThreadPlacementOption, "observedConnections">,
  model: Pick<ModelSelection, "modelId" | "providerId">,
  now: number = Date.now(),
): boolean {
  const connection = observedAccountConnection(placement.observedConnections);
  return (
    connection !== null && currentConnectionUsage(connection, now, model)?.limitReached === true
  );
}

/** The latest Run's id when it was refused for want of capacity; any later Run clears it. */
function latestUsageLimitRun(
  entries: readonly TranscriptEntry[],
): Extract<TranscriptEntry, { kind: "run" }> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "selection") return null;
    if (entry?.kind !== "run") continue;
    return entry.status === "failed" && entry.error?.code === harnessUsageLimitFailureCode
      ? entry
      : null;
  }
  return null;
}

/**
 * Where a platform keeps dismissed notices: browser storage, a private file.
 * Either may fail; a notice that cannot be remembered as dismissed is shown.
 */
export interface UsageNoticeDismissalStorage {
  read(): readonly string[] | Promise<readonly string[]>;
  write(keys: readonly string[]): void | Promise<void>;
}

/** Old episodes are never shown again anyway, so only the latest few are worth keeping. */
const keptDismissals = 32;

export interface UsageNoticeDismissals {
  /** Null until storage has answered: nothing is shown that might already be dismissed. */
  getSnapshot(): ReadonlySet<string> | null;
  subscribe(listener: () => void): () => void;
  dismiss(key: string): void;
}

/**
 * One runtime's dismissed notices, shared by every composer on screen so
 * dismissing a notice in one hides the same notice in another.
 */
export function createUsageNoticeDismissals(
  storage: UsageNoticeDismissalStorage,
): UsageNoticeDismissals {
  let keys: readonly string[] | null = null;
  let snapshot: ReadonlySet<string> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: readonly string[]) => {
    keys = next.slice(-keptDismissals);
    snapshot = new Set(keys);
    for (const listener of listeners) listener();
  };
  const loaded = (stored: readonly string[]) => {
    // A dismissal made before storage answered is kept beside what it held.
    publish([...stored.filter((key) => !snapshot?.has(key)), ...(keys ?? [])]);
  };
  try {
    const stored = storage.read();
    if (Array.isArray(stored)) loaded(stored);
    else void Promise.resolve(stored).then(loaded, () => loaded([]));
  } catch {
    loaded([]);
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss(key) {
      if (snapshot?.has(key)) return;
      publish([...(keys ?? []), key]);
      try {
        void Promise.resolve(storage.write(keys ?? [])).catch(() => undefined);
      } catch {
        // Still dismissed for as long as this runtime lives.
      }
    },
  };
}
