import {
  computerAppIdentityKey,
  type ComputerAppIdentity,
  type MachineSummary,
} from "@opensteer/protocol";
import { canWatchComputer } from "../integrations/computer-use.js";
import { browserIdentity, type PlaceBrowserIdentity } from "./start-page-model.js";
import { browserTabTitle } from "./browser-presentation.js";
import type { BrowserPageContentPart } from "@opensteer/core";
import type { Turn } from "./agent-activity-model.js";
import type { BrowserSessionSummary, HostSnapshot, PlaceEntry } from "./client.js";
import { mergeTaskEntries } from "./task-entries.js";
import { threadsWaitingOnReader } from "./waiting-requests.js";

/** One page a conversation used, with its exact tab and browsing identity. */
export interface BrowserSurfaceItem {
  readonly kind: "browser";
  readonly key: string;
  readonly session: BrowserSessionSummary;
  readonly tabId: string;
  readonly identity: PlaceBrowserIdentity;
  readonly acting: boolean;
  readonly title: string;
  /** The page's host name, or null before a page has an address. */
  readonly site: string | null;
  /** The shown page's site icon, while this client watches the browser and the page has one. */
  readonly favicon: string | null;
  readonly openedAt: string;
}

/** One app on one Mac, however many of the conversation's Runs used it. */
export interface AppSurfaceItem {
  readonly kind: "app";
  readonly key: string;
  readonly app: ComputerAppIdentity;
  readonly appKey: string;
  readonly machine: MachineSummary;
  readonly computerSessionId: string;
  /** The conversation whose Run holds the session (a delegated task's own conversation). */
  readonly threadId: string;
  readonly acting: boolean;
  readonly openedAt: string;
}

/** A phone's whole display, once per machine even when several Runs hold it. */
export interface PhoneSurfaceItem {
  readonly kind: "phone";
  readonly key: string;
  readonly machine: MachineSummary;
  readonly computerSessionId: string;
  readonly threadId: string;
  readonly acting: boolean;
  readonly openedAt: string;
}

export type SurfaceItem = BrowserSurfaceItem | AppSurfaceItem | PhoneSurfaceItem;

/** Exactly what a link or a tile opens. Nothing else chooses a surface. */
export type NativeViewerSource =
  | { readonly kind: "task-session"; readonly sessionId: string; readonly appKey?: string }
  | { readonly kind: "owner-view"; readonly viewId: string; readonly generation: number };
type NativeDestinationSource<Source extends NativeViewerSource> = Source extends {
  kind: "task-session";
}
  ? { readonly computerSessionId: string; readonly source?: Source }
  : { readonly computerSessionId?: never; readonly source: Source };
/** Existing conversation callers keep task-only destinations; workspace places opt into owner sources. */
export type SurfaceDestination<
  Source extends NativeViewerSource = Extract<NativeViewerSource, { kind: "task-session" }>,
> =
  | { readonly kind: "browser"; readonly sessionId: string; readonly tabId: string }
  | ({
      readonly kind: "app";
      readonly appKey: string;
      readonly windowId?: number;
      readonly machineId: string;
    } & NativeDestinationSource<Source>)
  | ({
      readonly kind: "phone";
      readonly display?: string;
      readonly machineId: string;
    } & NativeDestinationSource<Source>);
export type WorkspaceSurfaceDestination = SurfaceDestination<NativeViewerSource>;
export function nativeViewerSource(
  destination: Exclude<WorkspaceSurfaceDestination, { kind: "browser" }>,
): NativeViewerSource {
  if (destination.source) return destination.source;
  return { kind: "task-session", sessionId: destination.computerSessionId! };
}

const conversationSurfaceKeys = [
  "assignments",
  "browserSessions",
  "browserProfiles",
  "connection",
  "machines",
] as const;
export type ConversationSurfaceSource = Pick<
  HostSnapshot,
  (typeof conversationSurfaceKeys)[number]
>;

/** Exactly the state a conversation's surface grid draws. */
export function sameConversationSurfaceSource(
  previous: ConversationSurfaceSource,
  next: ConversationSurfaceSource,
): boolean {
  return conversationSurfaceKeys.every((key) => previous[key] === next[key]);
}

