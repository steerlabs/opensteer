import type { EditingOperation } from "@opensteer/client/editing";
import {
  RemoteEditingProxy,
  type RemoteEditingProxyHandle,
} from "../remote-editing/remote-editing-proxy.js";
import { BrowserEditingStore, type BrowserEditingState } from "@opensteer/client/host";
import type { EditingCaret, EditingContext } from "@opensteer/protocol/editing";
import { StreamedContextMenu, type StreamedMenuAction } from "./streamed-context-menu.js";
import type { DesktopWindowRect } from "@opensteer/protocol/desktop";
import { attachBrowserCanvas } from "./browser-presenter.js";
import { BrowserCropCue } from "./browser-crop-cue.js";
import {
  browserFrameContentRect,
  type BrowserFrameRect,
} from "@opensteer/shared/browserPresentation";
import { observeResize } from "@opensteer/shared/resizeObserver";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type Ref,
} from "react";
import { browserViewportFits } from "@opensteer/protocol";
import { useOptionalWorkspace, type LayoutPhase } from "../workspace/workspace-context.js";
import type {
  BrowserCommand,
  BrowserFrameStore,
  BrowserFrameView,
  BrowserTabSummary,
} from "@opensteer/client/host";

export interface BrowserKeyboardHandle {
  readonly focus: () => void;
}

