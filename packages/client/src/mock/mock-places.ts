import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  nextMarkColor,
  type EventData,
} from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import {
  BrowserContextCandidateSchema,
  BrowserHistoryUrlSchema,
  BrowserProfileSchema,
  BrowserSessionTabOpenCommandSchema,
  BrowserTabCatalogSchema,
  BrowserTabCloseResultSchema,
  BrowserTabIconInputSchema,
  BrowserTabIconResultSchema,
  BrowserTabOpenCommandSchema,
  BrowserTabOpenResultSchema,
  ComputerUseSessionSummarySchema,
  HostedBrowserSessionSchema,
  PlaceActivitySchema,
  PlaceIdentitySchema,
  WorkspaceTabActivateResultSchema,
  WorkspaceTabReopenResultSchema,
  browserHistoryMaxEntries,
  browserHistoryRetentionMs,
  createBrowserSessionId,
  previousReleaseEligibility,
  type BrowserHistory,
  type BrowserTabOpenCommand,
  type BrowserTabOpenResult,
  type PlaceOccupant,
  type WorkspaceTabLineage,
} from "@opensteer/protocol";
import { browserTabArrangement, browserTabOrderTabs } from "../host/browser-tab-order.js";
import type { BrowserWatchState } from "../host/browser-watch.js";
import type {
  BrowserCommand,
  BrowserFrameView,
  BrowserSessionSummary,
  HostSnapshot,
} from "../host/client.js";
import { HostClientRequestError } from "../host/client.js";
import { LatestPlaceStore } from "../host/latest-place.js";
import { PlaceActivityStore } from "../host/place-activity.js";
import { placeList } from "../host/places.js";
import { mockBrowserPageImage } from "./mock-browser-frames.js";

const iconData =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const historyIconRef = "2640059609118b695c139804676372eca75c30d30e5906775902d13e44f5356c";
const emptyWatch: BrowserWatchState = { frame: null, error: null, status: "unavailable" };
/** How long a mock page takes to load, long enough to see its tab's spinner. */
const mockPageLoadMs = 900;
/** The window each scripted task is working in, by app; every app has its own. */
const mockSessionWindows: Readonly<
  Record<string, { readonly id: number; readonly title: string }>
> = {
  Keynote: { id: 301, title: "Q4 review" },
  Notes: { id: 101, title: "Shopping list" },
  Slack: { id: 201, title: "#launch" },
};
/** Each fixture picture decoded once, not again for every frame. */
const decodedPages = new Map<string, Uint8Array<ArrayBuffer>>();
function decodedPageImage(title: string): Uint8Array<ArrayBuffer> {
  const base64 = mockBrowserPageImage(title);
  let bytes = decodedPages.get(base64);
  if (!bytes) {
    bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    decodedPages.set(base64, bytes);
  }
  return bytes;
}
const sessionId = (index: number) =>
  `bsn_00000000-0000-4000-8000-${String(800 + index).padStart(12, "0")}`;
/**
 * `busy` is the decisive world of the approved design: 21 tabs over two
 * computers, two Work browsers and two separate Guest browsers. `stress`
 * adds one browser with 64 tabs, the bounded large case.
 */