const liveWorkKeys = ["tasks", "activeTasks", "waitingRequests"] as const;
export type LiveWorkSource = ConversationSurfaceSource &
  Pick<HostSnapshot, (typeof liveWorkKeys)[number]>;

/** The cross-Workspace overview, independent of opened conversations and transcript streaming. */
export function sameLiveWorkSource(previous: LiveWorkSource, next: LiveWorkSource): boolean {
  return (
    sameConversationSurfaceSource(previous, next) &&
    liveWorkKeys.every((key) => previous[key] === next[key])
  );
}

const openBrowserStates = new Set<BrowserSessionSummary["state"]>(["starting", "ready", "closing"]);

/**
 * The most recently active tab, from its authorized occupants rather than
 * session-wide presence or historical Run usage.
 */
export function browserActingTabId(session: BrowserSessionSummary): string | null {
  if (session.state !== "ready") return null;
  let latest: { readonly at: string; readonly tabId: string } | null = null;
  for (const tab of session.tabCatalog?.tabs ?? []) {
    for (const occupant of tab.occupants) {
      if (occupant.acting && (latest === null || occupant.lastActiveAt > latest.at))
        latest = { at: occupant.lastActiveAt, tabId: tab.id };
    }
  }
  return latest?.tabId ?? null;
}

function hostName(url: string): string | null {
  if (!url || url === "about:blank") return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * A browser belongs to a conversation because the Host recorded that
 * conversation using it. The catalog names those conversations for every
 * browser, whether or not this client has opened them; a usage read of a
 * conversation can say so before the catalog is read again.
 */
function browserUsedBy(session: BrowserSessionSummary, threadId: string): boolean {
  return (
    session.threadIds?.includes(threadId) === true ||
    session.uses?.some((use) => use.threadId === threadId) === true
  );
}

/**
 * The conversation and every conversation working for it now. Only open
 * assignments count: a reused worker has a new assignment, and its later work
 * is not its earlier parent's.
 */
export function conversationThreadIds(
  snapshot: Pick<HostSnapshot, "assignments">,
  threadId: string,
): ReadonlySet<string> {
  const ids = new Set([threadId]);
  const assignments = Object.values(snapshot.assignments);
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (
        assignment.status === "open" &&
        ids.has(assignment.parentThreadId) &&
        !ids.has(assignment.workerThread.id)
      ) {
        ids.add(assignment.workerThread.id);
        changed = true;
      }
    }
  }
  return ids;
}

/**
 * Every browser, Mac app and phone a conversation is using, including work its tasks
 * do, in the order each first appeared. A browser belongs to a conversation
 * because the Host recorded that conversation using it — a task's use credits
 * the conversations that asked for it at that time; Mac apps because a Run of
 * the conversation, or of work it handed out, holds them now.
 */
export function conversationSurfaces(
  snapshot: ConversationSurfaceSource,
  threadId: string,
): SurfaceItem[] {
  const browsers = snapshot.browserSessions
    .filter((session) => openBrowserStates.has(session.state) && browserUsedBy(session, threadId))
    .flatMap((session) => browserItems(session, snapshot.browserProfiles));
  const threads = conversationThreadIds(snapshot, threadId);
  return [...browsers, ...computerItems(snapshot, (session) => threads.has(session.threadId))].sort(
    stableOrder,
  );
}

