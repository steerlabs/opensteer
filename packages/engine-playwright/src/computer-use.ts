import {
  type ActionBoundaryOutcome,
  type PageRef,
  type Point,
  type ScreenshotArtifact,
  type StepEvent,
} from "@opensteer/browser-core";
import type {
  ComputerUseBridge,
  ComputerUseBridgeInput,
  NormalizedComputerScreenshotOptions,
  OpensteerComputerKeyModifier,
} from "@opensteer/protocol";
import type { Frame } from "playwright";

import { mapScreenshotFormat } from "./normalize.js";
import type { PlaywrightActionBoundaryOptions } from "./action-settle.js";
import type { FrameState, PageController } from "./types.js";
import { captureLayoutViewportScreenshotArtifact } from "./viewport-screenshot.js";

const DECORATION_NAMESPACE = "opensteer-computer-use";

export function createPlaywrightComputerUseBridge(context: {
  resolveController(pageRef: PageRef): PageController;
  flushPendingPageTasks(sessionRef: PageController["sessionRef"]): Promise<void>;
  flushDomUpdateTask(controller: PageController): Promise<void>;
  settleActionBoundary(
    controller: PageController,
    options: PlaywrightActionBoundaryOptions,
  ): Promise<ActionBoundaryOutcome>;
  requireMainFrame(controller: PageController): FrameState;
  drainQueuedEvents(pageRef: PageRef): readonly StepEvent[];
  withModifiers(
    page: PageController["page"],
    modifiers: readonly OpensteerComputerKeyModifier[] | undefined,
    action: () => Promise<void>,
  ): Promise<void>;
}): ComputerUseBridge {
  const cursorByPageRef = new Map<PageRef, Point>();

  return {
    async execute(input) {
      const startedAt = Date.now();
      const actionController = context.resolveController(input.pageRef);
      const action = input.action;
      let boundary: ActionBoundaryOutcome | undefined;
      let actionMs = 0;
      let waitMs = 0;

      const actionStartedAt = Date.now();
      const cursorPoint = pointForAction(action);
      switch (action.type) {
        case "click":
          await context.withModifiers(actionController.page, action.modifiers, async () => {
            await actionController.page.mouse.click(action.x, action.y, {
              ...(action.button === undefined ? {} : { button: action.button }),
              ...(action.clickCount === undefined ? {} : { clickCount: action.clickCount }),
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
        case "drag": {
          const steps = action.steps ?? 10;
          await actionController.page.mouse.move(action.start.x, action.start.y);
          await new Promise<void>((r) => setTimeout(r, 40 + Math.random() * 30));
          await actionController.page.mouse.down();
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const eased = 1 - Math.pow(1 - t, 3);
            const jitterFade = Math.max(0, 1 - i / (steps * 0.85));
            const jx = i < steps ? (Math.random() - 0.5) * 1.6 * jitterFade : 0;
            const jy = i < steps ? (Math.random() - 0.5) * 2.4 * jitterFade : 0;
            const x = action.start.x + (action.end.x - action.start.x) * eased + jx;
            const y = action.start.y + (action.end.y - action.start.y) * eased + jy;
            await actionController.page.mouse.move(Math.round(x), Math.round(y));
            if (i < steps) {
              const baseMs = t < 0.15 ? 22 : t > 0.85 ? 20 : 10;
              await new Promise<void>((r) => setTimeout(r, baseMs + Math.random() * 14));
            }
          }
          await new Promise<void>((r) => setTimeout(r, 30 + Math.random() * 40));
          await actionController.page.mouse.up();
          break;
        }
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
        boundary = await context.settleActionBoundary(actionController, {
          signal: input.signal,
          ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
          remainingMs: input.remainingMs,
          policySettle: input.policySettle,
        });
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
        await context.settleActionBoundary(resultController, {
          signal: input.signal,
          remainingMs: input.remainingMs,
          policySettle: input.policySettle,
        });
        waitMs += Date.now() - popupWaitStartedAt;
        await context.flushPendingPageTasks(actionController.sessionRef);
        resultController = context.resolveController(resultController.pageRef);
      }
      await context.flushDomUpdateTask(resultController);

      const screenshotCursor =
        resultController.pageRef === actionController.pageRef
          ? cursorByPageRef.get(resultController.pageRef)
          : undefined;
      const captured = await captureScreenshotWithDecorations(resultController, {
        screenshot: input.screenshot,
        ...(screenshotCursor === undefined ? {} : { cursorPoint: screenshotCursor }),
      });

      const events = [
        ...actionEvents,
        ...(resultController.pageRef === actionController.pageRef
          ? []
          : context.drainQueuedEvents(resultController.pageRef)),
      ];

      return {
        pageRef: resultController.pageRef,
        screenshot: captured.screenshot,
        viewport: captured.viewport,
        events,
        timing: {
          actionMs,
          waitMs,
          totalMs: Date.now() - startedAt,
        },
        ...(boundary === undefined ? {} : { boundary }),
      };
    },
  };
}

function pointForAction(action: ComputerUseBridgeInput["action"]): Point | undefined {
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
    readonly screenshot: NormalizedComputerScreenshotOptions;
    readonly cursorPoint?: Point;
  },
): Promise<{
  readonly screenshot: ScreenshotArtifact;
  readonly viewport: Awaited<
    ReturnType<typeof captureLayoutViewportScreenshotArtifact>
  >["viewport"];
}> {
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
    const format = mapScreenshotFormat(options.screenshot.format);
    const mainFrame = requireMainFrameState(controller);
    const { artifact, viewport } = await captureLayoutViewportScreenshotArtifact(
      controller,
      mainFrame,
      format,
    );
    return {
      screenshot: artifact,
      viewport,
    };
  } finally {
    if (shouldDecorate) {
      await cleanupDecorations(controller);
    }
  }
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
    readonly annotations: NormalizedComputerScreenshotOptions["annotations"];
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
    controller.page
      .frames()
      .map((frame) =>
        runFrameScript(
          frame,
          { annotations: [] },
          frame === controller.page.mainFrame(),
          "cleanup",
        ),
      ),
  );
}

async function runFrameScript(
  frame: Frame,
  options: {
    readonly annotations: NormalizedComputerScreenshotOptions["annotations"];
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
        readonly annotations: NormalizedComputerScreenshotOptions["annotations"];
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
  } catch {}
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
