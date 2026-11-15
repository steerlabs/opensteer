import type { Tab, TabId, TabLayout } from "@opensteer/core";
import type { HostClient, TabsReadModel } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { operationDetail } from "../client/mobile-client.js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { selectTabs } from "./tabs-host.js";
import { tabListSpans } from "./tab-entries.js";

const emptyLayout: TabLayout = { items: [], revision: 0 };
const noSubscription = () => () => undefined;

export function useTabsModel(hostClient: HostClient): TabsReadModel | null {
  return useHostSelector(hostClient, selectTabs);
}

/** The layout alone: a title or a usage change redraws its row, never the list. */
export function useTabLayout(model: TabsReadModel | null): TabLayout {
  return useSyncExternalStore(
    model?.subscribe ?? noSubscription,
    () => model?.layout ?? emptyLayout,
    () => model?.layout ?? emptyLayout,
  );
}

/** Still catching up with the Host: an empty list then is not yet "no tabs". */
export function useTabsSyncing(model: TabsReadModel | null): boolean {
  const read = () => model === null || model.syncing || !model.complete;
  return useSyncExternalStore(model?.subscribe ?? noSubscription, read, read);
}

/** One tab, redrawn only by its own row's changes. Undefined while it is not open. */
export function useTab(model: TabsReadModel | null, tabId: TabId | null): Tab | undefined {
  const subscribe = useCallback(
    (listener: () => void) =>
      model === null || tabId === null ? () => undefined : model.subscribeTab(tabId, listener),
    [model, tabId],
  );
  const read = () => (model === null || tabId === null ? undefined : model.get(tabId));
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether rows name profiles and computers; changes only when the answer does. */
export function useTabListSpans(model: TabsReadModel | null): {
  readonly showComputer: boolean;
  readonly showProfile: boolean;
} {
  const read = () => {
    const spans = tabListSpans(model?.rows.values() ?? []);
    return (Number(spans.showComputer) << 1) | Number(spans.showProfile);
  };
  const bits = useSyncExternalStore(model?.subscribe ?? noSubscription, read, read);
  return { showComputer: (bits & 2) !== 0, showProfile: (bits & 1) !== 0 };
}

/** One person action at a time, with its failure kept until the next one or a dismissal. */
export interface Operation {
  readonly busy: boolean;
  readonly failure: string | null;
  readonly dismiss: () => void;
  readonly run: <T>(
    work: () => Promise<T>,
    fallback: string,
    done?: (result: T) => void,
  ) => Promise<void>;
}

export function useOperation(): Operation {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const live = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = useCallback(
    async <T>(work: () => Promise<T>, fallback: string, done?: (result: T) => void) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setFailure(null);
      try {
        const result = await work();
        if (live.current) done?.(result);
      } catch (error) {
        if (live.current) setFailure(operationDetail(error, fallback));
      } finally {
        running.current = false;
        if (live.current) setBusy(false);
      }
    },
    [],
  );
  const dismiss = useCallback(() => setFailure(null), []);
  return { busy, dismiss, failure, run };
}