function browserItems(
  session: BrowserSessionSummary,
  profiles: HostSnapshot["browserProfiles"],
): BrowserSurfaceItem[] {
  const tabs = session.tabCatalog
    ? [...session.tabCatalog.tabs].sort(
        (left, right) => left.order - right.order || left.id.localeCompare(right.id),
      )
    : session.tabs.map((tab) => ({ ...tab, site: tab.url, openerId: null }));
  const identity = browserIdentity(session.profileId, profiles);
  const actingTabId = browserActingTabId(session);
  const items: BrowserSurfaceItem[] = [];
  const inserted = new Set<string>();
  const append = (tab: (typeof tabs)[number]) => {
    if (inserted.has(tab.id)) return;
    inserted.add(tab.id);
    const live = session.tabs.find((candidate) => candidate.id === tab.id);
    items.push({
      acting: actingTabId === tab.id,
      favicon: live?.favicon ?? null,
      identity,
      key: `browser:${session.id}:${tab.id}`,
      kind: "browser",
      openedAt: session.createdAt ?? "",
      session,
      tabId: tab.id,
      site: hostName(tab.site),
      title: browserTabTitle({ title: tab.title, url: tab.site }),
    });
    for (const child of tabs) if (child.openerId === tab.id) append(child);
  };
  for (const tab of tabs)
    if (!tab.openerId || !tabs.some((parent) => parent.id === tab.openerId)) append(tab);
  for (const tab of tabs) append(tab);
  return items;
}

/**
 * One tile per phone or app per Mac. When two Runs hold the same app, the one acting
 * in it now wins, then the newest: a person watching Notes sees Notes as it is.
 */
function computerItems(
  snapshot: Pick<HostSnapshot, "connection"> & { readonly machines: readonly MachineSummary[] },
  include: (session: { readonly runId: string; readonly threadId: string }) => boolean,
): (AppSurfaceItem | PhoneSurfaceItem)[] {
  if (snapshot.connection !== "connected") return [];
  const byApp = new Map<string, AppSurfaceItem | PhoneSurfaceItem>();
  for (const machine of snapshot.machines) {
    if (!canWatchComputer(machine)) continue;
    for (const session of machine.computerUse?.sessions ?? []) {
      if (!include(session)) continue;
      if (session.display) {
        const item: PhoneSurfaceItem = {
          acting: session.actingDisplay === true,
          computerSessionId: session.sessionId,
          key: `phone:${machine.id}`,
          kind: "phone",
          machine,
          openedAt: session.openedAt,
          threadId: session.threadId,
        };
        const held = byApp.get(item.key);
        if (!held || item.openedAt > held.openedAt) byApp.set(item.key, item);
        continue;
      }
      const acting = new Set(session.actingAppKeys ?? []);
      for (const app of session.apps) {
        const appKey = computerAppIdentityKey(app);
        const item: AppSurfaceItem = {
          acting: acting.has(appKey),
          app,
          appKey,
          computerSessionId: session.sessionId,
          key: `app:${machine.id}:${appKey}`,
          kind: "app",
          machine,
          openedAt: session.openedAt,
          threadId: session.threadId,
        };
        const held = byApp.get(item.key);
        if (
          !held ||
          (item.acting && !held.acting) ||
          (item.acting === held.acting && item.openedAt > held.openedAt)
        ) {
          byApp.set(item.key, item);
        }
      }
    }
  }
  return [...byApp.values()];
}

function stableOrder(left: SurfaceItem, right: SurfaceItem): number {
  const leftKey = left.kind === "browser" ? `browser:${left.session.id}` : left.key;
  const rightKey = right.kind === "browser" ? `browser:${right.session.id}` : right.key;
  return left.openedAt.localeCompare(right.openedAt) || leftKey.localeCompare(rightKey);
}

export type TaskSurfaceDestination = Extract<
  SurfaceDestination,
  { kind: "browser" } | { computerSessionId: string }
>;
export function surfaceDestination(item: SurfaceItem): TaskSurfaceDestination {
  return item.kind === "browser"
    ? { kind: "browser", sessionId: item.session.id, tabId: item.tabId }
    : {
        ...(item.kind === "app"
          ? { appKey: item.appKey, kind: "app" as const }
          : { kind: "phone" as const }),
        computerSessionId: item.computerSessionId,
        machineId: item.machine.id,
      };
}

/** A page a reply's Runs used, kept even after its browser ended. */
export interface RunPage {
  readonly key: string;
  readonly destination: Extract<SurfaceDestination, { readonly kind: "browser" }>;
  readonly title: string;
  readonly site: string | null;
  /** The page or its browser is gone; the link still names it but cannot open it. */
  readonly ended: boolean;
  /** An agent is at work in this very tab now, not merely somewhere in its browser. */
  readonly acting: boolean;
  /** The open tab's site icon, while its browser has one for it. */
  readonly favicon: string | null;
}

