import {
  createBodyPayload,
  createSize,
  createDevicePixelRatio,
  createPageScaleFactor,
  createPageZoomFactor,
  createScrollOffset,
  type FrameRef,
  type PageRef,
  type ScreenshotArtifact,
  type StepEvent,
  type ViewportMetrics,
} from "@opensteer/browser-core";
import type {
  ComputerUseBridge,
  ComputerUseBridgeOutput,
  NormalizedComputerScreenshotOptions,
} from "@opensteer/protocol";

import {
  buildImmediateActionRequest,
  buildImmediateScreenshotRequest,
  buildInputActionRequest,
} from "./rest-client.js";
import { buildAbpScrollSegments } from "./scroll.js";
import {
  collectPopupPageRefs,
  type DiscoveredTabEffects,
  resolveTabChangePageRef,
} from "./tab-change.js";
import type { AbpActionResponse, PageController, SessionState } from "./types.js";

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
  ): Promise<DiscoveredTabEffects>;
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
}): ComputerUseBridge {
  return {
    async execute(input) {
      const startedAt = Date.now();
      const controller = context.resolveController(input.pageRef);
      const session = context.resolveSession(controller.sessionRef);
      const action = input.action;
      const screenshot = toAbpScreenshotOptions(input.screenshot);
      const remainingMs = input.remainingMs();
      const requestOptions = {
        signal: input.signal,
      };
      const inputActionRequest = buildInputActionRequest({
        captureNetwork: false,
        omitDefaultTimeout: true,
        ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
        screenshot,
      });

      let response: AbpActionResponse;
      let dialogEvents: readonly StepEvent[] = [];

      switch (action.type) {
        case "click": {
          const executed = await context.executeInputAction(session, controller, () =>
            session.rest.clickTab(
              controller.tabId,
              {
                x: action.x,
                y: action.y,
                ...(action.button === undefined ? {} : { button: action.button }),
                ...(action.clickCount === undefined ? {} : { click_count: action.clickCount }),
                ...(action.modifiers === undefined ? {} : { modifiers: [...action.modifiers] }),
                ...inputActionRequest,
              },
              requestOptions,
            ),
          );
          response = executed.response;
          dialogEvents = executed.dialogEvents;
          break;
        }
        case "move":
          response = await session.rest.moveTab(
            controller.tabId,
            {
              x: action.x,
              y: action.y,
              ...buildImmediateActionRequest({
                captureNetwork: false,
                screenshot,
              }),
            },
            requestOptions,
          );
          break;
        case "scroll":
          response = await session.rest.scrollTab(
            controller.tabId,
            {
              x: action.x,
              y: action.y,
              scrolls: buildAbpScrollSegments({
                x: action.deltaX,
                y: action.deltaY,
              }),
              ...inputActionRequest,
            },
            requestOptions,
          );
          break;
        case "type":
          response = await session.rest.typeTab(
            controller.tabId,
            {
              text: action.text,
              ...inputActionRequest,
            },
            requestOptions,
          );
          break;
        case "key": {
          const executed = await context.executeInputAction(session, controller, () =>
            session.rest.keyPressTab(
              controller.tabId,
              {
                key: action.key,
                ...(action.modifiers === undefined ? {} : { modifiers: [...action.modifiers] }),
                ...inputActionRequest,
              },
              requestOptions,
            ),
          );
          response = executed.response;
          dialogEvents = executed.dialogEvents;
          break;
        }
        case "drag":
          response = await session.rest.dragTab(
            controller.tabId,
            {
              start_x: action.start.x,
              start_y: action.start.y,
              end_x: action.end.x,
              end_y: action.end.y,
              ...(action.steps === undefined ? {} : { steps: action.steps }),
              ...inputActionRequest,
            },
            requestOptions,
          );
          break;
        case "screenshot":
          response = await session.rest.screenshotTab(
            controller.tabId,
            buildImmediateScreenshotRequest(screenshot),
            requestOptions,
          );
          break;
        case "wait":
          response = await session.rest.waitTab(
            controller.tabId,
            {
              duration_ms: action.durationMs,
              ...buildImmediateActionRequest({
                captureNetwork: false,
                screenshot,
              }),
            },
            requestOptions,
          );
          break;
      }

      const actionEvents = await context.normalizeActionEvents(controller, response);
      const discoveredTabs = await context.detectNewTabs(session, controller);
      const popupPageRefs = collectPopupPageRefs([...actionEvents, ...discoveredTabs.events]);
      const resultPageRef = resolveTabChangePageRef({
        controllerPageRef: controller.pageRef,
        response,
        actionEvents,
        discoveredTabs,
        activePageRef: session.activePageRef,
      });
      if (response.tab_changed) {
        session.activePageRef = resultPageRef;
      }
      const resultController = context.resolveController(resultPageRef);
      await context.flushDomUpdateTask(resultController);

      const screenshotArtifact = await materializeScreenshotArtifact({
        context,
        session,
        controller: resultController,
        response,
        fallback: screenshot,
        signal: input.signal,
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
          ...discoveredTabs.events,
          ...dialogEvents,
          ...popupQueuedEvents,
        ],
        timing: timingFromResponse(response, Date.now() - startedAt),
      };
    },
  };
}

function toAbpScreenshotOptions(screenshot: NormalizedComputerScreenshotOptions): {
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
  readonly signal: AbortSignal;
}): Promise<ScreenshotArtifact> {
  let response = input.response;
  if (response.screenshot_after === undefined) {
    response = await input.session.rest.screenshotTab(
      input.controller.tabId,
      buildImmediateScreenshotRequest(input.fallback),
      {
        signal: input.signal,
      },
    );
  }

  const screenshot = response.screenshot_after;
  if (screenshot === undefined) {
    throw new Error(
      `ABP action response for ${input.controller.pageRef} did not include screenshot_after`,
    );
  }

  const mainFrame = input.context.requireMainFrame(input.controller);
  const format = (screenshot.format as NormalizedComputerScreenshotOptions["format"] | undefined) ?? "png";
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
