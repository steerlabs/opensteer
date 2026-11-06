import {
  browserThreadAgentTab,
  browserThreadTabs,
  browserTabTitle,
  transcriptPlaces,
  type BrowserTabDestination,
  type BrowserThreadTab,
  type BrowserThreadTabs,
  type HostClient,
  type HostSnapshot,
  type PlaceEntry,
} from "@opensteer/client/host";
import { useBrowserAgentFollow, useHostSelector } from "@opensteer/client/react";
import type { BrowserTabSummary } from "@opensteer/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { PlaceMark } from "../workspace/place-mark.js";

/** The conversation docked beside a browser tab: following its agent and its other tabs. */
export interface BrowserThreadPair {
  readonly following: boolean;
  /** The docked conversation's mark. */
  readonly mark: ReactNode;
  /** Where the agent is while the person looks elsewhere; null while following or idle. */
  readonly elsewhere: BrowserThreadTab | null;
  /** The task's tabs in this browser other than the one shown. */
  readonly taskTabs: readonly BrowserTabSummary[];
  /** Every tab in this browser, in tab order. */
  readonly allTabs: readonly BrowserTabSummary[];
  readonly sessionId: string;
  readonly shownTabId: string;
  /** The person drove the page themselves: stop following. */
  readonly pause: () => void;
  readonly resume: () => void;
  /** The person chose another tab of this browser. */
  readonly showTab: (tabId: string) => void;
}

const noPlaces: readonly PlaceEntry[] = [];
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
  const selectTranscript = useCallback(
    (snapshot: HostSnapshot) => (threadId ? snapshot.transcripts[threadId] : undefined),
    [threadId],
  );
  const transcript = useHostSelector(hostClient, selectTranscript);
  const places = transcript ? transcriptPlaces(transcript) : noPlaces;
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
  const session = shown ? sessions.find((candidate) => candidate.id === shown.sessionId) : null;
  const tabsMemo = useRef<BrowserThreadTabs | undefined>(undefined);
  const tabs = useMemo(() => {
    if (!session || !threadId) return null;
    return browserThreadTabs(session, threadId, places, tabsMemo.current);
  }, [places, session, threadId]);
  useEffect(() => {
    if (tabs) tabsMemo.current = tabs;
  }, [tabs]);

  if (!threadId || !shown) return null;
  const allTabs = session?.tabCatalog?.tabs
    ? [...session.tabCatalog.tabs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    : [];
  return {
    following: follow.following,
    mark,
    elsewhere: !follow.following && agentTab && agentTab.tabId !== shown.tabId ? agentTab : null,
    taskTabs: tabs?.taskTabs.filter((tab) => tab.id !== shown.tabId) ?? [],
    allTabs,
    sessionId: shown.sessionId,
    shownTabId: shown.tabId,
    pause,
    resume,
    showTab: (tabId) => onShow({ sessionId: shown.sessionId, tabId }, { replace: false }),
  };
}

/** A tab's name, from what the catalog says of it. */
function catalogTabTitle(tab: BrowserTabSummary): string {
  return browserTabTitle({ title: tab.title, url: tab.site });
}

/** Under the chrome, never over the page: where the agent went while the person looked away. */
export function BrowserFollowBand({ pair }: { readonly pair: BrowserThreadPair }) {
  if (!pair.elsewhere) return null;
  const title = catalogTabTitle(pair.elsewhere.tab);
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

const shownChips = 3;

/** The task's other tabs beside the address: a few chips, the rest behind +N. */
export function BrowserTaskTabs({
  hostClient,
  pair,
}: {
  readonly hostClient: HostClient;
  readonly pair: BrowserThreadPair;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const chips = pair.taskTabs.slice(0, shownChips);
  const rest = pair.taskTabs.slice(shownChips);
  const others = pair.allTabs.length > pair.taskTabs.length + 1;
  if (chips.length === 0) return null;
  const choose = (tabId: string) => {
    setOpen(false);
    pair.showTab(tabId);
  };
  const icon = (tab: BrowserTabSummary) => (
    <PlaceMark
      hostClient={hostClient}
      icon={{ kind: "site", ref: tab.iconRef, sessionId: pair.sessionId }}
    />
  );
  const menuLabel =
    rest.length > 0 ? `${rest.length} more of this task’s tabs` : "All tabs in this browser";
  return (
    <div aria-label="This task’s tabs" className="browser-task-tabs" role="group">
      {chips.map((tab) => {
        const title = catalogTabTitle(tab);
        return (
          <button
            aria-label={`Show ${title}`}
            className="browser-task-tab"
            key={tab.id}
            onClick={() => pair.showTab(tab.id)}
            title={title}
            type="button"
          >
            {icon(tab)}
            <span className="browser-task-tab__title">{title}</span>
          </button>
        );
      })}
      {rest.length === 0 && !others ? null : (
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={menuLabel}
          className="browser-task-tab browser-task-tab--more"
          onClick={() => setOpen(!open)}
          ref={setMenuAnchor}
          title={menuLabel}
          type="button"
        >
          {rest.length > 0 ? `+${rest.length}` : <Icon name="chevron-down" />}
        </button>
      )}
      {open && menuAnchor ? (
        <Popover
          anchor={menuAnchor}
          below
          className="popover--surface"
          label="This task’s tabs"
          onClose={() => setOpen(false)}
        >
          {rest.length > 0 ? (
            <div className="picker__section">
              {rest.map((tab) => (
                <TabRow choose={choose} icon={icon(tab)} key={tab.id} tab={tab} />
              ))}
            </div>
          ) : null}
          <div className="picker__section">
            <div className="picker__heading">All tabs in this browser</div>
            {pair.allTabs.map((tab) => (
              <TabRow
                choose={choose}
                current={tab.id === pair.shownTabId}
                icon={icon(tab)}
                key={tab.id}
                tab={tab}
              />
            ))}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

function TabRow({
  choose,
  current = false,
  icon,
  tab,
}: {
  readonly choose: (tabId: string) => void;
  readonly current?: boolean;
  readonly icon: ReactNode;
  readonly tab: BrowserTabSummary;
}) {
  return (
    <button
      aria-current={current || undefined}
      className="picker__row"
      disabled={current}
      onClick={() => choose(tab.id)}
      role="menuitem"
      type="button"
    >
      <span className="picker__check picker__check--icon">{icon}</span>
      <span className="picker__label-stack">
        <span className="picker__label">{catalogTabTitle(tab)}</span>
      </span>
    </button>
  );
}
