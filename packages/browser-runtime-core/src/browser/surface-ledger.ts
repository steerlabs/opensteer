import {
  browserFrameFits,
  defaultBrowserViewport,
  type CdpParameters,
} from "@opensteer/browser-core";
import {
  BrowserSurfaceIdSchema,
  browserSessionTabLimit,
  browserSessionTabsFullReason,
  browserWorkspaceTabUrlMaxLength,
  type BrowserDialog,
  type BrowserNavigationCommitted,
  type BrowserSurface,
  type BrowserSurfaceId,
  type BrowserTabRecord,
} from "@opensteer/protocol/browser";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AsyncMutex } from "../async.js";
import { BrowserRuntimeError } from "../errors.js";
import type { BrowserContext, BrowserPage, CdpSession, PageGeometry, Viewport } from "./backend.js";
import { TabLease } from "./tab-lease.js";
import { PageFavicon } from "./favicon.js";
import { PageTitleReader } from "./page-title.js";
import { PageScriptTargets, type ScriptTarget } from "./script-targets.js";

/** How long Chromium lets one person input open a popup. */
const userActivationLifespanMs = 5_000;

export type SurfaceLedgerEvent =
  | BrowserNavigationCommitted
  | {
      change: "closed" | "created" | "updated";
      closure?: "page" | "teardown";
      surface: BrowserSurface;
      type: "changed";
    }
  | { surfaces: BrowserSurface[]; type: "snapshot" }
  /** The viewer whose own input opened this popup; see `recordViewerInput`. */
  | { consumerToken: string; surfaceId: BrowserSurfaceId; type: "popup" }
  /** A size that waited for a page's dialog reached it once the dialog closed. */
  | { surfaceId: BrowserSurfaceId; type: "resized" }
  /** A page's JavaScript dialog opened or closed. */
  | { surfaceId: BrowserSurfaceId; type: "dialog" }
  | {
      surfaceId: BrowserSurfaceId;
      type: "geometry";
      geometry: PageGeometry;
      geometryRevision: number;
    }
  | { type: "closed" }
  | {
      type: "dialog-event";
      targetId: string;
      method: "Page.javascriptDialogOpening" | "Page.javascriptDialogClosed";
      parameters: CdpParameters;
    };

export interface SurfaceBinding {
  cdp: CdpSession;
  page: BrowserPage;
  surface: BrowserSurface;
  targetId: string;
}

interface SurfaceLedgerOptions {
  navigationVersion?: 1 | undefined;
  beforeResize?: (surfaceId: BrowserSurfaceId) => Promise<void>;
  /**
   * Makes a page this ledger registers reachable by the session's agents. It
   * runs before the page is announced; throwing refuses the page.
   */
  claimTarget?: (targetId: string) => void;
  releaseTarget?: (targetId: string) => void;
  /** The size the session starts at, until the person's view gives it one. */
  initialViewport?: Viewport;
  maxSurfaces?: number;
  rootPages?: readonly BrowserPage[];
  initialSurfaceId?: BrowserSurfaceId;
  dormantSurfaceIds?: readonly BrowserSurfaceId[];
}

export interface PageSize {
  readonly height: number;
  readonly width: number;
}

interface NavigationBinding {
  url: string;
  documentId: string;
  sequence: number;
  sameDocument: boolean;
  /** Undefined while awaiting the reply; null for a same-document navigation. */
  loaderId: string | null | undefined;
}

interface NavigationCommit {
  documentId: string;
  url: string;
  sequence: number;
  loaderId: string | null;
}

export interface TabRecord {
  documentId: string;
  geometryRevision: number;
  order: number;
  openerId: BrowserSurfaceId | null;
  /** Sequence number of the latest agent command sent to this page. */
  agentSequence: number;
  /**
   * The agent's latest complete device-metrics request, until it clears it or
   * the person fits the page. A later request replaces it whole.
   */
  agentMetrics: CdpParameters | null;
  /** Other pages' snapshots must not expose initialization before size or dialog ownership. */
  announced: boolean;
  /** The page's site icon as a data URL, while it names one that loads. */
  favicon: string | null;
  id: BrowserSurfaceId;
  /** The person's size for this page: where they read it, like a window's size. */
  ordinary: PageSize;
  /** The latest time the person's view changed this page's size. */
  pageResize?: BrowserPageResize;
  /** Sequence number of `pageResize`; 0 while the person has not resized it. */
  pageResizeSequence: number;
  /**
   * Orders this page's size writes. Each page has its own, so a write that
   * Chromium holds, as it holds any under a dialog, keeps no other page waiting.
   */
  readonly sizeLock: AsyncMutex;
  title: string;
  url: string;
  userActivity?: BrowserUserActivity;
  /** Sequence number of `userActivity`; 0 while the person has not acted here. */
  userActivitySequence: number;
  /** The viewer behind this page's latest person input, while it can still open a popup. */
  viewerInput: BrowserViewerInput | null;
  popupInputSequence: number;
  readonly lease: TabLease;
  live: LivePage | null;
  lastTargetId: string;
  origin: "agent" | "person";
  personUsed: boolean;
  agentActed: boolean;
  typed: boolean;
  usedAt: number;
  unrestorable: boolean;
  restore: { url: string; engine: unknown | null } | null;
}

export interface LivePage {
  commitSequence: number;
  pendingNavigations: Map<string, NavigationBinding>;
  recentCommits: Map<string, NavigationCommit>;
  navigation: { canGoBack: boolean; canGoForward: boolean } | null;
  navigationRevision: number;
  navigationFailed: boolean;
  navigationAttempt: number;
  committedUrl: string;
  /** What a failed navigation meant to reach; the document is Chromium's error page. */
  unreachableUrl: string | null;
  /** The committed document's loader, from its commit or the first title sample. */
  loaderId: string | null;
  titleReader: PageTitleReader | null;
  onSameDocumentNavigation: (parameters: unknown) => void;
  pageScale: number;
  onFrameNavigated: (parameters: unknown) => void;
  onFrameStartedLoading: (parameters: unknown) => void;
  onFrameStoppedLoading: (parameters: unknown) => void;
  /** The page's own document is loading; a frame inside it loading is not. */
  loading: boolean;
  /** The metrics Chromium has acknowledged; null until the starting size reaches it. */
  applied: CdpParameters | null;
  appliedGeometry: PageGeometry | null;
  stopObservingHumanInput: (() => void) | undefined;
  unbindGeometry: (() => void) | undefined;
  cdp: CdpSession;
  /**
   * The JavaScript dialog open on the page, kept from the moment it opens so
   * it can be shown and answered whenever the page is shown. Chromium answers
   * no size write to the page until it closes, so the person's size waits
   * here instead of in a queue. `answering` holds off a second answer.
   */
  dialog: (Omit<BrowserDialog, "surfaceId"> & { answering: boolean }) | null;
  faviconReader: PageFavicon | null;
  scriptTargets: PageScriptTargets | null;
  onClose: () => void;
  onDialogClosed: (parameters: unknown) => void;
  onDialogOpening: (parameters: unknown) => void;
  onMetadataChanged: () => void;
  page: BrowserPage;
  /**
   * The person's size changed while a dialog was open and reaches the page
   * when it closes, after releasing what that write would have released.
   */
  sizeWaiting: {
    readonly beforeResize: BeforePageResize | undefined;
    /** The person fit the page: the agent's size goes when the size lands. */
    readonly fit: boolean;
    readonly followSize?: () => PageSize | null;
    readonly hasPersonSize: boolean;
  } | null;
  targetId: string;
  restoring: boolean;
}

type SurfaceRecord = TabRecord & { live: LivePage };

export interface BrowserViewerInput {
  readonly at: number;
  readonly consumerToken: string;
  readonly sequence: number;
  readonly native: boolean;
}

/** The person's latest action on one page. It never carries keys, text or dialog answers. */
export interface BrowserUserActivity {
  readonly at: string;
  readonly kind: "click" | "scroll" | "typing" | "navigation" | "dialog";
  readonly x?: number;
  readonly y?: number;
}

export interface BrowserTargetActivity extends BrowserUserActivity {
  /** The person acted after the latest agent command sent to this page. */
  readonly sinceLastAgentCommand: boolean;
}

/** The person's view resized one page to this size. */
export interface BrowserPageResize {
  /** The person fit the page to their view, which removed the size an agent set. */
  readonly agentSizeRemoved?: true;
  readonly at: string;
  readonly height: number;
  readonly width: number;
}

export interface BrowserTargetResize extends BrowserPageResize {
  /** The resize came after the latest agent command sent to this page. */
  readonly sinceLastAgentCommand: boolean;
}

/** What one size write did. */
export interface PageSizeWrite {
  readonly changed: boolean;
}

/**
 * Runs inside the size lock just before a write changes what a page shows,
 * and only then: a press held there is released before the page reflows.
 */
type BeforePageResize = () => Promise<void>;

const pageAppearanceTimeoutMs = 5_000;

/**
 * The pages of one Browser Session. Each page has the person's size, which
 * their view sets the way a window's size is set, and an agent may lay its
 * own device metrics over it. The first page and every page opened without a
 * size start at the size the person's view last gave this session; a popup
 * starts at the size its opener shows. Nothing resizes a page except a write
 * that names it, and a write that changes nothing reaches no page.
 */
