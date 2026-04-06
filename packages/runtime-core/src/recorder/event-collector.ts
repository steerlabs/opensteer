import { FLOW_RECORDER_DRAIN_SCRIPT, FLOW_RECORDER_INSTALL_SCRIPT } from "./browser-scripts.js";
import type {
  FlowRecorderSnapshot,
  RawFlowRecorderEvent,
  RecordedAction,
  RecorderPageState,
} from "./types.js";

export interface RecorderRuntimeAdapter {
  addInitScript(input: { readonly script: string }): Promise<unknown>;
  evaluate(input: { readonly script: string; readonly pageRef?: string }): Promise<unknown>;
  listPages(): Promise<{
    readonly pages: readonly {
      readonly pageRef: string;
      readonly url: string;
      readonly openerPageRef?: string;
    }[];
  }>;
}

export interface FlowRecorderCollectorOptions {
  readonly pollIntervalMs?: number;
  readonly onAction?: (action: RecordedAction) => void | Promise<void>;
  readonly installScript?: string;
}

interface KnownRecorderPageState {
  readonly pageId: string;
  readonly pageRef: string;
  openerPageRef?: string;
  openerPageId?: string;
  currentUrl: string;
}

interface EvaluatedPageState {
  readonly pageRef: string;
  readonly pageId: string;
  readonly openerPageRef?: string;
  readonly openerPageId?: string;
  readonly previousUrl: string;
  readonly currentUrl: string;
  readonly focused: boolean;
  readonly stopRequested: boolean;
  readonly events: readonly RawFlowRecorderEvent[];
}

export class FlowRecorderCollector {
  private readonly runtime: RecorderRuntimeAdapter;
  private readonly pollIntervalMs: number;
  private readonly onAction;
  private readonly installScript: string;
  private readonly pages = new Map<string, KnownRecorderPageState>();
  private readonly actions: RecordedAction[] = [];
  private nextPageOrdinal = 0;
  private runningLoop: Promise<void> | undefined;
  private loopStopRequested = false;
  private stopDetected = false;
  private focusedPageId: string | undefined;
  private stopWaiters: Array<() => void> = [];

  constructor(runtime: RecorderRuntimeAdapter, options: FlowRecorderCollectorOptions = {}) {
    this.runtime = runtime;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.onAction = options.onAction;
    this.installScript = options.installScript ?? FLOW_RECORDER_INSTALL_SCRIPT;
  }

  async install(): Promise<void> {
    await this.runtime.addInitScript({
      script: this.installScript,
    });

    const { pages } = await this.runtime.listPages();
    for (const page of pages) {
      this.ensureKnownPage(page.pageRef, page.url, page.openerPageRef);
    }

    await Promise.all(
      pages.map((page) =>
        this.runtime
          .evaluate({
            script: this.installScript,
            pageRef: page.pageRef,
          })
          .catch(() => undefined),
      ),
    );

    const evaluatedPages = await this.readEvaluatedPages(pages);
    for (const page of evaluatedPages) {
      this.updateKnownPage(page.pageRef, page.currentUrl, page.openerPageRef);
    }
    this.focusedPageId = evaluatedPages.find((page) => page.focused)?.pageId ?? this.focusedPageId;
  }

  start(): void {
    if (this.runningLoop !== undefined) {
      return;
    }
    this.loopStopRequested = false;
    this.runningLoop = this.runLoop();
  }

  async stop(): Promise<readonly RecordedAction[]> {
    this.loopStopRequested = true;
    if (this.runningLoop !== undefined) {
      await this.runningLoop;
      this.runningLoop = undefined;
    }
    if (!this.stopDetected) {
      await this.pollOnce().catch(() => undefined);
    }
    return this.actions.slice();
  }

  getActions(): readonly RecordedAction[] {
    return this.actions.slice();
  }

  getPages(): readonly RecorderPageState[] {
    return [...this.pages.values()]
      .map((page) => ({
        pageId: page.pageId,
        pageRef: page.pageRef,
        ...(page.openerPageRef === undefined ? {} : { openerPageRef: page.openerPageRef }),
        ...(page.openerPageId === undefined ? {} : { openerPageId: page.openerPageId }),
        currentUrl: page.currentUrl,
      }))
      .sort((left, right) => comparePageIds(left.pageId, right.pageId));
  }

