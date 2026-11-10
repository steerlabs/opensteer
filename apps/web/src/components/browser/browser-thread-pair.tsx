import {
  browserThreadAgentTab,
  browserTabTitle,
  type BrowserTabDestination,
  type BrowserThreadTab,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useBrowserAgentFollow, useHostSelector } from "@opensteer/client/react";
import { useCallback, useMemo, type ReactNode } from "react";

/** The conversation docked beside a browser tab, following its agent. */
export interface BrowserThreadPair {
  readonly following: boolean;
  /** The docked conversation's mark. */
  readonly mark: ReactNode;
  /** Where the agent is while the person looks elsewhere; null while following or idle. */
  readonly elsewhere: BrowserThreadTab | null;
  /** The person drove the page themselves: stop following. */
  readonly pause: () => void;
  readonly resume: () => void;
}

const selectSessions = (snapshot: HostSnapshot) => snapshot.browserSessions;

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
  const sessions = useHostSelector(hostClient, selectSessions);
  const agentTab = useMemo(
    () => (threadId ? browserThreadAgentTab(sessions, threadId) : null),
    [sessions, threadId],
  );
  const onFollow = useCallback(
    (tab: BrowserTabDestination) => onShow(tab, { replace: true }),
    [onShow],
  );
  const follow = useBrowserAgentFollow({ threadId, shownTab: shown, agentTab, onFollow });
  const { pause, resume } = follow;

  if (!threadId || !shown) return null;
  return {
    following: follow.following,
    mark,
    elsewhere: !follow.following && agentTab && agentTab.tabId !== shown.tabId ? agentTab : null,
    pause,
    resume,
  };
}

/** Under the chrome, never over the page: where the agent went while the person looked away. */
export function BrowserFollowBand({
  pair,
}: {
  readonly pair: Pick<BrowserThreadPair, "elsewhere" | "mark" | "resume">;
}) {
  if (!pair.elsewhere) return null;
  const { tab } = pair.elsewhere;
  const title = browserTabTitle({ title: tab.title, url: tab.site });
  return (
    <div className="browser-follow-band">
      <span className="browser-follow-band__mark">{pair.mark}</span>
      <span className="browser-follow-band__text" role="status">
        Agent is on <strong>{title}</strong>
      </span>
      <button
        aria-label="Follow the agent"
        className="browser-follow-band__follow"
        onClick={pair.resume}
        type="button"
      >
        Follow
      </button>
    </div>
  );
}