/**
 * Each page the given Runs used, one per browser tab, in the order they were
 * first used. Only exact page uses count. The authoritative tab catalog names
 * open pages; missing or ended pages keep that use's recorded title and site.
 */
export function runPages(
  sessions: readonly BrowserSessionSummary[],
  runIds: readonly string[],
): RunPage[] {
  return usedPages(sessions, runIds).map(({ firstUsedAt: _firstUsedAt, ...page }) => page);
}

/**
 * Where a Run entered a browser tab, as the reader can use it now: that exact
 * tab while it is open, named as it was when the Run entered it.
 */
export function placePage(
  entry: PlaceEntry,
  sessions: readonly BrowserSessionSummary[],
  threadId: string | null,
): RunPage | null {
  if (entry.place.kind !== "browser") return null;
  const { sessionId, surfaceId: tabId } = entry.place;
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const { acting, ended, favicon } = session
    ? pageState(session, tabId, entry.runId, threadId)
    : { acting: false, ended: true, favicon: null };
  const site = entry.site ? hostName(entry.site) : null;
  return {
    acting,
    destination: { kind: "browser", sessionId, tabId },
    ended,
    favicon,
    key: `${sessionId}:${tabId}`,
    site,
    title: entry.title.trim() || site || "Page",
  };
}

/** A tab as a Run's page: whether it is gone, its icon, and whether the Run's agent acts there now. */
function pageState(
  session: BrowserSessionSummary,
  tabId: string,
  runId: string,
  threadId: string | null,
): { readonly acting: boolean; readonly ended: boolean; readonly favicon: string | null } {
  const open = openBrowserStates.has(session.state);
  const catalog = open ? session.tabCatalog : undefined;
  const tab = catalog?.tabs.find((candidate) => candidate.id === tabId);
  // A live browser's catalog lists every tab it has, so one missing from it was closed.
  const ended = !open || (catalog != null && !tab);
  return {
    acting:
      session.state === "ready" &&
      session.attachedRunIds.includes(runId) &&
      tab?.occupants.some((occupant) => occupant.threadId === threadId && occupant.acting) === true,
    ended,
    favicon: ended
      ? null
      : (session.tabs.find((candidate) => candidate.id === tabId)?.favicon ?? null),
  };
}

function usedPages(
  sessions: readonly BrowserSessionSummary[],
  runIds: readonly string[],
): (RunPage & { readonly firstUsedAt: string })[] {
  const runs = new Set(runIds);
  const pages = new Map<string, RunPage & { readonly firstUsedAt: string }>();
  for (const session of sessions) {
    const catalog = openBrowserStates.has(session.state) ? session.tabCatalog : undefined;
    for (const use of session.uses ?? []) {
      if (use.runId === null || !runs.has(use.runId) || !use.tabId) continue;
      const tabId = use.tabId;
      const key = `${session.id}:${tabId}`;
      const tab = catalog?.tabs.find((candidate) => candidate.id === tabId);
      const { acting, ended, favicon } = pageState(session, tabId, use.runId, use.threadId);
      const held = pages.get(key);
      if (held && held.firstUsedAt <= use.firstUsedAt) {
        if (acting) pages.set(key, { ...held, acting: true });
        continue;
      }
      const recordedSite = use.pageSite ? hostName(use.pageSite) : null;
      const site = tab ? hostName(tab.site) : recordedSite;
      const title =
        (tab?.title.trim() || null) ?? (use.pageTitle?.trim() || null) ?? site ?? "Page";
      pages.set(key, {
        acting: acting || held?.acting === true,
        destination: { kind: "browser", sessionId: session.id, tabId },
        ended,
        favicon,
        firstUsedAt: use.firstUsedAt,
        key,
        site,
        title,
      });
    }
  }
  return [...pages.values()].sort(
    (left, right) =>
      left.firstUsedAt.localeCompare(right.firstUsedAt) || left.key.localeCompare(right.key),
  );
}