  getFocusedPageId(): string | undefined {
    return this.focusedPageId;
  }

  async waitForStop(): Promise<void> {
    if (this.stopDetected) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.stopWaiters.push(resolve);
    });
  }

  async pollOnce(): Promise<readonly RecordedAction[]> {
    const pollTimestamp = Date.now();
    const { pages } = await this.runtime.listPages();
    const previousPageRefs = new Set(this.pages.keys());
    const evaluatedPages = await this.readEvaluatedPages(pages);
    if (!this.stopDetected && evaluatedPages.some((page) => page.stopRequested)) {
      this.stopDetected = true;
      this.loopStopRequested = true;
      for (const resolve of this.stopWaiters.splice(0, this.stopWaiters.length)) {
        resolve();
      }
    }
    const actions = this.normalizePoll({
      pollTimestamp,
      previousPageRefs,
      listedPages: pages,
      evaluatedPages,
    });

    if (actions.length === 0) {
      return [];
    }

    actions.sort((left, right) => {
      const timestampOrder = left.timestamp - right.timestamp;
      if (timestampOrder !== 0) {
        return timestampOrder;
      }
      return actionSortPriority(left.kind) - actionSortPriority(right.kind);
    });
    for (const action of actions) {
      this.actions.push(action);
      if (this.onAction !== undefined) {
        await this.onAction(action);
      }
    }
    return actions;
  }

  private async runLoop(): Promise<void> {
    while (!this.loopStopRequested) {
      try {
        await this.pollOnce();
      } catch {}
      if (this.loopStopRequested) {
        break;
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async readEvaluatedPages(
    listedPages: readonly {
      readonly pageRef: string;
      readonly url: string;
      readonly openerPageRef?: string;
    }[],
  ): Promise<readonly EvaluatedPageState[]> {
    const pages = await Promise.all(
      listedPages.map(async (page) => {
        const knownPage = this.ensureKnownPage(page.pageRef, page.url, page.openerPageRef);
        const snapshot = await this.readSnapshot(page.pageRef, page.url);
        this.updateKnownPage(page.pageRef, snapshot.url, page.openerPageRef);
        return {
          pageRef: page.pageRef,
          pageId: knownPage.pageId,
          previousUrl: knownPage.currentUrl,
          currentUrl: snapshot.url,
          focused: snapshot.focused || snapshot.visibilityState === "visible",
          stopRequested: snapshot.stopRequested,
          events: snapshot.events,
          ...(page.openerPageRef === undefined ? {} : { openerPageRef: page.openerPageRef }),
          ...(knownPage.openerPageId === undefined ? {} : { openerPageId: knownPage.openerPageId }),
        } satisfies EvaluatedPageState;
      }),
    );

    return pages;
  }

  private async readSnapshot(pageRef: string, fallbackUrl: string): Promise<FlowRecorderSnapshot> {
    const value = await this.runtime.evaluate({
      script: FLOW_RECORDER_DRAIN_SCRIPT,
      pageRef,
    });
    return normalizeSnapshot(value, fallbackUrl);
  }

  private normalizePoll(input: {
    readonly pollTimestamp: number;
    readonly previousPageRefs: ReadonlySet<string>;
    readonly listedPages: readonly {
      readonly pageRef: string;
      readonly url: string;
      readonly openerPageRef?: string;
    }[];
    readonly evaluatedPages: readonly EvaluatedPageState[];
  }): RecordedAction[] {
    const listedPageRefs = new Set(input.listedPages.map((page) => page.pageRef));
    const actions: RecordedAction[] = [];
    const firstEventTimestampByPage = new Map<string, number>();

    for (const evaluatedPage of input.evaluatedPages) {
      const firstTimestamp = evaluatedPage.events[0]?.timestamp;
      if (firstTimestamp !== undefined) {
        firstEventTimestampByPage.set(evaluatedPage.pageRef, firstTimestamp);
      }
    }

    for (const listedPage of input.listedPages) {
      if (!input.previousPageRefs.has(listedPage.pageRef)) {
        const created = this.ensureKnownPage(
          listedPage.pageRef,
          listedPage.url,
          listedPage.openerPageRef,
        );
        actions.push({
          kind: "new-tab",
          timestamp: Math.max(
            0,
            (firstEventTimestampByPage.get(listedPage.pageRef) ?? input.pollTimestamp) - 1,
          ),
          pageId: created.pageId,
          pageUrl: listedPage.url,
          detail: {
            kind: "new-tab",
            ...(created.openerPageId === undefined ? {} : { openerPageId: created.openerPageId }),
            initialUrl: listedPage.url,
          },
        });
      }
    }

    for (const [pageRef, knownPage] of [...this.pages.entries()]) {
      if (listedPageRefs.has(pageRef)) {
        continue;
      }
      actions.push({
        kind: "close-tab",
        timestamp: input.pollTimestamp,
        pageId: knownPage.pageId,
        pageUrl: knownPage.currentUrl,
        detail: {
          kind: "close-tab",
        },
      });
      this.pages.delete(pageRef);
    }

    for (const evaluatedPage of input.evaluatedPages) {
      const knownPage = this.pages.get(evaluatedPage.pageRef);
      if (!knownPage) {
        continue;
      }

      if (
        evaluatedPage.previousUrl !== evaluatedPage.currentUrl &&
        !evaluatedPage.events.some(
          (event) =>
            event.kind === "navigate" ||
            event.kind === "reload" ||
            event.kind === "go-back" ||
            event.kind === "go-forward",
        )
      ) {
        actions.push({
          kind: "navigate",
          timestamp: Math.max(
            0,
            (firstEventTimestampByPage.get(evaluatedPage.pageRef) ?? input.pollTimestamp) - 1,
          ),
          pageId: knownPage.pageId,
          pageUrl: evaluatedPage.currentUrl,
          detail: {
            kind: "navigate",
            url: evaluatedPage.currentUrl,
            source: "poll",
          },
        });
      }

      actions.push(
        ...evaluatedPage.events.flatMap((event) =>
          this.normalizeRawEvent(event, knownPage, evaluatedPage.currentUrl),
        ),
      );
      this.updateKnownPage(
        evaluatedPage.pageRef,
        evaluatedPage.currentUrl,
        evaluatedPage.openerPageRef,
      );
    }

    const focusedPage = input.evaluatedPages.find((page) => page.focused);
    if (focusedPage !== undefined && focusedPage.pageId !== this.focusedPageId) {
      actions.push({
        kind: "switch-tab",
        timestamp: Math.max(
          0,
          (firstEventTimestampByPage.get(focusedPage.pageRef) ?? input.pollTimestamp) - 1,
        ),
        pageId: focusedPage.pageId,
        pageUrl: focusedPage.currentUrl,
        detail: {
          kind: "switch-tab",
          ...(this.focusedPageId === undefined ? {} : { fromPageId: this.focusedPageId }),
          toPageId: focusedPage.pageId,
        },
      });
      this.focusedPageId = focusedPage.pageId;
    }

    return dedupeConsecutiveSwitchActions(actions);
  }

  private normalizeRawEvent(
    event: RawFlowRecorderEvent,
    page: KnownRecorderPageState,
    currentUrl: string,
  ): RecordedAction[] {
    switch (event.kind) {
      case "navigate":
        return [
          {
            kind: "navigate",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: event.url,
            detail: {
              kind: "navigate",
              url: event.url,
              source: event.source,
            },
          },
        ];
      case "click":
        return [
          {
            kind: "click",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: currentUrl,
            selector: event.selector,
            detail: {
              kind: "click",
              button: event.button,
              modifiers: event.modifiers,
            },
          },
        ];
      case "dblclick":
        return [
          {
            kind: "dblclick",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: currentUrl,
            selector: event.selector,
            detail: {
              kind: "dblclick",
            },
          },
        ];
      case "type":
        return [
          {
            kind: "type",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: currentUrl,
            selector: event.selector,
            detail: {
              kind: "type",
              text: event.text,
            },
          },
        ];
      case "keypress":
        return [
          {
            kind: "keypress",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: currentUrl,
            ...(event.selector === undefined ? {} : { selector: event.selector }),
            detail: {
              kind: "keypress",
              key: event.key,
              modifiers: event.modifiers,
            },
          },
        ];
      case "scroll":
        return [
          {
            kind: "scroll",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: currentUrl,
            ...(event.selector === undefined ? {} : { selector: event.selector }),
            detail: {
              kind: "scroll",
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            },
          },
        ];
      case "select-option":
        return [
          {
            kind: "select-option",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: currentUrl,
            selector: event.selector,
            detail: {
              kind: "select-option",
              value: event.value,
              ...(event.label === undefined ? {} : { label: event.label }),
            },
          },
        ];
      case "reload":
        return [
          {
            kind: "reload",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: event.url,
            detail: {
              kind: "reload",
              url: event.url,
            },
          },
        ];
      case "go-back":
        return [
          {
            kind: "go-back",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: event.url,
            detail: {
              kind: "go-back",
              url: event.url,
            },
          },
        ];
      case "go-forward":
        return [
          {
            kind: "go-forward",
            timestamp: event.timestamp,
            pageId: page.pageId,
            pageUrl: event.url,
            detail: {
              kind: "go-forward",
              url: event.url,
            },
          },
        ];
    }
  }

  private ensureKnownPage(
    pageRef: string,
    url: string,
    openerPageRef?: string,
  ): KnownRecorderPageState {
    const existing = this.pages.get(pageRef);
    if (existing !== undefined) {
      return existing;
    }
    const openerPageId =
      openerPageRef === undefined ? undefined : this.pages.get(openerPageRef)?.pageId;

    const page = {
      pageId: `page${String(this.nextPageOrdinal++)}`,
      pageRef,
      currentUrl: url,
      ...(openerPageRef === undefined ? {} : { openerPageRef }),
      ...(openerPageId === undefined ? {} : { openerPageId }),
    } satisfies KnownRecorderPageState;
    this.pages.set(pageRef, page);
    return page;
  }

  private updateKnownPage(pageRef: string, url: string, openerPageRef?: string): void {
    const current = this.pages.get(pageRef);
    if (current === undefined) {
      this.ensureKnownPage(pageRef, url, openerPageRef);
      return;
    }
    const openerPageId =
      openerPageRef === undefined ? undefined : this.pages.get(openerPageRef)?.pageId;
    this.pages.set(pageRef, {
      ...current,
      currentUrl: url,
      ...(openerPageRef === undefined ? {} : { openerPageRef }),
      ...(openerPageId === undefined ? {} : { openerPageId }),
    });
  }
}

function normalizeSnapshot(value: unknown, fallbackUrl: string): FlowRecorderSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      url: fallbackUrl,
      focused: false,
      visibilityState: "hidden",
      stopRequested: false,
      events: [],
    };
  }

  const snapshot = value as Partial<FlowRecorderSnapshot> & {
    readonly visibilityState?: string;
  };
  return {
    url: typeof snapshot.url === "string" ? snapshot.url : fallbackUrl,
    focused: snapshot.focused === true,
    visibilityState:
      snapshot.visibilityState === "visible" ||
      snapshot.visibilityState === "prerender" ||
      snapshot.visibilityState === "hidden"
        ? snapshot.visibilityState
        : "hidden",
    stopRequested: snapshot.stopRequested === true,
    events: Array.isArray(snapshot.events)
      ? (snapshot.events as readonly RawFlowRecorderEvent[])
      : [],
  };
}

function dedupeConsecutiveSwitchActions(actions: readonly RecordedAction[]): RecordedAction[] {
  const deduped: RecordedAction[] = [];
  for (const action of actions) {
    const previous = deduped[deduped.length - 1];
    if (
      previous?.kind === "switch-tab" &&
      action.kind === "switch-tab" &&
      previous.pageId === action.pageId
    ) {
      continue;
    }
    deduped.push(action);
  }
  return deduped;
}

function actionSortPriority(kind: RecordedAction["kind"]): number {
  switch (kind) {
    case "new-tab":
      return 0;
    case "switch-tab":
      return 1;
    case "navigate":
    case "go-back":
    case "go-forward":
    case "reload":
      return 2;
    case "click":
    case "dblclick":
      return 3;
    case "type":
    case "keypress":
    case "select-option":
      return 4;
    case "scroll":
      return 5;
    case "close-tab":
      return 6;
  }
}

function comparePageIds(left: string, right: string): number {
  const leftMatch = /^page(\d+)$/u.exec(left);
  const rightMatch = /^page(\d+)$/u.exec(right);
  if (leftMatch && rightMatch) {
    return Number(leftMatch[1]) - Number(rightMatch[1]);
  }
  return left.localeCompare(right);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
