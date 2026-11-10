import { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserAgentFollow,
  type BrowserAgentFollowInput,
  type BrowserAgentFollowTimers,
} from "../host/browser-agent-follow.js";
import type { BrowserTabDestination } from "../host/browser-thread-tabs.js";

export interface UseBrowserAgentFollowInput extends BrowserAgentFollowInput {
  readonly onFollow: (tab: BrowserTabDestination) => void;
  readonly timers?: BrowserAgentFollowTimers;
}

export interface BrowserAgentFollowResult {
  readonly following: boolean;
  /** The person moved the page themselves, within its tab: following stops. */
  readonly steer: () => void;
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