/**
 * The pages a person included with a message, as chips: the tab's current
 * title while its browser is open, else what the person saw when they sent it.
 */
export function messagePages(
  pages: readonly BrowserPageContentPart[],
  sessions: readonly BrowserSessionSummary[],
): RunPage[] {
  return pages.map((page) => {
    const session = sessions.find((candidate) => candidate.id === page.sessionId);
    const ended = !session || !openBrowserStates.has(session.state);
    const tab = ended ? undefined : session?.tabs.find((candidate) => candidate.id === page.tabId);
    return {
      acting: false,
      destination: { kind: "browser", sessionId: page.sessionId, tabId: page.tabId },
      ended,
      favicon: tab?.favicon ?? null,
      key: `${page.sessionId}:${page.tabId}`,
      site: hostName(tab?.url ?? page.url),
      title: (tab ? browserTabTitle(tab) : page.title.trim()) || hostName(page.url) || "Page",
    };
  });
}

/** A Mac app a reply's steps worked in, kept after the agent is done with it. */
export interface TurnApp {
  readonly key: string;
  readonly app: ComputerAppIdentity;
  readonly title: string;
  /** Null once the Run no longer holds the app: the chip only names it. */
  readonly destination: Extract<SurfaceDestination, { readonly kind: "app" }> | null;
  readonly ended: boolean;
  readonly acting: boolean;
  /** The reply's first step in the app. */
  readonly firstUsedAt: string;
}

/**
 * The Mac apps a reply's steps worked in, one per app per Mac, from the steps
 * themselves. An app opens while the reply's Run still holds it.
 */
export function turnApps(
  turn: Pick<Turn, "runId" | "subagentWork" | "work">,
  machines: readonly MachineSummary[],
): TurnApp[] {
  const apps = new Map<string, TurnApp>();
  for (const entry of [...turn.work, ...Object.values(turn.subagentWork).flat()]) {
    if (entry.kind !== "tool" || entry.tool?.name === "computer") continue;
    const place = entry.integration?.computerApp;
    if (!place) continue;
    const app: ComputerAppIdentity = {
      bundleId: place.bundleId,
      displayName: place.app,
      teamId: null,
    };
    const appKey = computerAppIdentityKey(app);
    const key = `app:${place.runnerId}:${appKey}`;
    const held = apps.get(key);
    if (held) {
      // Subagents' steps follow the reply's own, so the earliest one is looked for.
      if (entry.createdAt < held.firstUsedAt)
        apps.set(key, { ...held, firstUsedAt: entry.createdAt });
      continue;
    }
    const machine = machines.find((candidate) => candidate.id === place.runnerId);
    const session =
      machine && canWatchComputer(machine)
        ? machine.computerUse?.sessions.find(
            (candidate) =>
              candidate.runId === entry.runId &&
              candidate.apps.some((held) => computerAppIdentityKey(held) === appKey),
          )
        : undefined;
    apps.set(key, {
      acting: session?.actingAppKeys?.includes(appKey) === true,
      app,
      destination:
        session && machine
          ? { appKey, computerSessionId: session.sessionId, kind: "app", machineId: machine.id }
          : null,
      ended: session === undefined,
      firstUsedAt: entry.createdAt,
      key,
      title: place.app,
    });
  }
  return [...apps.values()];
}

/** A phone recorded in a reply's work, kept after its session ends. */
export interface TurnPhone {
  readonly key: string;
  readonly title: string;
  readonly destination: Extract<SurfaceDestination, { readonly kind: "phone" }> | null;
  readonly ended: boolean;
  readonly acting: boolean;
  /** The reply's first step on the phone. */
  readonly firstUsedAt: string;
}