export type MockPlacesWorld = "seeded" | "busy" | "stress";
export function seedMockPlaces(
  snapshot: HostSnapshot,
  now: Date,
  world: MockPlacesWorld = "seeded",
): HostSnapshot {
  const busy = world !== "seeded";
  const threads = snapshot.threads.filter(
    (thread) => thread.listed && thread.id !== snapshot.homeThreadId,
  );
  const first = threads.find((thread) => thread.status === "running") ?? threads[0];
  if (!first) return snapshot;
  const at = now.toISOString();
  const occupant = (id: string, acting = true): PlaceOccupant => {
    const thread = snapshot.threads.find((thread) => thread.id === id);
    const live = !thread || thread.status === "running" || thread.status === "waiting";
    return {
      threadId: ThreadIdSchema.parse(id),
      home: id === snapshot.homeThreadId,
      holding: live,
      acting: acting && (!thread || thread.status === "running"),
      lastActiveAt: at,
    };
  };
  const sessions: BrowserSessionSummary[] = [];
  const add = (
    index: number,
    origin: BrowserSessionSummary["origin"],
    pages: readonly {
      title: string;
      site: string;
      occupants: PlaceOccupant[];
      openerIndex?: number;
    }[],
  ) => {
    const id = sessionId(index);
    const catalog = BrowserTabCatalogSchema.parse({
      generation: 1,
      revision: 1,
      inventoryRevision: 1,
      tabs: pages.map((page, order) => ({
        id: `mock-tab-${index}-${order}`,
        title: page.title,
        site: page.site,
        order,
        iconRef: `icon-${index}-${order}`,
        openerId: page.openerIndex === undefined ? null : `mock-tab-${index}-${page.openerIndex}`,
        documentId: `mock-document-${index}-${order}-1`,
        availability: "ready",
        occupants: page.occupants,
      })),
    });
    sessions.push({
      access: "full-control",
      acting: pages.some((page) => page.occupants.some((value) => value.acting)),
      attachedRunIds: [
        ...new Set(
          pages.flatMap((page) =>
            page.occupants
              .filter((occupant) => occupant.holding)
              .flatMap((occupant) =>
                snapshot.runQueue
                  .filter(
                    (run) =>
                      run.threadId === occupant.threadId &&
                      (run.status === "running" || run.status === "waiting"),
                  )
                  .map((run) => run.id),
              ),
          ),
        ),
      ],
      createdAt: new Date(now.getTime() - (20 - index) * 1000).toISOString(),
      dialog: null,
      error: null,
      id,
      origin,
      placement: {
        kind: "runner",
        runnerId: snapshot.machines[0]?.id ?? "rnr_11111111-1111-4111-8111-111111111111",
      },
      opener:
        origin === "trigger"
          ? { kind: "automation" }
          : index === 6
            ? { kind: "opensteer" }
            : origin === "workspace"
              ? { kind: "you" }
              : {
                  kind: "task",
                  threadId: pages[0]?.occupants[0]?.threadId ?? ThreadIdSchema.parse(first.id),
                },
      profileId:
        index === 0 || index === 1
          ? "bpr_00000000-0000-4000-8000-000000000001"
          : index === 2 || index === 6
            ? "bpr_00000000-0000-4000-8000-000000000002"
            : null,
      runtimeId: "mock-targeted-runtime",
      state: "ready",
      tabCatalog: catalog,
      tabs: catalog.tabs.map((tab, index) => ({
        active: index === 0,
        id: tab.id,
        title: tab.title,
        url: `${tab.site}/`,
        favicon: iconData,
      })),
      threadIds: [
        ...new Set(pages.flatMap((page) => page.occupants.map(({ threadId }) => threadId))),
      ],
      uses: catalog.tabs.flatMap((tab) =>
        tab.occupants
          .filter((occupant) => occupant.acting)
          .flatMap((occupant) => {
            const run = snapshot.runQueue.find(
              (candidate) =>
                candidate.threadId === occupant.threadId &&
                (candidate.status === "running" || candidate.status === "waiting"),
            );
            return run
              ? [
                  {
                    threadId: occupant.threadId,
                    runId: run.id,
                    tabId: tab.id,
                    firstUsedAt: at,
                    lastUsedAt: at,
                    pageTitle: tab.title,
                    pageSite: tab.site,
                  },
                ]
              : [];
          }),
      ),
      page: { title: pages[0]?.title ?? "New tab", url: pages[0]?.site ?? "about:blank" },
      viewerError: null,
      viewerState: "disconnected",
      workspaceId:
        origin === "workspace"
          ? (snapshot.homeWorkspaceId ?? first.workspaceId)
          : first.workspaceId,
    });
  };
  add(0, "workspace", [
    { title: "Your reading list", site: "https://en.wikipedia.org", occupants: [] },
    { title: "Le Petit Jardin", site: "https://resy.com", occupants: [occupant(first.id)] },
    {
      title: "Confirm your reservation",
      site: "https://resy.com",
      occupants: [occupant(first.id, false)],
      openerIndex: 0,
    },
    ...(busy
      ? [
          { title: "Inbox (3) – Gmail", site: "https://mail.google.com", occupants: [] },
          { title: "Lisbon · Stays – Airbnb", site: "https://www.airbnb.com", occupants: [] },
          { title: "Nopa – Resy", site: "https://resy.com", occupants: [] },
        ]
      : []),
  ]);
  threads.slice(0, 4).forEach((thread, index) =>
    add(index + 1, "agent", [
      {
        title: ["Friday dinner", "PortableFS documentation", "Launch brief", "Coffee shortlist"][
          index
        ]!,
        site: [
          "https://resy.com",
          "https://github.com",
          "https://docs.google.com",
          "https://maps.google.com",
        ][index]!,
        occupants: [occupant(thread.id, thread.status === "running")],
      },
      ...(busy && index < 2
        ? [
            {
              title: ["Nopa – OpenTable", "Q4 revenue model – Google Sheets"][index]!,
              site: ["https://www.opentable.com", "https://docs.google.com"][index]!,
              occupants: [occupant(thread.id, false)],
            },
          ]
        : []),
    ]),
  );
  if (snapshot.homeThreadId)
    add(6, "workspace", [
      {
        title: "Weekend ideas",
        site: "https://www.nps.gov",
        occupants: [occupant(snapshot.homeThreadId)],
      },
    ]);
  add(7, "trigger", [
    { title: "Flight award alerts", site: "https://www.united.com", occupants: [] },
  ]);
  add(8, "workspace", [
    { title: "Q4 roadmap – Linear", site: "https://linear.app", occupants: [] },
    ...(busy
      ? [
          { title: "Pull requests · opensteer", site: "https://github.com", occupants: [] },
          { title: "Launch brief – Google Docs", site: "https://docs.google.com", occupants: [] },
          { title: "Q4 numbers – Notion", site: "https://www.notion.so", occupants: [] },
          { title: "Figma – Board deck", site: "https://www.figma.com", occupants: [] },
        ]
      : []),
  ]);
  sessions[sessions.length - 1] = {
    ...sessions[sessions.length - 1]!,
    profileId: "bpr_00000000-0000-4000-8000-000000000002",
    opener: { kind: "you" },
  };
  if (busy) {
    // A second Guest browser of the person's own, on the other computer.
    add(9, "workspace", [
      { title: "SFO → JFK · Google Flights", site: "https://www.google.com", occupants: [] },
      { title: "SFO to NYC – Kayak", site: "https://www.kayak.com", occupants: [] },
    ]);
    sessions[sessions.length - 1] = {
      ...sessions[sessions.length - 1]!,
      placement: { kind: "runner", runnerId: "rnr_88888888-8888-4888-8888-888888888888" },
    };
  }
  if (world === "stress")
    add(
      10,
      "agent",
      Array.from({ length: 64 }, (_, order) => ({
        title: `Supplier ${order + 1} – Quote comparison`,
        site: `https://supplier-${order + 1}.example.com`,
        occupants: order === 0 ? [occupant(first.id)] : [],
      })),
    );
  const machines: MachineSummary[] = snapshot.machines.map((machine) => ({
    ...machine,
    computerUse: machine.computerUse
      ? {
          ...machine.computerUse,
          ...(machine.device?.form === "phone" ? {} : { ownerViewVersion: 3 }),
          ownerViews: [],
          sessions: machine.computerUse.sessions.map((session) => ({
            ...session,
            windows: session.apps.map((app) => ({
              appKey: app.bundleId.toLowerCase(),
              ...(mockSessionWindows[app.displayName] ?? { id: 900, title: "Untitled" }),
            })),
            actingAppKeys: session.apps.map((app) => app.bundleId.toLowerCase()),
            actingDisplay: false,
            actor: { threadId: session.threadId, home: false },
          })),
        }
      : null,
  }));
  const mac = machines.find((machine) =>
    machine.computerUse?.sessions.some((session) => !session.display),
  );
  if (mac?.computerUse) {
    const second = threads[1] ?? first;
    const secondRun = snapshot.runQueue.find(
      (run) => run.threadId === second.id && (run.status === "running" || run.status === "waiting"),
    );
    if (secondRun)
      machines.push({
        ...mac,
        id: "rnr_88888888-8888-4888-8888-888888888888",
        name: "Studio Mac",
        computerUse: {
          ...mac.computerUse,
          sessions: [
            ComputerUseSessionSummarySchema.parse({
              actionCount: 3,
              apps: [{ bundleId: "com.apple.Keynote", displayName: "Keynote", teamId: null }],
              display: false,
              actingAppKeys: ["com.apple.keynote"],
              openedAt: at,
              runId: secondRun.id,
              sessionId: "cus_00000000-0000-4000-8000-000000000888",
              threadId: second.id,
              threadTitle: second.title,
              actor: { threadId: second.id, home: false },
            }),
          ],
        },
      });
  }
  const waitingThread = {
    ...first,
    id: "thr_00000000-0000-4000-8000-000000000902",
    title: "Prepare the weekly report",
    icon: "chart" as const,
    color: nextMarkColor(
      [...snapshot.threads].reverse().flatMap(({ color }) => (color === null ? [] : [color])),
    ),
    status: "waiting" as const,
    inputQueuePaused: true,
    pendingRequests: 0,
    unread: false,
    createdAt: at,
    updatedAt: at,
  };
  const phoneThread = {
    ...first,
    id: "thr_00000000-0000-4000-8000-000000000903",
    title: "Check the delivery ETA",
    icon: "truck" as const,
    color: nextMarkColor([
      waitingThread.color,
      ...[...snapshot.threads].reverse().flatMap(({ color }) => (color === null ? [] : [color])),
    ]),
    status: "running" as const,
    inputQueuePaused: false,
    pendingRequests: 0,
    unread: true,
    createdAt: at,
    updatedAt: at,
  };
  for (const machine of machines)
    if (machine.computerUse)
      machine.computerUse = {
        ...machine.computerUse,
        sessions: machine.computerUse.sessions.map((session) =>
          session.display
            ? {
                ...session,
                threadId: ThreadIdSchema.parse(phoneThread.id),
                threadTitle: phoneThread.title,
                actingDisplay: true,
                runId: RunIdSchema.parse("run_00000000-0000-4000-8000-000000000903"),
                actor: { threadId: ThreadIdSchema.parse(phoneThread.id), home: false },
              }
            : session,
        ),
      };
  return {
    ...snapshot,
    browserAvailable: true,
    browserProfiles: [
      BrowserProfileSchema.parse({
        id: "bpr_00000000-0000-4000-8000-000000000001",
        name: "Personal",
        revision: 1,
      }),
      BrowserProfileSchema.parse({
        id: "bpr_00000000-0000-4000-8000-000000000002",
        name: "Work",
        revision: 1,
      }),
    ],
    browserPlacements: machines
      .filter(
        (machine) => machine.device?.platform === "macos" && machine.computerUse?.state === "ready",
      )
      .map((machine) => ({
        kind: "runner" as const,
        runnerId: machine.id,
        label: machine.name,
        available: machine.status === "online",
        runtimeId: "mock-targeted-runtime",
        environmentIds: [],
      })),
    browserSessions: sessions,
    machines,
    threads: [...snapshot.threads, waitingThread, phoneThread],
    transcripts: {
      ...snapshot.transcripts,
      [waitingThread.id]: [
        {
          createdAt: at,
          error: null,
          id: "run:run_00000000-0000-4000-8000-000000000902",
          kind: "run",
          replyMessageId: null,
          runId: "run_00000000-0000-4000-8000-000000000902",
          status: "waiting",
        },
      ],
      [phoneThread.id]: [
        {
          createdAt: at,
          error: null,
          id: "run:run_00000000-0000-4000-8000-000000000903",
          kind: "run",
          replyMessageId: null,
          runId: "run_00000000-0000-4000-8000-000000000903",
          status: "running",
        },
      ],
    },
    transcriptWindows: {
      ...snapshot.transcriptWindows,
      [waitingThread.id]: {
        byteCount: 0,
        hasMore: false,
        itemCount: 0,
        nextBefore: null,
        threadId: waitingThread.id,
        totalItems: 0,
      },
      [phoneThread.id]: {
        byteCount: 0,
        hasMore: false,
        itemCount: 0,
        nextBefore: null,
        threadId: phoneThread.id,
        totalItems: 0,
      },
    },
    runQueue: [
      ...snapshot.runQueue,
      {
        id: "run_00000000-0000-4000-8000-000000000902",
        threadId: waitingThread.id,
        status: "waiting",
        createdAt: at,
        runOrdinal: 1,
      },
      {
        id: "run_00000000-0000-4000-8000-000000000903",
        threadId: phoneThread.id,
        status: "running",
        createdAt: at,
        runOrdinal: 1,
      },
    ],
  };
}

