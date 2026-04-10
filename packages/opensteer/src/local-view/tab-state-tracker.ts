import type { BrowserContext, Page } from "playwright";

import type { OpensteerViewStreamTab } from "@opensteer/protocol";

import { LocalViewRuntimeState } from "./runtime-state.js";

interface CachedPageMetadata {
  readonly title: string;
  readonly targetId: string | undefined;
}

const ACTIVATION_INTENT_DISCOVERY_GRACE_MS = 2_000;

export interface TabStateTrackerDeps {
  readonly browserContext: BrowserContext;
  readonly sessionId: string;
  readonly pollMs: number;
  readonly runtimeState: LocalViewRuntimeState;
  readonly onTabsChanged: (payload: {
    readonly tabs: readonly OpensteerViewStreamTab[];
    readonly activeTabIndex: number;
  }) => void;
  readonly onActivePageChanged: (page: Page) => void;
}

export class TabStateTracker {
  private readonly deps: TabStateTrackerDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastActivePage: Page | null = null;
  private lastTabsSignature = "";
  private tickInFlight = false;
  private readonly metadataByPage = new Map<Page, CachedPageMetadata>();
  private readonly targetIdByPage = new WeakMap<Page, string>();
  private readonly pageCleanupByPage = new Map<Page, () => void>();
  private boundContextCleanup: (() => void) | null = null;