/** Phones named by the reply's own and delegated steps, one per computer. */
export function turnPhones(
  turn: Pick<Turn, "runId" | "subagentWork" | "work">,
  machines: readonly MachineSummary[],
): TurnPhone[] {
  const phones = new Map<string, TurnPhone>();
  for (const entry of [...turn.work, ...Object.values(turn.subagentWork).flat()]) {
    if (entry.kind !== "tool" || entry.tool?.name === "computer" || !entry.integration?.phone)
      continue;
    const place = entry.integration.phone;
    const key = `phone:${place.runnerId}`;
    const held = phones.get(key);
    if (held) {
      if (entry.createdAt < held.firstUsedAt)
        phones.set(key, { ...held, firstUsedAt: entry.createdAt });
      continue;
    }
    const machine = machines.find((candidate) => candidate.id === place.runnerId);
    const session =
      machine && canWatchComputer(machine)
        ? machine.computerUse?.sessions.find(
            (candidate) => candidate.runId === entry.runId && candidate.display,
          )
        : undefined;
    phones.set(key, {
      acting: session?.actingDisplay === true,
      destination:
        session && machine
          ? { kind: "phone", computerSessionId: session.sessionId, machineId: machine.id }
          : null,
      ended: session === undefined,
      firstUsedAt: entry.createdAt,
      key,
      title: place.computer,
    });
  }
  return [...phones.values()];
}

/** One place a reply's Run used: a browser page, a phone or a Mac app. */
export type ReplyPlace =
  | { readonly kind: "page"; readonly page: RunPage }
  | { readonly kind: "phone"; readonly phone: TurnPhone }
  | { readonly kind: "app"; readonly app: TurnApp };

/**
 * Every place a reply's Run used, whatever its kind, in the order it first
 * used them: a place used later always comes after, so none ever moves.
 */
export function replyPlaces(
  turn: Pick<Turn, "runId" | "subagentWork" | "work">,
  sessions: readonly BrowserSessionSummary[],
  machines: readonly MachineSummary[],
): ReplyPlace[] {
  const used: { readonly at: string; readonly place: ReplyPlace }[] = [
    ...(turn.runId ? usedPages(sessions, [turn.runId]) : []).map(({ firstUsedAt, ...page }) => ({
      at: firstUsedAt,
      place: { kind: "page" as const, page },
    })),
    ...turnPhones(turn, machines).map((phone) => ({
      at: phone.firstUsedAt,
      place: { kind: "phone" as const, phone },
    })),
    ...turnApps(turn, machines).map((app) => ({
      at: app.firstUsedAt,
      place: { kind: "app" as const, app },
    })),
  ];
  return used
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map(({ place }) => place);
}

/**
 * The Mac apps the given Runs hold now, one per app per Mac. A Mac session
 * lasts only while its Run uses the Mac, so a finished reply names none.
 */
export function runApps(
  snapshot: Pick<HostSnapshot, "connection"> & { readonly machines: readonly MachineSummary[] },
  runIds: readonly string[],
): AppSurfaceItem[] {
  const runs = new Set(runIds);
  return computerItems(snapshot, (session) => runs.has(session.runId))
    .filter((item): item is AppSurfaceItem => item.kind === "app")
    .sort(stableOrder);
}

/** Whole phone displays the given Runs hold now, one per phone. */
export function runPhones(
  snapshot: Pick<HostSnapshot, "connection"> & { readonly machines: readonly MachineSummary[] },
  runIds: readonly string[],
): PhoneSurfaceItem[] {
  const runs = new Set(runIds);
  return computerItems(snapshot, (session) => runs.has(session.runId))
    .filter((item): item is PhoneSurfaceItem => item.kind === "phone")
    .sort(stableOrder);
}

export type LiveWorkState = "needs-you" | "working" | "waiting" | "idle";

/** One conversation in the overview: what it is doing now, and where. */
export interface LiveWorkGroup {
  /** The conversation, which opens it; null for a browser no conversation uses. */
  readonly threadId: string | null;
  /** The conversation's title, or its page's while this client has not read the conversation. */
  readonly title: string;
  readonly state: LiveWorkState;
  /** One short line, or null when there is nothing to say. */
  readonly statusLine: string | null;
  readonly surfaces: readonly SurfaceItem[];
}

