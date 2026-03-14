import {
  createBodyPayload,
  createDevicePixelRatio,
  createPageScaleFactor,
  createPageZoomFactor,
  createSize,
  createScrollOffset,
  type KeyModifier,
  type PageRef,
  type Point,
  type ScreenshotArtifact,
  type ScreenshotFormat,
  type StepEvent,
  type ViewportMetrics,
} from "@opensteer/browser-core";
import type { Frame } from "playwright";

import { mapScreenshotFormat } from "./normalize.js";
import type { FrameState, PageController } from "./types.js";

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

interface PlaywrightComputerUseBridge {
  execute(input: ComputerUseBridgeInput): Promise<ComputerUseBridgeOutput>;
}

const DECORATION_NAMESPACE = "opensteer-computer-use";

export function createPlaywrightComputerUseBridge(context: {
  resolveController(pageRef: PageRef): PageController;
  flushPendingPageTasks(sessionRef: PageController["sessionRef"]): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  requireMainFrame(controller: PageController): FrameState;
  drainQueuedEvents(pageRef: PageRef): readonly StepEvent[];
  getViewportMetrics(pageRef: PageRef): Promise<ViewportMetrics>;
  withModifiers(
    page: PageController["page"],
    modifiers: readonly KeyModifier[] | undefined,
    action: () => Promise<void>,
  ): Promise<void>;
}): PlaywrightComputerUseBridge {
  const cursorByPageRef = new Map<PageRef, Point>();

  return {
    async execute(input) {
      const startedAt = Date.now();
      const actionController = context.resolveController(input.pageRef);
      const action = input.action;
      let actionMs = 0;
      let waitMs = 0;

      const actionStartedAt = Date.now();
      const cursorPoint = pointForAction(action);
      switch (action.type) {
        case "click":
          await context.withModifiers(actionController.page, action.modifiers, async () => {
            await actionController.page.mouse.click(action.x, action.y, {
              ...(action.button === undefined ? {} : { button: action.button }),
              ...(action.clickCount === undefined
                ? {}
                : { clickCount: action.clickCount }),
            });
          });
          break;
        case "move":
          await actionController.page.mouse.move(action.x, action.y);
          break;
        case "scroll":
          await actionController.page.mouse.move(action.x, action.y);
          await actionController.page.mouse.wheel(action.deltaX, action.deltaY);
          await waitForAnimationFrame(actionController);
          break;
        case "type":
          await actionController.page.keyboard.type(action.text);
          break;
        case "key":
          await context.withModifiers(actionController.page, action.modifiers, async () => {
            await actionController.page.keyboard.press(action.key);
          });
          break;
        case "drag":
          await actionController.page.mouse.move(action.start.x, action.start.y);
          await actionController.page.mouse.down();
          await actionController.page.mouse.move(action.end.x, action.end.y, {
            steps: action.steps ?? 10,
          });
          await actionController.page.mouse.up();
          break;
        case "screenshot":
          break;
        case "wait":
          await delayWithSignal(action.durationMs, input.signal);
          break;
      }
      actionMs = Date.now() - actionStartedAt;

      if (cursorPoint !== undefined) {
        cursorByPageRef.set(actionController.pageRef, cursorPoint);
      }

      await context.flushPendingPageTasks(actionController.sessionRef);

      if (action.type !== "screenshot" && action.type !== "wait") {
        const waitStartedAt = Date.now();
        await input.settle(actionController.pageRef);
        waitMs = Date.now() - waitStartedAt;
      } else if (action.type === "wait") {
        waitMs = actionMs;
        actionMs = 0;
      }

      await context.flushPendingPageTasks(actionController.sessionRef);
      const actionEvents = context.drainQueuedEvents(actionController.pageRef);
      const resultPageRef = resolveResultingPageRef(actionController.pageRef, actionEvents);
      let resultController = context.resolveController(resultPageRef);
      if (
        action.type !== "screenshot" &&
        action.type !== "wait" &&
        resultController.pageRef !== actionController.pageRef
      ) {
        const popupWaitStartedAt = Date.now();
        await input.settle(resultController.pageRef);
        waitMs += Date.now() - popupWaitStartedAt;
        await context.flushPendingPageTasks(actionController.sessionRef);
        resultController = context.resolveController(resultController.pageRef);
      }
      await context.flushDomUpdateTask(resultController);

      const screenshotCursor =
        resultController.pageRef === actionController.pageRef
          ? cursorByPageRef.get(resultController.pageRef)
          : undefined;
      const screenshot = await captureScreenshotWithDecorations(resultController, {
        screenshot: input.screenshot,
        ...(screenshotCursor === undefined ? {} : { cursorPoint: screenshotCursor }),
      });
      const viewport = await context.getViewportMetrics(resultController.pageRef);

      const events = [
        ...actionEvents,
        ...(resultController.pageRef === actionController.pageRef
          ? []
          : context.drainQueuedEvents(resultController.pageRef)),
      ];

      return {
        pageRef: resultController.pageRef,
        screenshot,
        viewport,
        events,
        timing: {
          actionMs,
          waitMs,
          totalMs: Date.now() - startedAt,
        },
      };
    },
  };
}

