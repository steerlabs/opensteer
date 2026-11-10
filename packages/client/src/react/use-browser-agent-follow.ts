import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserAgentFollow,
  type BrowserAgentFollowInput,
  type BrowserAgentFollowTimers,
} from "../host/browser-agent-follow.js";
import {
  browserThreadAgentTab,
  sameBrowserTab,
  type BrowserTabDestination,
} from "../host/browser-thread-tabs.js";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { threadInDirectory } from "../host/host-snapshot-selectors.js";
import { threadStopTarget } from "../host/thread-activity.js";
import { useHostSelector } from "./use-host-snapshot.js";
import { useRunPlace, useRunPlaceBinding } from "./use-places.js";

export interface UseBrowserAgentFollowInput extends BrowserAgentFollowInput {
  readonly onFollow: (tab: BrowserTabDestination) => void;
  readonly timers?: BrowserAgentFollowTimers;
}

export interface BrowserAgentFollowResult {
  readonly following: boolean;
  /** The person moved the page themselves, within its tab: following stops. */
  readonly steer: () => void;
}

const sameOccupied = (a: BrowserTabDestination | null, b: BrowserTabDestination | null) =>
  a === b || sameBrowserTab(a, b);

/**
 * The tab a Thread's agent is on, which following keeps up with. While its
 * working Run acts in a browser tab it is that tab, from the same Run place
 * the Thread's live card shows, so a tap on the card lands where following
 * agrees the agent is. Otherwise it is the tab the Thread occupies, so a turn
 * in another app keeps its browser tab.
 */
export function useThreadAgentTab(
  hostClient: HostClient,
  threadId: string | null,
): BrowserTabDestination | null {
  const selectRunId = useCallback(
    (snapshot: HostSnapshot) => {
      const thread = threadId === null ? null : threadInDirectory(threadId, snapshot);
      return thread === null
        ? null
        : (threadStopTarget({ runQueue: snapshot.runQueue, thread })?.id ?? null);
    },
    [threadId],
  );
  const selectOccupied = useCallback(
    (snapshot: HostSnapshot) =>
      threadId === null ? null : browserThreadAgentTab(snapshot.browserSessions, threadId),
    [threadId],
  );
  const runId = useHostSelector(hostClient, selectRunId);
  const runPlace = useRunPlace(hostClient, runId);
  const { destination } = useRunPlaceBinding(hostClient, runPlace);
  const occupied = useHostSelector(hostClient, selectOccupied, sameOccupied);
  return destination?.kind === "browser" ? destination : occupied;
}

export function useBrowserAgentFollow(input: UseBrowserAgentFollowInput): BrowserAgentFollowResult {
  const [following, setFollowing] = useState(false);
  const onFollow = useRef(input.onFollow);
  onFollow.current = input.onFollow;
  const controller = useMemo(
    () => new BrowserAgentFollow((tab) => onFollow.current(tab), setFollowing, input.timers),
    [input.timers],
  );
  const { threadId, shownTab, agentTab, held = false } = input;
  const shownSessionId = shownTab?.sessionId;
  const shownTabId = shownTab?.tabId;
  const agentSessionId = agentTab?.sessionId;
  const agentTabId = agentTab?.tabId;
  useEffect(() => {
    controller.update({
      threadId,
      shownTab:
        shownSessionId !== undefined && shownTabId !== undefined
          ? { sessionId: shownSessionId, tabId: shownTabId }
          : null,
      agentTab:
        agentSessionId !== undefined && agentTabId !== undefined
          ? { sessionId: agentSessionId, tabId: agentTabId }
          : null,
      held,
    });
  }, [controller, threadId, shownSessionId, shownTabId, agentSessionId, agentTabId, held]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { following, steer: controller.steer };
}
