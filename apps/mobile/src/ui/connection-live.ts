import {
  connectionNotice,
  showsClientLive,
  type ClientConnection,
  type ClientConnectionState,
} from "@opensteer/client/connections";
import type { ClientIssue } from "@opensteer/client/feedback";
import type { HostClient } from "@opensteer/client/host";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * How screens and the shell ask a connection for something: try now, refresh
 * now, whether live marks may move, and that a gate is explaining. None of it
 * says anything about the connection; only the shell's pill and gates do.
 */

/** Where a person gets a newer Opensteer. */
export const downloadPage = "https://opensteer.com/download";

/**
 * Connections a person asked to try now, until that attempt ends: the pill
 * says "Reconnecting…" at once instead of the reason the last attempt failed.
 */
const asked = new WeakSet<ClientConnection>();

/** A person's own retry: it skips the quiet hold, and the shell says it is trying. */
export function retryConnection(connection: ClientConnection): void {
  asked.add(connection);
  connection.retry();
}

/**
 * Pull to refresh: "try now". A ready connection reads again; one that isn't
 * is asked to recover, and the spinner lasts until that attempt ends. It
 * never fails: if the attempt does, the pill says why at once.
 */
export async function refreshNow(client: HostClient): Promise<void> {
  const { connection } = client;
  if (connection.getSnapshot().phase === "ready") {
    await client.refresh().catch(() => undefined);
    return;
  }
  retryConnection(connection);
  await new Promise<void>((settle) => {
    const check = (): boolean => {
      if (connection.getSnapshot().trying) return false;
      stop?.();
      settle();
      return true;
    };
    let stop: (() => void) | undefined;
    if (!check()) stop = connection.subscribe(check);
  });
}

/**
 * What the shell says about a connection right now, or null while it says
 * nothing (connected, or inside the quiet hold).
 */
export function shellIssue(state: ClientConnectionState, connection: ClientConnection) {
  const issue = connectionNotice(state);
  if (!state.trying) asked.delete(connection);
  if (
    issue?.code === "connection" &&
    issue.reason === "unreachable" &&
    state.trying &&
    asked.has(connection)
  )
    return { ...issue, reason: "reconnecting" } satisfies ClientIssue;
  return issue;
}

export function connectionIssueKey(issue: ClientIssue): string {
  return `${issue.code}:${issue.reason ?? ""}`;
}

/** Gates explaining a focused route; while any is up, the pill steps aside. */
const gates = new Set<object>();
const gateListeners = new Set<() => void>();
export const subscribeGates = (listener: () => void) => {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
};
export const gated = () => gates.size > 0;
function changedGates(): void {
  for (const listener of gateListeners) listener();
}

/**
 * Said by a screen while it shows a gate, or a sheet that already explains the
 * connection: the pill would only repeat it.
 */
export function useShellGate(shown: boolean): void {
  const focused = useIsFocused();
  useEffect(() => {
    if (!shown || !focused) return;
    const token = {};
    gates.add(token);
    changedGates();
    return () => {
      gates.delete(token);
      changedGates();
    };
  }, [focused, shown]);
}

/**
 * Whether marks that claim "happening right now" may move: through the quiet
 * hold they do, and once the pill shows they hold still at full colour until
 * the stream is back. Re-renders only when that answer changes.
 */
export function useShowsLive(connection: ClientConnection | null): boolean {
  const read = useCallback(
    () => (connection === null ? true : showsLiveWhile(connection.getSnapshot())),
    [connection],
  );
  return useSyncExternalStore(connection?.subscribe ?? noSubscribe, read, read);
}
const noSubscribe = () => () => undefined;

function showsLiveWhile(state: ClientConnectionState): boolean {
  return state.phase === "ready" || showsClientLive(state);
}
