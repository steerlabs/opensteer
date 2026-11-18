import type { HostClient } from "@opensteer/client/host";
import { useCallback, useSyncExternalStore } from "react";
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