/** The focused view keeps the shared active page at its panel size. */
export function BrowserViewport({
  activeSurfaceId,
  canInput,
  keyboardRef,
  frames,
  onFramePresented,
  pageFollowsView = true,
  phoneLayout = false,
  live,
  occluded,
  onCommand,
  onFitAvailable,
  onOpenLink,
  onLeave,
  onTouchTap,
  sessionId,
  targeted = false,
  visible,
}: {
  activeSurfaceId: BrowserTabSummary["id"] | null;
  canInput: boolean;
  keyboardRef?: Ref<BrowserKeyboardHandle> | undefined;
  frames: BrowserFrameStore;
  /** Each picture once it is on screen, so a target that waits for a reply gets one. */
  onFramePresented?: ((frame: BrowserFrameView) => void) | undefined;
  /**
   * The browser sizes the page to this view. One on a computer not yet
   * updated keeps its size, so, as on a phone, the person fits it.
   */
  pageFollowsView?: boolean | undefined;
  phoneLayout?: boolean | undefined;
  live: boolean;
  occluded: boolean;
  onCommand: (command: BrowserCommand) => void;
  onOpenLink: (url: string) => void;
  onFitAvailable?: ((available: boolean) => void) | undefined;
  /** F6 inside the page: the person wants their keyboard back, at the composer. */
  onLeave?: (() => void) | undefined;
  /** A finger tapped the page, which is when a text field there may want the keyboard. */
  onTouchTap?: (() => void) | undefined;
  sessionId: string;
  /**
   * The view holds exactly `activeSurfaceId` through its own targeted stream:
   * pictures are that tab's, and the stream's demand is the retain, not a
   * session-wide subscribe.
   */
  targeted?: boolean | undefined;
  visible: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<RemoteEditingProxyHandle>(null);
  const measureRef = useRef<(() => void) | null>(null);
  const layout = useOptionalWorkspace()?.layout ?? null;
  const eligibilityRef = useRef({ phoneLayout, live, visible });
  eligibilityRef.current = { phoneLayout, live, visible };
  const activeSurfaceRef = useRef(activeSurfaceId);
  activeSurfaceRef.current = activeSurfaceId;
  const [stageSize, setStageSize] = useState<BrowserViewportSize | null>(null);
  const fitAvailableRef = useRef(onFitAvailable);
  fitAvailableRef.current = onFitAvailable;
  // Read while hidden too: the client pauses the picture and keeps its last one
  // for the moment the page is shown again.
  const receivedFrame = useBrowserFrame(frames, sessionId, targeted ? activeSurfaceId : null);
  const frame = receivedFrame?.header.surfaceId === activeSurfaceId ? receivedFrame : null;
  const [presentedSurfaceId, setPresentedSurfaceId] = useState<string | null>(null);
  const presentedFrameRef = useRef<BrowserFrameView | null>(null);
  // A hidden page keeps its last picture but takes no input against it.
  const viewportCanInput =
    canInput && visible && presentedSurfaceId === activeSurfaceId && frame !== null && !occluded;
  const canInputRef = useRef(viewportCanInput);
  canInputRef.current = viewportCanInput;
  useImperativeHandle(keyboardRef, () => ({ focus: () => textInputRef.current?.focus() }), []);
  const [presentedGeometry, setPresentedGeometry] = useState<BrowserFrameView | null>(null);
  const framePresentedRef = useRef(onFramePresented);
  framePresentedRef.current = onFramePresented;
  const markFramePresented = useCallback((presentedFrame: BrowserFrameView) => {
    presentedFrameRef.current = presentedFrame;
    setPresentedSurfaceId(presentedFrame.header.surfaceId);
    setPresentedGeometry((previous) =>
      sameBrowserFrameGeometry(previous, presentedFrame)
        ? previous
        : { header: presentedFrame.header, data: new ArrayBuffer(0) },
    );
    framePresentedRef.current?.(presentedFrame);
  }, []);
  const pendingMove = useRef<
    | (BrowserFramePoint & { modifiers: ReturnType<typeof keyboardModifiers>; buttons: number })
    | null
  >(null);
  const animationFrame = useRef<number | null>(null);
  const pressedButton = useRef<"left" | "middle" | "right" | null>(null);
  const lastPointerPoint = useRef<BrowserFramePoint | null>(null);
  const clickTracker = useRef<{ count: number; time: number; x: number; y: number } | null>(null);
  // A finger is a tap until it moves; once it moves it scrolls the page.
  const touch = useRef<{
    readonly id: number;
    readonly start: BrowserFramePoint;
    lastX: number;
    lastY: number;
    scrolling: boolean;
  } | null>(null);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const editing = useMemo(
    () =>
      frames.editing ??
      new BrowserEditingStore((_session, _surface, command) => onCommandRef.current(command)),
    [frames.editing],
  );
  useEffect(
    () => () => {
      if (!frames.editing) editing.dispose();
    },
    [editing, frames.editing],
  );
  const editingTarget = useMemo(
    () => (activeSurfaceId ? editing.target(sessionId, activeSurfaceId) : null),
    [editing, sessionId, activeSurfaceId],
  );
  const editingState = useSyncExternalStore<BrowserEditingState | null>(
    editingTarget?.subscribe ?? noEditingSubscription,
    editingTarget?.get ?? noEditingState,
    noEditingState,
  );
  const legacyContext = useMemo<EditingContext>(
    () => ({ contextId: crypto.randomUUID(), field: null, caret: null }),
    [sessionId, activeSurfaceId],
  );
  const editingContext = editingState?.negotiated ? editingState.context : legacyContext;
  const stage = viewportRef.current?.getBoundingClientRect();
  const localStage = stage ? { left: 0, top: 0, width: stage.width, height: stage.height } : null;
  const caret =
    localStage &&
    editingContext?.caret &&
    (editingState?.geometryRevision === undefined ||
      editingState.geometryRevision === presentedGeometry?.header.geometryRevision)
      ? mappedBrowserCaret(localStage, presentedGeometry, editingContext.caret)
      : null;
  const menu = viewportCanInput ? editingState?.menu : null;
  const menuPoint =
    menu &&
    localStage &&
    (menu.geometryRevision === undefined ||
      menu.geometryRevision === presentedGeometry?.header.geometryRevision)
      ? mappedBrowserCaret(localStage, presentedGeometry, { x: menu.x, y: menu.y, height: 0 })
      : null;
  const dismissMenu = useCallback(() => {
    editingTarget?.dismissMenu();
    textInputRef.current?.focus();
  }, [editingTarget]);
  function menuAction(action: StreamedMenuAction) {
    if (action === "copy" || action === "cut") textInputRef.current?.perform({ kind: action });
    else if (action === "paste") textInputRef.current?.pasteFromMenu();
    else if (action === "select-all")
      textInputRef.current?.perform({ kind: "command", command: "selectAll" });
    else if (action === "copy-link" && menu?.linkUrl) textInputRef.current?.copyText(menu.linkUrl);
    else if (action === "open-link" && menu?.linkUrl) onOpenLink(menu.linkUrl);
    dismissMenu();
  }

  useEffect(() => {
    presentedFrameRef.current = null;
  }, [sessionId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const phase = (): LayoutPhase => layout?.get() ?? "settled";
    const announcer = createBrowserViewportAnnouncer(
      (surfaceId, size) => {
        const { live, visible, phoneLayout } = eligibilityRef.current;
        if (
          !live ||
          !visible ||
          phoneLayout ||
          !browserViewportFocused() ||
          surfaceId !== activeSurfaceRef.current
        )
          return;
        flushMove();
        onCommandRef.current({ ...size, surfaceId, type: "viewport.follow" });
      },
      () => pressedButton.current !== null,
    );
    const measure = () => {
      const { live, visible, phoneLayout } = eligibilityRef.current;
      const size = browserTargetViewport(viewport.getBoundingClientRect(), phoneLayout);
      const now = phase();
      // While the place's size is still moving the picture is only scaled;
      // nothing re-renders for each frame of it.
      if (now === "settled")
        setStageSize((previous) => (sameBrowserViewportSize(size, previous) ? previous : size));
      announcer.observe(
        activeSurfaceRef.current,
        size,
        live && visible && !phoneLayout && browserViewportFocused() && size !== null,
        now,
      );
    };
    measureRef.current = measure;
    const stopResize = observeResize([viewport], measure);
    // Settled, the size is read once the layout that settled it has been laid out.
    let settleFrame: number | null = null;
    const stopPhase =
      layout?.subscribe(() => {
        if (settleFrame !== null) cancelAnimationFrame(settleFrame);
        if (phase() !== "settled") {
          settleFrame = null;
          measure();
          return;
        }
        settleFrame = requestAnimationFrame(() => {
          settleFrame = null;
          measure();
        });
      }) ?? (() => undefined);
    document.addEventListener("visibilitychange", measure);
    window.addEventListener("focus", measure);
    window.addEventListener("blur", measure);
    measure();
    return () => {
      stopResize();
      stopPhase();
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      document.removeEventListener("visibilitychange", measure);
      window.removeEventListener("focus", measure);
      window.removeEventListener("blur", measure);
      announcer.dispose();
      measureRef.current = null;
    };
  }, [layout, sessionId]);

  useLayoutEffect(() => {
    measureRef.current?.();
  }, [activeSurfaceId, phoneLayout, live, visible]);

  const frameWidth = frame?.header.viewportWidth ?? null;
  const frameHeight = frame?.header.viewportHeight ?? null;
  useEffect(() => {
    const mismatched =
      stageSize !== null &&
      frameWidth !== null &&
      (frameWidth !== stageSize.width || frameHeight !== stageSize.height);
    if (!mismatched) {
      fitAvailableRef.current?.(false);
      return;
    }
    if (phoneLayout || !pageFollowsView) {
      fitAvailableRef.current?.(true);
      return;
    }
    // A view that sizes the page to itself shows another size only until its
    // own size lands. One that stays is someone else's: a phone's Fit, another
    // window's view or a page under a dialog, which Fit takes back.
    const settle = setTimeout(() => fitAvailableRef.current?.(true), followSettleMs);
    return () => clearTimeout(settle);
  }, [frameHeight, frameWidth, pageFollowsView, phoneLayout, stageSize]);

  // A picture kept through a pause or reconnect stays drawn but is not the
  // current socket's: input waits until the presenter draws one that is.
  useEffect(() => {
    if (!frame || !live) {
      presentedFrameRef.current = null;
      setPresentedSurfaceId(null);
    }
  }, [frame, live]);

  useEffect(() => {
    if (targeted || !live || !visible || occluded) return;
    onCommandRef.current({ type: "stream.subscribe", captureRegion: true });
    return () => {
      onCommandRef.current({ type: "stream.unsubscribe" });
    };
  }, [live, occluded, targeted, visible]);

  useEffect(
    () => () => {
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    },
    [],
  );

  // React registers wheel listeners passively, which silently disables
  // preventDefault — the panel behind the page would scroll too. A DOM
  // non-passive listener keeps every wheel gesture on the page.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: globalThis.WheelEvent) => {
      if (!canInputRef.current) return;
      const point = normalizedBrowserFramePoint(
        viewport.getBoundingClientRect(),
        presentedFrameRef.current,
        event.clientX,
        event.clientY,
        false,
      );
      if (!point) return;
      event.preventDefault();
      flushMove();
      sendWheel(onCommandRef.current, {
        deltaX:
          event.deltaX *
          (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? point.viewportWidth : 1),
        deltaY:
          event.deltaY *
          (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? point.viewportHeight : 1),
        modifiers: keyboardModifiers(event),
        ...point,
        type: "input.wheel",
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);

  const flushMove = useCallback(() => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = null;
    const point = pendingMove.current;
    pendingMove.current = null;
    if (point && canInputRef.current)
      onCommandRef.current({ action: "move", button: "none", ...point, type: "input.pointer" });
  }, []);
  const wire = useMemo(
    () =>
      editingTarget
        ? {
            send: (operation: EditingOperation) => {
              flushMove();
              return editingTarget.send(operation);
            },
            subscribeClipboard: editingTarget.activate,
          }
        : null,
    [editingTarget, flushMove],
  );
  useEffect(() => {
    const cancel = () => {
      flushMove();
      pressedButton.current = null;
      lastPointerPoint.current = null;
      touch.current = null;
      if (activeSurfaceId) {
        try {
          onCommand({ type: "input.cancel", surfaceId: activeSurfaceId });
        } catch {
          /* Socket departure owns cleanup when this view is already detached. */
        }
      }
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
      cancel();
    };
  }, [activeSurfaceId, sessionId, flushMove, onCommand]);

  function normalizedPointer(
    event: PointerEvent<HTMLDivElement>,
    clampOutside: boolean,
  ): BrowserFramePoint | null {
    return normalizedBrowserFramePoint(
      event.currentTarget.getBoundingClientRect(),
      presentedFrameRef.current,
      event.clientX,
      event.clientY,
      clampOutside,
    );
  }

  function pointerButton(button: number): "left" | "middle" | "right" | null {
    if (button === 0) return "left";
    if (button === 1) return "middle";
    if (button === 2) return "right";
    return null;
  }

  /** Chromium selects a word/line only when the click count says so. */
  function trackClickCount(event: PointerEvent<HTMLDivElement>): number {
    const now = performance.now();
    const previous = clickTracker.current;
    const chained =
      previous !== null &&
      now - previous.time < 500 &&
      Math.abs(event.clientX - previous.x) < 6 &&
      Math.abs(event.clientY - previous.y) < 6;
    const count = chained ? Math.min(3, previous.count + 1) : 1;
    clickTracker.current = { count, time: now, x: event.clientX, y: event.clientY };
    return count;
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    flushMove();
    if (!canInputRef.current) return;
    const button = pointerButton(event.button);
    if (!button) return;
    const point = normalizedPointer(event, false);
    if (!point) return;
    event.preventDefault();
    editingTarget?.dismissMenu();
    textInputRef.current?.pointerDown();
    if (event.pointerType === "touch") {
      if (button !== "left") return;
      event.currentTarget.setPointerCapture(event.pointerId);
      touch.current = {
        id: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
        scrolling: false,
        start: point,
      };
      return;
    }
    textInputRef.current?.focus(event.pointerType === "pen");
    event.currentTarget.setPointerCapture(event.pointerId);
    pressedButton.current = button;
    lastPointerPoint.current = point;
    const clickCount = button === "left" ? trackClickCount(event) : 1;
    onCommand({
      action: "down",
      modifiers: keyboardModifiers(event),
      buttons: event.buttons,
      button,
      clickCount,
      ...point,
      type: "input.pointer",
    });
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!canInputRef.current) return;
    const finger = touch.current;
    if (finger && event.pointerId === finger.id) {
      const dx = event.clientX - finger.lastX;
      const dy = event.clientY - finger.lastY;
      if (!finger.scrolling && Math.hypot(dx, dy) < touchSlop) return;
      finger.scrolling = true;
      finger.lastX = event.clientX;
      finger.lastY = event.clientY;
      const content = presentedFrameRef.current
        ? browserFrameContentRect(
            event.currentTarget.getBoundingClientRect(),
            presentedFrameRef.current.header.rasterWidth,
            presentedFrameRef.current.header.rasterHeight,
            presentedFrameRef.current.header.capture,
          )
        : null;
      if (!content) return;
      // The finger moves the page under it: page pixels per screen pixel.
      const scale =
        (presentedFrameRef.current?.header.capture?.width ?? finger.start.viewportWidth) /
        content.width;
      sendWheel(onCommand, {
        ...finger.start,
        modifiers: keyboardModifiers(event),
        deltaX: -dx * scale,
        deltaY: -dy * scale,
        type: "input.wheel",
      });
      return;
    }
    const point = normalizedPointer(event, pressedButton.current !== null);
    pendingMove.current = point
      ? { ...point, modifiers: keyboardModifiers(event), buttons: event.buttons }
      : null;
    if (pendingMove.current) lastPointerPoint.current = pendingMove.current;
    if (animationFrame.current !== null) return;
    animationFrame.current = requestAnimationFrame(flushMove);
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    flushMove();
    if (!canInputRef.current) return;
    const finger = touch.current;
    if (finger && event.pointerId === finger.id) {
      touch.current = null;
      if (finger.scrolling) return;
      event.preventDefault();
      // The editing context decides whether this tap may raise a touch keyboard.
      const tap = {
        button: "left",
        modifiers: keyboardModifiers(event),
        buttons: 0,
        clickCount: 1,
        ...finger.start,
        type: "input.pointer",
      } as const;
      onCommand({ ...tap, action: "down" });
      textInputRef.current?.activate();
      onCommand({ ...tap, action: "up" });
      textInputRef.current?.focus(true);
      onTouchTap?.();
      return;
    }
    const button = pressedButton.current ?? pointerButton(event.button);
    if (!button) return;
    const point = normalizedPointer(event, true);
    if (!point) return;
    event.preventDefault();
    pressedButton.current = null;
    lastPointerPoint.current = null;
    const clickCount = clickTracker.current?.count ?? 1;
    if (button === "left") textInputRef.current?.activate();
    onCommand({
      action: "up",
      modifiers: keyboardModifiers(event),
      buttons: event.buttons,
      button,
      clickCount,
      ...point,
      type: "input.pointer",
    });
    measureRef.current?.();
  }

  function pointerCancel(event: PointerEvent<HTMLDivElement>) {
    flushMove();
    if (touch.current?.id === event.pointerId) {
      touch.current = null;
      return;
    }
    if (!canInputRef.current || !pressedButton.current) return;
    const button = pressedButton.current;
    const point = normalizedPointer(event, true);
    if (!point) return;
    pressedButton.current = null;
    lastPointerPoint.current = null;
    onCommand({
      action: "up",
      button,
      ...point,
      modifiers: keyboardModifiers(event),
      buttons: 0,
      type: "input.pointer",
    });
    measureRef.current?.();
  }

  return (
    <div
      aria-label="Live browser page"
      className="browser-canvas browser-frame"
      data-live-page=""
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          flushMove();
          if (activeSurfaceId) onCommand({ type: "input.cancel", surfaceId: activeSurfaceId });
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={pointerDown}
      onPointerCancel={pointerCancel}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      ref={viewportRef}
      /* Only a surface that actually forwards keystrokes to the remote page
         claims the application role — that is the case the role exists for.
         When the page cannot take input the surface is inert pixels, so it
         stays an ordinary labelled region and browse mode keeps working. */
      role={viewportCanInput ? "application" : undefined}
      tabIndex={-1}
    >
      {wire && editingState ? (
        <RemoteEditingProxy
          abilities={editingState.abilities}
          caret={caret}
          context={editingContext}
          enabled={viewportCanInput}
          key={`${sessionId}:${activeSurfaceId}`}
          label="Browser keyboard input"
          onLeave={onLeave}
          ref={textInputRef}
          wire={wire}
        />
      ) : null}
      {menu && menuPoint ? (
        <StreamedContextMenu
          editable={menu.editable}
          selection={menu.selection && !editingContext?.field?.sensitive}
          left={Math.max(
            0,
            Math.min(menuPoint.left, (localStage?.width ?? menuPoint.left + 200) - 200),
          )}
          top={Math.max(
            0,
            Math.min(menuPoint.top, (localStage?.height ?? menuPoint.top + 220) - 220),
          )}
          linkUrl={menu.linkUrl}
          onAction={menuAction}
          onDismiss={dismissMenu}
        />
      ) : null}
      <BrowserCropCue />
      {frame ? (
        <BrowserFrameImage
          frames={frames}
          sessionId={sessionId}
          surfaceId={activeSurfaceId!}
          targeted={targeted}
          onPresented={markFramePresented}
        />
      ) : null}
    </div>
  );
}

