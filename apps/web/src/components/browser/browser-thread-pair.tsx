import type { BrowserTabDestination, HostClient } from "@opensteer/client/host";
import { useBrowserAgentFollow, useThreadAgentTab } from "@opensteer/client/react";
import { useCallback, type ReactNode } from "react";

/**
 * The conversation docked beside a browser tab, following its agent. Where the
 * agent is while the person looks elsewhere is the conversation's live card.
 */
export interface BrowserThreadPair {
  readonly following: boolean;
  /** The docked conversation's mark. */
  readonly mark: ReactNode;
  /** The person moved the page themselves, within its tab: following stops. */
  readonly steer: () => void;
}

/**
 * Pairs the stage's browser tab with the docked conversation. A null thread
 * leaves the stage as it is; following swaps the stage's tab in place,
 * replacing the address entry, and any other change of tab is the person's.
 */
export function useBrowserThreadPair({
  hostClient,
  mark,
  onShow,
  shown,
  threadId,
}: {
  readonly hostClient: HostClient;
  readonly mark: ReactNode;
  readonly onShow: (destination: BrowserTabDestination, options: { replace: boolean }) => void;
  readonly shown: BrowserTabDestination | null;
  readonly threadId: string | null;
}): BrowserThreadPair | null {
  const onFollow = useCallback(
    (tab: BrowserTabDestination) => onShow(tab, { replace: true }),
    [onShow],
  );
  const agentTab = useThreadAgentTab(hostClient, threadId);
  const { following, steer } = useBrowserAgentFollow({
    threadId,
    shownTab: shown,
    agentTab,
    onFollow,
  });
  if (!threadId || !shown) return null;
  return { following, mark, steer };
}