  constructor(deps: TabStateTrackerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.bindContextEvents();
    void this.reconcile({
      includeFocus: true,
      refreshMetadata: true,
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.boundContextCleanup?.();
    this.boundContextCleanup = null;
    for (const cleanup of this.pageCleanupByPage.values()) {
      cleanup();
    }
    this.pageCleanupByPage.clear();
    this.metadataByPage.clear();
  }

  private bindContextEvents(): void {
    if (this.boundContextCleanup) {
      this.syncTrackedPages(this.deps.browserContext.pages());
      this.updatePolling(this.deps.browserContext.pages().length);
      return;
    }

    const onPage = (page: Page) => {
      this.syncTrackedPages(this.deps.browserContext.pages());
      this.updatePolling(this.deps.browserContext.pages().length);
      this.attachPageListeners(page);
      void this.reconcile({
        includeFocus: true,
        refreshMetadata: true,
      });
    };

    this.deps.browserContext.on("page", onPage);
    this.boundContextCleanup = () => {
      this.deps.browserContext.off("page", onPage);
    };

    this.syncTrackedPages(this.deps.browserContext.pages());
    this.updatePolling(this.deps.browserContext.pages().length);
  }

  private syncTrackedPages(pages: readonly Page[]): void {
    const nextPages = new Set(pages);

    for (const [page, cleanup] of this.pageCleanupByPage.entries()) {
      if (nextPages.has(page)) {
        continue;
      }
      cleanup();
      this.pageCleanupByPage.delete(page);
      this.metadataByPage.delete(page);
    }

    for (const page of pages) {
      this.attachPageListeners(page);
    }
  }

  private attachPageListeners(page: Page): void {
    if (this.pageCleanupByPage.has(page)) {
      return;
    }

    const refreshMetadata = () => {
      void this.reconcile({
        includeFocus: false,
        refreshMetadata: true,
      });
    };
    const handleClose = () => {
      this.pageCleanupByPage.get(page)?.();
      this.pageCleanupByPage.delete(page);
      this.metadataByPage.delete(page);
      void this.reconcile({
        includeFocus: true,
        refreshMetadata: true,
      });
    };

    page.on("close", handleClose);
    page.on("domcontentloaded", refreshMetadata);
    page.on("load", refreshMetadata);
    page.on("framenavigated", refreshMetadata);

    this.pageCleanupByPage.set(page, () => {
      page.off("close", handleClose);
      page.off("domcontentloaded", refreshMetadata);
      page.off("load", refreshMetadata);
      page.off("framenavigated", refreshMetadata);
    });
  }

  private updatePolling(pageCount: number): void {
    const shouldPoll = this.running && pageCount > 0;
    if (!shouldPoll) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }

    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      const trackedPageCount = this.deps.browserContext.pages().length;
      void this.reconcile({
        includeFocus: trackedPageCount > 1,
        refreshMetadata: true,
      });
    }, this.deps.pollMs);
  }

  private async reconcile(args: {
    readonly includeFocus: boolean;
    readonly refreshMetadata: boolean;
  }): Promise<void> {
    if (!this.running || this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;

    try {
      this.bindContextEvents();
      const pages = this.deps.browserContext.pages();
      this.syncTrackedPages(pages);
      this.updatePolling(pages.length);
      const preferredActivePage = this.lastActivePage ?? pages[0] ?? null;

      const pageStates = await Promise.all(
        pages.map(async (page, index) => {
          const metadata = await this.readPageMetadata(page, {
            refresh: args.refreshMetadata,
          });
          const focusState = args.includeFocus
            ? await this.readFocusState(page)
            : {
                isVisible: page === preferredActivePage,
                hasFocus: page === preferredActivePage,
              };

          return {
            page,
            index,
            targetId: metadata.targetId,
            url: page.url(),
            title: metadata.title,
            isVisible: focusState.isVisible,
            hasFocus: focusState.hasFocus,
          };
        }),
      );

      const activePage = this.pickActivePage(
        pageStates,
        this.lastActivePage,
        preferredActivePage,
        this.resolveIntentPage(pageStates),
      );
      if (activePage && activePage !== this.lastActivePage) {
        this.lastActivePage = activePage;
        this.deps.onActivePageChanged(activePage);
      }

      const tabs = pageStates.map((state) => ({
        index: state.index,
        ...(state.targetId === undefined ? {} : { targetId: state.targetId }),
        url: state.url,
        title: state.title,
        active: activePage ? state.page === activePage : false,
      })) satisfies OpensteerViewStreamTab[];
      const activeTabIndex = tabs.findIndex((tab) => tab.active);
      const signature = JSON.stringify({
        activeTabIndex,
        tabs: tabs.map((tab) => ({
          index: tab.index,
          targetId: tab.targetId,
          url: tab.url,
          title: tab.title,
          active: tab.active,
        })),
      });

      if (signature !== this.lastTabsSignature) {
        this.lastTabsSignature = signature;
        this.deps.onTabsChanged({
          tabs,
          activeTabIndex,
        });
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async readPageMetadata(
    page: Page,
    options: {
      readonly refresh: boolean;
    },
  ): Promise<CachedPageMetadata> {
    const cached = this.metadataByPage.get(page);
    if (cached && !options.refresh) {
      return cached;
    }

    const [title, targetId] = await Promise.all([
      page.title().catch(() => cached?.title ?? ""),
      this.resolveTargetId(page).catch(() => cached?.targetId),
    ]);
    const nextMetadata = {
      title,
      targetId: targetId ?? undefined,
    } satisfies CachedPageMetadata;
    this.metadataByPage.set(page, nextMetadata);
    return nextMetadata;
  }

  private async resolveTargetId(page: Page): Promise<string | null> {
    const cached = this.targetIdByPage.get(page);
    if (cached) {
      return cached;
    }

    const cdp = await page.context().newCDPSession(page);
    try {
      const result = (await cdp.send("Target.getTargetInfo")) as {
        readonly targetInfo?: {
          readonly targetId?: unknown;
        };
      } | null;
      const targetId = result?.targetInfo?.targetId;
      if (typeof targetId === "string" && targetId.length > 0) {
        this.targetIdByPage.set(page, targetId);
        return targetId;
      }
      return null;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  private async readFocusState(page: Page): Promise<{
    readonly isVisible: boolean;
    readonly hasFocus: boolean;
  }> {
    try {
      const result = (await page.evaluate(() => ({
        visibilityState: (
          globalThis as {
            readonly document?: {
              readonly visibilityState?: unknown;
            };
          }
        ).document?.visibilityState,
        hasFocus:
          (
            globalThis as {
              readonly document?: {
                readonly hasFocus?: (() => boolean) | undefined;
              };
            }
          ).document?.hasFocus?.() ?? false,
      }))) as {
        readonly visibilityState?: unknown;
        readonly hasFocus?: unknown;
      };
      return {
        isVisible: result.visibilityState === "visible",
        hasFocus: result.hasFocus === true,
      };
    } catch {
      return {
        isVisible: false,
        hasFocus: false,
      };
    }
  }

  private pickActivePage(
    pageStates: Array<{
      readonly page: Page;
      readonly targetId: string | undefined;
      readonly isVisible: boolean;
      readonly hasFocus: boolean;
    }>,
    lastActivePage: Page | null,
    fallbackPage: Page | null,
    intent: { readonly page: Page } | null,
  ): Page | null {
    if (intent) {
      return intent.page;
    }

    const focusedVisiblePages = pageStates.filter((state) => state.isVisible && state.hasFocus);
    if (focusedVisiblePages.length === 1) {
      return focusedVisiblePages[0]?.page ?? null;
    }

    const visiblePages = pageStates.filter((state) => state.isVisible);
    if (visiblePages.length === 1) {
      return visiblePages[0]?.page ?? null;
    }

    const lastActivePageState = lastActivePage
      ? (pageStates.find((state) => state.page === lastActivePage) ?? null)
      : null;
    if (
      lastActivePageState &&
      ((focusedVisiblePages.length > 1 &&
        lastActivePageState.isVisible &&
        lastActivePageState.hasFocus) ||
        (visiblePages.length > 1 && lastActivePageState.isVisible) ||
        visiblePages.length === 0)
    ) {
      return lastActivePage;
    }

    const fallbackPageState = fallbackPage
      ? (pageStates.find((state) => state.page === fallbackPage) ?? null)
      : null;
    if (
      fallbackPageState &&
      ((focusedVisiblePages.length > 1 &&
        fallbackPageState.isVisible &&
        fallbackPageState.hasFocus) ||
        (visiblePages.length > 1 && fallbackPageState.isVisible))
    ) {
      return fallbackPage;
    }

    if (focusedVisiblePages.length > 0) {
      return focusedVisiblePages[0]?.page ?? null;
    }

    if (visiblePages.length > 0) {
      return visiblePages[0]?.page ?? null;
    }

    if (lastActivePageState) {
      return lastActivePageState.page;
    }

    if (fallbackPageState) {
      return fallbackPageState.page;
    }

    return pageStates[0]?.page ?? null;
  }

  private resolveIntentPage(
    pageStates: Array<{
      readonly page: Page;
      readonly targetId: string | undefined;
    }>,
  ): { readonly page: Page } | null {
    const intent = this.deps.runtimeState.getPageActivationIntent(this.deps.sessionId);
    if (!intent) {
      return null;
    }

    const matched = pageStates.find((state) => state.targetId === intent.targetId);
    if (!matched) {
      if (Date.now() - intent.ts > ACTIVATION_INTENT_DISCOVERY_GRACE_MS) {
        this.deps.runtimeState.clearPageActivationIntent(this.deps.sessionId, intent.targetId);
      }
      return null;
    }

    this.deps.runtimeState.clearPageActivationIntent(this.deps.sessionId, intent.targetId);
    return { page: matched.page };
  }
}
