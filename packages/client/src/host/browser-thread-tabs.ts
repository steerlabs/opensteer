import type { BrowserCatalogTab as BrowserTabSummary } from "./client.js";
import type { BrowserSessionSummary, PlaceEntry } from "./client.js";

export interface BrowserTabDestination {
  readonly sessionId: string;
  readonly tabId: string;
}

export interface BrowserThreadTab extends BrowserTabDestination {
  readonly tab: BrowserTabSummary;
}

export function sameBrowserTab(
  a: BrowserTabDestination | null,
  b: BrowserTabDestination | null,
): boolean {
  return a !== null && b !== null && a.sessionId === b.sessionId && a.tabId === b.tabId;
}

type TabSession = Pick<BrowserSessionSummary, "id" | "tabCatalog">;

/** Occupancy is Host-authorized; this only ranks the supplied catalog. */
export function browserThreadAgentTab(
  sessions: readonly TabSession[],
  threadId: string,
): BrowserThreadTab | null {
  const candidates = sessions.flatMap((session) =>
    (session.tabCatalog?.tabs ?? []).flatMap((tab) =>
      tab.occupants
        .filter((occupant) => occupant.threadId === threadId)
        .map((occupant) => ({
          sessionId: session.id,
          tabId: tab.id,
          tab,
          occupant,
        })),
    ),
  );
  candidates.sort(
    (a, b) =>
      Number(b.occupant.acting) - Number(a.occupant.acting) ||
      Number(b.occupant.holding) - Number(a.occupant.holding) ||
      b.occupant.lastActiveAt.localeCompare(a.occupant.lastActiveAt) ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.tab.order - b.tab.order ||
      a.tabId.localeCompare(b.tabId),
  );
  const winner = candidates[0];
  return winner ? { sessionId: winner.sessionId, tabId: winner.tabId, tab: winner.tab } : null;
}

export interface BrowserThreadTabs {
  readonly sessionId: string;
  readonly threadId: string;
  readonly taskTabs: readonly BrowserTabSummary[];
  readonly otherTabs: readonly BrowserTabSummary[];
  readonly rememberedTabIds: readonly string[];
}

/** Pass the previous result to retain observed membership across occupancy gaps. */
export function browserThreadTabs(
  session: TabSession,
  threadId: string,
  places: readonly PlaceEntry[] = [],
  previous?: BrowserThreadTabs,
): BrowserThreadTabs {
  const members = new Set(
    previous?.sessionId === session.id && previous.threadId === threadId
      ? previous.rememberedTabIds
      : [],
  );
  for (const entry of places) {
    if (entry.place.kind === "browser" && entry.place.sessionId === session.id)
      members.add(entry.place.surfaceId);
  }
  const tabs = [...(session.tabCatalog?.tabs ?? [])].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  for (const tab of tabs) {
    if (tab.occupants.some((occupant) => occupant.threadId === threadId)) members.add(tab.id);
  }
  const taskTabs = tabs.filter((tab) => members.has(tab.id));
  return {
    sessionId: session.id,
    threadId,
    taskTabs,
    otherTabs: tabs.filter((tab) => !members.has(tab.id)),
    rememberedTabIds: taskTabs.map((tab) => tab.id),
  };
}