export class SurfaceLedger {
  private readonly navigationVersion: 1 | undefined;
  private nextOrder = 0;
  private inventorySealed = false;
  private inventoryVersion = 0;
  private legacyPersonUntil = 0;
  get closing(): boolean {
    return (
      this.closed ||
      this.tearingDown ||
      this.inventorySealed ||
      this.context.isConnected?.() === false
    );
  }
  get sealed(): boolean {
    return this.inventorySealed;
  }
  get inventoryRevision(): number {
    return this.inventoryVersion;
  }
  recordLegacyPersonActivity(targeted: boolean): void {
    this.legacyPersonUntil = targeted ? 0 : Date.now() + 15_000;
  }
  pageScaleOf(surfaceId: BrowserSurfaceId): number {
    return this.liveRecord(surfaceId)?.live.pageScale ?? 1;
  }
  /**
   * Hears where scripts aim events in one page's top frame, until the
   * returned stop. Installs the page's observer again if its install failed.
   */
  watchScriptTargets(
    surfaceId: BrowserSurfaceId,
    watcher: (target: ScriptTarget) => void,
  ): () => void {
    return this.liveRecord(surfaceId)?.live.scriptTargets?.watch(watcher) ?? (() => undefined);
  }
  private discoveries = 0;
  private activeId: BrowserSurfaceId | null = null;
  private readonly adoptedTargetIds = new Set<string>();
  private readonly releaseTarget: SurfaceLedgerOptions["releaseTarget"];
  private readonly claimTarget: ((targetId: string) => void) | undefined;
  private readonly beforeResize: SurfaceLedgerOptions["beforeResize"];
  private closed = false;
  private tearingDown = false;
  private creatingPage: Promise<void> | null = null;
  private readonly creationLock = new AsyncMutex();
  private readonly initialSurfaceId: BrowserSurfaceId | undefined;
  private readonly dormantSurfaceIds: Set<BrowserSurfaceId>;
  private readonly context: BrowserContext;
  /** The size the person's view last followed on any page here; new pages start at it. */
  private followedSize: PageSize;
  private readonly listeners = new Set<(event: SurfaceLedgerEvent) => void>();
  private readonly maxSurfaces: number;
  private readonly pageIds = new Map<BrowserPage, BrowserSurfaceId>();
  private readonly rootPages: readonly BrowserPage[] | null;
  private readonly records = new Map<BrowserSurfaceId, TabRecord>();
  private readonly registrations = new Map<BrowserPage, Promise<void>>();
  private readonly removals = new Map<BrowserSurfaceId, Promise<void>>();
  private readonly agentCommandListeners = new Set<(surfaceId: BrowserSurfaceId) => void>();
  onAgentCommand(listener: (surfaceId: BrowserSurfaceId) => void): () => void {
    this.agentCommandListeners.add(listener);
    return () => this.agentCommandListeners.delete(listener);
  }
  private sequence = 0;
  private started = false;
  private readonly viewportMutex = new AsyncMutex();
  private readonly onPage = (page: BrowserPage) => {
    this.discoveries++;
    void this.registerDiscovered(page)
      .finally(() => {
        this.discoveries--;
      })
      .catch(() => undefined);
  };

