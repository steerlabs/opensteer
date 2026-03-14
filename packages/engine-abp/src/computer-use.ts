import {
  createBodyPayload,
  createSize,
  createDevicePixelRatio,
  createPageScaleFactor,
  createPageZoomFactor,
  createScrollOffset,
  type FrameRef,
  type KeyModifier,
  type PageRef,
  type Point,
  type ScreenshotArtifact,
  type ScreenshotFormat,
  type StepEvent,
  type ViewportMetrics,
} from "@opensteer/browser-core";

import {
  buildImmediateActionRequest,
  buildImmediateScreenshotRequest,
  buildInputActionRequest,
} from "./rest-client.js";
import type { AbpActionResponse, PageController, SessionState } from "./types.js";

export const opensteerComputerUseBridgeSymbol = Symbol.for("@opensteer/computer-use-bridge");

type ComputerAnnotation = "clickable" | "typeable" | "scrollable" | "grid" | "selected";
type ComputerMouseButton = "left" | "middle" | "right";
type ComputerAction =
  | {
      readonly type: "click";
      readonly x: number;
      readonly y: number;
      readonly button?: ComputerMouseButton;
      readonly clickCount?: number;
      readonly modifiers?: readonly KeyModifier[];
    }
  | {
      readonly type: "move";
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "scroll";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | {
      readonly type: "type";
      readonly text: string;
    }
  | {
      readonly type: "key";
      readonly key: string;
      readonly modifiers?: readonly KeyModifier[];
    }
  | {
      readonly type: "drag";
      readonly start: Point;
      readonly end: Point;
      readonly steps?: number;
    }
  | {
      readonly type: "screenshot";
    }
  | {
      readonly type: "wait";
      readonly durationMs: number;
    };

interface ComputerUseScreenshotOptions {
  readonly format: ScreenshotFormat;
  readonly includeCursor: boolean;
  readonly annotations: readonly ComputerAnnotation[];
}

interface ComputerUseBridgeInput {
  readonly pageRef: PageRef;
  readonly action: ComputerAction;
  readonly screenshot: ComputerUseScreenshotOptions;
  readonly signal: AbortSignal;
  remainingMs(): number | undefined;
  settle(pageRef: PageRef): Promise<void>;
}

interface ComputerUseBridgeOutput {
  readonly pageRef: PageRef;
  readonly screenshot: ScreenshotArtifact;
  readonly viewport: ViewportMetrics;
  readonly events: readonly StepEvent[];
  readonly timing: {
    readonly actionMs: number;
    readonly waitMs: number;
    readonly totalMs: number;
  };
}

interface AbpComputerUseBridge {
  execute(input: ComputerUseBridgeInput): Promise<ComputerUseBridgeOutput>;
}

export function createAbpComputerUseBridge(context: {
  resolveController(pageRef: PageRef): PageController;
  resolveSession(sessionRef: SessionState["sessionRef"]): SessionState;
  normalizeActionEvents(
    controller: PageController,
    response: AbpActionResponse,
  ): Promise<readonly StepEvent[]>;
  detectNewTabs(
    session: SessionState,
    openerController: PageController,
  ): Promise<readonly StepEvent[]>;
  executeInputAction(
    session: SessionState,
    controller: PageController,
    execute: () => Promise<AbpActionResponse>,
  ): Promise<{ readonly response: AbpActionResponse; readonly dialogEvents: readonly StepEvent[] }>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  requireMainFrame(controller: PageController): {
    readonly frameRef: FrameRef;
    readonly currentDocument: {
      readonly documentRef: NonNullable<ScreenshotArtifact["documentRef"]>;
      readonly documentEpoch: NonNullable<ScreenshotArtifact["documentEpoch"]>;
    };
  };
  drainQueuedEvents(pageRef: PageRef): readonly StepEvent[];
  getViewportMetrics(pageRef: PageRef): Promise<ViewportMetrics>;
}): AbpComputerUseBridge {
  return {
    async execute(input) {
      const startedAt = Date.now();
      const controller = context.resolveController(input.pageRef);
      const session = context.resolveSession(controller.sessionRef);
      const action = input.action;
      const screenshot = toAbpScreenshotOptions(input.screenshot);

      let response: AbpActionResponse;
      let dialogEvents: readonly StepEvent[] = [];

      switch (action.type) {
        case "click": {
          const executed = await context.executeInputAction(session, controller, () =>
            session.rest.clickTab(controller.tabId, {
              x: action.x,
              y: action.y,
              ...(action.button === undefined ? {} : { button: action.button }),
              ...(action.clickCount === undefined
                ? {}
                : { click_count: action.clickCount }),
              ...(action.modifiers === undefined
                ? {}
                : { modifiers: [...action.modifiers] }),
              ...buildInputActionRequest({
                captureNetwork: false,
                screenshot,
              }),
            }),
          );
          response = executed.response;
          dialogEvents = executed.dialogEvents;
          break;
        }
        case "move":
          response = await session.rest.moveTab(controller.tabId, {
            x: action.x,
            y: action.y,
            ...buildImmediateActionRequest({
              captureNetwork: false,
              screenshot,
            }),
          });
          break;
        case "scroll":
          response = await session.rest.scrollTab(controller.tabId, {
            x: action.x,
            y: action.y,
            delta_x: action.deltaX,
            delta_y: action.deltaY,
            ...buildInputActionRequest({
              captureNetwork: false,
              screenshot,
            }),
          });
          break;
        case "type":
          response = await session.rest.typeTab(controller.tabId, {
            text: action.text,
            ...buildInputActionRequest({
              captureNetwork: false,
              screenshot,
            }),
          });
          break;
        case "key": {
          const executed = await context.executeInputAction(session, controller, () =>
            session.rest.keyPressTab(controller.tabId, {
              key: action.key,
              ...(action.modifiers === undefined
                ? {}
                : { modifiers: [...action.modifiers] }),
              ...buildInputActionRequest({
                captureNetwork: false,
                screenshot,
              }),
            }),
          );
          response = executed.response;
          dialogEvents = executed.dialogEvents;
          break;
        }
        case "drag":
          response = await session.rest.dragTab(controller.tabId, {
            start_x: action.start.x,
            start_y: action.start.y,
            end_x: action.end.x,
            end_y: action.end.y,
            ...(action.steps === undefined ? {} : { steps: action.steps }),
            ...buildInputActionRequest({
              captureNetwork: false,
              screenshot,
            }),
          });
          break;
        case "screenshot":
          response = await session.rest.screenshotTab(
            controller.tabId,
            buildImmediateScreenshotRequest(screenshot),
          );
          break;
        case "wait":
          response = await session.rest.waitTab(controller.tabId, {
            duration_ms: action.durationMs,
            ...buildImmediateActionRequest({
              captureNetwork: false,
              screenshot,
            }),
          });
          break;
      }

      const actionEvents = await context.normalizeActionEvents(controller, response);
      const newTabEvents = await context.detectNewTabs(session, controller);
      const popupPageRefs = collectPopupPageRefs([...actionEvents, ...newTabEvents]);
      const resultPageRef =
        response.tab_changed === true ? session.activePageRef ?? controller.pageRef : controller.pageRef;
      const resultController = context.resolveController(resultPageRef);
      await context.flushDomUpdateTask(resultController);

      const screenshotArtifact = await materializeScreenshotArtifact({
        context,
        session,
        controller: resultController,
        response,
        fallback: screenshot,
      });

      let viewport: ViewportMetrics;
      try {
        viewport = await context.getViewportMetrics(resultController.pageRef);
      } catch {
        viewport = viewportMetricsFromResponse(response) ?? {
          layoutViewport: {
            origin: { x: 0, y: 0 },
            size: { width: 0, height: 0 },
          },
          visualViewport: {
            origin: { x: 0, y: 0 },
            offsetWithinLayoutViewport: createScrollOffset(0, 0),
            size: { width: 0, height: 0 },
          },
          scrollOffset: createScrollOffset(0, 0),
          contentSize: { width: 0, height: 0 },
          devicePixelRatio: createDevicePixelRatio(1),
          pageScaleFactor: createPageScaleFactor(1),
          pageZoomFactor: createPageZoomFactor(1),
        };
      }

      const popupQueuedEvents = popupPageRefs.flatMap((pageRef) =>
        pageRef === controller.pageRef ? [] : context.drainQueuedEvents(pageRef),
      );

      return {
        pageRef: resultController.pageRef,
        screenshot: screenshotArtifact,
        viewport,
        events: [
          ...context.drainQueuedEvents(controller.pageRef),
          ...actionEvents,
          ...newTabEvents,
          ...dialogEvents,
          ...popupQueuedEvents,
        ],
        timing: timingFromResponse(response, Date.now() - startedAt),
      };
    },
  };
}

function toAbpScreenshotOptions(
  screenshot: ComputerUseScreenshotOptions,
): {
  readonly cursor?: boolean;
  readonly format?: string;
  readonly markup?: readonly string[];
} {
  return {
    ...(screenshot.includeCursor ? { cursor: true } : {}),
    ...(screenshot.format === undefined ? {} : { format: screenshot.format }),
    ...(screenshot.annotations.length === 0 ? {} : { markup: [...screenshot.annotations] }),
  };
}

async function materializeScreenshotArtifact(input: {
  readonly context: Parameters<typeof createAbpComputerUseBridge>[0];
  readonly session: SessionState;
  readonly controller: PageController;
  readonly response: AbpActionResponse;
  readonly fallback: ReturnType<typeof toAbpScreenshotOptions>;
}): Promise<ScreenshotArtifact> {
  let response = input.response;
  if (response.screenshot_after === undefined) {
    response = await input.session.rest.screenshotTab(
      input.controller.tabId,
      buildImmediateScreenshotRequest(input.fallback),
    );
  }

  const screenshot = response.screenshot_after;
  if (screenshot === undefined) {
    throw new Error(`ABP action response for ${input.controller.pageRef} did not include screenshot_after`);
  }

  const mainFrame = input.context.requireMainFrame(input.controller);
  const format = (screenshot.format as ScreenshotFormat | undefined) ?? "png";
  return {
    pageRef: input.controller.pageRef,
    frameRef: mainFrame.frameRef,
    documentRef: mainFrame.currentDocument.documentRef,
    documentEpoch: mainFrame.currentDocument.documentEpoch,
    payload: createBodyPayload(new Uint8Array(Buffer.from(screenshot.data, "base64")), {
      mimeType: `image/${format}`,
    }),
    format,
    size: createSize(screenshot.width, screenshot.height),
    coordinateSpace: "layout-viewport-css",
  };
}

function collectPopupPageRefs(events: readonly StepEvent[]): readonly PageRef[] {
  const seen = new Set<PageRef>();
  const pageRefs: PageRef[] = [];
  for (const event of events) {
    if (event.kind !== "popup-opened" || seen.has(event.pageRef)) {
      continue;
    }
    seen.add(event.pageRef);
    pageRefs.push(event.pageRef);
  }
  return pageRefs;
}

function timingFromResponse(
  response: AbpActionResponse,
  fallbackTotalMs: number,
): ComputerUseBridgeOutput["timing"] {
  const timing = response.timing;
  if (timing === undefined) {
    return {
      actionMs: fallbackTotalMs,
      waitMs: 0,
      totalMs: fallbackTotalMs,
    };
  }

  return {
    actionMs: Math.max(0, timing.action_completed_ms - timing.action_started_ms),
    waitMs: Math.max(0, timing.wait_completed_ms - timing.action_completed_ms),
    totalMs: Math.max(0, timing.duration_ms),
  };
}

function viewportMetricsFromResponse(response: AbpActionResponse): ViewportMetrics | undefined {
  const scroll = response.scroll;
  if (scroll === undefined) {
    return undefined;
  }

  const x = scroll.scrollX ?? scroll.horizontal_px ?? 0;
  const y = scroll.scrollY ?? scroll.vertical_px ?? 0;
  const pageWidth = scroll.pageWidth ?? scroll.page_width ?? 0;
  const pageHeight = scroll.pageHeight ?? scroll.page_height ?? 0;
  const viewportWidth = scroll.viewportWidth ?? scroll.viewport_width ?? 0;
  const viewportHeight = scroll.viewportHeight ?? scroll.viewport_height ?? 0;

  return {
    layoutViewport: {
      origin: { x, y },
      size: createSize(viewportWidth, viewportHeight),
    },
    visualViewport: {
      origin: { x, y },
      offsetWithinLayoutViewport: createScrollOffset(0, 0),
      size: createSize(viewportWidth, viewportHeight),
    },
    scrollOffset: createScrollOffset(x, y),
    contentSize: createSize(pageWidth, pageHeight),
    devicePixelRatio: createDevicePixelRatio(1),
    pageScaleFactor: createPageScaleFactor(1),
    pageZoomFactor: createPageZoomFactor(1),
  };
}
