import { TabIdSchema, type BrowserPageContentPart, type TabId } from "@opensteer/core";
import { computerAppIdentityKey, type ComputerAppIdentity } from "@opensteer/protocol";
import type { Turn } from "./agent-activity-model.js";
import type {
  BrowserSessionUseSummary,
  HostSnapshot,
  PlaceEntry,
  TranscriptEntry,
} from "./client.js";
import { placeList, placeOf, type PlaceItem } from "./places.js";
import { mergeTaskEntries } from "./task-entries.js";
import { threadsWaitingOnReader } from "./waiting-requests.js";

/** Where navigation goes: one tab in the person's list, by its stable ID. */
export interface TabDestination {
  readonly kind: "tab";
  readonly tabId: TabId;
}

/** Exactly which native picture a display socket reads: the person's own view, or a task's session. */
export type NativeViewerSource =
  | { readonly kind: "task-session"; readonly sessionId: string; readonly appKey?: string }
  | { readonly kind: "owner-view"; readonly viewId: string; readonly generation: number };

/** A tab a conversation, or work it handed out, is using now. */
export type SurfaceItem = PlaceItem & { readonly acting: boolean };

export type ConversationSurfaceSource = Pick<
  HostSnapshot,
  "assignments" | "tabs" | "browserProfiles" | "connection"
>;
/** Exactly the state a conversation's surface grid draws, besides the tab rows themselves. */
export function sameConversationSurfaceSource(
  previous: ConversationSurfaceSource,
  next: ConversationSurfaceSource,
): boolean {
  return (
    previous.assignments === next.assignments &&
    previous.tabs === next.tabs &&
    previous.browserProfiles === next.browserProfiles &&
    previous.connection === next.connection
  );
}

const liveWorkKeys = ["tasks", "activeTasks", "waitingRequests"] as const;
export type LiveWorkSource = ConversationSurfaceSource &
  Pick<HostSnapshot, (typeof liveWorkKeys)[number]>;

export function sameLiveWorkSource(previous: LiveWorkSource, next: LiveWorkSource): boolean {
  return (
    sameConversationSurfaceSource(previous, next) &&
    liveWorkKeys.every((key) => previous[key] === next[key])
  );
}