  constructor(context: BrowserContext, options: SurfaceLedgerOptions = {}) {
    this.context = context;
    this.navigationVersion = options.navigationVersion;
    this.initialSurfaceId = options.initialSurfaceId;
    this.dormantSurfaceIds = new Set(options.dormantSurfaceIds);
    this.claimTarget = options.claimTarget;
    this.releaseTarget = options.releaseTarget;
    this.beforeResize = options.beforeResize;
    const initialViewport = options.initialViewport ?? {
      devicePixelRatio: 1,
      ...defaultBrowserViewport,
    };
    assertViewport(initialViewport);
    this.followedSize = {
      height: initialViewport.height,
      width: initialViewport.width,
    };
    this.rootPages = options.rootPages ? [...options.rootPages] : null;
    this.maxSurfaces = options.maxSurfaces ?? browserSessionTabLimit;
    if (
      !Number.isInteger(this.maxSurfaces) ||
      this.maxSurfaces < 1 ||
      this.maxSurfaces > browserSessionTabLimit
    ) {
      throw new Error(
        `Surface maxSurfaces must be an integer from 1 through ${browserSessionTabLimit}.`,
      );
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new BrowserRuntimeError("conflict", "The surface ledger is closed.");
    if (this.started) return;
    this.started = true;
    this.context.onPage(this.onPage);
    const pages = this.rootPages ?? this.context.pages();
    for (const [index, page] of pages.entries())
      await this.register(page, false, undefined, index === 0 ? this.initialSurfaceId : undefined);
    const initial = [...this.records.values()].findLast((record) => record.announced);
    if (initial) this.activeId = initial.id;
    this.emitSnapshot();
  }

  subscribe(listener: (event: SurfaceLedgerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readonly policyListeners = new Set<() => void>();
  onPolicyChanged(listener: () => void): () => void {
    this.policyListeners.add(listener);
    return () => this.policyListeners.delete(listener);
  }
  private policyChanged(): void {
    for (const listener of this.policyListeners) listener();
  }
  policyRecords(): Iterable<TabRecord> {
    return this.records.values();
  }
  stateOf(id: BrowserSurfaceId): "live" | "suspended" | undefined {
    const record = this.records.get(id);
    return record ? surfaceState(record) : undefined;
  }
  demand(id: BrowserSurfaceId): void {
    this.records.get(id)?.lease.demand();
  }
  use<T>(id: BrowserSurfaceId, operation: () => Promise<T>): Promise<T> {
    const record = this.records.get(id);
    if (!record)
      return Promise.reject(new BrowserRuntimeError("not_found", "The browser tab closed."));
    this.touch(id);
    return record.lease.use(operation).catch((error) => {
      if (error instanceof BrowserRuntimeError && error.reason === "target-suspended")
        throw new BrowserRuntimeError(
          "conflict",
          `Resume tab ${id} before using its new document.`,
          { reason: "target-suspended", retryable: true },
        );
      throw error;
    });
  }
  touch(id: BrowserSurfaceId, person = false): void {
    const record = this.records.get(id);
    if (!record) return;
    record.usedAt = Date.now();
    if (person) record.personUsed = true;
    this.policyChanged();
  }
  recordAgentInput(id: BrowserSurfaceId, typed = false): void {
    const record = this.records.get(id);
    if (!record) return;
    record.agentActed = true;
    record.typed ||= typed;
    this.touch(id);
  }
  async sleep(
    id: BrowserSurfaceId,
    blocked: (record: TabRecord) => string | null,
  ): Promise<boolean> {
    const record = this.liveRecord(id);
    if (!record || this.closing || blocked(record) || !record.lease.beginSleep()) return false;
    const live = record.live;
    const documentId = record.documentId;
    try {
      const [engine, keepAwake] = await withTimeout(
        Promise.all([
          live.page.captureRestore ? live.page.captureRestore() : null,
          live.page.keepAwake?.() ?? null,
        ]),
        2_000,
        { timeoutError: () => new Error("Tab capture timed out.") },
      );
      if (live.page.captureRestore && engine === null) record.unrestorable = true;
      if (
        record.lease.demanded ||
        record.lease.state !== "sleeping" ||
        this.closing ||
        this.records.get(id) !== record ||
        record.documentId !== documentId ||
        blocked(record) ||
        keepAwake ||
        record.unrestorable
      )
        return false;
      record.restore = { url: record.url, engine };
      const disposing = this.disposeRecord(record);
      this.pageIds.delete(live.page);
      this.releaseTarget?.(record.lastTargetId);
      // Listeners are detached before the page ceases to be this tab's lease.
      (record as TabRecord).live = null;
      record.lease.endSleep(true);
      this.emit({ type: "changed", change: "updated", surface: this.toSurface(record) });
      await Promise.all([disposing, live.page.close()]);
      return true;
    } catch {
      if (record.live === live) record.unrestorable = true;
      return false;
    } finally {
      if (record.lease.state === "sleeping") record.lease.endSleep(false);
    }
  }
  async wake(id: BrowserSurfaceId): Promise<SurfaceBinding> {
    const record = this.records.get(id);
    if (!record) throw new BrowserRuntimeError("not_found", "The browser tab closed.");
    let resumed = false;
    await record.lease.resume(() =>
      this.creationLock.run(async () => {
        if (this.records.get(id) !== record || record.lease.state === "closing")
          throw new BrowserRuntimeError("not_found", "The browser tab closed.");
        const restore = record.restore;
        if (!restore || this.closing)
          throw new BrowserRuntimeError("not_found", "The browser session closed.");
        await withTimeout(Promise.resolve(this.creatingPage), 18_000, {
          timeoutError: () =>
            new BrowserRuntimeError("conflict", "Resuming this tab timed out.", {
              retryable: true,
            }),
        });
        const created = Promise.withResolvers<void>();
        this.creatingPage = created.promise;
        let page: BrowserPage | undefined;
        let accepting = true;
        try {
          const creating = this.context.createPage(
            restore.engine === null ? undefined : { restore: restore.engine },
          );
          void creating.then(
            (p) => {
              if (!accepting) void p.close().catch(() => undefined);
            },
            () => undefined,
          );
          page = await withTimeout(creating, 18_000, {
            timeoutError: () =>
              new BrowserRuntimeError("conflict", "Resuming this tab timed out.", {
                retryable: true,
              }),
          });
          await withTimeout(this.registerOnce(page, false, undefined, id, record), 18_000, {
            timeoutError: () =>
              new BrowserRuntimeError("conflict", "Resuming this tab timed out.", {
                retryable: true,
              }),
          });
          if (this.records.get(id) !== record || this.closing)
            throw new BrowserRuntimeError("not_found", "The browser tab closed.");
          if (restore.engine === null && isLive(record))
            await this.navigateLive(record, restore.url);
          if (this.records.get(id) !== record || !record.live)
            throw new BrowserRuntimeError("not_found", "The browser tab closed.");
          record.restore = null;
          record.usedAt = Date.now();
          resumed = true;
        } catch (error) {
          if (isLive(record)) await this.disposeRecord(record);
          if (page) {
            this.pageIds.delete(page);
            await page.close().catch(() => undefined);
          }
          this.releaseTarget?.(record.lastTargetId);
          record.live = null;
          if (record.restore) record.restore.engine = null;
          throw error;
        } finally {
          accepting = false;
          this.creatingPage = null;
          created.resolve();
        }
      }),
    );
    const binding = this.binding(id);
    if (!binding || record.lease.state === "closing")
      throw new BrowserRuntimeError("not_found", "The browser tab closed.");
    if (resumed) this.emit({ type: "changed", change: "updated", surface: binding.surface });
    return binding;
  }

  get activeSurfaceId(): BrowserSurfaceId | null {
    return this.activeId;
  }
  toRecord(id: BrowserSurfaceId): BrowserTabRecord | undefined {
    const record = this.records.get(id);
    if (!record?.announced) return undefined;
    const url = record.url;
    return {
      id,
      state: surfaceState(record),
      title: record.title.slice(0, 256),
      url: url.length <= browserWorkspaceTabUrlMaxLength ? url : "opensteer:unavailable-url",
      icon: record.favicon ? createHash("sha256").update(record.favicon).digest("base64url") : null,
      order: record.order,
      openerId: record.openerId,
      documentId: record.documentId,
      geometryRevision: record.geometryRevision,
      loading: record.live?.loading ?? false,
      navigationFailed: record.live?.navigationFailed ?? false,
      canGoBack: record.live?.navigation?.canGoBack ?? false,
      canGoForward: record.live?.navigation?.canGoForward ?? false,
      sizedByAgent: record.agentMetrics !== null,
    };
  }
  setSavedTabs(ids: Iterable<string>): void {
    this.dormantSurfaceIds.clear();
    for (const id of ids)
      if (!this.records.has(BrowserSurfaceIdSchema.parse(id)))
        this.dormantSurfaceIds.add(BrowserSurfaceIdSchema.parse(id));
  }

  /** Correlates only this Page.navigate with the document Chromium says it produced. */
  async navigate(surfaceId: BrowserSurfaceId, url: string, navigationId?: string) {
    const record = this.liveRecord(surfaceId);
    if (!record)
      return this.use(surfaceId, async () => {
        throw new BrowserRuntimeError("not_found", "The browser page closed.");
      });
    return this.use(surfaceId, () => this.navigateLive(record, url, navigationId));
  }
  private async navigateLive(record: SurfaceRecord, url: string, navigationId?: string) {
    const surfaceId = record.id;
    const attempt = ++record.live.navigationAttempt;
    this.setNavigationFailed(record, false);
    const pending: NavigationBinding | undefined = navigationId
      ? {
          url,
          documentId: record.documentId,
          sequence: record.live.commitSequence,
          sameDocument: url.split("#", 1)[0] === record.live.committedUrl.split("#", 1)[0],
          loaderId: undefined,
        }
      : undefined;
    if (pending && navigationId) {
      record.live.pendingNavigations.set(navigationId, pending);
      if (record.live.pendingNavigations.size > 32)
        record.live.pendingNavigations.delete(record.live.pendingNavigations.keys().next().value!);
    }
    try {
      const result = z
        .object({
          frameId: z.string().optional(),
          loaderId: z.string().optional(),
          errorText: z.string().optional(),
          isDownload: z.boolean().optional(),
        })
        .parse(await record.live.cdp.send("Page.navigate", { url }));
      if (attempt === record.live.navigationAttempt)
        this.setNavigationFailed(record, !!result.errorText);
      if (!pending || !navigationId || record.live.pendingNavigations.get(navigationId) !== pending)
        return result;
      if (
        this.records.get(surfaceId) !== record ||
        result.errorText ||
        result.isDownload ||
        (!result.loaderId && (!result.frameId || !pending.sameDocument))
      ) {
        record.live.pendingNavigations.delete(navigationId);
        return result;
      }
      pending.loaderId = result.loaderId || null;
      this.matchNavigation(record, navigationId, pending);
      return result;
    } catch (error) {
      if (navigationId) record.live.pendingNavigations.delete(navigationId);
      if (attempt === record.live.navigationAttempt) this.setNavigationFailed(record, true);
      throw error;
    }
  }

  private setNavigationFailed(record: SurfaceRecord, failed: boolean): void {
    if (this.records.get(record.id) !== record || record.live.navigationFailed === failed) return;
    record.live.navigationFailed = failed;
    if (failed) record.live.loading = false;
    if (record.announced)
      this.emit({ change: "updated", surface: this.toSurface(record), type: "changed" });
  }

  private matchNavigation(
    record: SurfaceRecord,
    navigationId: string,
    pending: NavigationBinding,
  ): void {
    if (pending.loaderId === undefined) return;
    const matched =
      pending.loaderId === null
        ? [...record.live.recentCommits.entries()].find(
            ([, commit]) =>
              commit.loaderId === null &&
              commit.sequence > pending.sequence &&
              commit.documentId === pending.documentId &&
              commit.url === pending.url,
          )
        : record.live.recentCommits.has(pending.loaderId)
          ? ([pending.loaderId, record.live.recentCommits.get(pending.loaderId)!] as const)
          : undefined;
    if (!matched) return;
    const [key, commit] = matched;
    if (commit.sequence <= pending.sequence) return;
    record.live.recentCommits.delete(key);
    record.live.pendingNavigations.delete(navigationId);
    this.emit({
      type: "navigation.committed",
      navigationId,
      surfaceId: record.id,
      documentId: commit.documentId,
      url: commit.url,
    });
  }

  private navigationCommitted(record: SurfaceRecord, loaderId: string | null): void {
    const sequence = ++record.live.commitSequence;
    record.live.recentCommits.set(loaderId ?? `same-document:${sequence}`, {
      documentId: record.documentId,
      url: record.live.committedUrl,
      sequence,
      loaderId,
    });
    if (record.live.recentCommits.size > 32)
      record.live.recentCommits.delete(record.live.recentCommits.keys().next().value!);
    for (const [navigationId, pending] of record.live.pendingNavigations)
      this.matchNavigation(record, navigationId, pending);
  }

  snapshot(): BrowserSurface[] {
    return [...this.records.values()]
      .filter((record) => record.announced)
      .map((record) => this.toSurface(record));
  }

  /**
   * The person's view of one page is this size, like a window's: the page
   * takes it unless an agent laid its own size over it, which stays, and
   * returns to this size once the agent clears it.
   */
  followViewport(
    surfaceId: BrowserSurfaceId,
    size: PageSize | (() => PageSize | null),
    beforeResize?: BeforePageResize,
  ): Promise<PageSizeWrite> {
    if (typeof size !== "function") assertPageSize(size);
    return this.personWrite(surfaceId, size, false, beforeResize);
  }

  /**
   * The person fits one page to their view: it takes this size and loses any
   * size an agent laid over it.
   */
  fitViewport(
    surfaceId: BrowserSurfaceId,
    size: PageSize,
    beforeResize?: BeforePageResize,
  ): Promise<PageSizeWrite> {
    assertPageSize(size);
    return this.personWrite(surfaceId, size, true, beforeResize);
  }

  /**
   * Lays an agent's device metrics over one of this session's pages. They go
   * through the page's own session,
   * not the agent's: an override belongs to the CDP session that set it, and
   * once that session detaches, as an agent's does after every Browser
   * Harness run, Chromium drops it at the page's next navigation. Each
   * request replaces the agent's last one whole, as in Chromium; a zero width
   * or height keeps following the person's size, and `null` clears the
   * agent's size. Null when the target is not one of this session's pages.
   */
  agentMetrics(
    targetId: string,
    metrics: CdpParameters | null,
    beforeResize?: BeforePageResize,
  ): Promise<PageSizeWrite | null> {
    if (metrics?.dontSetVisibleSize === true) {
      // Callers cannot independently control visible geometry. An engine may
      // derive this flag only while providing the complete capture surface.
      throw new BrowserRuntimeError(
        "bad_message",
        "dontSetVisibleSize is not supported: Opensteer shows the size a page is laid out at.",
      );
    }
    const found = this.recordForTarget(targetId);
    if (!found) return Promise.resolve(null);
    return this.use(found.id, () =>
      found.sizeLock.run(async () => {
        if (this.closed) throw new BrowserRuntimeError("conflict", "The surface ledger is closed.");
        const record = this.recordForTarget(targetId);
        if (record !== found) return null;
        if (record.live.dialog) {
          throw new BrowserRuntimeError(
            "conflict",
            "A JavaScript dialog is open on this page. Chromium changes its size only after the dialog is answered with Page.handleJavaScriptDialog.",
          );
        }
        const next = this.metricsFor(record, metrics);
        if (!metricsFit(next)) {
          throw new BrowserRuntimeError(
            "bad_message",
            "CDP device metrics exceed the bounded browser frame size.",
          );
        }
        const write = await this.applyMetrics(record, next, beforeResize, metrics);
        if (this.records.get(record.id) !== record) return write;
        const wasSized = record.agentMetrics !== null;
        record.agentMetrics = metrics;
        if (write.changed || wasSized !== (metrics !== null)) {
          this.emit({
            change: "updated",
            surface: this.toSurface(record),
            type: "changed",
          });
        }
        return write;
      }),
    );
  }

  /**
   * The size one page shows now, in CSS pixels: the whole viewport the stream
   * pictures, a scrollbar included. Null for a page that is gone.
   */
  viewportOf(surfaceId: BrowserSurfaceId): PageSize | null {
    const record = this.liveRecord(surfaceId);
    return record?.live?.applied ? metricsSize(record.live.applied) : null;
  }

  /** Keeps a page read and the operation using it atomic with ledger geometry writes. */
  withGeometry<T>(
    surfaceId: BrowserSurfaceId,
    operation: (cdp: CdpSession, geometry: PageGeometry | null) => Promise<T>,
  ): Promise<T> {
    return this.use(surfaceId, () => {
      const record = this.liveRecord(surfaceId);
      if (!record)
        throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
      return record.sizeLock.run(() => {
        if (this.closed || this.records.get(surfaceId) !== record || record.live.page.isClosed())
          throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
        return operation(record.live.cdp, record.live.appliedGeometry);
      });
    });
  }

  /** A JavaScript dialog is open on one page, an answer under way included. */
  dialogOpen(surfaceId: BrowserSurfaceId): boolean {
    return (this.liveRecord(surfaceId)?.live.dialog ?? null) !== null;
  }

  /** The JavaScript dialog open on one page, if any, until it is answered. */
  dialogOf(surfaceId: BrowserSurfaceId): BrowserDialog | null {
    const dialog = this.liveRecord(surfaceId)?.live.dialog;
    if (!dialog || dialog.answering) return null;
    return {
      id: dialog.id,
      message: dialog.message,
      surfaceId,
      type: dialog.type,
    };
  }

  /**
   * The person answers the dialog they were shown. An answer that comes late,
   * or twice, finds that dialog gone and reaches no other.
   */
  async answerDialog(
    dialogId: string,
    accept: boolean,
    promptText: string | undefined,
  ): Promise<BrowserSurfaceId> {
    const record = [...this.records.values()]
      .filter(isLive)
      .find((entry) => entry.live.dialog?.id === dialogId);
    const dialog = record?.live.dialog;
    if (!record || !dialog || dialog.answering) {
      throw new BrowserRuntimeError("conflict", "There is no active browser dialog.");
    }
    const surfaceId = record.id;
    dialog.answering = true;
    this.emit({ surfaceId, type: "dialog" });
    try {
      await this.use(surfaceId, () =>
        record.live.cdp.send("Page.handleJavaScriptDialog", {
          accept,
          ...(promptText === undefined ? {} : { promptText }),
        }),
      );
    } catch (error) {
      dialog.answering = false;
      this.emit({ surfaceId, type: "dialog" });
      throw error;
    }
    return surfaceId;
  }

  active(): SurfaceBinding | null {
    if (!this.activeId) return null;
    return this.binding(this.activeId);
  }

  async resolveTarget(targetId: string): Promise<boolean> {
    await this.settleTarget(targetId);
    return this.recordForTarget(targetId) !== undefined;
  }

  recordHumanActivity(
    surfaceId: BrowserSurfaceId,
    activity: Omit<BrowserUserActivity, "at">,
  ): void {
    const record = this.records.get(surfaceId);
    if (!record) return;
    record.personUsed = true;
    record.typed ||= activity.kind === "typing";
    this.touch(surfaceId, true);
    record.userActivity = { ...activity, at: new Date().toISOString() };
    record.userActivitySequence = ++this.sequence;
  }

  /**
   * Names the viewer behind the person input a page is receiving, before the
   * page can act on it. Null clears it: whoever gave that input is unknown.
   */
  recordViewerInput(
    surfaceId: BrowserSurfaceId,
    consumerToken: string | null | undefined,
    native = false,
  ): void {
    const record = this.records.get(surfaceId);
    if (!record) return;
    this.touch(surfaceId, true);
    record.viewerInput = consumerToken
      ? { at: Date.now(), consumerToken, sequence: ++this.sequence, native }
      : null;
  }

  /**
   * The viewer whose input opened a popup from this page. Only the page that
   * took the input can answer, and one input opens one popup, as the
   * browser's own user activation does. Nothing separates an agent's timer
   * firing just after that input from the input itself; Chromium reports both
   * as a user gesture.
   */
  private takeViewerInput(record: SurfaceRecord | undefined): string | null {
    const input = record?.viewerInput;
    if (!record || !input || input.sequence <= record.popupInputSequence) return null;
    record.popupInputSequence = input.sequence;
    return input.sequence > record.agentSequence && Date.now() - input.at < userActivationLifespanMs
      ? input.consumerToken
      : null;
  }

  latestViewerInput(surfaceId: BrowserSurfaceId): BrowserViewerInput | null {
    const record = this.liveRecord(surfaceId);
    const input = record?.viewerInput;
    return record &&
      input &&
      input.sequence > record.agentSequence &&
      Date.now() - input.at < userActivationLifespanMs
      ? input
      : null;
  }

  recordAgentCommand(targetId: string): void {
    const record = this.recordForTarget(targetId);
    if (record) {
      this.touch(record.id);
      record.agentSequence = ++this.sequence;
      for (const listener of this.agentCommandListeners) listener(record.id);
    }
  }

  targetActivity(targetId: string): BrowserTargetActivity | undefined {
    const record = this.recordForTarget(targetId);
    if (!record?.userActivity) return undefined;
    return {
      ...record.userActivity,
      sinceLastAgentCommand: record.userActivitySequence > record.agentSequence,
    };
  }

  /** The latest time the person's view resized one page, kept apart from their input. */
  targetResize(targetId: string): BrowserTargetResize | undefined {
    const record = this.recordForTarget(targetId);
    if (!record?.pageResize) return undefined;
    return {
      ...record.pageResize,
      sinceLastAgentCommand: record.pageResizeSequence > record.agentSequence,
    };
  }

  surfaceIdForTarget(targetId: string): BrowserSurfaceId | undefined {
    return [...this.records.values()].find((record) => record.lastTargetId === targetId)?.id;
  }

  /**
   * Settles registration before an agent attaches, unless a dialog must be
   * answered first. Initial metrics hold the page's size lock either way,
   * so an agent's later size write cannot race behind the starting size.
   */
  async settleTarget(targetId: string): Promise<void> {
    const record = this.recordForTarget(targetId);
    if (record) {
      if (!record.live.dialog) await this.registrations.get(record.live.page);
      return;
    }
    const page = await this.pageForTarget(targetId);
    if (page) await this.registerDiscovered(page);
  }

  /**
   * Adds a target created through this session's scoped CDP router. The target
   * ID is authoritative because callers may only pass the result of a
   * successful, session-scoped Target.createTarget.
   */
  async adoptTarget(targetId: string): Promise<boolean> {
    if (this.closed) throw new BrowserRuntimeError("conflict", "The surface ledger is closed.");
    if (this.recordForTarget(targetId)) {
      const record = this.recordForTarget(targetId)!;
      record.origin = "agent";
      record.personUsed = false;
      await this.settleTarget(targetId);
      return this.recordForTarget(targetId) !== undefined;
    }
    this.adoptedTargetIds.add(targetId);
    const page = await this.pageForTarget(targetId);
    if (!page) return false;
    await this.register(page, false);
    if (!this.pageIds.has(page)) this.adoptedTargetIds.delete(targetId);
    return this.pageIds.has(page);
  }

  /** The full address of the document a page has committed, before any display bound. */
  committedUrl(surfaceId: BrowserSurfaceId): string | null {
    return (
      this.records.get(surfaceId)?.live?.committedUrl ?? this.records.get(surfaceId)?.url ?? null
    );
  }

  binding(surfaceId: BrowserSurfaceId): SurfaceBinding | null {
    const record = this.liveRecord(surfaceId);
    if (!record) return null;
    return {
      cdp: record.live.cdp,
      page: record.live.page,
      surface: this.toSurface(record),
      targetId: record.live.targetId,
    };
  }

  /** The geometry last applied to a page, with the revision pointer input and activity are measured against. */
  appliedGeometry(
    surfaceId: BrowserSurfaceId,
  ): { geometry: PageGeometry; geometryRevision: number } | null {
    const record = this.liveRecord(surfaceId);
    if (!record?.live?.appliedGeometry) return null;
    return { geometry: record.live.appliedGeometry, geometryRevision: record.geometryRevision };
  }

  async activate(surfaceId: BrowserSurfaceId): Promise<void> {
    if (!this.records.has(surfaceId)) {
      throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
    }
    if (this.activeId === surfaceId) return;
    this.activeId = surfaceId;
    this.emitSnapshot();
  }

  /**
   * Opens a fresh page for the person, selecting it unless `activate` is false. It
   * starts at `viewport`, the size of the place they will read it, or at the
   * size their view last gave this session without one.
   */
  async openSurface(
    options: {
      readonly signal?: AbortSignal;
      readonly viewport?: Viewport;
      readonly activate?: boolean;
      readonly surfaceId?: BrowserSurfaceId;
    } = {},
  ): Promise<BrowserSurface> {
    return this.creationLock.run(() => this.openSurfaceOnce(options));
  }

  private async openSurfaceOnce(options: {
    readonly signal?: AbortSignal;
    readonly viewport?: Viewport;
    readonly activate?: boolean;
    readonly surfaceId?: BrowserSurfaceId;
  }): Promise<BrowserSurface> {
    options.signal?.throwIfAborted();
    if (this.closed) throw new BrowserRuntimeError("conflict", "The surface ledger is closed.");
    if (options.surfaceId && this.records.has(options.surfaceId))
      return this.toSurface(this.liveRecord(options.surfaceId)!);
    if (options.viewport) assertViewport(options.viewport);
    if (this.atCapacity(options.surfaceId)) {
      throw new BrowserRuntimeError("conflict", "This browser session holds all the tabs it can.", {
        reason: browserSessionTabsFullReason,
      });
    }
    // Discovery waits until the creator has assigned the requested identity.
    await withTimeout(Promise.resolve(this.creatingPage), 18_000, {
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutError: () => new BrowserRuntimeError("conflict", "Opening this page timed out."),
    });
    options.signal?.throwIfAborted();
    let created: () => void = () => undefined;
    this.creatingPage = new Promise<void>((resolve) => {
      created = resolve;
    });
    let page: BrowserPage;
    try {
      const creating = this.context.createPage();
      void creating.then(
        (created) => {
          if (options.signal?.aborted) void created.close().catch(() => undefined);
        },
        () => undefined,
      );
      page = await withTimeout(creating, 18_000, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutError: () => new BrowserRuntimeError("conflict", "Opening this page timed out."),
      });
      const abort = () => {
        void page.close().catch(() => undefined);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        await withTimeout(
          this.register(page, options.activate ?? true, options.viewport, options.surfaceId),
          18_000,
          {
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutError: () => new BrowserRuntimeError("conflict", "Opening this page timed out."),
          },
        );
        options.signal?.throwIfAborted();
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    } finally {
      this.creatingPage = null;
      created();
    }
    const id = this.pageIds.get(page);
    const record = id ? this.liveRecord(id) : undefined;
    if (!record) {
      await page.close().catch(() => undefined);
      throw new BrowserRuntimeError("conflict", "The browser could not open a new tab.");
    }
    return this.toSurface(record);
  }

  recordPageScale(surfaceId: BrowserSurfaceId, scale: number): number {
    const record = this.liveRecord(surfaceId);
    if (!record) return 0;
    if (record.live.pageScale !== scale) {
      record.live.pageScale = scale;
      record.geometryRevision++;
      this.emit({ type: "changed", change: "updated", surface: this.toSurface(record) });
    }
    return record.geometryRevision;
  }

  sealLastSurface(surfaceId: BrowserSurfaceId): boolean {
    if (
      this.inventorySealed ||
      this.records.size !== 1 ||
      !this.records.has(surfaceId) ||
      this.discoveries > 0 ||
      this.registrations.size > 0
    )
      return false;
    this.inventorySealed = true;
    return true;
  }

  async closeSurface(surfaceId: BrowserSurfaceId): Promise<void> {
    const record = this.records.get(surfaceId);
    if (!record) throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
    record.lease.close();
    await record.live?.page.close();
    await this.remove(record);
  }

  async refresh(surfaceId: BrowserSurfaceId): Promise<void> {
    const record = this.liveRecord(surfaceId);
    if (!record || record.live.page.isClosed() || record.live.restoring) return;
    const url = surfaceAddress(record);
    if (url !== record.url) {
      record.url = url;
      this.emit({
        change: "updated",
        surface: this.toSurface(record),
        type: "changed",
      });
    }
    record.live.faviconReader?.refresh(record.documentId, normalizeUrl(record.live.committedUrl));
    record.live.titleReader?.sample();
    await this.refreshNavigation(record);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.records.values()) record.lease.close();
    this.emit({ type: "closed" });
    this.context.offPage(this.onPage);
    const registrations = [...this.registrations.values()];
    const removals = [...this.removals.values()];
    let records: TabRecord[] = [];
    await this.viewportMutex.run(async () => {
      records = [...this.records.values()];
      this.records.clear();
      this.pageIds.clear();
      this.adoptedTargetIds.clear();
      this.activeId = null;
    });
    await Promise.allSettled([
      ...registrations,
      ...removals,
      ...records.filter(isLive).map((record) => this.disposeRecord(record)),
    ]);
    this.listeners.clear();
    this.agentCommandListeners.clear();
  }

  async closeOwnedPages(): Promise<void> {
    this.tearingDown = true;
    await Promise.allSettled(
      [...this.records.values()].filter(isLive).map((record) => record.live.page.close()),
    );
  }

  forgetDormantSurface(surfaceId: BrowserSurfaceId): void {
    this.dormantSurfaceIds.delete(surfaceId);
  }

  private atCapacity(surfaceId?: BrowserSurfaceId): boolean {
    if (surfaceId && this.dormantSurfaceIds.has(surfaceId)) return false;
    return (
      this.records.size +
        [...this.registrations.keys()].filter((page) => !this.pageIds.has(page)).length +
        this.dormantSurfaceIds.size >=
      this.maxSurfaces
    );
  }

  private liveRecord(id: BrowserSurfaceId): SurfaceRecord | undefined {
    const record = this.records.get(id);
    return record && isLive(record) ? record : undefined;
  }

  private recordForTarget(targetId: string): SurfaceRecord | undefined {
    return [...this.records.values()]
      .filter(isLive)
      .find((record) => record.live.targetId === targetId);
  }

  /**
   * The page for a target known to be one: a tab this session created or a
   * page its router owns. An engine can surface its page object a moment
   * after CDP announced the target, as Playwright does for a popup, so it is
   * waited for, briefly, rather than taken to be absent.
   */
  private async pageForTarget(targetId: string): Promise<BrowserPage | null> {
    const deadline = Date.now() + pageAppearanceTimeoutMs;
    for (;;) {
      for (const page of this.context.pages()) {
        if (!page.isClosed() && (await page.targetId()) === targetId) return page;
      }
      if (this.closed || Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        const appeared = () => finish();
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
        function finish(): void {
          clearTimeout(timer);
          context.offPage(appeared);
          resolve();
        }
        const context = this.context;
        context.onPage(appeared);
      });
    }
  }

  private async registerDiscovered(page: BrowserPage): Promise<void> {
    await this.creatingPage;
    if (!this.rootPages) {
      await this.register(page, false);
      return;
    }
    const targetId = await page.targetId();
    if (this.adoptedTargetIds.has(targetId)) {
      await this.register(page, false);
      if (!this.pageIds.has(page)) this.adoptedTargetIds.delete(targetId);
      return;
    }
    const opener = await page.opener().catch(() => null);
    if (!opener || !this.pageIds.has(opener)) return;
    await this.register(page, false);
  }

  private async register(
    page: BrowserPage,
    makeActive: boolean,
    viewport?: Viewport,
    surfaceId?: BrowserSurfaceId,
  ): Promise<void> {
    const existing = this.registrations.get(page);
    if (existing || this.pageIds.has(page)) {
      await existing;
      // The engine announced the page and another path registered it first;
      // an explicit open still decides its size and selection.
      const id = this.pageIds.get(page);
      if (!id) return;
      if (viewport) await this.fitViewport(id, viewport);
      if (makeActive) await this.activate(id);
      return;
    }
    if (this.atCapacity(surfaceId)) {
      await page.close().catch(() => undefined);
      return;
    }
    const registration = this.registerOnce(page, makeActive, viewport, surfaceId).finally(() => {
      this.registrations.delete(page);
    });
    this.registrations.set(page, registration);
    await registration;
  }

  private async registerOnce(
    page: BrowserPage,
    makeActive: boolean,
    requestedViewport: Viewport | undefined,
    surfaceId: BrowserSurfaceId | undefined,
    waking?: TabRecord,
  ): Promise<void> {
    if (this.closed || page.isClosed() || this.pageIds.has(page)) return;
    if (this.inventorySealed) {
      await page.close();
      throw new BrowserRuntimeError("conflict", "The browser session is closing.");
    }
    const id = surfaceId ?? BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`);
    let cdp: CdpSession | null = null;
    let registered: SurfaceRecord | undefined;
    try {
      const acquiredCdp = await page.cdp();
      cdp = acquiredCdp;
      // The title is read from the page's own document once it is registered;
      // browser-side target info cannot say which document a title belongs to.
      const [opener, targetId] = await Promise.all([
        page.opener().catch(() => null),
        page.targetId(),
      ]);
      let sawDialog: () => void = () => undefined;
      const dialogOpening = new Promise<void>((resolve) => {
        sawDialog = resolve;
      });
      let announce: () => void = () => undefined;
      await this.viewportMutex.run(async () => {
        if (this.closed || page.isClosed() || this.pageIds.has(page)) {
          await acquiredCdp.detach().catch(() => undefined);
          return;
        }
        if (waking && (this.records.get(id) !== waking || waking.lease.state === "closing"))
          throw new BrowserRuntimeError("not_found", "The browser tab closed.");
        this.claimTarget?.(targetId);
        const size = requestedViewport ?? this.startingSize(opener);
        const openerId = opener ? this.pageIds.get(opener) : undefined;
        const openerRecord = openerId ? this.liveRecord(openerId) : undefined;
        const answersPerson =
          openerRecord?.userActivity?.kind === "click" &&
          openerRecord.userActivitySequence > openerRecord.agentSequence;
        const forward =
          makeActive ||
          (answersPerson && Date.now() < this.legacyPersonUntil && openerId === this.activeId);
        const follower = page.openedInBackground ? null : this.takeViewerInput(openerRecord);
        const record: SurfaceRecord = Object.assign(
          waking ?? {
            documentId: randomUUID(),
            geometryRevision: 0,
            order: this.nextOrder++,
            openerId: opener ? (this.pageIds.get(opener) ?? null) : null,
            agentMetrics: null,
            agentSequence: 0,
            announced: false,
            favicon: null,
            id,
            ordinary: { height: size.height, width: size.width },
            pageResizeSequence: 0,
            sizeLock: new AsyncMutex(),
            title: "",
            url: page.url(),
            userActivitySequence: 0,
            viewerInput: null,
            popupInputSequence: 0,
            lease: new TabLease(() => this.policyChanged()),
            lastTargetId: targetId,
            origin:
              openerRecord?.origin ?? (this.adoptedTargetIds.has(targetId) ? "agent" : "person"),
            personUsed: openerRecord
              ? openerRecord.origin === "person"
              : !this.adoptedTargetIds.has(targetId),
            agentActed: false,
            typed: false,
            usedAt: Date.now(),
            unrestorable: false,
            restore: null,
          },
          {
            documentId: randomUUID(),
            geometryRevision: (waking?.geometryRevision ?? -1) + 1,
            lastTargetId: targetId,
            live: {
              commitSequence: 0,
              pendingNavigations: new Map(),
              recentCommits: new Map(),
              navigation: null,
              navigationRevision: 0,
              navigationFailed: false,
              navigationAttempt: 0,
              loaderId: null,
              titleReader: null,
              pageScale: 1,
              onFrameNavigated: (parameters: unknown) => {
                if (
                  parameters &&
                  typeof parameters === "object" &&
                  "frame" in parameters &&
                  parameters.frame &&
                  typeof parameters.frame === "object" &&
                  !("parentId" in parameters.frame) &&
                  "url" in parameters.frame &&
                  typeof parameters.frame.url === "string"
                ) {
                  const fragment =
                    "urlFragment" in parameters.frame &&
                    typeof parameters.frame.urlFragment === "string" &&
                    parameters.frame.urlFragment.startsWith("#")
                      ? parameters.frame.urlFragment
                      : "";
                  if (
                    record.live.restoring &&
                    parameters.frame.url === "about:blank" &&
                    record.url !== "about:blank"
                  )
                    return;
                  record.live.restoring = false;
                  record.typed = false;
                  record.agentActed = false;
                  record.unrestorable = false;
                  record.live.committedUrl = parameters.frame.url + fragment;
                  record.live.unreachableUrl =
                    "unreachableUrl" in parameters.frame &&
                    typeof parameters.frame.unreachableUrl === "string"
                      ? attemptedAddress(parameters.frame.unreachableUrl)
                      : null;
                  record.url = surfaceAddress(record);
                }
                if (!parameters || typeof parameters !== "object" || !("frame" in parameters))
                  return;
                const frame = parameters.frame;
                if (!frame || typeof frame !== "object" || "parentId" in frame) return;
                void this.refreshNavigation(record).catch(() => undefined);
                record.live.pageScale = 1;
                record.documentId = randomUUID();
                record.live.loaderId =
                  "loaderId" in frame && typeof frame.loaderId === "string" ? frame.loaderId : null;
                // A new document has no title until its own document names one.
                record.title = "";
                record.favicon = null;
                // Reload, history and an agent's own navigation all commit without navigate().
                record.live.navigationFailed =
                  record.live.unreachableUrl !== null ||
                  record.live.committedUrl.startsWith("chrome-error://");
                record.live.faviconReader?.refresh(
                  record.documentId,
                  normalizeUrl(record.live.committedUrl),
                );
                record.geometryRevision++;
                if (record.announced)
                  this.emit({
                    change: "updated",
                    surface: this.toSurface(record),
                    type: "changed",
                  });
                if (record.live.loaderId) this.navigationCommitted(record, record.live.loaderId);
                record.live.titleReader?.sample();
              },
              onFrameStartedLoading: (parameters: unknown) =>
                this.loadingChanged(record, parameters, true),
              onFrameStoppedLoading: (parameters: unknown) =>
                this.loadingChanged(record, parameters, false),
              loading: false,
              applied: null,
              appliedGeometry: null,
              stopObservingHumanInput: undefined,
              unbindGeometry: undefined,
              cdp: acquiredCdp,
              dialog: null,
              faviconReader: null,
              scriptTargets: null,
              onClose: () => {
                void this.remove(record).catch(() => undefined);
              },
              onDialogClosed: (parameters: unknown) => {
                this.emit({
                  type: "dialog-event",
                  targetId: record.live.targetId,
                  method: "Page.javascriptDialogClosed",
                  parameters:
                    parameters !== null && typeof parameters === "object"
                      ? (parameters as CdpParameters)
                      : {},
                });
                void this.dialogClosed(record).catch(() => undefined);
                record.live.titleReader?.sample();
              },
              onDialogOpening: (parameters: unknown) => {
                this.dialogOpened(record, parameters);
                if (!record.live.dialog) return;
                if (!record.live.applied)
                  this.keepForDialog(record, record.ordinary, true, undefined);
                announce();
                sawDialog();
              },
              onMetadataChanged: () => {
                if (record.announced) void this.refresh(record.id).catch(() => undefined);
              },
              page,
              sizeWaiting: null,
              targetId,
              committedUrl: page.url(),
              unreachableUrl: null,
              onSameDocumentNavigation: (parameters: unknown) => {
                if (
                  !parameters ||
                  typeof parameters !== "object" ||
                  !("frameId" in parameters) ||
                  parameters.frameId !== targetId ||
                  !("url" in parameters) ||
                  typeof parameters.url !== "string"
                )
                  return;
                void this.refreshNavigation(record).catch(() => undefined);
                record.live.committedUrl = parameters.url;
                record.live.unreachableUrl = null;
                record.url = record.live.committedUrl;
                if (record.announced)
                  this.emit({
                    type: "changed",
                    change: "updated",
                    surface: this.toSurface(record),
                  });
                if ("navigationType" in parameters && parameters.navigationType === "fragment")
                  this.navigationCommitted(record, null);
                record.live.titleReader?.sample();
              },
              restoring: waking !== undefined,
            },
          },
        );
        announce = () => {
          if (waking || record.announced || this.closed || this.records.get(id) !== record) return;
          record.announced = true;
          record.live.scriptTargets?.start();
          if (forward || !this.activeId) this.activeId = id;
          this.emit({
            change: "created",
            surface: this.toSurface(record),
            type: "changed",
          });
          if (forward) this.emitSnapshot();
          if (follower) this.emit({ consumerToken: follower, surfaceId: id, type: "popup" });
          void this.refresh(id).catch(() => undefined);
        };
        registered = record;
        record.live.unbindGeometry = page.bindGeometry?.(
          (operation) =>
            this.use(id, () =>
              record.sizeLock.run(async () => {
                if (this.closed || this.records.get(id) !== record || page.isClosed()) return;
                await operation();
              }),
            ),
          async () => this.beforeResize?.(id),
        );
        this.records.set(id, record);
        record.live.faviconReader = new PageFavicon(acquiredCdp, targetId, (favicon) => {
          if (
            this.records.get(id) !== record ||
            record.live.restoring ||
            record.favicon === favicon
          )
            return;
          record.favicon = favicon;
          if (record.announced)
            this.emit({ change: "updated", surface: this.toSurface(record), type: "changed" });
        });
        record.live.scriptTargets = new PageScriptTargets(acquiredCdp);
        record.live.titleReader = new PageTitleReader(
          acquiredCdp,
          targetId,
          () =>
            this.records.get(id) === record && !page.isClosed() && !record.live.restoring
              ? {
                  committedUrl: record.live.committedUrl,
                  documentId: record.documentId,
                  loaderId: record.live.loaderId,
                }
              : null,
          (documentId, loaderId) => {
            if (record.documentId === documentId && record.live.loaderId === null)
              record.live.loaderId = loaderId;
          },
          (documentId, title) => {
            const next = normalizeTitle(title);
            if (this.records.get(id) !== record || record.documentId !== documentId) return;
            if (next === record.title) return;
            record.title = next;
            if (record.announced)
              this.emit({ change: "updated", surface: this.toSurface(record), type: "changed" });
          },
        );
        this.dormantSurfaceIds.delete(id);
        this.pageIds.set(page, id);
        record.live.stopObservingHumanInput = page.observeHumanInput?.((observation) => {
          this.recordHumanActivity(id, observation);
        });
        page.onClose(record.live.onClose);
        page.onMetadataChanged(record.live.onMetadataChanged);
        acquiredCdp.on("Page.frameNavigated", record.live.onFrameNavigated);
        acquiredCdp.on("Page.navigatedWithinDocument", record.live.onSameDocumentNavigation);
        acquiredCdp.on("Page.frameStartedLoading", record.live.onFrameStartedLoading);
        acquiredCdp.on("Page.frameStoppedLoading", record.live.onFrameStoppedLoading);
        acquiredCdp.on("Page.javascriptDialogClosed", record.live.onDialogClosed);
        acquiredCdp.on("Page.javascriptDialogOpening", record.live.onDialogOpening);
      });
      const record = registered;
      if (!record) return;
      // Target metadata is browser-side. Page.enable and size writes also
      // reach the renderer, which answers neither while its dialog is open.
      // The record and listeners exist first, so that dialog can be answered.
      const initialized = record.sizeLock.run(async () => {
        await acquiredCdp.send("Page.enable");
        if (record.live?.page !== page || page.isClosed()) return;
        await this.initializeDocument(record);
        await this.refreshNavigation(record);
        if (this.closed || this.records.get(id) !== record || page.isClosed()) return;
        if (record.live.dialog) {
          this.keepForDialog(record, record.ordinary, true, undefined);
          return;
        }
        const write = await this.applyMetrics(
          record,
          this.metricsFor(record, record.agentMetrics),
          undefined,
        );
        // A first-script dialog can announce the page before initialization
        // finishes. Publish its eventual geometry before a stream uses it.
        if (write.changed && record.announced) this.emit({ surfaceId: record.id, type: "resized" });
      });
      // A dialog makes the page reachable immediately; initialization keeps
      // its per-page lock until Chromium answers, without holding other pages.
      void initialized
        .catch(() => (record.announced ? page.close() : undefined))
        .catch(() => undefined);
      await Promise.race([initialized, dialogOpening]);
      announce();
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...(registered
          ? [
              waking
                ? registered.live?.page === page
                  ? this.disposeRecord(registered)
                  : Promise.resolve()
                : this.remove(registered),
            ]
          : cdp
            ? [cdp.detach()]
            : []),
        page.close(),
      ]);
      const cleanupFailures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Browser surface registration and cleanup both failed.",
        );
      }
      throw error;
    }
  }

  /**
   * A popup opens at the size its opener shows; any other page at the size
   * the person's view last gave this session.
   */
  private startingSize(opener: BrowserPage | null): PageSize {
    const openerId = opener ? this.pageIds.get(opener) : undefined;
    const openerRecord = openerId ? this.liveRecord(openerId) : undefined;
    if (!openerRecord) return { ...this.followedSize };
    return openerRecord.live.applied
      ? metricsSize(openerRecord.live.applied)
      : { ...openerRecord.ordinary };
  }

  /**
   * One size write from the person's view. The page always keeps the
   * person's size; whether it shows it depends on any size an agent laid over
   * it. Only the size a view follows is where the session's next pages start:
   * a fit or a tab opened from a phone sizes that page alone, so a glance from
   * a phone never narrows the pages an agent opens next.
   */
  private personWrite(
    surfaceId: BrowserSurfaceId,
    requested: PageSize | (() => PageSize | null),
    fit: boolean,
    beforeResize: BeforePageResize | undefined,
  ): Promise<PageSizeWrite> {
    const found = this.liveRecord(surfaceId);
    if (!found && this.records.has(surfaceId))
      return this.use(surfaceId, async () => ({ changed: false }));
    if (!found) {
      return Promise.reject(
        new BrowserRuntimeError("not_found", "The browser surface does not exist."),
      );
    }
    // Under a dialog the page answers no write, and one Chromium already holds
    // keeps this page's lock until the dialog closes; the person's size waits
    // here instead, so nothing the person does next waits behind it.
    if (found.live.dialog) {
      this.keepForDialog(found, requested, fit, beforeResize);
      return Promise.resolve({ changed: false });
    }
    return this.use(found.id, () =>
      found.sizeLock.run(async () => {
        if (this.closed) throw new BrowserRuntimeError("conflict", "The surface ledger is closed.");
        const record = this.liveRecord(surfaceId);
        if (record !== found || record.live.page.isClosed()) {
          throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
        }
        if (record.live.dialog) {
          this.keepForDialog(record, requested, fit, beforeResize);
          return { changed: false };
        }
        const size = typeof requested === "function" ? requested() : requested;
        if (!size) return { changed: false };
        assertPageSize(size);
        if (!fit) this.followedSize = { height: size.height, width: size.width };
        record.ordinary = { height: size.height, width: size.width };
        return this.applyPersonSize(record, beforeResize, fit && this.removeAgentSize(record));
      }),
    );
  }

  /** Records the person's size for a page under a dialog; it lands when the dialog closes. */
  private keepForDialog(
    record: SurfaceRecord,
    size: PageSize | (() => PageSize | null),
    fit: boolean,
    beforeResize: BeforePageResize | undefined,
  ): void {
    if (typeof size === "function") {
      record.live.sizeWaiting = {
        beforeResize,
        fit: record.live.sizeWaiting?.fit === true,
        hasPersonSize: record.live.sizeWaiting?.hasPersonSize === true,
        followSize: size,
      };
      return;
    }
    if (!fit) this.followedSize = { height: size.height, width: size.width };
    record.ordinary = { height: size.height, width: size.width };
    record.live.sizeWaiting = {
      beforeResize,
      fit: fit || record.live.sizeWaiting?.fit === true,
      hasPersonSize: true,
    };
  }

  /** The person's fit removes the size an agent set; answers whether there was one. */
  private removeAgentSize(record: SurfaceRecord): boolean {
    if (record.agentMetrics === null) return false;
    record.agentMetrics = null;
    this.emit({
      change: "updated",
      surface: this.toSurface(record),
      type: "changed",
    });
    return true;
  }

  /**
   * Shows the person's size, under any agent size, and records when that
   * changed what the page shows. Runs under the size lock.
   */
  private async applyPersonSize(
    record: SurfaceRecord,
    beforeResize: BeforePageResize | undefined,
    agentSizeRemoved: boolean,
  ): Promise<PageSizeWrite> {
    const next = this.metricsFor(record, record.agentMetrics);
    // An agent's size that would follow a larger view past the frame bound
    // stays where it is until the agent changes it or the person fits.
    if (!metricsFit(next)) return { changed: false };
    const before = record.live.applied ? metricsSize(record.live.applied) : null;
    const write = await this.applyMetrics(record, next, beforeResize);
    if (this.records.get(record.id) !== record) return write;
    const after = record.live.applied ? metricsSize(record.live.applied) : null;
    if (
      after &&
      before &&
      (agentSizeRemoved || after.width !== before.width || after.height !== before.height)
    ) {
      record.pageResize = {
        at: new Date().toISOString(),
        ...after,
        ...(agentSizeRemoved ? { agentSizeRemoved: true as const } : {}),
      };
      record.pageResizeSequence = ++this.sequence;
    }
    if (write.changed) this.emit({ type: "resized", surfaceId: record.id });
    return write;
  }

  private dialogOpened(record: SurfaceRecord, parameters: unknown): void {
    const dialog = parseDialog(parameters);
    if (!dialog) return;
    record.live.dialog = { ...dialog, answering: false, id: randomUUID() };
    record.live.faviconReader?.dialog(true);
    this.emit({
      type: "dialog-event",
      targetId: record.live.targetId,
      method: "Page.javascriptDialogOpening",
      parameters: { ...(parameters as CdpParameters), dialogId: record.live.dialog.id },
    });
    this.emit({ surfaceId: record.id, type: "dialog" });
  }

  /** A page's dialog closed: the person's size that waited for it reaches the page. */
  private async dialogClosed(record: SurfaceRecord): Promise<void> {
    const initializing = record.live.applied === null;
    record.live.dialog = null;
    record.live.faviconReader?.dialog(false);
    if (!initializing) this.emit({ surfaceId: record.id, type: "dialog" });
    if (!record.live.sizeWaiting) return;
    await record.sizeLock.run(async () => {
      if (this.closed || this.records.get(record.id) !== record || record.live.dialog) return;
      const waiting = record.live.sizeWaiting;
      if (!waiting) return;
      record.live.sizeWaiting = null;
      if (waiting.followSize) {
        const size = waiting.followSize();
        if (size) {
          assertPageSize(size);
          this.followedSize = { ...size };
          record.ordinary = { ...size };
        } else if (!waiting.hasPersonSize) return;
      }
      // A fit removes the agent's size only now, after any agent write the
      // dialog held, so that write cannot put it back.
      const write = await this.applyPersonSize(
        record,
        waiting.beforeResize,
        waiting.fit && this.removeAgentSize(record),
      );
      if (write.changed) this.emit({ surfaceId: record.id, type: "resized" });
      // A first-document dialog closed before the page ever had geometry;
      // its stream can start only once the starting size has reached it.
      if (initializing) this.emit({ surfaceId: record.id, type: "dialog" });
    });
  }

  /** Sends `next` unless the page already shows exactly it. Runs under the size lock. */
  private async applyMetrics(
    record: SurfaceRecord,
    next: CdpParameters,
    beforeResize: BeforePageResize | undefined,
    agent: CdpParameters | null = record.agentMetrics,
  ): Promise<PageSizeWrite> {
    const geometry: PageGeometry = {
      person: { ...record.ordinary },
      agent: agent ? resolveAgentSize(record.ordinary, agent) : null,
    };
    const same = record.live.applied && sameMetrics(record.live.applied, next);
    if (
      same &&
      (!record.live.page.applyGeometry ||
        canonicalJson(record.live.appliedGeometry) === canonicalJson(geometry))
    )
      return { changed: false };
    if (!same) await beforeResize?.();
    try {
      if (record.live.page.applyGeometry) await record.live.page.applyGeometry(geometry);
      else await record.live.cdp.send("Emulation.setDeviceMetricsOverride", next);
    } catch (error) {
      if (!record.live.page.isClosed()) throw error;
      throw new BrowserRuntimeError("not_found", "The browser surface does not exist.", {
        cause: error,
      });
    }
    if (this.records.get(record.id) === record) {
      record.live.applied = next;
      record.live.appliedGeometry = geometry;
      if (!same) record.geometryRevision++;
      this.emit({
        type: "geometry",
        surfaceId: record.id,
        geometry,
        geometryRevision: record.geometryRevision,
      });
    }
    return { changed: !same };
  }

  private metricsFor(record: SurfaceRecord, agent: CdpParameters | null): CdpParameters {
    return record.live.page.applyGeometry && agent
      ? resolveAgentSize(record.ordinary, agent)
      : effectiveMetrics(record.ordinary, agent);
  }

  private async remove(record: TabRecord): Promise<void> {
    const existing = this.removals.get(record.id);
    if (existing) return existing;
    const removal = this.removeOnce(record).finally(() => {
      this.removals.delete(record.id);
    });
    this.removals.set(record.id, removal);
    return removal;
  }

  private async removeOnce(record: TabRecord): Promise<void> {
    await this.viewportMutex.run(async () => {
      if (!this.records.delete(record.id)) return;
      record.lease.close();
      this.adoptedTargetIds.delete(record.lastTargetId);
      this.releaseTarget?.(record.lastTargetId);
      if (record.live) this.pageIds.delete(record.live.page);
      const wasActive = this.activeId === record.id;
      if (wasActive) this.activeId = null;
      if (isLive(record)) await this.disposeRecord(record);
      if (record.announced && !this.tearingDown) {
        const closedSurface = { ...this.toSurface(record), active: false };
        this.emit({
          change: "closed",
          closure: this.context.isConnected?.() === false ? "teardown" : "page",
          surface: closedSurface,
          type: "changed",
        });
      }
      if (wasActive) {
        const next = [...this.records.values()].findLast((entry) => entry.announced);
        if (next) this.activeId = next.id;
        this.emitSnapshot();
      }
    });
  }

  private async disposeRecord(record: SurfaceRecord): Promise<void> {
    const live = record.live;
    live.pendingNavigations.clear();
    live.recentCommits.clear();
    live.titleReader?.close();
    live.stopObservingHumanInput?.();
    live.unbindGeometry?.();
    live.page.offClose(live.onClose);
    live.page.offMetadataChanged(live.onMetadataChanged);
    live.cdp.off("Page.frameNavigated", live.onFrameNavigated);
    live.cdp.off("Page.navigatedWithinDocument", live.onSameDocumentNavigation);
    live.cdp.off("Page.frameStartedLoading", live.onFrameStartedLoading);
    live.cdp.off("Page.frameStoppedLoading", live.onFrameStoppedLoading);
    live.cdp.off("Page.javascriptDialogOpening", live.onDialogOpening);
    live.cdp.off("Page.javascriptDialogClosed", live.onDialogClosed);
    await Promise.all([live.faviconReader?.close(), live.scriptTargets?.close()]);
    await live.cdp.detach().catch(() => undefined);
  }

  /**
   * A page target's main frame shares its target's id, so only that frame's
   * loads are the tab's; an iframe refreshing an ad never spins the tab.
   */
  private loadingChanged(record: SurfaceRecord, parameters: unknown, loading: boolean): void {
    if (
      !parameters ||
      typeof parameters !== "object" ||
      !("frameId" in parameters) ||
      parameters.frameId !== record.live.targetId ||
      record.live.loading === loading
    )
      return;
    record.live.loading = loading;
    if (!loading) {
      this.touch(record.id);
      void this.refreshNavigation(record).catch(() => undefined);
    }
    if (record.announced && this.records.get(record.id) === record)
      this.emit({ change: "updated", surface: this.toSurface(record), type: "changed" });
  }

  private async initializeDocument(record: SurfaceRecord): Promise<void> {
    const live = record.live;
    const documentId = record.documentId;
    const committedUrl = live.committedUrl;
    // Page.enable does not replay a commit that raced renderer initialization.
    const snapshot = await live.cdp.send("Page.getFrameTree");
    if (
      this.closed ||
      this.records.get(record.id) !== record ||
      record.live !== live ||
      live.page.isClosed() ||
      record.documentId !== documentId ||
      live.committedUrl !== committedUrl
    )
      return;
    const frame = z
      .object({
        frameTree: z.object({
          frame: z.object({
            id: z.string(),
            loaderId: z.string(),
            url: z.string(),
            urlFragment: z.string().optional(),
            unreachableUrl: z.string().optional(),
            parentId: z.string().optional(),
          }),
        }),
      })
      .parse(snapshot).frameTree.frame;
    if (frame.id !== live.targetId || frame.parentId)
      throw new BrowserRuntimeError(
        "conflict",
        "Initial browser document does not belong to the registered root target.",
      );
    delete frame.parentId;
    const url = frame.url + (frame.urlFragment?.startsWith("#") ? frame.urlFragment : "");
    if (
      (live.restoring && url !== "about:blank") ||
      url !== live.committedUrl ||
      (live.loaderId !== null && frame.loaderId !== live.loaderId) ||
      attemptedAddress(frame.unreachableUrl ?? "") !== live.unreachableUrl
    )
      live.onFrameNavigated({ frame });
    else live.loaderId ??= frame.loaderId;
  }

  private async refreshNavigation(record: SurfaceRecord): Promise<void> {
    const live = record.live;
    if (this.navigationVersion !== 1) return;
    const revision = ++live.navigationRevision;
    const history = z
      .object({
        currentIndex: z.number().int().nonnegative(),
        entries: z.array(z.object({ id: z.number().int() })),
      })
      .parse(await live.cdp.send("Page.getNavigationHistory"));
    if (
      this.closed ||
      this.records.get(record.id) !== record ||
      record.live !== live ||
      revision !== live.navigationRevision
    )
      return;
    const navigation = {
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex + 1 < history.entries.length,
    };
    if (
      record.live?.navigation?.canGoBack === navigation.canGoBack &&
      record.live?.navigation?.canGoForward === navigation.canGoForward
    )
      return;
    live.navigation = navigation;
    if (record.announced)
      this.emit({ type: "changed", change: "updated", surface: this.toSurface(record) });
  }

  private toSurface(record: TabRecord): BrowserSurface {
    return {
      state: surfaceState(record),
      active: record.id === this.activeId,
      ...record.live?.navigation,
      ...(record.favicon === null ? {} : { favicon: record.favicon }),
      ...(record.live?.loading ? { loading: true } : {}),
      ...(record.live?.navigationFailed ? { navigationFailed: true } : {}),
      id: record.id,
      sizedByAgent: record.agentMetrics !== null,
      documentId: record.documentId,
      geometryRevision: record.geometryRevision,
      order: record.order,
      openerId: record.openerId && this.records.has(record.openerId) ? record.openerId : null,
      title: record.title,
      url: normalizeUrl(record.url),
    };
  }

  private emitSnapshot(): void {
    this.emit({ surfaces: this.snapshot(), type: "snapshot" });
  }

  private emit(event: SurfaceLedgerEvent): void {
    if (event.type === "changed" && (event.change === "created" || event.change === "closed"))
      this.inventoryVersion++;

    this.policyChanged();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A controller cannot corrupt the authoritative surface ledger.
      }
    }
  }
}

function isViewport(viewport: Viewport): boolean {
  return (
    viewport.devicePixelRatio === 1 &&
    Number.isSafeInteger(viewport.width) &&
    Number.isSafeInteger(viewport.height) &&
    viewport.width > 0 &&
    viewport.height > 0 &&
    browserFrameFits(viewport.width, viewport.height, 1)
  );
}

function assertViewport(viewport: Viewport): void {
  if (!isViewport(viewport)) {
    throw new TypeError("The browser viewport must be bounded integer CSS pixels at DPR 1.");
  }
}

function assertPageSize(size: PageSize): void {
  assertViewport({
    devicePixelRatio: 1,
    height: size.height,
    width: size.width,
  });
}

const ordinaryScreen: PageSize = { height: 1_080, width: 1_920 };

/**
 * The person's size as device metrics. Resizing a window does not resize the
 * monitor it is on, so the screen stays one ordinary monitor, grown only for
 * a page larger than it. Left unset, headless Chromium reports 800×600.
 */
function ordinaryMetrics(size: PageSize): CdpParameters {
  return {
    deviceScaleFactor: 1,
    height: size.height,
    mobile: false,
    screenHeight: Math.max(ordinaryScreen.height, size.height),
    screenWidth: Math.max(ordinaryScreen.width, size.width),
    width: size.width,
  };
}

function resolveAgentSize(ordinary: PageSize, agent: CdpParameters): CdpParameters {
  return {
    ...agent,
    height: agent.height === 0 ? ordinary.height : agent.height,
    width: agent.width === 0 ? ordinary.width : agent.width,
  };
}

/** Playwright keeps its emulated person viewport and screen, including DSF 0's legacy 1× scale. */
function effectiveMetrics(ordinary: PageSize, agent: CdpParameters | null): CdpParameters {
  if (!agent) return ordinaryMetrics(ordinary);
  const height = agent.height === 0 ? ordinary.height : agent.height;
  const width = agent.width === 0 ? ordinary.width : agent.width;
  return {
    ...agent,
    deviceScaleFactor: agent.deviceScaleFactor === 0 ? 1 : agent.deviceScaleFactor,
    height,
    // A request that names no screen keeps the person's; Chromium's own is
    // 800×600 on a headless server.
    screenHeight: agent.screenHeight || Math.max(ordinaryScreen.height, Number(height)),
    screenWidth: agent.screenWidth || Math.max(ordinaryScreen.width, Number(width)),
    width,
  };
}

function metricsSize(metrics: CdpParameters): PageSize {
  return { height: metrics.height as number, width: metrics.width as number };
}

function metricsFit(metrics: CdpParameters): boolean {
  const { deviceScaleFactor, height, width } = metrics;
  return (
    typeof width === "number" &&
    typeof height === "number" &&
    typeof deviceScaleFactor === "number" &&
    browserFrameFits(width, height, deviceScaleFactor || 1)
  );
}

function parseDialog(value: unknown): Omit<BrowserDialog, "id" | "surfaceId"> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.message !== "string" ||
    (record.type !== "alert" &&
      record.type !== "beforeunload" &&
      record.type !== "confirm" &&
      record.type !== "prompt")
  ) {
    return null;
  }
  return { message: record.message.slice(0, 10_000), type: record.type };
}

function sameMetrics(left: CdpParameters, right: CdpParameters): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeTitle(value: string): string {
  return value.slice(0, 1_000);
}

/** Chromium reports what was typed, so credentials are kept out before it is shown or saved. */
function attemptedAddress(address: string): string | null {
  try {
    const url = new URL(address);
    if (!url.username && !url.password) return address;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}

function surfaceAddress(record: Pick<SurfaceRecord, "live">): string {
  return record.live.unreachableUrl ?? record.live.committedUrl;
}

function normalizeUrl(value: string): string {
  return value.slice(0, browserWorkspaceTabUrlMaxLength);
}

function isLive(record: TabRecord): record is SurfaceRecord {
  return record.live !== null;
}

function surfaceState(record: TabRecord): "live" | "suspended" {
  return record.live && record.lease.state !== "resuming" ? "live" : "suspended";
}
