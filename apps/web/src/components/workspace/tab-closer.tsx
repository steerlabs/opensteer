import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TabId } from "@opensteer/core";
import {
  createClientAction,
  type ActionOutcome,
  type ClientAction,
} from "@opensteer/client/actions";
import { classifyClientFailure } from "@opensteer/client/connections";
import { unwrapRpcResult, type HostClient, type PlaceItem } from "@opensteer/client/host";
import { useClientAction } from "@opensteer/client/react";
import type { ActionLineValue } from "../action-line.js";
import { actionLine } from "../use-action.js";

/**
 * Closing removes tabs from the person's list and nothing more: it never
 * quits an app, stops a phone, stops an agent or stops a server, so it asks
 * nothing first. Nothing here changes what the middle shows: when the tab
 * there leaves the list, its neighbour takes it ([succession](./place-succession.ts)).
 *
 * A close that didn't happen leaves the tab in the list, so its outcome is
 * said on that tab's row, whichever control asked: never a toast.
 */
interface TabCloser {
  close(tabIds: readonly TabId[]): void;
  outcome(tabId: TabId): ClientAction<TabId, void> | null;
  subscribe(listener: () => void): () => void;
}
const TabCloserContext = createContext<TabCloser | null>(null);

function useCloser(): TabCloser {
  const closer = useContext(TabCloserContext);
  if (!closer) throw new Error("Closing tabs is not available here.");
  return closer;
}

export function useTabCloser(): (place: Pick<PlaceItem, "key">) => void {
  const closer = useCloser();
  return useCallback((place) => closer.close([place.key]), [closer]);
}

export function useTabGroupCloser(): (tabIds: readonly TabId[]) => void {
  const closer = useCloser();
  return useCallback((tabIds) => closer.close(tabIds), [closer]);
}

const idle = { key: "", running: false, outcome: null, issue: null } as const;
const noAction = {
  getSnapshot: () => idle,
  subscribe: () => () => {},
  preflight: () => null,
  run: () => Promise.resolve({ kind: "not-sent", issue: null }),
  reconcile: () => Promise.resolve(),
  dismiss: () => {},
  dispose: () => {},
} satisfies ClientAction<TabId, void>;

/** How long a "Not closed" line stays when nothing else clears it. */
const notSentMs = 6_000;

/** The line a tab's row shows for its last close that didn't happen; null otherwise. */
export function useTabCloseLine(tabId: TabId): ActionLineValue | null {
  const closer = useContext(TabCloserContext);
  const read = useCallback(() => closer?.outcome(tabId) ?? null, [closer, tabId]);
  const subscribe = useCallback(
    (listener: () => void) => closer?.subscribe(listener) ?? (() => {}),
    [closer],
  );
  const owned = useSyncExternalStore(subscribe, read, read);
  const action = owned ?? noAction;
  const state = useClientAction(action);
  const notSent = state.outcome?.kind === "not-sent" && state.issue !== null;
  useEffect(() => {
    if (!notSent) return;
    const timer = setTimeout(action.dismiss, notSentMs);
    return () => clearTimeout(timer);
  }, [action, notSent, state.outcome]);
  return useMemo(
    () => (state.issue === null ? null : actionLine(state.issue, () => void action.reconcile())),
    [action, state.issue],
  );
}

/** The Host's in-band refusal of a tab, carried as the refusal it is. */
function tabCloseRefused(code: string): Error {
  return Object.assign(new Error("The tab was not closed."), {
    code,
    provenance: "host",
    retryable: false,
  });
}

export function TabCloserProvider({
  children,
  hostClient,
}: {
  readonly children: ReactNode;
  readonly hostClient: HostClient;
}) {
  const closer = useMemo(() => createTabCloser(hostClient), [hostClient]);
  useEffect(() => () => closer.dispose(), [closer]);
  return <TabCloserContext.Provider value={closer}>{children}</TabCloserContext.Provider>;
}

function createTabCloser(hostClient: HostClient): TabCloser & { dispose(): void } {
  const latest = new Map<TabId, ClientAction<TabId, void>>();
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const release = (action: ClientAction<TabId, void>) => {
    for (const [tabId, held] of latest) if (held === action) latest.delete(tabId);
    action.dispose();
  };
  const exists = async (tabId: TabId, signal: AbortSignal): Promise<boolean | null> => {
    try {
      signal.throwIfAborted();
      unwrapRpcResult(await hostClient.rpc["tabs.get"]({ tabId }, { signal }));
      return true;
    } catch (error) {
      return classifyClientFailure(error).code === "not_found" ? false : null;
    }
  };
  return {
    close(tabIds) {
      if (!tabIds.length) return;
      const ids = [...new Set(tabIds)];
      let batch: ReturnType<HostClient["closeTabs"]> | undefined;
      const rows = ids.map((tabId) => {
        const action = createClientAction<TabId, void>(hostClient, {
          key: `close:${tabId}`,
          label: "close this tab",
          done: "closed",
          happened: "this tab closed",
          execute: async (id) => {
            const result = await (batch ??= hostClient.closeTabs(ids));
            const refused = result.failed.find((row) => row.tabId === id);
            if (refused) throw tabCloseRefused(refused.error.code);
          },
          reconcile: async (id, signal): Promise<ActionOutcome<void> | null> => {
            const found = await exists(id, signal);
            if (found === null) return null;
            return found
              ? { kind: "not-sent", issue: { code: "not-sent", done: "closed" } }
              : { kind: "confirmed", value: undefined };
          },
        });
        latest.get(tabId)?.dispose();
        latest.set(tabId, action);
        return { tabId, action };
      });
      publish();
      for (const { tabId, action } of rows) {
        const settle = () => {
          if (latest.get(tabId) !== action || action.getSnapshot().outcome?.kind !== "confirmed")
            return;
          release(action);
          publish();
        };
        action.subscribe(settle);
        void action.run(tabId).then(settle);
      }
    },
    outcome: (tabId) => latest.get(tabId) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      for (const action of new Set(latest.values())) action.dispose();
      latest.clear();
      listeners.clear();
    },
  };
}