/** A page's site as a person reads it: its host, without the "www." that says nothing. */
export function pageSiteLabel(url: string): string | null {
  return hostName(url)?.replace(/^www\./u, "") || null;
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
 * Every tab a conversation is using now, including work its tasks do, in the
 * person's layout order. A tab belongs to a conversation while the Host lists
 * one of those tasks in its usedBy.
 */
export function conversationSurfaces(
  snapshot: ConversationSurfaceSource,
  threadId: string,
): SurfaceItem[] {
  const threads = conversationThreadIds(snapshot, threadId);
  return placeList(snapshot)
    .filter((place) => place.tab.usedBy.some((holder) => threads.has(holder.taskId)))
    .map(surfaceItem);
}
const surfaceItems = new WeakMap<PlaceItem, SurfaceItem>();
function surfaceItem(place: PlaceItem): SurfaceItem {
  let item = surfaceItems.get(place);
  if (!item) surfaceItems.set(place, (item = { ...place, acting: false }));
  return item;
}

/** A page a reply's Runs used, kept even after its tab closed. */
export interface RunPage {
  readonly key: string;
  readonly destination: TabDestination;
  readonly title: string;
  readonly site: string | null;
  /** The tab is gone from the person's list; the link still names it but cannot open it. */
  readonly ended: boolean;
  readonly acting: boolean;
  readonly favicon: string | null;
}
type TabSource = Pick<HostSnapshot, "tabs" | "browserProfiles">;
function liveTab(source: TabSource, tabId: string): PlaceItem | null {
  const tab = source.tabs.get(tabId as TabId);
  return tab ? placeOf(tab, source.browserProfiles) : null;
}

/** Each page the given Runs used, one per tab, in the order they were first used. */
export function runPages(
  uses: readonly BrowserSessionUseSummary[],
  source: TabSource,
  runIds: readonly string[],
): RunPage[] {
  return usedPages(uses, source, runIds).map(({ firstUsedAt: _firstUsedAt, ...page }) => page);
}

/** Where a Run entered a tab: that exact tab while it is listed, named as it was then. */
export function placePage(entry: PlaceEntry, source: TabSource): RunPage {
  const place = liveTab(source, entry.tabId);
  const site = entry.site ? pageSiteLabel(entry.site) : null;
  return {
    acting: false,
    destination: { kind: "tab", tabId: entry.tabId },
    ended: place === null,
    favicon: null,
    key: entry.tabId,
    site: place?.site ?? site,
    title: place?.title ?? (entry.title.trim() || site || "Tab"),
  };
}

function usedPages(
  uses: readonly BrowserSessionUseSummary[],
  source: TabSource,
  runIds: readonly string[],
): (RunPage & { readonly firstUsedAt: string })[] {
  const runs = new Set(runIds);
  const pages = new Map<string, RunPage & { readonly firstUsedAt: string }>();
  for (const use of uses) {
    if (use.runId === null || !runs.has(use.runId) || !use.tabId) continue;
    const tabId = TabIdSchema.parse(use.tabId);
    const held = pages.get(tabId);
    if (held && held.firstUsedAt <= use.firstUsedAt) continue;
    const place = liveTab(source, tabId);
    const recordedSite = use.pageSite ? hostName(use.pageSite) : null;
    const site = place?.site ?? recordedSite;
    pages.set(tabId, {
      acting: false,
      destination: { kind: "tab", tabId },
      ended: place === null,
      favicon: null,
      firstUsedAt: use.firstUsedAt,
      key: tabId,
      site,
      title: place?.title ?? (use.pageTitle?.trim() || null) ?? site ?? "Page",
    });
  }
  return [...pages.values()].sort(
    (left, right) =>
      left.firstUsedAt.localeCompare(right.firstUsedAt) || left.key.localeCompare(right.key),
  );
}

/**
 * The pages a person included with a message, as chips: the tab's current
 * title while it is listed, else what the person saw when they sent it.
 */
export function messagePages(
  pages: readonly BrowserPageContentPart[],
  source: TabSource,
): RunPage[] {
  return pages.map((page) => {
    const place = liveTab(source, page.tabId);
    return {
      acting: false,
      destination: { kind: "tab", tabId: page.tabId },
      ended: place === null,
      favicon: null,
      key: page.tabId,
      site: place?.site ?? hostName(page.url),
      title: place?.title ?? (page.title.trim() || hostName(page.url) || "Page"),
    };
  });
}

/** The first listed window tab of this app on this computer, or the computer's phone tab. */
function nativeTab(
  source: TabSource,
  match: { readonly computerId: string } & (
    { readonly kind: "window"; readonly bundleId: string } | { readonly kind: "phone" }
  ),
): PlaceItem | null {
  return (
    placeList(source).find(
      (place) =>
        place.kind === match.kind &&
        place.device.machineId === match.computerId &&
        (match.kind === "phone" || place.tab.bundleId === match.bundleId),
    ) ?? null
  );
}

/** A Mac app a reply's steps worked in, kept after the agent is done with it. */
export interface TurnApp {
  readonly key: string;
  readonly app: ComputerAppIdentity;
  readonly title: string;
  /** Its window tab while one is listed; else the chip only names it. */
  readonly destination: TabDestination | null;
  readonly ended: boolean;
  readonly acting: boolean;
  /** The reply's first step in the app. */
  readonly firstUsedAt: string;
}

/** The Mac apps a reply's steps worked in, one per app per Mac, from the steps themselves. */
export function turnApps(turn: Pick<Turn, "runId" | "work">, source: TabSource): TurnApp[] {
  const apps = new Map<string, TurnApp>();
  for (const entry of turn.work) {
    if (entry.kind !== "tool" || entry.tool?.name === "computer_use") continue;
    const place = entry.integration?.computerApp;
    if (!place) continue;
    const app: ComputerAppIdentity = {
      bundleId: place.bundleId,
      displayName: place.app,
      teamId: null,
    };
    const key = `app:${place.runnerId}:${computerAppIdentityKey(app)}`;
    const held = apps.get(key);
    if (held) {
      // Subagents' steps follow the reply's own, so the earliest one is looked for.
      if (entry.createdAt < held.firstUsedAt)
        apps.set(key, { ...held, firstUsedAt: entry.createdAt });
      continue;
    }
    const tab = nativeTab(source, {
      kind: "window",
      computerId: place.runnerId,
      bundleId: place.bundleId,
    });
    apps.set(key, {
      acting: false,
      app,
      destination: tab?.destination ?? null,
      ended: tab === null,
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
  readonly destination: TabDestination | null;
  readonly ended: boolean;
  readonly acting: boolean;
  /** The reply's first step on the phone. */
  readonly firstUsedAt: string;
}

/** Phones named by the reply's own and delegated steps, one per computer. */
export function turnPhones(turn: Pick<Turn, "runId" | "work">, source: TabSource): TurnPhone[] {
  const phones = new Map<string, TurnPhone>();
  for (const entry of turn.work) {
    if (entry.kind !== "tool" || entry.tool?.name === "computer_use" || !entry.integration?.phone)
      continue;
    const place = entry.integration.phone;
    const key = `phone:${place.runnerId}`;
    const held = phones.get(key);
    if (held) {
      if (entry.createdAt < held.firstUsedAt)
        phones.set(key, { ...held, firstUsedAt: entry.createdAt });
      continue;
    }
    const tab = nativeTab(source, { kind: "phone", computerId: place.runnerId });
    phones.set(key, {
      acting: false,
      destination: tab?.destination ?? null,
      ended: tab === null,
      firstUsedAt: entry.createdAt,
      key,
      title: place.computer,
    });
  }
  return [...phones.values()];
}

/** One place a reply's Run used: a page, a phone or a Mac app window. */
export type ReplyPlace =
  | { readonly kind: "page"; readonly page: RunPage }
  | { readonly kind: "phone"; readonly phone: TurnPhone }
  | { readonly kind: "app"; readonly app: TurnApp };

/** A recorded stop stays readable even after its tab closes. */
export function placeReply(entry: PlaceEntry, source: TabSource): ReplyPlace {
  const place = liveTab(source, entry.tabId);
  const destination: TabDestination = { kind: "tab", tabId: entry.tabId };
  if (place?.kind === "window")
    return {
      kind: "app",
      app: {
        key: entry.tabId,
        title: entry.title,
        app: { bundleId: place.tab.bundleId ?? "", displayName: place.title, teamId: null },
        firstUsedAt: entry.createdAt,
        destination,
        ended: false,
        acting: false,
      },
    };
  if (place?.kind === "phone")
    return {
      kind: "phone",
      phone: {
        key: entry.tabId,
        title: entry.title,
        firstUsedAt: entry.createdAt,
        destination,
        ended: false,
        acting: false,
      },
    };
  return { kind: "page", page: placePage(entry, source) };
}

/**
 * Every place a reply's Run used, whatever its kind, in the order it first
 * used them: a place used later always comes after, so none ever moves.
 */
export function replyPlaces(
  turn: Pick<Turn, "runId" | "work">,
  uses: readonly BrowserSessionUseSummary[],
  source: TabSource,
): ReplyPlace[] {
  const used: { readonly at: string; readonly place: ReplyPlace }[] = [
    ...(turn.runId ? usedPages(uses, source, [turn.runId]) : []).map(
      ({ firstUsedAt, ...page }) => ({
        at: firstUsedAt,
        place: { kind: "page" as const, page },
      }),
    ),
    ...turnPhones(turn, source).map((phone) => ({
      at: phone.firstUsedAt,
      place: { kind: "phone" as const, phone },
    })),
    ...turnApps(turn, source).map((app) => ({
      at: app.firstUsedAt,
      place: { kind: "app" as const, app },
    })),
  ];
  for (const entry of turn.work)
    if (entry.kind === "place")
      used.push({ at: entry.createdAt, place: placeReply(entry, source) });
  const unique = new Map<string, ReplyPlace>();
  for (const { place } of used.sort((left, right) => Date.parse(left.at) - Date.parse(right.at))) {
    const destination =
      place.kind === "page"
        ? place.page.destination
        : place.kind === "app"
          ? place.app.destination
          : place.phone.destination;
    const key =
      destination?.tabId ??
      (place.kind === "page"
        ? place.page.key
        : place.kind === "app"
          ? place.app.key
          : place.phone.key);
    if (!unique.has(key)) unique.set(key, place);
  }
  return [...unique.values()];
}

/**
 * Everything a transcript's page, app and phone chips read of the tab list (`placePage`,
 * `messagePages`, `usedPages`, `turnApps` and `turnPhones` above): the profiles, the rows of the
 * tabs it names, and, once it names a Mac app or a phone, the other tabs with their order. Item by
 * item the same until one of those changes, so a transcript follows its own tabs, not every tab.
 */
export function transcriptTabReads(
  entries: readonly TranscriptEntry[],
  uses: readonly BrowserSessionUseSummary[],
  source: TabSource,
): readonly unknown[] {
  const named = new Set<string>();
  let native = false;
  for (const entry of entries) {
    if (entry.kind === "place") named.add(entry.tabId);
    else if (entry.kind === "message") for (const page of entry.pages ?? []) named.add(page.tabId);
    else if (
      entry.kind === "tool" &&
      entry.tool?.name !== "computer_use" &&
      (entry.integration?.computerApp || entry.integration?.phone)
    )
      native = true;
  }
  for (const use of uses) if (use.runId !== null && use.tabId) named.add(use.tabId);
  const reads: unknown[] = [source.browserProfiles];
  for (const tabId of named) reads.push(source.tabs.get(tabId as TabId));
  if (native) {
    reads.push(source.tabs.strip);
    for (const tab of source.tabs.rows.values()) if (tab.kind !== "page") reads.push(tab);
  }
  return reads;
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
  // A tab in use by work this client has not read still appears, so nothing is out of reach.
  const unlisted = placeList(snapshot)
    .filter((place) => place.tab.usedBy.length > 0 && !claimed.has(place.key))
    .map((place): LiveWorkGroup => ({
      state: "idle",
      statusLine: null,
      surfaces: [surfaceItem(place)],
      threadId: place.tab.usedBy[0]!.taskId,
      title: place.title,
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
  if (acting?.kind === "page") return acting.site ? `On ${acting.site}` : `In ${acting.title}`;
  if (acting?.kind === "window") return `Using ${acting.tab.appName ?? acting.title}`;
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
