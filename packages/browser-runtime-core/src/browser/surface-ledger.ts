import {
  browserFrameFits,
  defaultBrowserViewport,
  type CdpParameters,
} from "@opensteer/browser-core";
import {
  BrowserSurfaceIdSchema,
  browserWorkspaceTabUrlMaxLength,
  type BrowserDialog,
  type BrowserNavigationCommitted,
  type BrowserSurface,
  type BrowserSurfaceId,
  type BrowserWorkspaceTabDescriptor,
} from "@opensteer/protocol/browser";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AsyncMutex } from "../async.js";
import { BrowserRuntimeError } from "../errors.js";
import type { BrowserContext, BrowserPage, CdpSession, PageGeometry, Viewport } from "./backend.js";
import { PageFavicon } from "./favicon.js";
import { PageTitleReader } from "./page-title.js";
import { PageScriptTargets, type ScriptTarget } from "./script-targets.js";

export type SurfaceLedgerEvent =
  | BrowserNavigationCommitted
  | {
      change: "closed" | "created" | "updated";
      closure?: "page" | "teardown";
      surface: BrowserSurface;
      type: "changed";
    }
  | { surfaces: BrowserSurface[]; type: "snapshot" }
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

interface SurfaceRecord {
  commitSequence: number;
  pendingNavigations: Map<string, NavigationBinding>;
  recentCommits: Map<string, NavigationCommit>;
  navigation: { canGoBack: boolean; canGoForward: boolean } | null;
  navigationRevision: number;
  navigationFailed: boolean;
  navigationAttempt: number;
  committedUrl: string;
  /** The committed document's loader, from its commit or the first title sample. */
  loaderId: string | null;
  titleReader: PageTitleReader | null;
  onSameDocumentNavigation: (parameters: unknown) => void;
  documentId: string;
  geometryRevision: number;
  pageScale: number;
  order: number;
  openerId: BrowserSurfaceId | null;
  onFrameNavigated: (parameters: unknown) => void;
  onFrameStartedLoading: (parameters: unknown) => void;
  onFrameStoppedLoading: (parameters: unknown) => void;
  /** The page's own document is loading; a frame inside it loading is not. */
  loading: boolean;
  /** Sequence number of the latest agent command sent to this page. */
  agentSequence: number;
  /**
   * The agent's latest complete device-metrics request, until it clears it or
   * the person fits the page. A later request replaces it whole.
   */
  agentMetrics: CdpParameters | null;
  /** Other pages' snapshots must not expose initialization before size or dialog ownership. */
  announced: boolean;
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
  /** The page's site icon as a data URL, while it names one that loads. */
  favicon: string | null;
  faviconReader: PageFavicon | null;
  scriptTargets: PageScriptTargets | null;
  id: BrowserSurfaceId;
  onClose: () => void;
  onDialogClosed: (parameters: unknown) => void;
  onDialogOpening: (parameters: unknown) => void;
  onMetadataChanged: () => void;
  /** The person's size for this page: where they read it, like a window's size. */
  ordinary: PageSize;
  page: BrowserPage;
  /** The latest time the person's view changed this page's size. */
  pageResize?: BrowserPageResize;
  /** Sequence number of `pageResize`; 0 while the person has not resized it. */
  pageResizeSequence: number;
  /**
   * Orders this page's size writes. Each page has its own, so a write that
   * Chromium holds, as it holds any under a dialog, keeps no other page waiting.
   */
  readonly sizeLock: AsyncMutex;
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
  title: string;
  url: string;
  userActivity?: BrowserUserActivity;
  /** Sequence number of `userActivity`; 0 while the person has not acted here. */
  userActivitySequence: number;
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
  private inventoryIds = "";
  private legacyPersonUntil = 0;
  get sealed(): boolean {
    return this.inventorySealed;
  }
  get inventoryRevision(): number {
    const ids = JSON.stringify(this.snapshot().map(({ id, order }) => [id, order]));
    if (ids !== this.inventoryIds) {
      this.inventoryIds = ids;
      this.inventoryVersion++;
    }
    return this.inventoryVersion;
  }
  recordLegacyPersonActivity(targeted: boolean): void {
    this.legacyPersonUntil = targeted ? 0 : Date.now() + 15_000;
  }
  pageScaleOf(surfaceId: BrowserSurfaceId): number {
    return this.records.get(surfaceId)?.pageScale ?? 1;
  }
  /**
   * Hears where scripts aim events in one page's top frame, until the
   * returned stop. Installs the page's observer again if its install failed.
   */
  watchScriptTargets(
    surfaceId: BrowserSurfaceId,
    watcher: (target: ScriptTarget) => void,
  ): () => void {
    return this.records.get(surfaceId)?.scriptTargets?.watch(watcher) ?? (() => undefined);
  }
  private discoveries = 0;
  private activeId: BrowserSurfaceId | null = null;
  private readonly adoptedTargetIds = new Set<string>();
  private readonly claimTarget: ((targetId: string) => void) | undefined;
  private readonly beforeResize: SurfaceLedgerOptions["beforeResize"];
  private closed = false;
  private tearingDown = false;
  private creatingPage: Promise<void> | null = null;
  private readonly initialSurfaceId: BrowserSurfaceId | undefined;
  private readonly dormantSurfaceIds: Set<BrowserSurfaceId>;
  private readonly context: BrowserContext;
  /** The size the person's view last followed on any page here; new pages start at it. */
  private followedSize: PageSize;
  private readonly listeners = new Set<(event: SurfaceLedgerEvent) => void>();
  private readonly maxSurfaces: number;
  private readonly pageIds = new Map<BrowserPage, BrowserSurfaceId>();
  private readonly rootPages: readonly BrowserPage[] | null;
  private readonly records = new Map<BrowserSurfaceId, SurfaceRecord>();
  private readonly registrations = new Map<BrowserPage, Promise<void>>();
  private readonly removals = new Map<BrowserSurfaceId, Promise<void>>();
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
    this.maxSurfaces = options.maxSurfaces ?? 64;
    if (!Number.isInteger(this.maxSurfaces) || this.maxSurfaces < 1 || this.maxSurfaces > 64) {
      throw new Error("Surface maxSurfaces must be an integer from 1 through 64.");
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

  durableSnapshot(): BrowserWorkspaceTabDescriptor[] {
    return [...this.records.values()]
      .filter((record) => record.announced)
      .map((record) => ({
        id: record.id,
        title: record.title.slice(0, 256),
        url:
          record.committedUrl.length <= browserWorkspaceTabUrlMaxLength
            ? record.committedUrl
            : "opensteer:unavailable-url",
        order: record.order,
        openerId: record.openerId,
      }));
  }

  /** Correlates only this Page.navigate with the document Chromium says it produced. */
  async navigate(surfaceId: BrowserSurfaceId, url: string, navigationId?: string) {
    const record = this.records.get(surfaceId);
    if (!record) throw new BrowserRuntimeError("not_found", "The browser page closed.");
    const attempt = ++record.navigationAttempt;
    this.setNavigationFailed(record, false);
    const pending: NavigationBinding | undefined = navigationId
      ? {
          url,
          documentId: record.documentId,
          sequence: record.commitSequence,
          sameDocument: url.split("#", 1)[0] === record.committedUrl.split("#", 1)[0],
          loaderId: undefined,
        }
      : undefined;
    if (pending && navigationId) {
      record.pendingNavigations.set(navigationId, pending);
      if (record.pendingNavigations.size > 32)
        record.pendingNavigations.delete(record.pendingNavigations.keys().next().value!);
    }
    try {
      const result = z
        .object({
          frameId: z.string().optional(),
          loaderId: z.string().optional(),
          errorText: z.string().optional(),
          isDownload: z.boolean().optional(),
        })
        .parse(await record.cdp.send("Page.navigate", { url }));
      if (attempt === record.navigationAttempt)
        this.setNavigationFailed(record, !!result.errorText);
      if (!pending || !navigationId || record.pendingNavigations.get(navigationId) !== pending)
        return result;
      if (
        this.records.get(surfaceId) !== record ||
        result.errorText ||
        result.isDownload ||
        (!result.loaderId && (!result.frameId || !pending.sameDocument))
      ) {
        record.pendingNavigations.delete(navigationId);
        return result;
      }
      pending.loaderId = result.loaderId || null;
      this.matchNavigation(record, navigationId, pending);
      return result;
    } catch (error) {
      if (navigationId) record.pendingNavigations.delete(navigationId);
      if (attempt === record.navigationAttempt) this.setNavigationFailed(record, true);
      throw error;
    }
  }

  private setNavigationFailed(record: SurfaceRecord, failed: boolean): void {
    if (this.records.get(record.id) !== record || record.navigationFailed === failed) return;
    record.navigationFailed = failed;
    if (failed) record.loading = false;
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
        ? [...record.recentCommits.entries()].find(
            ([, commit]) =>
              commit.loaderId === null &&
              commit.sequence > pending.sequence &&
              commit.documentId === pending.documentId &&
              commit.url === pending.url,
          )
        : record.recentCommits.has(pending.loaderId)
          ? ([pending.loaderId, record.recentCommits.get(pending.loaderId)!] as const)
          : undefined;
    if (!matched) return;
    const [key, commit] = matched;
    if (commit.sequence <= pending.sequence) return;
    record.recentCommits.delete(key);
    record.pendingNavigations.delete(navigationId);
    this.emit({
      type: "navigation.committed",
      navigationId,
      surfaceId: record.id,
      documentId: commit.documentId,
      url: commit.url,
    });
  }

  private navigationCommitted(record: SurfaceRecord, loaderId: string | null): void {
    const sequence = ++record.commitSequence;
    record.recentCommits.set(loaderId ?? `same-document:${sequence}`, {
      documentId: record.documentId,
      url: record.committedUrl,
      sequence,
      loaderId,
    });
    if (record.recentCommits.size > 32)
      record.recentCommits.delete(record.recentCommits.keys().next().value!);
    for (const [navigationId, pending] of record.pendingNavigations)
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
    return found.sizeLock.run(async () => {
      if (this.closed) throw new BrowserRuntimeError("conflict", "The surface ledger is closed.");
      const record = this.recordForTarget(targetId);
      if (record !== found) return null;
      if (record.dialog) {
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
    });
  }

  /**
   * The size one page shows now, in CSS pixels: the whole viewport the stream
   * pictures, a scrollbar included. Null for a page that is gone.
   */
  viewportOf(surfaceId: BrowserSurfaceId): PageSize | null {
    const record = this.records.get(surfaceId);
    return record?.applied ? metricsSize(record.applied) : null;
  }

  /** Keeps a page read and the operation using it atomic with ledger geometry writes. */
  withGeometry<T>(
    surfaceId: BrowserSurfaceId,
    operation: (cdp: CdpSession, geometry: PageGeometry | null) => Promise<T>,
  ): Promise<T> {
    const record = this.records.get(surfaceId);
    if (!record)
      return Promise.reject(
        new BrowserRuntimeError("not_found", "The browser surface does not exist."),
      );
    return record.sizeLock.run(() => {
      if (this.closed || this.records.get(surfaceId) !== record || record.page.isClosed())
        throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
      return operation(record.cdp, record.appliedGeometry);
    });
  }

  /** A JavaScript dialog is open on one page, an answer under way included. */
  dialogOpen(surfaceId: BrowserSurfaceId): boolean {
    return (this.records.get(surfaceId)?.dialog ?? null) !== null;
  }

  /** The JavaScript dialog open on one page, if any, until it is answered. */
  dialogOf(surfaceId: BrowserSurfaceId): BrowserDialog | null {
    const dialog = this.records.get(surfaceId)?.dialog;
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
    const record = [...this.records.values()].find((entry) => entry.dialog?.id === dialogId);
    const dialog = record?.dialog;
    if (!record || !dialog || dialog.answering) {
      throw new BrowserRuntimeError("conflict", "There is no active browser dialog.");
    }
    const surfaceId = record.id;
    dialog.answering = true;
    this.emit({ surfaceId, type: "dialog" });
    try {
      await record.cdp.send("Page.handleJavaScriptDialog", {
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      });
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
    record.userActivity = { ...activity, at: new Date().toISOString() };
    record.userActivitySequence = ++this.sequence;
  }

  recordAgentCommand(targetId: string): void {
    const record = this.recordForTarget(targetId);
    if (record) record.agentSequence = ++this.sequence;
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
    return this.recordForTarget(targetId)?.id;
  }

  /**
   * Settles registration before an agent attaches, unless a dialog must be
   * answered first. Initial metrics hold the page's size lock either way,
   * so an agent's later size write cannot race behind the starting size.
   */
  async settleTarget(targetId: string): Promise<void> {
    const record = this.recordForTarget(targetId);
    if (record) {
      if (!record.dialog) await this.registrations.get(record.page);
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
    return this.records.get(surfaceId)?.committedUrl ?? null;
  }

  binding(surfaceId: BrowserSurfaceId): SurfaceBinding | null {
    const record = this.records.get(surfaceId);
    if (!record) return null;
    return {
      cdp: record.cdp,
      page: record.page,
      surface: this.toSurface(record),
      targetId: record.targetId,
    };
  }

  /** The geometry last applied to a page, with the revision pointer input and activity are measured against. */
  appliedGeometry(
    surfaceId: BrowserSurfaceId,
  ): { geometry: PageGeometry; geometryRevision: number } | null {
    const record = this.records.get(surfaceId);
    if (!record?.appliedGeometry) return null;
    return { geometry: record.appliedGeometry, geometryRevision: record.geometryRevision };
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
    options.signal?.throwIfAborted();
    if (this.closed) throw new BrowserRuntimeError("conflict", "The surface ledger is closed.");
    if (options.surfaceId && this.records.has(options.surfaceId))
      return this.toSurface(this.records.get(options.surfaceId)!);
    if (options.viewport) assertViewport(options.viewport);
    if (this.atCapacity(options.surfaceId)) {
      throw new BrowserRuntimeError("conflict", "The browser cannot open more tabs.");
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
    const record = id ? this.records.get(id) : undefined;
    if (!record) {
      await page.close().catch(() => undefined);
      throw new BrowserRuntimeError("conflict", "The browser could not open a new tab.");
    }
    return this.toSurface(record);
  }

  recordPageScale(surfaceId: BrowserSurfaceId, scale: number): number {
    const record = this.records.get(surfaceId);
    if (!record) return 0;
    if (record.pageScale !== scale) {
      record.pageScale = scale;
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
    await record.page.close();
    await this.remove(record);
  }

  async refresh(surfaceId: BrowserSurfaceId): Promise<void> {
    const record = this.records.get(surfaceId);
    if (!record || record.page.isClosed()) return;
    const url = normalizeUrl(record.committedUrl);
    if (url !== record.url) {
      record.url = url;
      this.emit({
        change: "updated",
        surface: this.toSurface(record),
        type: "changed",
      });
    }
    record.faviconReader?.refresh(record.documentId, record.url);
    record.titleReader?.sample();
    await this.refreshNavigation(record);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit({ type: "closed" });
    this.context.offPage(this.onPage);
    const registrations = [...this.registrations.values()];
    const removals = [...this.removals.values()];
    let records: SurfaceRecord[] = [];
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
      ...records.map((record) => this.disposeRecord(record)),
    ]);
    this.listeners.clear();
  }

  async closeOwnedPages(): Promise<void> {
    this.tearingDown = true;
    await Promise.allSettled([...this.records.values()].map((record) => record.page.close()));
  }

  forgetDormantSurface(surfaceId: BrowserSurfaceId): void {
    this.dormantSurfaceIds.delete(surfaceId);
  }

  private atCapacity(surfaceId?: BrowserSurfaceId): boolean {
    if (surfaceId && this.dormantSurfaceIds.has(surfaceId)) return false;
    return (
      new Set([...this.pageIds.keys(), ...this.registrations.keys()]).size +
        this.dormantSurfaceIds.size >=
      this.maxSurfaces
    );
  }

  private recordForTarget(targetId: string): SurfaceRecord | undefined {
    return [...this.records.values()].find((record) => record.targetId === targetId);
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
        this.claimTarget?.(targetId);
        const size = requestedViewport ?? this.startingSize(opener);
        const openerId = opener ? this.pageIds.get(opener) : undefined;
        const openerRecord = openerId ? this.records.get(openerId) : undefined;
        const answersPerson =
          openerRecord?.userActivity?.kind === "click" &&
          openerRecord.userActivitySequence > openerRecord.agentSequence;
        const forward =
          makeActive ||
          (answersPerson && Date.now() < this.legacyPersonUntil && openerId === this.activeId);
        const record: SurfaceRecord = {
          commitSequence: 0,
          pendingNavigations: new Map(),
          recentCommits: new Map(),
          navigation: null,
          navigationRevision: 0,
          navigationFailed: false,
          navigationAttempt: 0,
          loaderId: null,
          titleReader: null,
          documentId: randomUUID(),
          geometryRevision: 0,
          pageScale: 1,
          order: this.nextOrder++,
          openerId: opener ? (this.pageIds.get(opener) ?? null) : null,
          onFrameNavigated: (parameters) => {
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
              record.committedUrl = parameters.frame.url + fragment;
              record.url = normalizeUrl(record.committedUrl);
            }
            if (!parameters || typeof parameters !== "object" || !("frame" in parameters)) return;
            const frame = parameters.frame;
            if (!frame || typeof frame !== "object" || "parentId" in frame) return;
            void this.refreshNavigation(record).catch(() => undefined);
            record.pageScale = 1;
            record.documentId = randomUUID();
            record.loaderId =
              "loaderId" in frame && typeof frame.loaderId === "string" ? frame.loaderId : null;
            // A new document has no title until its own document names one.
            record.title = "";
            record.favicon = null;
            record.faviconReader?.refresh(record.documentId, normalizeUrl(record.committedUrl));
            record.geometryRevision++;
            if (record.announced)
              this.emit({
                change: "updated",
                surface: this.toSurface(record),
                type: "changed",
              });
            if (record.loaderId) this.navigationCommitted(record, record.loaderId);
            record.titleReader?.sample();
          },
          onFrameStartedLoading: (parameters) => this.loadingChanged(record, parameters, true),
          onFrameStoppedLoading: (parameters) => this.loadingChanged(record, parameters, false),
          loading: false,
          agentMetrics: null,
          agentSequence: 0,
          announced: false,
          applied: null,
          appliedGeometry: null,
          stopObservingHumanInput: undefined,
          unbindGeometry: undefined,
          cdp: acquiredCdp,
          dialog: null,
          favicon: null,
          faviconReader: null,
          scriptTargets: null,
          id,
          onClose: () => {
            void this.remove(record).catch(() => undefined);
          },
          onDialogClosed: (parameters) => {
            this.emit({
              type: "dialog-event",
              targetId: record.targetId,
              method: "Page.javascriptDialogClosed",
              parameters:
                parameters !== null && typeof parameters === "object"
                  ? (parameters as CdpParameters)
                  : {},
            });
            void this.dialogClosed(record).catch(() => undefined);
            record.titleReader?.sample();
          },
          onDialogOpening: (parameters) => {
            this.dialogOpened(record, parameters);
            if (!record.dialog) return;
            if (!record.applied) this.keepForDialog(record, record.ordinary, true, undefined);
            announce();
            sawDialog();
          },
          onMetadataChanged: () => {
            if (record.announced) void this.refresh(record.id).catch(() => undefined);
          },
          ordinary: { height: size.height, width: size.width },
          page,
          pageResizeSequence: 0,
          sizeLock: new AsyncMutex(),
          sizeWaiting: null,
          targetId,
          title: "",
          url: normalizeUrl(page.url()),
          committedUrl: page.url(),
          onSameDocumentNavigation: (parameters) => {
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
            record.committedUrl = parameters.url;
            record.url = normalizeUrl(record.committedUrl);
            if (record.announced)
              this.emit({
                type: "changed",
                change: "updated",
                surface: this.toSurface(record),
              });
            if ("navigationType" in parameters && parameters.navigationType === "fragment")
              this.navigationCommitted(record, null);
            record.titleReader?.sample();
          },
          userActivitySequence: 0,
        };
        announce = () => {
          if (record.announced || this.closed || this.records.get(id) !== record) return;
          record.announced = true;
          record.scriptTargets?.start();
          if (forward || !this.activeId) this.activeId = id;
          this.emit({
            change: "created",
            surface: this.toSurface(record),
            type: "changed",
          });
          if (forward) this.emitSnapshot();
          void this.refresh(id).catch(() => undefined);
        };
        registered = record;
        record.unbindGeometry = page.bindGeometry?.(
          (operation) =>
            record.sizeLock.run(async () => {
              if (this.closed || this.records.get(id) !== record || page.isClosed()) return;
              await operation();
            }),
          async () => this.beforeResize?.(id),
        );
        this.records.set(id, record);
        record.faviconReader = new PageFavicon(acquiredCdp, targetId, (favicon) => {
          if (this.records.get(id) !== record || record.favicon === favicon) return;
          record.favicon = favicon;
          if (record.announced)
            this.emit({ change: "updated", surface: this.toSurface(record), type: "changed" });
        });
        record.scriptTargets = new PageScriptTargets(acquiredCdp);
        record.titleReader = new PageTitleReader(
          acquiredCdp,
          targetId,
          () =>
            this.records.get(id) === record && !page.isClosed()
              ? {
                  committedUrl: record.committedUrl,
                  documentId: record.documentId,
                  loaderId: record.loaderId,
                }
              : null,
          (documentId, loaderId) => {
            if (record.documentId === documentId && record.loaderId === null)
              record.loaderId = loaderId;
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
        record.stopObservingHumanInput = page.observeHumanInput?.((observation) => {
          this.recordHumanActivity(id, observation);
        });
        page.onClose(record.onClose);
        page.onMetadataChanged(record.onMetadataChanged);
        acquiredCdp.on("Page.frameNavigated", record.onFrameNavigated);
        acquiredCdp.on("Page.navigatedWithinDocument", record.onSameDocumentNavigation);
        acquiredCdp.on("Page.frameStartedLoading", record.onFrameStartedLoading);
        acquiredCdp.on("Page.frameStoppedLoading", record.onFrameStoppedLoading);
        acquiredCdp.on("Page.javascriptDialogClosed", record.onDialogClosed);
        acquiredCdp.on("Page.javascriptDialogOpening", record.onDialogOpening);
      });
      const record = registered;
      if (!record) return;
      // Target metadata is browser-side. Page.enable and size writes also
      // reach the renderer, which answers neither while its dialog is open.
      // The record and listeners exist first, so that dialog can be answered.
      const initialized = record.sizeLock.run(async () => {
        await acquiredCdp.send("Page.enable");
        await this.refreshNavigation(record);
        if (this.closed || this.records.get(id) !== record || page.isClosed()) return;
        if (record.dialog) {
          this.keepForDialog(record, record.ordinary, true, undefined);
          return;
        }
        const write = await this.applyMetrics(record, ordinaryMetrics(record.ordinary), undefined);
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
        ...(registered ? [this.remove(registered)] : cdp ? [cdp.detach()] : []),
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
    const openerRecord = openerId ? this.records.get(openerId) : undefined;
    if (!openerRecord) return { ...this.followedSize };
    return openerRecord.applied ? metricsSize(openerRecord.applied) : { ...openerRecord.ordinary };
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
    const found = this.records.get(surfaceId);
    if (!found) {
      return Promise.reject(
        new BrowserRuntimeError("not_found", "The browser surface does not exist."),
      );
    }
    // Under a dialog the page answers no write, and one Chromium already holds
    // keeps this page's lock until the dialog closes; the person's size waits
    // here instead, so nothing the person does next waits behind it.
    if (found.dialog) {
      this.keepForDialog(found, requested, fit, beforeResize);
      return Promise.resolve({ changed: false });
    }
    return found.sizeLock.run(async () => {
      if (this.closed) throw new BrowserRuntimeError("conflict", "The surface ledger is closed.");
      const record = this.records.get(surfaceId);
      if (record !== found || record.page.isClosed()) {
        throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
      }
      if (record.dialog) {
        this.keepForDialog(record, requested, fit, beforeResize);
        return { changed: false };
      }
      const size = typeof requested === "function" ? requested() : requested;
      if (!size) return { changed: false };
      assertPageSize(size);
      if (!fit) this.followedSize = { height: size.height, width: size.width };
      record.ordinary = { height: size.height, width: size.width };
      return this.applyPersonSize(record, beforeResize, fit && this.removeAgentSize(record));
    });
  }

  /** Records the person's size for a page under a dialog; it lands when the dialog closes. */
  private keepForDialog(
    record: SurfaceRecord,
    size: PageSize | (() => PageSize | null),
    fit: boolean,
    beforeResize: BeforePageResize | undefined,
  ): void {
    if (typeof size === "function") {
      record.sizeWaiting = {
        beforeResize,
        fit: record.sizeWaiting?.fit === true,
        hasPersonSize: record.sizeWaiting?.hasPersonSize === true,
        followSize: size,
      };
      return;
    }
    if (!fit) this.followedSize = { height: size.height, width: size.width };
    record.ordinary = { height: size.height, width: size.width };
    record.sizeWaiting = {
      beforeResize,
      fit: fit || record.sizeWaiting?.fit === true,
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
    const before = record.applied ? metricsSize(record.applied) : null;
    const write = await this.applyMetrics(record, next, beforeResize);
    if (this.records.get(record.id) !== record) return write;
    const after = record.applied ? metricsSize(record.applied) : null;
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
    record.dialog = { ...dialog, answering: false, id: randomUUID() };
    record.faviconReader?.dialog(true);
    this.emit({
      type: "dialog-event",
      targetId: record.targetId,
      method: "Page.javascriptDialogOpening",
      parameters: { ...(parameters as CdpParameters), dialogId: record.dialog.id },
    });
    this.emit({ surfaceId: record.id, type: "dialog" });
  }

  /** A page's dialog closed: the person's size that waited for it reaches the page. */
  private async dialogClosed(record: SurfaceRecord): Promise<void> {
    const initializing = record.applied === null;
    record.dialog = null;
    record.faviconReader?.dialog(false);
    if (!initializing) this.emit({ surfaceId: record.id, type: "dialog" });
    if (!record.sizeWaiting) return;
    await record.sizeLock.run(async () => {
      if (this.closed || this.records.get(record.id) !== record || record.dialog) return;
      const waiting = record.sizeWaiting;
      if (!waiting) return;
      record.sizeWaiting = null;
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
    const same = record.applied && sameMetrics(record.applied, next);
    if (
      same &&
      (!record.page.applyGeometry ||
        canonicalJson(record.appliedGeometry) === canonicalJson(geometry))
    )
      return { changed: false };
    if (!same) await beforeResize?.();
    try {
      if (record.page.applyGeometry) await record.page.applyGeometry(geometry);
      else await record.cdp.send("Emulation.setDeviceMetricsOverride", next);
    } catch (error) {
      if (!record.page.isClosed()) throw error;
      throw new BrowserRuntimeError("not_found", "The browser surface does not exist.", {
        cause: error,
      });
    }
    if (this.records.get(record.id) === record) {
      record.applied = next;
      record.appliedGeometry = geometry;
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
    return record.page.applyGeometry && agent
      ? resolveAgentSize(record.ordinary, agent)
      : effectiveMetrics(record.ordinary, agent);
  }

  private async remove(record: SurfaceRecord): Promise<void> {
    const existing = this.removals.get(record.id);
    if (existing) return existing;
    const removal = this.removeOnce(record).finally(() => {
      this.removals.delete(record.id);
    });
    this.removals.set(record.id, removal);
    return removal;
  }

  private async removeOnce(record: SurfaceRecord): Promise<void> {
    await this.viewportMutex.run(async () => {
      if (!this.records.delete(record.id)) return;
      this.adoptedTargetIds.delete(record.targetId);
      this.pageIds.delete(record.page);
      const wasActive = this.activeId === record.id;
      if (wasActive) this.activeId = null;
      await this.disposeRecord(record);
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
    record.pendingNavigations.clear();
    record.recentCommits.clear();
    record.titleReader?.close();
    record.stopObservingHumanInput?.();
    record.unbindGeometry?.();
    record.page.offClose(record.onClose);
    record.page.offMetadataChanged(record.onMetadataChanged);
    record.cdp.off("Page.frameNavigated", record.onFrameNavigated);
    record.cdp.off("Page.navigatedWithinDocument", record.onSameDocumentNavigation);
    record.cdp.off("Page.frameStartedLoading", record.onFrameStartedLoading);
    record.cdp.off("Page.frameStoppedLoading", record.onFrameStoppedLoading);
    record.cdp.off("Page.javascriptDialogOpening", record.onDialogOpening);
    record.cdp.off("Page.javascriptDialogClosed", record.onDialogClosed);
    await Promise.all([record.faviconReader?.close(), record.scriptTargets?.close()]);
    await record.cdp.detach().catch(() => undefined);
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
      parameters.frameId !== record.targetId ||
      record.loading === loading
    )
      return;
    record.loading = loading;
    if (!loading) void this.refreshNavigation(record).catch(() => undefined);
    if (record.announced && this.records.get(record.id) === record)
      this.emit({ change: "updated", surface: this.toSurface(record), type: "changed" });
  }

  private async refreshNavigation(record: SurfaceRecord): Promise<void> {
    if (this.navigationVersion !== 1) return;
    const revision = ++record.navigationRevision;
    const history = z
      .object({
        currentIndex: z.number().int().nonnegative(),
        entries: z.array(z.object({ id: z.number().int() })),
      })
      .parse(await record.cdp.send("Page.getNavigationHistory"));
    if (
      this.closed ||
      this.records.get(record.id) !== record ||
      revision !== record.navigationRevision
    )
      return;
    const navigation = {
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex + 1 < history.entries.length,
    };
    if (
      record.navigation?.canGoBack === navigation.canGoBack &&
      record.navigation?.canGoForward === navigation.canGoForward
    )
      return;
    record.navigation = navigation;
    if (record.announced)
      this.emit({ type: "changed", change: "updated", surface: this.toSurface(record) });
  }

  private toSurface(record: SurfaceRecord): BrowserSurface {
    return {
      active: record.id === this.activeId,
      ...record.navigation,
      ...(record.favicon === null ? {} : { favicon: record.favicon }),
      ...(record.loading ? { loading: true } : {}),
      ...(record.navigationFailed ? { navigationFailed: true } : {}),
      id: record.id,
      sizedByAgent: record.agentMetrics !== null,
      documentId: record.documentId,
      geometryRevision: record.geometryRevision,
      order: record.order,
      openerId: record.openerId && this.records.has(record.openerId) ? record.openerId : null,
      title: record.title,
      url: record.url,
    };
  }

  private emitSnapshot(): void {
    this.emit({ surfaces: this.snapshot(), type: "snapshot" });
  }

  private emit(event: SurfaceLedgerEvent): void {
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

function normalizeUrl(value: string): string {
  return value.slice(0, browserWorkspaceTabUrlMaxLength);
}