function useBrowserFrame(
  frames: BrowserFrameStore,
  sessionId: string,
  surfaceId: string | null,
): BrowserFrameView | null {
  const subscribe = useCallback(
    (listener: () => void) => frames.subscribe(sessionId, listener, surfaceId ?? undefined),
    [frames, sessionId, surfaceId],
  );
  const geometry = useRef<BrowserFrameView | null>(null);
  const getSnapshot = useCallback(() => {
    const next = frames.get(sessionId, surfaceId ?? undefined);
    if (!sameBrowserFrameGeometry(geometry.current, next))
      geometry.current = next ? { header: next.header, data: new ArrayBuffer(0) } : null;
    return geometry.current;
  }, [frames, sessionId, surfaceId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function BrowserFrameImage({
  frames,
  sessionId,
  surfaceId,
  targeted,
  onPresented,
}: {
  frames: BrowserFrameStore;
  sessionId: string;
  surfaceId: string;
  targeted: boolean;
  onPresented: (frame: BrowserFrameView) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas)
      return attachBrowserCanvas(frames, sessionId, surfaceId, targeted, canvas, onPresented);
    return;
  }, [frames, sessionId, surfaceId, targeted, onPresented]);
  return <canvas aria-label="Live browser page" ref={canvasRef} role="img" />;
}

export interface BrowserViewportSize {
  readonly height: number;
  readonly width: number;
}

interface BrowserViewportRect {
  readonly height: number;
  readonly width: number;
}

/** Browser geometry is expressed in integer CSS pixels. DPR belongs to Runtime. */
export function browserViewportSize(rect: BrowserViewportRect | null): BrowserViewportSize | null {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  return browserViewportFits(width, height) ? { height, width } : null;
}

/**
 * Narrower than this, a page keeps this layout width and is scaled to fit the
 * middle, as a browser's page beside its side panel stops reflowing: a
 * tablet-wide layout reads better small than a phone layout reads large.
 */
export const browserLayoutFloor = 768;

/**
 * The size a page is given for a stage of `rect` CSS pixels. On a desktop the
 * page fills the stage, keeping at least the floor's layout width and a
 * height that, scaled by the same factor, fills the stage's height. A phone
 * gives its physical stage: it never follows on its own and Fit says so.
 * At a ratio past the frame limits the height stops there and the picture is
 * letterboxed, rather than asking for geometry no runtime accepts.
 */
export function browserTargetViewport(
  rect: BrowserViewportRect | null,
  phone: boolean,
): BrowserViewportSize | null {
  if (phone) return browserViewportSize(rect);
  if (
    !rect ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  const width = Math.max(browserLayoutFloor, Math.round(rect.width));
  const scale = Math.min(1, rect.width / width);
  let height = Math.round(rect.height / scale);
  while (height > 1 && !browserViewportFits(width, height)) height = Math.floor(height * 0.9);
  return browserViewportFits(width, height) ? { height, width } : null;
}

/**
 * Follows the latest size: at most 20 Hz as a window is resized, 5 Hz while
 * the dock's divider is dragged, nothing while the dock slides, and once
 * more, straight away, when it settles. One latest size waits; an equal one
 * is never resent. A size waits while the person holds a press on the page,
 * so focusing the window with a click never resizes the page under that
 * click. Another viewer's size is never answered: only this view's own
 * layout, focus and visibility call `observe`.
 */
function createBrowserViewportAnnouncer(
  send: (surfaceId: BrowserTabSummary["id"], size: BrowserViewportSize) => void,
  held: () => boolean,
) {
  let follows = false;
  let surfaceId: BrowserTabSummary["id"] | null = null;
  let latest: BrowserViewportSize | null = null;
  let lastSent: BrowserViewportSize | null = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let phase: LayoutPhase = "settled";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    dispose: cancel,
    observe: (
      nextSurfaceId: BrowserTabSummary["id"] | null,
      size: BrowserViewportSize | null,
      nextFollows: boolean,
      nextPhase: LayoutPhase,
    ) => {
      if (surfaceId !== nextSurfaceId || (nextFollows && !follows)) lastSent = null;
      const settledNow = phase !== "settled" && nextPhase === "settled";
      surfaceId = nextSurfaceId;
      follows = nextFollows;
      latest = size;
      phase = nextPhase;
      if (!follows || !surfaceId || !latest || phase === "settling") {
        cancel();
        return;
      }
      if (settledNow) {
        cancel();
        lastSentAt = Number.NEGATIVE_INFINITY;
      }
      if (timer !== null || sameBrowserViewportSize(latest, lastSent)) return;
      const interval = phase === "dragging" ? 200 : 50;
      timer = setTimeout(
        () => {
          timer = null;
          if (
            !surfaceId ||
            !latest ||
            phase === "settling" ||
            sameBrowserViewportSize(latest, lastSent) ||
            held()
          )
            return;
          lastSent = latest;
          lastSentAt = performance.now();
          send(surfaceId, latest);
        },
        Math.max(0, Math.ceil(interval - (performance.now() - lastSentAt))),
      );
    },
  };
}

function sameBrowserViewportSize(
  left: BrowserViewportSize | null,
  right: BrowserViewportSize | null,
): boolean {
  return left?.width === right?.width && left?.height === right?.height;
}

function browserViewportFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

interface BrowserFramePoint {
  readonly geometryRevision?: number;
  readonly captureRevision?: number;
  readonly surfaceId: BrowserFrameView["header"]["surfaceId"];
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly x: number;
  readonly y: number;
}

export function normalizedBrowserFramePoint(
  container: BrowserFrameRect,
  frame: BrowserFrameView | null,
  clientX: number,
  clientY: number,
  clampOutside: boolean,
): BrowserFramePoint | null {
  if (!frame) return null;
  const content = browserFrameContentRect(
    container,
    frame.header.rasterWidth,
    frame.header.rasterHeight,
    frame.header.capture,
  );
  if (!content) return null;
  const rawX = (clientX - content.left) / content.width;
  const rawY = (clientY - content.top) / content.height;
  if (!clampOutside && (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1)) return null;
  return {
    ...(frame.header.geometryRevision === undefined
      ? {}
      : { geometryRevision: frame.header.geometryRevision }),
    ...(frame.header.capture ? { captureRevision: frame.header.capture.revision } : {}),
    surfaceId: frame.header.surfaceId,
    viewportHeight: frame.header.viewportHeight,
    viewportWidth: frame.header.viewportWidth,
    x: clamp(rawX),
    y: clamp(rawY),
  };
}

const touchSlop = 8;

/** Long past a follow's round trip and a drag's 50 ms beat, so Fit never flickers mid-drag. */
const followSettleMs = 500;

/** Keep each wire delta representable without losing a large native scroll. */
function sendWheel(
  send: (command: BrowserCommand) => void,
  command: Extract<BrowserCommand, { type: "input.wheel" }>,
): void {
  const pieces = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(command.deltaX), Math.abs(command.deltaY)) / 100_000),
  );
  // Native wheel deltas are finite. Preserve boundary validation for malformed input.
  if (!Number.isFinite(pieces)) {
    send(command);
    return;
  }
  let x = command.deltaX,
    y = command.deltaY;
  for (let i = pieces; i > 0; i--) {
    const deltaX = x / i,
      deltaY = y / i;
    send({ ...command, deltaX, deltaY });
    x -= deltaX;
    y -= deltaY;
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function keyboardModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  const modifiers: Array<"alt" | "control" | "meta" | "shift"> = [];
  if (event.altKey) modifiers.push("alt");
  if (event.ctrlKey) modifiers.push("control");
  if (event.metaKey) modifiers.push("meta");
  if (event.shiftKey) modifiers.push("shift");
  return modifiers;
}

