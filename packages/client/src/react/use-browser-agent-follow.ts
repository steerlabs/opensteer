import { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserAgentFollow,
  type BrowserAgentFollowInput,
  type BrowserAgentFollowTimers,
} from "../host/browser-agent-follow.js";
import type { BrowserTabDestination, BrowserThreadTab } from "../host/browser-thread-tabs.js";

export interface UseBrowserAgentFollowInput extends BrowserAgentFollowInput {
  readonly agentTab: BrowserThreadTab | null;
  readonly onFollow: (tab: BrowserTabDestination) => void;
  readonly timers?: BrowserAgentFollowTimers;
}

export interface BrowserAgentFollowResult {
  readonly following: boolean;
  readonly agentTab: BrowserThreadTab | null;
  readonly pause: () => void;
  /** Jumps immediately via onFollow and also returns that destination. */
  readonly resume: () => BrowserTabDestination | null;
}

export function useBrowserAgentFollow(input: UseBrowserAgentFollowInput): BrowserAgentFollowResult {
  const [following, setFollowing] = useState(false);
  const onFollow = useRef(input.onFollow);
  onFollow.current = input.onFollow;
  const controller = useMemo(
    () => new BrowserAgentFollow((tab) => onFollow.current(tab), setFollowing, input.timers),
    [input.timers],
  );
  const { threadId, shownTab, agentTab } = input;
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
    });
  }, [controller, threadId, shownSessionId, shownTabId, agentSessionId, agentTabId]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { following, agentTab, pause: controller.pause, resume: controller.resume };
}
