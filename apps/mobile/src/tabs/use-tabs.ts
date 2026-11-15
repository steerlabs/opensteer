import type { HostClient } from "@opensteer/client/host";
import { operationDetail } from "../client/mobile-client.js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { tabListSpans } from "./tab-entries.js";

/** Whether rows name profiles and computers; changes only when the answer does. */
export function useTabListSpans(hostClient: HostClient): {
  readonly showComputer: boolean;
  readonly showProfile: boolean;
} {
  const tabs = hostClient.getSnapshot().tabs;
  const read = () => {
    const spans = tabListSpans(tabs.rows.values());
    return (Number(spans.showComputer) << 1) | Number(spans.showProfile);
  };
  const subscribe = useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]);
  const bits = useSyncExternalStore(subscribe, read, read);
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