export interface MockPlaceScript {
  /** Applies a Host place notice as the Host's client would receive it. */
  apply(notice: unknown): void;
  /** Crops a page's picture to a region of its view, or shows all of it again. */
  crop(
    sessionId: string,
    surfaceId: string,
    region: { readonly width: number; readonly height: number } | null,
  ): void;
}

/** All animation derives from elapsed injected-clock time and stable fixture IDs. */
export class MockPlaceWorld {
  readonly #history = new Map<string, BrowserHistory>();
  readonly #historyChanged: (profileId: string) => void;
  readonly #entered: (runId: string, threadId: string, data: EventData<"place.entered">) => void;
  readonly #historyOwner: string | undefined;
  readonly activity: PlaceActivityStore;
  readonly latest = new LatestPlaceStore();
  readonly #watches = new Map<
    string,
    { holds: number; state: BrowserWatchState; awaiting: string | null }
  >();
  readonly #identityOpens = new Map<
    string,
    { fingerprint: string; result: Promise<BrowserTabOpenResult> }
  >();
  readonly #rememberedPlacements = new Map<string, string>();
  readonly #profileHolders = new Map<string, { runnerId: string }>();
  readonly #openedTabs = new Map<string, { fingerprint: string; result: BrowserTabOpenResult }>();
  readonly #nativeReferences = new Set<string>();
  readonly #watchListeners = new Map<string, Set<() => void>>();
  readonly #snapshot: () => HostSnapshot;
  readonly #update: (snapshot: HostSnapshot) => void;
  readonly #now: () => Date;
  readonly #started: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #loads = new Map<string, ReturnType<typeof setTimeout>>();
  /** The size each targeted page was last given, and how many times it changed. */
  readonly #viewports = new Map<
    string,
    { readonly width: number; readonly height: number; readonly revision: number }
  >();
  /** The region a scripted page's picture shows, as a native page's stage crops it. */
  readonly #crops = new Map<
    string,
    { readonly width: number; readonly height: number; readonly revision: number }
  >();
  readonly #closedTabs: {
    ownerId: string | undefined;
    at: number;
    lineage: WorkspaceTabLineage;
    tab: NonNullable<WorkspaceTabLineage["tabs"]>[number];
    url: string;
    preceding: string | null;
    groupId: string | null;
  }[] = [];
  readonly #restoreUrls = new Map<string, string>();
  readonly #reopenedTabs = new Map<
    string,
    ReturnType<typeof WorkspaceTabReopenResultSchema.parse>
  >();
  #scripted = false;
  #seq = 0;
  /**
   * Each picture's own id and token, as the Host mints one per frame: a viewer
   * never finishes the same picture twice.
   */
  #pictures = 0;
  #order = 0;
  #catalogTick = 0;
  #ready = false;
  constructor(
    snapshot: () => HostSnapshot,
    update: (snapshot: HostSnapshot) => void,
    now: () => Date,
    historyChanged: (profileId: string) => void = () => undefined,
    /** As the Host records it: a Run began acting in a tab. */
    entered: (runId: string, threadId: string, data: EventData<"place.entered">) => void = () =>
      undefined,
  ) {
    this.#snapshot = snapshot;
    this.#historyChanged = historyChanged;
    this.#entered = entered;
    this.#historyOwner = snapshot().user?.id;
    this.#update = update;
    this.#now = now;
    this.activity = new PlaceActivityStore();
    this.#started = now().getTime();
    this.latest.reconcile(snapshot());
    this.#rememberProfileHolders(this.#snapshot());
    this.#tick();
  }
  #rememberProfileHolders(snapshot: HostSnapshot): void {
    for (const session of snapshot.browserSessions) {
      if (!session.profileId || !["ready", "starting", "closing"].includes(session.state)) continue;
      this.#profileHolders.set(session.profileId, {
        runnerId: session.placement.runnerId,
      });
    }
  }

  reconcile(): void {
    const snapshot = this.#snapshot();
    this.#rememberProfileHolders(snapshot);
    const liveThreads = new Set(
      snapshot.threads
        .filter((thread) => thread.status === "running" || thread.status === "waiting")
        .map((thread) => thread.id),
    );
    const liveRuns = new Set(
      snapshot.runQueue
        .filter((run) => run.status === "running" || run.status === "waiting")
        .map((run) => run.id),
    );
    // A Run that ended takes its cursors with it at once, as the Host's clear does.
    for (const place of placeList(snapshot))
      for (const record of this.activity.get(place.key))
        if (!liveRuns.has(record.runId))
          this.activity.apply({
            type: "host.place-activity-cleared",
            place: record.place,
            runId: record.runId,
            generation: record.generation,
            seq: record.seq + 1,
          });
    let changed = false;
    const browserSessions = snapshot.browserSessions.map((session) => {
      if (
        !session.tabCatalog ||
        !session.tabCatalog.tabs.some((tab) =>
          tab.occupants.some((occupant) => !liveThreads.has(occupant.threadId)),
        )
      )
        return session;
      changed = true;
      const tabs = session.tabCatalog.tabs.map((tab) => ({
        ...tab,
        occupants: tab.occupants.filter((occupant) => liveThreads.has(occupant.threadId)),
      }));
      const activeRunIds = new Set(snapshot.runQueue.map(({ id }) => id));
      return {
        ...session,
        attachedRunIds: session.attachedRunIds.filter((id) => activeRunIds.has(id)),
        tabCatalog: { ...session.tabCatalog, revision: session.tabCatalog.revision + 1, tabs },
      };
    });
    const machines = snapshot.machines.map((machine) => {
      const computerUse = machine.computerUse;
      if (!computerUse?.sessions.some((session) => !liveThreads.has(session.threadId)))
        return machine;
      changed = true;
      return {
        ...machine,
        computerUse: {
          ...computerUse,
          sessions: computerUse.sessions.filter((session) => liveThreads.has(session.threadId)),
        },
      };
    });
    if (changed) {
      this.#update({ ...snapshot, browserSessions, machines });
      return;
    }
    if (snapshot.session !== "authenticated" || snapshot.connection !== "connected") {
      this.#ready = false;
      this.activity.clear();
      if (snapshot.session !== "authenticated") {
        this.latest.clear();
        this.#nativeReferences.clear();
      } else this.latest.reconcile(snapshot);
      for (const [key, watch] of this.#watches) {
        watch.state = emptyWatch;
        watch.awaiting = null;
        this.#notify(key);
      }
      return;
    }
    this.latest.reconcile(snapshot);
    if (!this.#ready) {
      this.#ready = true;
      this.#tick();
    }
    this.activity.reconcile(
      new Set(
        placeList(snapshot)
          .filter((place) => place.availability === "ready")
          .map(({ key }) => key),
      ),
    );
  }
  start(): void {
    if (this.#timer === null && !this.#scripted) this.#timer = setInterval(() => this.#tick(), 250);
  }
  /**
   * For journeys: the world stops moving on its own, so cursors move only for
   * the Host notices applied here and a picture is cropped only when told.
   */
  script(): MockPlaceScript {
    if (!this.#scripted) {
      this.#scripted = true;
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
      this.activity.clear();
    }
    return {
      apply: (notice) => this.activity.apply(notice),
      crop: (sessionId, surfaceId, region) => {
        const key = this.#key(sessionId, surfaceId);
        if (region) this.#crops.set(key, { ...region, revision: this.#pictures + 1 });
        else this.#crops.delete(key);
        // Another region is another layout: its pictures carry a new geometry revision,
        // as the Runtime's do, so a viewer takes them over the region before.
        const size = this.#viewports.get(key);
        this.#viewports.set(key, {
          width: size?.width ?? 960,
          height: size?.height ?? 600,
          revision: (size?.revision ?? 0) + 1,
        });
        const watch = this.#watches.get(key);
        if (watch) watch.awaiting = null;
        this.#frames(key);
      },
    };
  }
  actInPlace(threadId: string, placeKey: string): void {
    const snapshot = this.#snapshot();
    const place = placeList(snapshot).find((item) => item.key === placeKey);
    const run = snapshot.runQueue.find(
      (candidate) =>
        candidate.threadId === threadId &&
        (candidate.status === "running" || candidate.status === "waiting"),
    );
    if (!run || place?.destination.kind !== "browser" || place.availability !== "ready")
      throw new Error("The Run cannot act in this page.");
    const { sessionId, tabId } = place.destination;
    const at = this.#now().toISOString();
    const browserSessions = snapshot.browserSessions.map((session) => {
      if (!session.tabCatalog) return session;
      let changed = false;
      const tabs = session.tabCatalog.tabs.map((tab) => {
        const target = session.id === sessionId && tab.id === tabId;
        const present = tab.occupants.some((occupant) => occupant.threadId === threadId);
        if (!target && !present) return tab;
        changed = true;
        const occupants = tab.occupants
          .filter((occupant) => !target || occupant.threadId !== threadId)
          .map((occupant) =>
            occupant.threadId === threadId ? { ...occupant, acting: false } : occupant,
          );
        if (target)
          occupants.push({
            threadId: ThreadIdSchema.parse(threadId),
            home: threadId === snapshot.homeThreadId,
            holding: true,
            acting: true,
            lastActiveAt: at,
          });
        return { ...tab, occupants };
      });
      if (!changed) return session;
      return {
        ...session,
        attachedRunIds:
          session.id === sessionId && !session.attachedRunIds.includes(run.id)
            ? [...session.attachedRunIds, run.id]
            : session.attachedRunIds,
        ...(session.id === sessionId
          ? { threadIds: [...new Set([...(session.threadIds ?? []), threadId])] }
          : {}),
        tabCatalog: { ...session.tabCatalog, revision: session.tabCatalog.revision + 1, tabs },
      };
    });
    this.#update({ ...snapshot, browserSessions });
    const tab = snapshot.browserSessions
      .find((session) => session.id === sessionId)
      ?.tabs.find((candidate) => candidate.id === tabId);
    this.#entered(run.id, threadId, {
      place: {
        kind: "browser",
        sessionId: BrowserSessionIdSchema.parse(sessionId),
        surfaceId: BrowserSurfaceIdSchema.parse(tabId),
      },
      title: place.title.slice(0, 256),
      site: tab?.url ? originOf(tab.url) : null,
    });
    this.#tick();
  }
  subscribeActivity = (key: string, listener: () => void): (() => void) => {
    this.start();
    return this.activity.subscribe(key, listener);
  };
  #key(sessionId: string, surfaceId: string): string {
    return JSON.stringify([sessionId, surfaceId]);
  }
  watchState = (sessionId: string, surfaceId: string): BrowserWatchState =>
    this.#watches.get(this.#key(sessionId, surfaceId))?.state ?? emptyWatch;
  watchFrame = (sessionId: string, surfaceId: string): BrowserFrameView | null =>
    this.watchState(sessionId, surfaceId).frame;
  subscribeWatch = (sessionId: string, surfaceId: string, listener: () => void): (() => void) => {
    this.start();
    const key = this.#key(sessionId, surfaceId);
    const listeners = this.#watchListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#watchListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#watchListeners.delete(key);
    };
  };
  retain(sessionId: string, surfaceId: string): () => void {
    const key = this.#key(sessionId, surfaceId);
    const watch = this.#watches.get(key) ?? { holds: 0, state: emptyWatch, awaiting: null };
    watch.holds++;
    this.#watches.set(key, watch);
    this.start();
    this.#frames();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--watch.holds > 0) return;
      this.#watches.delete(key);
      this.#notify(key);
    };
  }
  activeSurface(sessionId: string): string | null {
    return (
      this.#snapshot()
        .browserSessions.find((session) => session.id === sessionId)
        ?.tabs.find((tab) => tab.active)?.id ?? null
    );
  }
  command(sessionId: string, command: BrowserCommand): void {
    const snapshot = this.#snapshot();
    const session = snapshot.browserSessions.find((session) => session.id === sessionId);
    if (!session?.tabCatalog || session.state !== "ready") {
      // As the Host client: a view's cleanup after its browser has gone needs no error.
      if (
        command.type === "stream.unsubscribe" ||
        command.type === "viewport.follow" ||
        command.type === "input.cancel"
      )
        return;
      throw new Error("The browser is unavailable.");
    }
    if (command.type === "surface.close") {
      void this.close(sessionId, command.surfaceId, session.tabCatalog, false);
      return;
    }
    let tabs = session.tabCatalog.tabs;
    let surfaces = session.tabs;
    if (command.type === "surface.open") {
      void this.open(
        sessionId,
        command.url === undefined ? {} : { url: command.url },
        crypto.randomUUID(),
        true,
      );
      return;
    } else if (command.type === "viewport.follow" || command.type === "viewport.set") {
      // A page takes the size it is given; an identical size changes nothing, and a
      // new one restarts its picture at that size, as a runtime's cast does.
      const key = this.#key(sessionId, command.surfaceId);
      const held = this.#viewports.get(key);
      if (held?.width === command.width && held.height === command.height) return;
      this.#viewports.set(key, {
        width: command.width,
        height: command.height,
        revision: (held?.revision ?? 0) + 1,
      });
      const watch = this.#watches.get(key);
      if (watch) watch.awaiting = null;
      this.#frames(key);
      return;
    } else if (command.type === "surface.activate") {
      surfaces = surfaces.map((tab) => ({ ...tab, active: tab.id === command.surfaceId }));
    } else if (
      command.type === "navigation.go" ||
      command.type === "navigation.reload" ||
      command.type === "navigation.stop"
    ) {
      const surfaceId = command.surfaceId ?? this.activeSurface(sessionId);
      // A page loads for a moment, as a real one does; Stop ends that at once.
      const loading = command.type !== "navigation.stop";
      if (surfaceId) this.#loading(sessionId, surfaceId, loading);
      surfaces = surfaces.map((tab) =>
        tab.id !== surfaceId
          ? tab
          : {
              ...tab,
              ...(command.type === "navigation.go"
                ? {
                    url: new URL(command.url).href,
                    title: new URL(command.url).hostname || "New tab",
                  }
                : {}),
              loading,
            },
      );
      tabs = tabs.map((tab) => {
        const surface = surfaces.find((surface) => surface.id === tab.id);
        return tab.id === surfaceId && surface
          ? {
              ...tab,
              title: surface.title,
              site: surface.url.startsWith("http") ? new URL(surface.url).origin : "about:blank",
              // As the runtime does, a new document has no icon until its page
              // has loaded far enough for the browser to fetch one.
              ...(loading
                ? {
                    documentId: `${tab.id}-document-${session.tabCatalog!.revision + 1}`,
                    iconRef: null,
                  }
                : { iconRef: tab.iconRef ?? `${tab.id}-icon-${session.tabCatalog!.revision + 1}` }),
              loading,
            }
          : tab;
      });
    } else return;
    const updated = {
      ...snapshot,
      browserSessions: snapshot.browserSessions.map((value) =>
        value.id === sessionId
          ? {
              ...value,
              tabs: surfaces,
              tabCatalog: {
                ...session.tabCatalog!,
                revision: session.tabCatalog!.revision + 1,
                tabs,
              },
            }
          : value,
      ),
    };
    this.#update(updated);
    const committed = updated.browserSessions.find((value) => value.id === sessionId)!;
    if (command.type === "navigation.go") {
      const surfaceId = command.surfaceId ?? this.activeSurface(sessionId);
      if (surfaceId) this.#recordVisit(committed, surfaceId, command.typed === true);
    }
    this.#retainHistoryIcons(updated);
    this.latest.reconcile(updated);
    this.#frames();
  }
  #loading(sessionId: string, surfaceId: string, loading: boolean): void {
    const key = this.#key(sessionId, surfaceId);
    clearTimeout(this.#loads.get(key));
    this.#loads.delete(key);
    if (!loading) return;
    this.#loads.set(
      key,
      setTimeout(() => {
        this.#loads.delete(key);
        try {
          this.command(sessionId, {
            surfaceId: BrowserSurfaceIdSchema.parse(surfaceId),
            type: "navigation.stop",
          });
        } catch {
          // The browser ended while the page loaded; nothing is left to stop.
        }
      }, mockPageLoadMs),
    );
  }
  accept(sessionId: string, surfaceId: string, token: string): void {
    const watch = this.#watches.get(this.#key(sessionId, surfaceId));
    if (watch?.awaiting === token) watch.awaiting = null;
  }
  async candidate(sessionId: string, tabId: string) {
    const session = this.#snapshot().browserSessions.find((session) => session.id === sessionId);
    const tab = session?.tabCatalog?.tabs.find((tab) => tab.id === tabId);
    if (!tab || !tab.documentId || session?.state !== "ready")
      throw new HostClientRequestError({
        code: "not_found",
        status: 404,
        message: "This page is unavailable.",
      });
    return BrowserContextCandidateSchema.parse({
      sessionId,
      tabId,
      documentId: tab.documentId,
      title: tab.title,
      url: session.tabs.find((surface) => surface.id === tabId)?.url ?? tab.site,
      ...previousReleaseEligibility(this.#now()),
    });
  }
  async openTarget(input: BrowserTabOpenCommand): Promise<BrowserTabOpenResult> {
    const command = BrowserTabOpenCommandSchema.parse(input);
    const snapshot = this.#snapshot();
    if (snapshot.session !== "authenticated" || !snapshot.user)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "Sign in to open a browser.",
      });
    const key = `${snapshot.user.id}:${command.idempotencyKey}`;
    const fingerprint = JSON.stringify(command);
    const previous = this.#identityOpens.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new HostClientRequestError({
          code: "conflict",
          status: 409,
          message: "Idempotency key already used.",
        });
      return previous.result;
    }
    const result = this.#resolveOpen(command);
    this.#identityOpens.set(key, { fingerprint, result });
    return result;
  }
  async #resolveOpen(command: BrowserTabOpenCommand): Promise<BrowserTabOpenResult> {
    if (command.sessionId !== undefined)
      return this.open(command.sessionId, { ...command }, command.idempotencyKey);
    const snapshot = this.#snapshot();
    const identity = command.identity!;
    if (
      identity.kind === "profile" &&
      !snapshot.browserProfiles.some((profile) => profile.id === identity.profileId)
    )
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        reason: "browser-profile-unavailable",
        message: "This profile is unavailable.",
      });
    const profileId = identity.kind === "profile" ? identity.profileId : null;
    this.#rememberProfileHolders(snapshot);
    const holder = profileId ? this.#profileHolders.get(profileId) : undefined;
    const rememberedKey = JSON.stringify([snapshot.user?.id, profileId]);
    const exact = command.placement?.runnerId;
    if (holder && exact && holder.runnerId !== exact)
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        reason: "browser-placement-unavailable",
        message: "The selected computer does not hold this live profile.",
      });
    const desired = exact ?? holder?.runnerId ?? this.#rememberedPlacements.get(rememberedKey);
    const eligible = snapshot.browserPlacements.filter((placement) => placement.available);
    const placement = desired
      ? snapshot.browserPlacements.find((placement) => placement.runnerId === desired)
      : eligible.length === 1
        ? eligible[0]
        : undefined;
    if (!placement?.available)
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        reason:
          desired || eligible.length === 0
            ? "browser-placement-unavailable"
            : "browser-placement-ambiguous",
        message: desired
          ? "The browser's computer is unavailable."
          : "Choose a computer to browse on.",
      });
    const reused = snapshot.browserSessions
      .filter(
        (session) =>
          session.opener?.kind === "you" &&
          session.origin === "workspace" &&
          session.workspaceId === snapshot.homeWorkspaceId &&
          session.profileId === profileId &&
          session.placement.runnerId === placement.runnerId &&
          session.state === "ready",
      )
      .sort(
        (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
      )[0];
    this.#rememberedPlacements.set(rememberedKey, placement.runnerId);
    if (reused) return this.open(reused.id, command, command.idempotencyKey);
    const id = createBrowserSessionId();
    const at = this.#now().toISOString();
    const session: BrowserSessionSummary = {
      id,
      access: "full-control",
      opener: { kind: "you" },
      origin: "workspace",
      workspaceId: snapshot.homeWorkspaceId!,
      profileId,
      placement: { kind: "runner", runnerId: placement.runnerId },
      runtimeId: placement.runtimeId ?? "mock-targeted-runtime",
      state: "ready",
      createdAt: at,
      attachedRunIds: [],
      dialog: null,
      error: null,
      tabs: [],
      tabCatalog: { generation: 1, revision: 0, tabs: [] },
      viewerError: null,
      viewerState: "disconnected",
    };
    this.#update({ ...snapshot, browserSessions: [...snapshot.browserSessions, session] });
    const opened = await this.open(id, command, command.idempotencyKey);
    return { ...opened, browserStarted: true };
  }
  async open(
    sessionId: string,
    options: { readonly url?: string | undefined; readonly typed?: boolean | undefined },
    idempotencyKey: string,
    activate = false,
  ) {
    const command = BrowserSessionTabOpenCommandSchema.parse({
      type: "browser.tab.open",
      sessionId,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.typed === undefined ? {} : { typed: options.typed }),
      idempotencyKey,
    });
    const snapshot = this.#snapshot();
    const session = snapshot.browserSessions.find((session) => session.id === sessionId);
    if (!session)
      throw new HostClientRequestError({
        code: "not_found",
        status: 404,
        message: "Browser session not found.",
      });
    const fingerprint = JSON.stringify({ sessionId, url: command.url, typed: command.typed });
    const previous = this.#openedTabs.get(idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new HostClientRequestError({
          code: "conflict",
          status: 409,
          message: "Idempotency key already used.",
        });
      return previous.result;
    }
    if (session.state === "closed" || session.state === "closing" || session.state === "failed")
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        reason: "browser-session-closed",
        message: "The browser session has ended. Open a new browser.",
      });
    if (!session.tabCatalog || session.state !== "ready")
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        message: "The browser is unavailable.",
      });
    if (command.url !== undefined) {
      const url = new URL(command.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new HostClientRequestError({
          code: "forbidden",
          status: 403,
          message: "Only HTTP and HTTPS URLs without credentials are allowed.",
        });
    }
    const id = BrowserSurfaceIdSchema.parse(`${sessionId}-tab-${session.tabCatalog.revision + 1}`);
    const url = command.url ? new URL(command.url).href : "about:blank";
    const tab = {
      id,
      title: command.url ?? "New tab",
      site: command.url ? new URL(command.url).origin : "about:blank",
      loading: command.url !== undefined,
      order: Math.max(-1, ...session.tabCatalog.tabs.map((tab) => tab.order)) + 1,
      openerId: null,
      occupants: [],
      iconRef: null,
      documentId: `${id}-document-1`,
      availability: "ready" as const,
    };
    const catalog = {
      ...session.tabCatalog,
      revision: session.tabCatalog.revision + 1,
      inventoryRevision: (session.tabCatalog.inventoryRevision ?? 0) + 1,
      tabs: [...session.tabCatalog.tabs, tab],
    };
    const updated = {
      ...snapshot,
      browserSessions: snapshot.browserSessions.map((value) =>
        value.id === sessionId
          ? {
              ...value,
              tabCatalog: catalog,
              tabs: [
                ...value.tabs.map((surface) =>
                  activate ? { ...surface, active: false } : surface,
                ),
                { id, active: activate, title: tab.title, url, loading: tab.loading },
              ],
            }
          : value,
      ),
    };
    const result = BrowserTabOpenResultSchema.parse({
      type: "browser.tab.open",
      browserStarted: false,
      session: HostedBrowserSessionSchema.parse({
        ...session,
        tabCatalog: catalog,
        createdAt: session.createdAt ?? this.#now().toISOString(),
        updatedAt: this.#now().toISOString(),
      }),
      sessionId,
      tabId: id,
      catalog,
    });
    this.#openedTabs.set(idempotencyKey, { fingerprint, result });
    this.#update(updated);
    if (command.url)
      this.#recordVisit(
        updated.browserSessions.find((value) => value.id === sessionId)!,
        id,
        command.typed === true,
      );
    if (tab.loading) this.#loading(sessionId, id, true);
    this.latest.reconcile(updated);
    this.#frames();
    return result;
  }
  reopen(idempotencyKey: string) {
    const snapshot = this.#snapshot();
    const key = JSON.stringify([snapshot.user?.id, idempotencyKey]);
    const replay = this.#reopenedTabs.get(key);
    if (replay) return replay;
    const source = this.#closedTabs.findLast(
      (source) =>
        source.ownerId === snapshot.user?.id &&
        source.at >= this.#now().getTime() - 24 * 60 * 60_000,
    );
    if (!source) throw new Error("No recently closed tab to reopen.");
    const lineage =
      snapshot.workspaceTabs?.find((group) => group.id === source.lineage.id) ?? source.lineage;
    if ((lineage.tabs?.length ?? 0) >= 64) throw new Error("Browser tab limit reached.");
    const id = BrowserSurfaceIdSchema.parse(`surface_${crypto.randomUUID()}`);
    const tab = {
      ...source.tab,
      id,
      state: "suspended" as const,
      createdAt: this.#now().toISOString(),
    };
    const group = {
      ...lineage,
      revision: lineage.revision + 1,
      tabs: [...(lineage.tabs ?? []), tab],
    };
    const arrangement = browserTabArrangement(
      snapshot.browserTabGroups ?? { revision: 0, groups: [] },
      browserTabOrderTabs(snapshot.workspaceTabs),
    );
    const order = [...arrangement.order];
    const target = snapshot.browserTabGroups?.groups.find((group) => group.id === source.groupId);
    let at = source.preceding ? order.indexOf(source.preceding) + 1 : order.length;
    if (
      target &&
      (!source.preceding || !target.tabIds.includes(BrowserSurfaceIdSchema.parse(source.preceding)))
    )
      at = Math.max(...target.tabIds.map((id) => order.indexOf(id))) + 1;
    if (!target && source.preceding) {
      const precedingGroup = arrangement.groupOf.get(source.preceding);
      while (
        precedingGroup &&
        at < order.length &&
        arrangement.groupOf.get(order[at]!) === precedingGroup
      )
        at++;
    }
    order.splice(at, 0, id);
    const layout = {
      revision: (snapshot.browserTabGroups?.revision ?? 0) + 1,
      groups: (snapshot.browserTabGroups?.groups ?? []).map((group) =>
        group.id === target?.id ? { ...group, tabIds: [...group.tabIds, id] } : group,
      ),
      order: order.map((id) => BrowserSurfaceIdSchema.parse(id)),
    };
    this.#restoreUrls.set(id, source.url);
    this.#closedTabs.splice(this.#closedTabs.indexOf(source), 1);
    this.#update({
      ...snapshot,
      workspaceTabs: [
        ...(snapshot.workspaceTabs ?? []).filter((held) => held.id !== group.id),
        group,
      ],
      browserTabGroups: layout,
    });
    const result = WorkspaceTabReopenResultSchema.parse({
      type: "workspace.tab.reopen",
      tabId: id,
      group,
      layout,
    });
    this.#reopenedTabs.set(key, result);
    return result;
  }
  activateWorkspaceTab(tabId: string) {
    const snapshot = this.#snapshot();
    const lineage = snapshot.workspaceTabs?.find((group) =>
      group.tabs?.some((tab) => tab.id === tabId),
    );
    const tab = lineage?.tabs?.find((tab) => tab.id === tabId);
    const session = snapshot.browserSessions.find((session) => session.id === lineage?.session.id);
    if (!lineage || !tab || !session?.tabCatalog) throw new Error("Browser tab not found.");
    const url = this.#restoreUrls.get(tabId) ?? tab.site;
    const catalog = {
      ...session.tabCatalog,
      revision: session.tabCatalog.revision + 1,
      tabs: [
        ...session.tabCatalog.tabs.filter((held) => held.id !== tabId),
        {
          id: tab.id,
          title: tab.title,
          site: tab.site,
          order: tab.order,
          openerId: tab.openerId,
          occupants: [],
          iconRef: tab.iconRef ?? null,
          documentId: `${tabId}-document-1`,
          availability: "ready" as const,
        },
      ],
    };
    const updated = {
      ...session,
      state: "ready" as const,
      tabCatalog: catalog,
      tabs: [
        ...session.tabs.filter((held) => held.id !== tabId),
        { id: tab.id, title: tab.title, url, active: true },
      ],
    };
    this.#update({
      ...snapshot,
      browserSessions: snapshot.browserSessions.map((held) =>
        held.id === session.id ? updated : held,
      ),
    });
    this.#frames();
    return WorkspaceTabActivateResultSchema.parse({
      type: "workspace.tab.activate",
      tabId,
      group: this.#snapshot().workspaceTabs?.find((group) => group.id === lineage.id),
      session: { ...updated, updatedAt: this.#now().toISOString() },
      catalog,
    });
  }
  async close(
    sessionId: string,
    surfaceId: string,
    expected: {
      readonly generation: number;
      readonly revision: number;
      readonly inventoryRevision?: number | undefined;
    },
    person = true,
  ) {
    const snapshot = this.#snapshot();
    const session = snapshot.browserSessions.find((session) => session.id === sessionId);
    const catalog = session?.tabCatalog;
    if (
      !catalog ||
      catalog.generation !== expected.generation ||
      (expected.inventoryRevision ??
        (expected.revision === catalog.revision
          ? (catalog.inventoryRevision ?? catalog.revision)
          : expected.revision)) !== (catalog.inventoryRevision ?? catalog.revision)
    )
      throw new HostClientRequestError({
        code: "conflict",
        reason: "stale-tab-inventory",
        status: 409,
        message: "The browser tabs changed. Try again.",
      });
    if (!catalog.tabs.some((tab) => tab.id === surfaceId))
      throw new HostClientRequestError({
        code: "not_found",
        status: 404,
        message: "The tab is no longer open.",
      });
    const lineage = snapshot.workspaceTabs?.find((group) => group.session.id === sessionId);
    const tab = lineage?.tabs?.find((tab) => tab.id === surfaceId);
    if (person && lineage && tab) {
      const arrangement = browserTabArrangement(
        snapshot.browserTabGroups ?? { revision: 0, groups: [] },
        browserTabOrderTabs(snapshot.workspaceTabs),
      );
      const at = arrangement.order.indexOf(surfaceId);
      this.#closedTabs.push({
        ownerId: snapshot.user?.id,
        at: this.#now().getTime(),
        lineage,
        tab,
        url: session?.tabs.find((tab) => tab.id === surfaceId)?.url ?? tab.site,
        preceding: at > 0 ? arrangement.order[at - 1]! : null,
        groupId: arrangement.groupOf.get(surfaceId) ?? null,
      });
    }
    const tabs = catalog.tabs
      .filter((tab) => tab.id !== surfaceId)
      .map((tab) => (tab.openerId === surfaceId ? { ...tab, openerId: null } : tab));
    const next = {
      ...catalog,
      revision: catalog.revision + 1,
      inventoryRevision: (catalog.inventoryRevision ?? 0) + 1,
      tabs,
    };
    const ended = tabs.length === 0;
    const updated = {
      ...snapshot,
      browserSessions: snapshot.browserSessions.map((value) =>
        value.id === sessionId
          ? {
              ...value,
              tabCatalog: next,
              tabs: value.tabs.filter((tab) => tab.id !== surfaceId),
              state: ended ? ("closed" as const) : value.state,
              attachedRunIds: ended ? [] : value.attachedRunIds,
            }
          : value,
      ),
    };
    this.#update(updated);
    this.latest.reconcile(updated);
    this.activity.reconcile(
      new Set(
        placeList(updated)
          .filter((place) => place.availability === "ready")
          .map(({ key }) => key),
      ),
    );
    this.#frames();
    return BrowserTabCloseResultSchema.parse({
      type: "browser.tab.close",
      sessionId,
      outcome: ended ? "session-closed" : "tab-closed",
      catalog: next,
    });
  }
  #requireHistoryOwner(profileId: string): void {
    const snapshot = this.#snapshot();
    if (snapshot.session !== "authenticated" || !snapshot.user)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "Sign in to read history.",
      });
    if (
      snapshot.user.id !== this.#historyOwner ||
      !snapshot.browserProfiles.some((profile) => profile.id === profileId)
    )
      throw new HostClientRequestError({
        code: "not_found",
        status: 404,
        message: "Profile not found.",
      });
  }
  history(profileId: string): BrowserHistory {
    this.#requireHistoryOwner(profileId);
    const value = this.#history.get(profileId) ?? { entries: [], icons: [] };
    const cutoff = this.#now().getTime() - browserHistoryRetentionMs;
    const entries = value.entries
      .filter((entry) => Date.parse(entry.lastVisitAt) > cutoff)
      .slice(0, browserHistoryMaxEntries);
    const origins = new Set(entries.map((entry) => new URL(entry.url).origin));
    const bounded = { entries, icons: value.icons.filter((icon) => origins.has(icon.origin)) };
    this.#history.set(profileId, bounded);
    return structuredClone(bounded);
  }
  historyIcons(profileId: string, refs: readonly string[]) {
    const retained = new Set(this.history(profileId).icons.map((icon) => icon.iconRef));
    return {
      icons: [...new Set(refs)].flatMap((iconRef) =>
        retained.has(iconRef) ? [{ iconRef, favicon: iconData }] : [],
      ),
    };
  }
  removeHistory(profileId: string, url?: string): void {
    const value = this.history(profileId);
    this.#history.set(
      profileId,
      url === undefined
        ? { entries: [], icons: [] }
        : { ...value, entries: value.entries.filter((entry) => entry.url !== url) },
    );
    this.history(profileId);
    this.#historyChanged(profileId);
  }
  deleteHistory(profileId: string): void {
    this.#history.delete(profileId);
  }
  #recordVisit(session: BrowserSessionSummary, surfaceId: string, typed: boolean): void {
    const profileId = session.profileId;
    const tab = session.tabs.find((tab) => tab.id === surfaceId);
    if (!profileId || !tab || !BrowserHistoryUrlSchema.safeParse(tab.url).success) return;
    try {
      const value = this.history(profileId);
      const previous = value.entries.find((entry) => entry.url === tab.url);
      this.#history.set(profileId, {
        ...value,
        entries: [
          {
            url: tab.url,
            title: tab.title.slice(0, 200),
            typedCount: Math.min(
              Number.MAX_SAFE_INTEGER,
              (previous?.typedCount ?? 0) + Number(typed),
            ),
            visitCount: Math.min(Number.MAX_SAFE_INTEGER, (previous?.visitCount ?? 0) + 1),
            lastVisitAt: this.#now().toISOString(),
          },
          ...value.entries.filter((entry) => entry.url !== tab.url),
        ].slice(0, browserHistoryMaxEntries),
      });
      this.history(profileId);
      this.#historyChanged(profileId);
    } catch {
      /* Guest and other people's profiles keep no history for this viewer. */
    }
  }
  #retainHistoryIcons(snapshot: HostSnapshot): void {
    for (const session of snapshot.browserSessions) {
      if (!session.profileId || !this.#history.has(session.profileId)) continue;
      const value = this.#history.get(session.profileId)!;
      for (const tab of session.tabCatalog?.tabs ?? []) {
        if (!tab.iconRef || !value.entries.some((entry) => new URL(entry.url).origin === tab.site))
          continue;
        if (value.icons.some((icon) => icon.origin === tab.site && icon.iconRef === historyIconRef))
          continue;
        value.icons = [
          ...value.icons.filter((icon) => icon.origin !== tab.site),
          { origin: tab.site, iconRef: historyIconRef },
        ];
        this.#historyChanged(session.profileId);
      }
    }
  }
  async icon(sessionId: string, iconRef: string): Promise<string | null> {
    BrowserTabIconInputSchema.parse({ sessionId, iconRef });
    const tab = this.#snapshot()
      .browserSessions.find((session) => session.id === sessionId)
      ?.tabCatalog?.tabs.find((tab) => tab.iconRef === iconRef);
    return BrowserTabIconResultSchema.parse({ favicon: tab ? iconData : null }).favicon;
  }
  #notify(key: string): void {
    for (const listener of this.#watchListeners.get(key) ?? []) listener();
  }
  /** Frames for every watched tab, or for one: a resized page restarts only its own picture. */
  #frames(only?: string): void {
    for (const [key, watch] of this.#watches) {
      if (watch.awaiting || (only !== undefined && key !== only)) continue;
      const [sessionId, surfaceId] = JSON.parse(key) as [string, string];
      const tab = this.#snapshot()
        .browserSessions.find((session) => session.id === sessionId)
        ?.tabs.find((tab) => tab.id === surfaceId);
      if (!tab) {
        watch.state = emptyWatch;
        this.#notify(key);
        continue;
      }
      const png = decodedPageImage(tab.title);
      const size = this.#viewports.get(key);
      const capture = this.#crops.get(key);
      const picture = ++this.#pictures;
      watch.state = {
        status: "live",
        error: null,
        frame: {
          data: png.buffer,
          header: {
            encoding: "png",
            frameId: picture,
            // The fixture is one 960×600 picture: drawn at the page's width, never stretched.
            rasterWidth: 960,
            rasterHeight: 600,
            surfaceId: BrowserSurfaceIdSchema.parse(surfaceId),
            viewportWidth: size?.width ?? 960,
            viewportHeight: size?.height ?? 600,
            geometryRevision: (size?.revision ?? 0) + 1,
            ...(capture ? { capture } : {}),
            watchToken: `00000000-0000-4000-8000-${String(picture).padStart(12, "0")}`,
          },
        },
      };
      watch.awaiting = watch.state.frame?.header.watchToken ?? null;
      this.#notify(key);
    }
  }
  #tick(): void {
    const snapshot = this.#snapshot();
    if (
      this.#scripted ||
      snapshot.session !== "authenticated" ||
      snapshot.connection !== "connected"
    )
      return;
    const now = this.#now().getTime();
    const tick = Math.floor((now - this.#started) / 8000);
    if (tick !== this.#catalogTick) {
      this.#catalogTick = tick;
      const browserSessions = snapshot.browserSessions.map((session) => {
        if (session.id !== sessionId(0) || session.state !== "ready" || !session.tabCatalog)
          return session;
        const tabs = session.tabCatalog.tabs.filter((tab) => tab.id !== "mock-changing-tab");
        if (tick % 2 === 1)
          tabs.push({
            ...tabs[0]!,
            id: BrowserSurfaceIdSchema.parse("mock-changing-tab"),
            title: "Fresh restaurant suggestions",
            documentId: `mock-changing-document-${tick}`,
            order: 100,
            openerId: null,
          });
        return {
          ...session,
          tabCatalog: {
            ...session.tabCatalog,
            revision: session.tabCatalog.revision + 1,
            inventoryRevision: (session.tabCatalog.inventoryRevision ?? 0) + 1,
            tabs,
          },
          tabs: tabs.map(
            (tab, index) =>
              session.tabs.find((surface) => surface.id === tab.id) ?? {
                active: index === 0,
                id: tab.id,
                title: tab.title,
                url: `${tab.site}/recommendations`,
              },
          ),
        };
      });
      const updated = { ...snapshot, browserSessions };
      this.#update(updated);
      this.latest.reconcile(updated);
    }
    const current = this.#snapshot();
    const liveRuns = new Map(
      current.runQueue
        .filter((run) => run.status === "running" || run.status === "waiting")
        .map((run) => [run.threadId, run.id]),
    );
    let recorded = false;
    const browserSessions = current.browserSessions.map((session) => {
      if (session.state !== "ready") return session;
      const uses = [...(session.uses ?? [])];
      for (const tab of session.tabCatalog?.tabs ?? [])
        for (const occupant of tab.occupants) {
          const runId = occupant.acting ? liveRuns.get(occupant.threadId) : undefined;
          if (!runId || uses.some((use) => use.runId === runId && use.tabId === tab.id)) continue;
          recorded = true;
          const at = this.#now().toISOString();
          uses.push({
            threadId: occupant.threadId,
            runId,
            tabId: tab.id,
            firstUsedAt: at,
            lastUsedAt: at,
            pageTitle: tab.title,
            pageSite: tab.site,
          });
        }
      return uses.length === (session.uses?.length ?? 0) ? session : { ...session, uses };
    });
    if (recorded) this.#update({ ...current, browserSessions });
    this.#seq++;
    const places = placeList(this.#snapshot());
    // Seeded native sessions predate the browser actions animated by this tick.
    for (const place of [
      ...places.filter((place) => place.kind !== "browser"),
      ...places.filter((place) => place.kind === "browser"),
    ]) {
      if (place.availability !== "ready") continue;
      for (const occupant of place.occupants.filter((occupant) => occupant.acting)) {
        const runId = liveRuns.get(occupant.threadId);
        if (!runId) continue;
        const identity = PlaceIdentitySchema.parse(
          place.destination.kind === "browser"
            ? {
                kind: "browser" as const,
                sessionId: place.destination.sessionId,
                surfaceId: place.destination.tabId,
              }
            : place.destination.kind === "app"
              ? {
                  kind: "app" as const,
                  machineId: place.destination.machineId,
                  appKey: place.destination.appKey,
                }
              : {
                  kind: "phone" as const,
                  machineId: place.destination.machineId,
                  display: place.destination.display,
                },
        );
        if (identity.kind !== "browser") {
          const referenceKey = `${occupant.threadId}:${runId}:${place.key}`;
          if (this.#nativeReferences.has(referenceKey)) continue;
          this.#nativeReferences.add(referenceKey);
          this.latest.accept({
            threadId: occupant.threadId,
            runId: RunIdSchema.parse(runId),
            place: identity,
            title: place.title,
            site: place.site,
            iconRef: null,
            order: ++this.#order,
            at: this.#now().toISOString(),
          });
          continue;
        }
        const phase = (now - this.#started) / 2000 + place.title.length;
        // As the runtime does, a pointer is labelled with the page's current geometry.
        const geometry = this.#viewports.get(this.#key(identity.sessionId, identity.surfaceId));
        const activity = PlaceActivitySchema.parse({
          place: identity,
          threadId: occupant.threadId,
          home: occupant.home,
          runId: RunIdSchema.parse(runId),
          generation: 1,
          seq: this.#seq,
          order: ++this.#order,
          at: now,
          expiresAt: now + 15000,
          pointer: { x: 0.5 + Math.sin(phase) * 0.25, y: 0.5 + Math.cos(phase * 0.7) * 0.25 },
          geometryRevision: (geometry?.revision ?? 0) + 1,
        });
        this.activity.apply({ type: "host.place-activity", activity });
        this.latest.accept({
          threadId: activity.threadId,
          runId: activity.runId,
          place: activity.place,
          title: place.title,
          site: place.site,
          iconRef: place.icon.kind === "site" ? place.icon.ref : null,
          order: activity.order,
          at: new Date(activity.at).toISOString(),
        });
      }
    }
    this.#frames();
  }
  dispose(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    for (const load of this.#loads.values()) clearTimeout(load);
    this.#loads.clear();
    this.activity.dispose();
    this.latest.dispose();
    this.#nativeReferences.clear();
    this.#watches.clear();
    this.#watchListeners.clear();
  }
}

/** A page's origin, as the Host records a place's site; null for one with none. */
function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}