function pointForAction(action: ComputerAction): Point | undefined {
  switch (action.type) {
    case "click":
    case "move":
    case "scroll":
      return {
        x: action.x,
        y: action.y,
      };
    case "drag":
      return action.end;
    case "key":
    case "screenshot":
    case "type":
    case "wait":
      return undefined;
  }
}

function resolveResultingPageRef(pageRef: PageRef, events: readonly StepEvent[]): PageRef {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "popup-opened") {
      return event.pageRef;
    }
  }
  return pageRef;
}

async function waitForAnimationFrame(controller: PageController): Promise<void> {
  await controller.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        (
          globalThis as unknown as {
            requestAnimationFrame(callback: () => void): number;
          }
        ).requestAnimationFrame(() => resolve());
      }),
  );
}

async function captureScreenshotWithDecorations(
  controller: PageController,
  options: {
    readonly screenshot: ComputerUseScreenshotOptions;
    readonly cursorPoint?: Point;
  },
): Promise<ScreenshotArtifact> {
  const shouldDecorate =
    options.screenshot.annotations.length > 0 ||
    (options.screenshot.includeCursor && options.cursorPoint !== undefined);

  if (shouldDecorate) {
    await injectDecorations(controller, {
      annotations: options.screenshot.annotations,
      ...(options.screenshot.includeCursor && options.cursorPoint !== undefined
        ? { cursorPoint: options.cursorPoint }
        : {}),
    });
  }

  try {
    const metrics = await getViewportMetricsFromCdp(controller);
    const format = mapScreenshotFormat(options.screenshot.format);
    const response = await controller.cdp.send("Page.captureScreenshot", {
      format,
      fromSurface: true,
    });
    const mainFrame = requireMainFrameState(controller);
    return {
      pageRef: controller.pageRef,
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      payload: createBodyPayload(new Uint8Array(Buffer.from(response.data, "base64")), {
        mimeType: `image/${format}`,
      }),
      format,
      size: createSize(metrics.visualViewport.size.width, metrics.visualViewport.size.height),
      coordinateSpace: "layout-viewport-css",
    };
  } finally {
    if (shouldDecorate) {
      await cleanupDecorations(controller);
    }
  }
}

async function getViewportMetricsFromCdp(controller: PageController): Promise<ViewportMetrics> {
  const layout = await controller.cdp.send("Page.getLayoutMetrics");
  const screenInfos = await controller.cdp.send("Emulation.getScreenInfos");
  const primaryScreen =
    screenInfos.screenInfos.find((screen: { readonly isPrimary?: boolean }) => screen.isPrimary) ??
    screenInfos.screenInfos[0];
  const pageZoomFactor = layout.cssVisualViewport.zoom ?? 1;
  const devicePixelRatio = (primaryScreen?.devicePixelRatio ?? 1) * pageZoomFactor;
  return {
    layoutViewport: {
      origin: { x: layout.cssLayoutViewport.pageX, y: layout.cssLayoutViewport.pageY },
      size: {
        width: layout.cssLayoutViewport.clientWidth,
        height: layout.cssLayoutViewport.clientHeight,
      },
    },
    visualViewport: {
      origin: { x: layout.cssVisualViewport.pageX, y: layout.cssVisualViewport.pageY },
      offsetWithinLayoutViewport: {
        x: layout.cssVisualViewport.offsetX,
        y: layout.cssVisualViewport.offsetY,
      },
      size: {
        width: layout.cssVisualViewport.clientWidth,
        height: layout.cssVisualViewport.clientHeight,
      },
    },
    scrollOffset: {
      x: layout.cssVisualViewport.pageX,
      y: layout.cssVisualViewport.pageY,
    },
    contentSize: {
      width: layout.cssContentSize.width,
      height: layout.cssContentSize.height,
    },
    devicePixelRatio: createDevicePixelRatio(devicePixelRatio),
    pageScaleFactor: createPageScaleFactor(layout.cssVisualViewport.scale),
    pageZoomFactor: createPageZoomFactor(pageZoomFactor),
  };
}