const stateRank: Record<LiveWorkState, number> = {
  "needs-you": 0,
  working: 1,
  waiting: 2,
  idle: 3,
};

/**
 * The overview across conversations: each conversation that needs the person,
 * is working, or has a browser or app open, with the surfaces it uses. A
 * surface appears once, under the most specific listed conversation using it,
 * so a task's page is not repeated under the conversation that delegated it.
 * Every open browser appears, including one whose conversation this client
 * has not read, so nothing left open is out of reach.
 */
export function liveWork(
  snapshot: LiveWorkSource,
  options: {
    /** What a conversation's reply under way says it is doing, when this client knows. */
    readonly composingLabel?: (threadId: string) => string | null;
  } = {},
): LiveWorkGroup[] {
  const waiting = threadsWaitingOnReader(snapshot.waitingRequests);
  const shown = mergeTaskEntries(snapshot.tasks?.entries ?? [], snapshot.activeTasks).map(
    ({ thread }) => thread,
  );
  const depth = new Map(shown.map((thread) => [thread.id, threadDepth(snapshot, thread.id)]));
  // Deepest conversations claim their surfaces first, so a task keeps its own page.
  const claimed = new Set<string>();
  const surfacesByThread = new Map<string, SurfaceItem[]>();
  for (const thread of [...shown].sort(
    (left, right) => (depth.get(right.id) ?? 0) - (depth.get(left.id) ?? 0),
  )) {
    const own = conversationSurfaces(snapshot, thread.id).filter((item) => !claimed.has(item.key));
    for (const item of own) claimed.add(item.key);
    surfacesByThread.set(thread.id, own);
  }
  const listed = shown
    .map((thread): LiveWorkGroup & { readonly updatedAt: string } => {
      const surfaces = surfacesByThread.get(thread.id) ?? [];
      const state: LiveWorkState = waiting.has(thread.id)
        ? "needs-you"
        : thread.status === "running"
          ? "working"
          : thread.status === "waiting"
            ? "waiting"
            : "idle";
      return {
        state,
        statusLine: statusLine(state, thread.id, surfaces, options),
        surfaces,
        threadId: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
      };
    })
    .filter((group) => group.state !== "idle" || group.surfaces.length > 0)
    .sort(
      (left, right) =>
        stateRank[left.state] - stateRank[right.state] ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .map(({ updatedAt: _updatedAt, ...group }): LiveWorkGroup => group);
  const unlisted = snapshot.browserSessions
    .filter((session) => openBrowserStates.has(session.state))
    .flatMap((session) => browserItems(session, snapshot.browserProfiles))
    .filter((item) => !claimed.has(item.key))
    .map((item): LiveWorkGroup => ({
      state: "idle",
      statusLine: null,
      surfaces: [item],
      threadId: item.session.threadIds?.[0] ?? null,
      title: item.title,
    }));
  return [...listed, ...unlisted];
}

function statusLine(
  state: LiveWorkState,
  threadId: string,
  surfaces: readonly SurfaceItem[],
  options: { readonly composingLabel?: (threadId: string) => string | null },
): string | null {
  if (state === "needs-you") return "Needs you";
  if (state === "waiting") return "Waiting on someone";
  if (state === "idle") return null;
  const acting = surfaces.find((item) => item.acting);
  if (acting?.kind === "browser") return acting.site ? `On ${acting.site}` : `In ${acting.title}`;
  if (acting?.kind === "app") return `Using ${acting.app.displayName}`;
  return options.composingLabel?.(threadId) ?? "Working";
}

/** How many hand-offs separate a conversation from the one that started its work. */
function threadDepth(snapshot: Pick<HostSnapshot, "assignments">, threadId: string): number {
  const parents = new Map<string, string>();
  for (const assignment of Object.values(snapshot.assignments)) {
    parents.set(assignment.workerThread.id, assignment.parentThreadId);
  }
  let depth = 0;
  const seen = new Set([threadId]);
  for (let current = parents.get(threadId); current !== undefined; current = parents.get(current)) {
    if (seen.has(current)) break;
    seen.add(current);
    depth += 1;
  }
  return depth;
}