/** The native body takes no input: its transparent hole reveals the real page view. */
export function NativeBrowserViewport({
  bounds,
  stage,
  sized,
  previewing,
}: {
  readonly bounds: DesktopWindowRect | null;
  readonly stage: DesktopWindowRect | null;
  readonly sized: boolean;
  readonly previewing: boolean;
}) {
  return (
    <div className={`browser-native-well${bounds ? " is-placed" : ""}`}>
      {bounds && stage ? (
        <div
          className={`browser-page-hole${sized ? " is-sized" : ""}`}
          style={{
            left: bounds.x - stage.x,
            top: bounds.y - stage.y,
            width: bounds.width,
            height: bounds.height,
          }}
        />
      ) : null}
      {sized ? (
        <div aria-hidden className={`browser-well__brackets${previewing ? " is-previewing" : ""}`}>
          <i />
          <i />
          <i />
          <i />
        </div>
      ) : null}
    </div>
  );
}

function noEditingSubscription(): () => void {
  return () => undefined;
}
function noEditingState(): null {
  return null;
}
function sameBrowserFrameGeometry(
  left: BrowserFrameView | null,
  right: BrowserFrameView | null,
): boolean {
  const a = left?.header,
    b = right?.header;
  return (
    !!a &&
    !!b &&
    a.surfaceId === b.surfaceId &&
    a.geometryRevision === b.geometryRevision &&
    a.capture?.revision === b.capture?.revision &&
    a.capture?.width === b.capture?.width &&
    a.capture?.height === b.capture?.height &&
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight &&
    a.rasterWidth === b.rasterWidth &&
    a.rasterHeight === b.rasterHeight
  );
}
/** Context is normalized in the full page; a presented capture may show only its top-left region. */
export function mappedBrowserCaret(
  container: BrowserFrameRect,
  frame: BrowserFrameView | null,
  caret: EditingCaret,
): { left: number; top: number; height: number } | null {
  if (!frame) return null;
  const content = browserFrameContentRect(
    container,
    frame.header.rasterWidth,
    frame.header.rasterHeight,
    frame.header.capture,
  );
  if (!content) return null;
  const width = frame.header.capture?.width ?? frame.header.viewportWidth;
  const height = frame.header.capture?.height ?? frame.header.viewportHeight;
  const x = (caret.x * frame.header.viewportWidth) / width,
    y = (caret.y * frame.header.viewportHeight) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return {
    left: content.left + x * content.width,
    top: content.top + y * content.height,
    height: ((caret.height * frame.header.viewportHeight) / height) * content.height,
  };
}