function requireMainFrameState(controller: PageController): FrameState {
  if (!controller.mainFrameRef) {
    throw new Error(`page ${controller.pageRef} has no main frame`);
  }
  const mainFrame = Array.from(controller.framesByCdpId.values()).find(
    (frame) => frame.frameRef === controller.mainFrameRef,
  );
  if (!mainFrame) {
    throw new Error(`page ${controller.pageRef} has no registered main frame state`);
  }
  return mainFrame;
}

async function injectDecorations(
  controller: PageController,
  options: {
    readonly annotations: readonly ComputerAnnotation[];
    readonly cursorPoint?: Point;
  },
): Promise<void> {
  const frames = controller.page.frames();
  await Promise.all(
    frames.map(async (frame) => {
      const rootOverlay = frame === controller.page.mainFrame();
      await runFrameScript(frame, options, rootOverlay, "inject");
    }),
  );
}

async function cleanupDecorations(controller: PageController): Promise<void> {
  await Promise.all(
    controller.page.frames().map((frame) =>
      runFrameScript(frame, { annotations: [] }, frame === controller.page.mainFrame(), "cleanup"),
    ),
  );
}

async function runFrameScript(
  frame: Frame,
  options: {
    readonly annotations: readonly ComputerAnnotation[];
    readonly cursorPoint?: Point;
  },
  rootOverlay: boolean,
  mode: "inject" | "cleanup",
): Promise<void> {
  try {
    await frame.evaluate(
      ({
        annotations,
        cursorPoint,
        namespace,
        rootOverlay,
        mode,
      }: {
        readonly annotations: readonly ComputerAnnotation[];
        readonly cursorPoint?: Point;
        readonly namespace: string;
        readonly rootOverlay: boolean;
        readonly mode: "inject" | "cleanup";
      }) => {
        const host = globalThis as unknown as {
          document: any;
          window: {
            innerWidth?: number;
            innerHeight?: number;
          };
          HTMLElement: new (...args: readonly unknown[]) => any;
          getComputedStyle(element: any): {
            readonly overflow?: string;
            readonly overflowX?: string;
            readonly overflowY?: string;
          };
        };
        const document = host.document;
        const window = host.window;
        const HTMLElement = host.HTMLElement;
        const getComputedStyle = host.getComputedStyle;
        const styleId = `${namespace}-style`;
        const overlayId = `${namespace}-overlay`;
        const scrollableClass = `${namespace}-scrollable`;

        const cleanup = () => {
          document.getElementById(styleId)?.remove();
          document.getElementById(overlayId)?.remove();
          document.querySelectorAll(`.${scrollableClass}`).forEach((element: any) => {
            element.classList.remove(scrollableClass);
          });
        };

        cleanup();
        if (mode === "cleanup") {
          return;
        }

        const style = document.createElement("style");
        style.id = styleId;
        const css: string[] = [];
        if (annotations.includes("clickable")) {
          css.push(
            `a,button,[role='button'],[role='link'],[onclick],[tabindex]:not([tabindex='-1']){outline:2px solid #4CAF50!important;outline-offset:-2px!important;}`,
          );
        }
        if (annotations.includes("typeable")) {
          css.push(
            `input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='submit']):not([type='button']),textarea,[contenteditable='true']{outline:2px solid #FF9800!important;outline-offset:-2px!important;}`,
          );
        }
        if (annotations.includes("scrollable")) {
          css.push(
            `.${scrollableClass}{outline:2px dashed #9C27B0!important;outline-offset:-2px!important;}`,
          );
        }
        if (annotations.includes("selected")) {
          css.push(`:focus{outline:3px solid #2196F3!important;outline-offset:-3px!important;}`);
        }
        if (css.length > 0) {
          style.textContent = css.join("\n");
          (document.head ?? document.documentElement)?.appendChild(style);
        }

        if (annotations.includes("scrollable")) {
          const nodes = Array.from(document.querySelectorAll("*"));
          for (const node of nodes) {
            if (!(node instanceof HTMLElement)) {
              continue;
            }
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              continue;
            }
            const computed = getComputedStyle(node);
            const overflow = `${computed.overflow} ${computed.overflowX} ${computed.overflowY}`;
            if (!/(auto|scroll|overlay)/i.test(overflow)) {
              continue;
            }
            if (node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth) {
              continue;
            }
            node.classList.add(scrollableClass);
          }
        }

        if (!rootOverlay) {
          return;
        }

        const overlay = document.createElement("div");
        overlay.id = overlayId;
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "2147483647";

        if (annotations.includes("grid")) {
          const grid = document.createElement("div");
          grid.style.position = "absolute";
          grid.style.inset = "0";
          grid.style.backgroundImage =
            "repeating-linear-gradient(to right, rgba(255,0,0,0.22) 0, rgba(255,0,0,0.22) 1px, transparent 1px, transparent 100px), repeating-linear-gradient(to bottom, rgba(255,0,0,0.22) 0, rgba(255,0,0,0.22) 1px, transparent 1px, transparent 100px)";
          overlay.appendChild(grid);

          const width = window.innerWidth || 0;
          const height = window.innerHeight || 0;
          for (let x = 100; x < width; x += 100) {
            const label = document.createElement("div");
            label.textContent = String(x);
            label.style.position = "absolute";
            label.style.left = `${String(x + 4)}px`;
            label.style.top = "4px";
            label.style.font = "11px monospace";
            label.style.color = "#b71c1c";
            label.style.background = "rgba(255,255,255,0.86)";
            label.style.padding = "1px 3px";
            overlay.appendChild(label);
          }
          for (let y = 100; y < height; y += 100) {
            const label = document.createElement("div");
            label.textContent = String(y);
            label.style.position = "absolute";
            label.style.left = "4px";
            label.style.top = `${String(y + 4)}px`;
            label.style.font = "11px monospace";
            label.style.color = "#b71c1c";
            label.style.background = "rgba(255,255,255,0.86)";
            label.style.padding = "1px 3px";
            overlay.appendChild(label);
          }
        }

        if (cursorPoint !== undefined) {
          const cursor = document.createElement("div");
          cursor.style.position = "absolute";
          cursor.style.left = `${String(cursorPoint.x)}px`;
          cursor.style.top = `${String(cursorPoint.y)}px`;
          cursor.style.width = "14px";
          cursor.style.height = "14px";
          cursor.style.border = "2px solid rgba(17,17,17,0.92)";
          cursor.style.borderRadius = "999px";
          cursor.style.background = "rgba(255,255,255,0.92)";
          cursor.style.transform = "translate(-50%, -50%)";
          overlay.appendChild(cursor);

          const crosshair = document.createElement("div");
          crosshair.style.position = "absolute";
          crosshair.style.left = `${String(cursorPoint.x)}px`;
          crosshair.style.top = `${String(cursorPoint.y)}px`;
          crosshair.style.width = "20px";
          crosshair.style.height = "20px";
          crosshair.style.borderLeft = "1px solid rgba(17,17,17,0.7)";
          crosshair.style.borderTop = "1px solid rgba(17,17,17,0.7)";
          crosshair.style.transform = "translate(-50%, -50%)";
          overlay.appendChild(crosshair);
        }

        document.documentElement?.appendChild(overlay);
      },
      {
        annotations: [...options.annotations],
        ...(options.cursorPoint === undefined ? {} : { cursorPoint: options.cursorPoint }),
        namespace: DECORATION_NAMESPACE,
        rootOverlay,
        mode,
      },
    );
  } catch {
    // Ignore detached or transient frame failures. Screenshot capture should remain best-effort.
  }
}

function delayWithSignal(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs <= 0) {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
