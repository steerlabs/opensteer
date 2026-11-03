import { browserPresentationRef } from "@opensteer/protocol";
import { createBrowserTouchGesture } from "@opensteer/shared/browserTouch";
import type { EditingOperation } from "@opensteer/client/editing";
import {
  RemoteEditingProxy,
  type RemoteEditingProxyHandle,
} from "../remote-editing/remote-editing-proxy.js";
import { BrowserEditingStore, type BrowserEditingState } from "@opensteer/client/host";
import type { EditingCaret, EditingContext } from "@opensteer/protocol/editing";
import { StreamedContextMenu, type StreamedMenuAction } from "./streamed-context-menu.js";
import type { DesktopWindowRect } from "@opensteer/protocol/desktop";
import { attachBrowserCanvas, sampleBrowserVideo } from "./browser-presenter.js";
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
  type CSSProperties,
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
  documentId,
  canInput,
  inputEpoch,
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
  documentId?: string | undefined;
  canInput: boolean;
  inputEpoch?: string | undefined;
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
  onCommand: (command: BrowserCommand) => boolean | void;
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
  const [cursor, setCursor] =
    useState<import("@opensteer/protocol/browser").BrowserCursor>("default");
  const cursorSequence = useRef(0);
  const cursorPointSequence = useRef(0);
  const cursorPoint = useRef<BrowserFramePoint | null>(null);
  const cursorExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetCursor = useCallback(
    (leave = true) => {
      cursorSequence.current++;
      setCursor("default");
      if (cursorExpiry.current) clearTimeout(cursorExpiry.current);
      if (leave) {
        cursorPoint.current = null;
        if (activeSurfaceId && frames.cursor) {
          try {
            onCommandRef.current({ type: "cursor.reset", surfaceId: activeSurfaceId });
          } catch {
            /* Departure owns remote cleanup. */
          }
        }
      }
    },
    [activeSurfaceId, frames.cursor],
  );
  const resetCursorRef = useRef(resetCursor);
  resetCursorRef.current = resetCursor;
  useLayoutEffect(() => {
    resetCursor();
    if (!activeSurfaceId || !frames.cursor || !viewportCanInput) return;
    const unsubscribe = frames.cursor.subscribe(sessionId, activeSurfaceId, (hint) => {
      const point = cursorPoint.current;
      if (
        !canInputRef.current ||
        !point ||
        hint.cursorSequence !== cursorSequence.current ||
        hint.documentId !== documentId ||
        hint.geometryRevision !== (point.geometryRevision ?? 0) ||
        hint.captureRevision !== (point.captureRevision ?? 0)
      )
        return;
      setCursor(hint.cursor);
      if (cursorExpiry.current) clearTimeout(cursorExpiry.current);
      cursorExpiry.current = setTimeout(() => setCursor("default"), 750);
    });
    const refresh = setInterval(() => {
      if (!cursorPoint.current || !canInputRef.current) return;
      try {
        onCommandRef.current({
          type: "cursor.query",
          surfaceId: activeSurfaceId,
          cursorSequence: cursorSequence.current,
          pointSequence: cursorPointSequence.current,
        });
      } catch {
        resetCursor();
      }
    }, 300);
    return () => {
      unsubscribe();
      clearInterval(refresh);
      resetCursor();
    };
  }, [
    activeSurfaceId,
    documentId,
    frames.cursor,
    live,
    sessionId,
    viewportCanInput,
    stageSize?.height,
    stageSize?.width,
    presentedGeometry?.header.geometryRevision,
    presentedGeometry?.header.capture?.revision,
    resetCursor,
  ]);

  const pendingMove = useRef<
    | (BrowserFramePoint & {
        cursorSequence?: number;
        modifiers: ReturnType<typeof keyboardModifiers>;
        buttons: number;
      })
    | null
  >(null);
  const animationFrame = useRef<number | null>(null);
  const pressedButton = useRef<"left" | "middle" | "right" | null>(null);
  const pointerPress = useRef<{ id: number; x: number; y: number; clickCount: number } | null>(
    null,
  );
  const lastPointerPoint = useRef<BrowserFramePoint | null>(null);
  const clickTracker = useRef<{ count: number; time: number; x: number; y: number } | null>(null);
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const pinch = useRef<{
    distance: number;
    x: number;
    y: number;
    transform: { scale: number; x: number; y: number };
  } | null>(null);
  const fingerId = useRef<number | null>(null);
  const [dragSelect, setDragSelect] = useState(false);
  const dragSelectRef = useRef(dragSelect);
  dragSelectRef.current = dragSelect;
  const [contact, setContact] = useState<{ x: number; y: number } | null>(null);
  const touchTapRef = useRef(onTouchTap);
  touchTapRef.current = onTouchTap;
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
  const unscaledCaret =
    localStage &&
    editingContext?.caret &&
    (editingState?.geometryRevision === undefined ||
      editingState.geometryRevision === presentedGeometry?.header.geometryRevision)
      ? mappedBrowserCaret(localStage, presentedGeometry, editingContext.caret)
      : null;
  const menu = viewportCanInput ? editingState?.menu : null;
  const unscaledMenuPoint =
    menu &&
    localStage &&
    (menu.geometryRevision === undefined ||
      menu.geometryRevision === presentedGeometry?.header.geometryRevision)
      ? mappedBrowserCaret(localStage, presentedGeometry, { x: menu.x, y: menu.y, height: 0 })
      : null;
  const scaledCaret = (point: { left: number; top: number; height: number } | null) =>
    point && {
      left: point.left * transform.scale + transform.x,
      top: point.top * transform.scale + transform.y,
      height: point.height * transform.scale,
    };
  const caret = scaledCaret(unscaledCaret);
  const menuPoint = scaledCaret(unscaledMenuPoint);
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

  const discardMove = useCallback(() => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = null;
    pendingMove.current = null;
  }, []);
  const touchGesture = useMemo(() => {
    const send = (command: BrowserCommand) => {
      try {
        return onCommandRef.current(command) !== false;
      } catch {
        return false;
      }
    };
    return createBrowserTouchGesture<BrowserFramePoint>({
      platform: /Android/i.test(navigator.userAgent) ? "android" : "ios",
      usable: () => canInputRef.current && eligibilityRef.current.live && !document.hidden,
      pointer: (point, action, button) =>
        send({
          ...point,
          type: "input.pointer",
          action,
          button,
          buttons: action === "up" ? 0 : button === "right" ? 2 : 1,
          clickCount: 1,
          modifiers: [],
        }),
      wheel: (point, deltaX, deltaY) =>
        send({ ...point, type: "input.wheel", deltaX, deltaY, modifiers: [] }),
      cancelPointer: (point) => {
        discardMove();
        resetCursorRef.current();
        clickTracker.current = null;
        send({ type: "input.cancel", surfaceId: point.surfaceId });
      },
      contact: setContact,
      onTap: () => {
        textInputRef.current?.activate();
        textInputRef.current?.focus(true);
        touchTapRef.current?.();
      },
      onDragEnd: () => setDragSelect(false),
    });
  }, [discardMove]);
  useLayoutEffect(() => {
    touchGesture.cancel();
    if (!live || !visible || occluded || !canInput) {
      fingers.current.clear();
      fingerId.current = null;
      touchGesture.contacts(0);
    }
    setDragSelect(false);
    setTransform((previous) =>
      previous.scale === 1 && previous.x === 0 && previous.y === 0
        ? previous
        : { scale: 1, x: 0, y: 0 },
    );
    pinch.current = null;
    editingTarget?.dismissMenu();
  }, [
    activeSurfaceId,
    sessionId,
    live,
    visible,
    occluded,
    canInput,
    inputEpoch,
    frame,
    presentedGeometry,
    stageSize,
    touchGesture,
    editingTarget,
  ]);
  useEffect(() => () => touchGesture.cancel(), [touchGesture]);

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
    let measuredRect = "";
    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}:${phase()}`;
      if (key !== measuredRect) {
        discardMove();
        resetCursorRef.current();
        touchGesture.cancel();
        measuredRect = key;
      }
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
      const rect = viewport.getBoundingClientRect();
      const view = transformRef.current;
      const point = normalizedBrowserFramePoint(
        rect,
        presentedFrameRef.current,
        rect.left + (event.clientX - rect.left - view.x) / view.scale,
        rect.top + (event.clientY - rect.top - view.y) / view.scale,
        false,
      );
      if (!point) return;
      event.preventDefault();
      resetCursorRef.current(false);
      touchGesture.cancel();
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

  const cancelInput = useCallback(
    (surfaceId: BrowserTabSummary["id"] | null, send = onCommandRef.current) => {
      discardMove();
      pressedButton.current = null;
      pointerPress.current = null;
      lastPointerPoint.current = null;
      touchGesture.cancel();
      fingers.current.clear();
      fingerId.current = null;
      touchGesture.contacts(0);
      pinch.current = null;
      resetCursor();
      clickTracker.current = null;
      if (surfaceId) send({ type: "input.cancel", surfaceId });
    },
    [discardMove, resetCursor, touchGesture],
  );
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
      try {
        cancelInput(activeSurfaceId, onCommandRef.current);
      } catch {
        /* Socket departure owns cleanup when this view is already detached. */
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
  }, [activeSurfaceId, sessionId, cancelInput]);

  function normalizedPointer(
    event: PointerEvent<HTMLDivElement>,
    clampOutside: boolean,
  ): BrowserFramePoint | null {
    const rect = event.currentTarget.getBoundingClientRect();
    const view = transformRef.current;
    return normalizedBrowserFramePoint(
      rect,
      presentedFrameRef.current,
      rect.left + (event.clientX - rect.left - view.x) / view.scale,
      rect.top + (event.clientY - rect.top - view.y) / view.scale,
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

  const videoGesture = useRef<{
    sample: NonNullable<ReturnType<typeof sampleBrowserVideo>>;
    id: string;
    pointer: number;
    canvas: HTMLCanvasElement;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    scrolling: boolean;
  } | null>(null);
  const cancelVideoGesture = useCallback(() => {
    const gesture = videoGesture.current;
    videoGesture.current = null;
    if (gesture && !gesture.scrolling)
      frames.video?.gesture(
        sessionId,
        activeSurfaceId ?? "",
        gesture.sample.header.streamId,
        browserPresentationRef(gesture.sample.header),
        gesture.id,
        "cancel",
      );
  }, [activeSurfaceId, frames.video, sessionId]);
  useLayoutEffect(() => {
    if (!viewportCanInput) cancelVideoGesture();
    return cancelVideoGesture;
  }, [cancelVideoGesture, viewportCanInput]);
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (frames.video?.selected()) {
      if (
        !canInputRef.current ||
        !activeSurfaceId ||
        (event.pointerType !== "touch" && event.button !== 0)
      )
        return;
      const canvas = event.currentTarget.querySelector("canvas");
      const sample = canvas && sampleBrowserVideo(canvas, event.clientX, event.clientY);
      if (!sample || !canvas) return;
      if (videoGesture.current) {
        cancelVideoGesture();
        return;
      }
      const id = crypto.randomUUID();
      videoGesture.current = {
        sample,
        id,
        pointer: event.pointerId,
        canvas,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        scrolling: false,
      };
      frames.video.gesture(
        sessionId,
        activeSurfaceId,
        sample.header.streamId,
        browserPresentationRef(sample.header),
        id,
        "begin",
      );
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      textInputRef.current?.pointerDown();
      return;
    }
    flushMove();
    if (event.pointerType === "touch") {
      resetCursor();
      discardMove();
      clickTracker.current = null;
      fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      touchGesture.contacts(fingers.current.size);
      event.currentTarget.setPointerCapture(event.pointerId);
      if (fingers.current.size > 1) {
        fingerId.current = null;
        pinch.current = null;
        const [first, second] = fingers.current.values();
        if (fingers.current.size === 2 && first && second) {
          const rect = event.currentTarget.getBoundingClientRect();
          pinch.current = {
            distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
            x: (first.x + second.x) / 2 - rect.left,
            y: (first.y + second.y) / 2 - rect.top,
            transform: transformRef.current,
          };
        }
        event.preventDefault();
        return;
      }
      touchGesture.cancel();
      if (!canInputRef.current) return;
      const point = normalizedPointer(event, false);
      const frame = presentedFrameRef.current;
      if (!point || !frame) return;
      event.preventDefault();
      editingTarget?.dismissMenu();
      textInputRef.current?.pointerDown();
      fingerId.current = event.pointerId;
      const rect = browserFrameContentRect(
        event.currentTarget.getBoundingClientRect(),
        frame.header.rasterWidth,
        frame.header.rasterHeight,
        frame.header.capture,
      );
      if (!rect) return;
      touchGesture.start({
        point,
        x: event.clientX,
        y: event.clientY,
        drag: dragSelectRef.current,
        scale:
          (frame.header.capture?.width ?? point.viewportWidth) /
          rect.width /
          transformRef.current.scale,
      });
      return;
    }
    touchGesture.cancel();
    if (!canInputRef.current) return;
    const button = pointerButton(event.button);
    if (!button) return;
    const point = normalizedPointer(event, false);
    if (!point) return;
    event.preventDefault();
    editingTarget?.dismissMenu();
    textInputRef.current?.pointerDown();
    textInputRef.current?.focus(event.pointerType === "pen");
    event.currentTarget.setPointerCapture(event.pointerId);
    pressedButton.current = button;
    lastPointerPoint.current = point;
    cursorPoint.current = point;
    cursorPointSequence.current = ++cursorSequence.current;
    const clickCount = button === "left" ? trackClickCount(event) : 1;
    pointerPress.current = { id: event.pointerId, x: event.clientX, y: event.clientY, clickCount };
    onCommand({
      action: "down",
      ...(frames.cursor ? { cursorSequence: cursorPointSequence.current } : {}),
      modifiers: keyboardModifiers(event),
      buttons: event.buttons,
      button,
      clickCount,
      ...point,
      type: "input.pointer",
    });
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (frames.video?.selected()) {
      const gesture = videoGesture.current;
      if (!gesture || gesture.pointer !== event.pointerId || !activeSurfaceId) return;
      const rect = gesture.canvas.getBoundingClientRect();
      if (
        rect.left !== gesture.sample.rect.left ||
        rect.top !== gesture.sample.rect.top ||
        rect.width !== gesture.sample.rect.width ||
        rect.height !== gesture.sample.rect.height
      ) {
        cancelVideoGesture();
        return;
      }
      if (
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8 &&
        !gesture.scrolling
      ) {
        frames.video.gesture(
          sessionId,
          activeSurfaceId,
          gesture.sample.header.streamId,
          browserPresentationRef(gesture.sample.header),
          gesture.id,
          "cancel",
        );
        gesture.scrolling = true;
      }
      if (gesture.scrolling && event.pointerType === "touch") {
        const p = gesture.sample.header.presentation;
        onCommand({
          type: "input.wheel",
          surfaceId: activeSurfaceId as import("@opensteer/core").BrowserSurfaceId,
          x: (gesture.sample.point.x - p.rasterCrop.x) / p.rasterCrop.width,
          y: (gesture.sample.point.y - p.rasterCrop.y) / p.rasterCrop.height,
          viewportWidth: p.rootCssWidth,
          viewportHeight: p.rootCssHeight,
          deltaX: ((gesture.lastX - event.clientX) * p.rootCssWidth) / rect.width,
          deltaY: ((gesture.lastY - event.clientY) * p.rootCssHeight) / rect.height,
          modifiers: [],
        });
      }
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      event.preventDefault();
      return;
    }
    if (!canInputRef.current) return;
    if (event.pointerType === "touch") {
      if (!fingers.current.has(event.pointerId)) return;
      fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const start = pinch.current;
      const [first, second] = fingers.current.values();
      if (start && fingers.current.size === 2 && first && second) {
        const rect = event.currentTarget.getBoundingClientRect();
        const scale = Math.max(
          1,
          Math.min(
            4,
            (start.transform.scale * Math.hypot(first.x - second.x, first.y - second.y)) /
              start.distance,
          ),
        );
        const x =
          (first.x + second.x) / 2 -
          rect.left -
          ((start.x - start.transform.x) * scale) / start.transform.scale;
        const y =
          (first.y + second.y) / 2 -
          rect.top -
          ((start.y - start.transform.y) * scale) / start.transform.scale;
        const next = {
          scale,
          x: Math.max(rect.width * (1 - scale), Math.min(0, x)),
          y: Math.max(rect.height * (1 - scale), Math.min(0, y)),
        };
        transformRef.current = next;
        setTransform(next);
        event.preventDefault();
        return;
      }
      if (fingerId.current === event.pointerId && fingers.current.size === 1) {
        const point = normalizedPointer(event, true);
        if (point) touchGesture.move({ point, x: event.clientX, y: event.clientY });
      }
      return;
    }
    const press = pointerPress.current;
    if (press && (Math.abs(event.clientX - press.x) >= 6 || Math.abs(event.clientY - press.y) >= 6))
      clickTracker.current = null;
    const point = normalizedPointer(event, pressedButton.current !== null);
    if (!point) resetCursor();
    else {
      cursorPoint.current = point;
      cursorPointSequence.current = ++cursorSequence.current;
    }
    if (!point && !pressedButton.current) {
      pointerLeave();
      return;
    }
    pendingMove.current = point
      ? {
          ...point,
          ...(frames.cursor ? { cursorSequence: cursorPointSequence.current } : {}),
          modifiers: keyboardModifiers(event),
          buttons: event.buttons,
        }
      : null;
    if (pendingMove.current) lastPointerPoint.current = pendingMove.current;
    if (animationFrame.current !== null) return;
    animationFrame.current = requestAnimationFrame(flushMove);
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (frames.video?.selected()) {
      const gesture = videoGesture.current;
      if (!gesture || gesture.pointer !== event.pointerId || !activeSurfaceId) return;
      const rect = gesture.canvas.getBoundingClientRect();
      if (
        !canInputRef.current ||
        rect.left !== gesture.sample.rect.left ||
        rect.top !== gesture.sample.rect.top ||
        rect.width !== gesture.sample.rect.width ||
        rect.height !== gesture.sample.rect.height
      ) {
        cancelVideoGesture();
        return;
      }
      videoGesture.current = null;
      event.preventDefault();
      if (gesture.scrolling) return;
      const modifiers =
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0);
      frames.video.click(
        sessionId,
        activeSurfaceId,
        gesture.sample.header.streamId,
        browserPresentationRef(gesture.sample.header),
        gesture.id,
        gesture.sample.point,
        modifiers,
      );
      textInputRef.current?.activate();
      return;
    }
    flushMove();
    if (event.pointerType === "touch") {
      if (fingerId.current === event.pointerId) touchGesture.release();
      fingers.current.delete(event.pointerId);
      pinch.current = null;
      touchGesture.contacts(fingers.current.size);
      if (fingers.current.size === 0) fingerId.current = null;
      event.preventDefault();
      return;
    }
    if (!canInputRef.current) return;
    const button = pressedButton.current;
    const press = pointerPress.current;
    if (!button || !press || press.id !== event.pointerId) return;
    const point = normalizedPointer(event, true);
    if (!point) return;
    event.preventDefault();
    pressedButton.current = null;
    lastPointerPoint.current = point;
    const clickCount = press.clickCount;
    pointerPress.current = null;
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
    if (!normalizedPointer(event, false)) pointerLeave();
    measureRef.current?.();
  }

  function pointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (frames.video?.selected()) {
      cancelVideoGesture();
      return;
    }
    resetCursor();
    if (event.pointerType === "touch") {
      discardMove();
      touchGesture.cancel();
      fingers.current.delete(event.pointerId);
      pinch.current = null;
      touchGesture.contacts(fingers.current.size);
      fingerId.current = null;
      clickTracker.current = null;
      return;
    }
    if (pointerPress.current?.id !== event.pointerId) return;
    cancelInput(lastPointerPoint.current?.surfaceId ?? activeSurfaceId);
    measureRef.current?.();
  }

  function pointerLeave() {
    resetCursor();
    if (pressedButton.current || fingers.current.size > 0) return;
    discardMove();
    const point = lastPointerPoint.current;
    lastPointerPoint.current = null;
    if (point && canInputRef.current)
      onCommand({
        ...point,
        type: "input.pointer",
        action: "leave",
        button: "none",
        modifiers: [],
      });
  }

  return (
    <div className="browser-touch-view">
      <div className={`browser-touch-tools${phoneLayout ? " is-phone" : ""}`}>
        <button
          type="button"
          disabled={!viewportCanInput}
          aria-pressed={dragSelect}
          onClick={() => {
            touchGesture.cancel();
            setDragSelect(!dragSelect);
          }}
        >
          {dragSelect ? "Done selecting" : "Drag/select"}
        </button>
        {dragSelect ? <span>Drag once to select or move content</span> : null}
      </div>
      <div
        aria-label="Live browser page"
        className="browser-canvas browser-frame"
        style={
          {
            cursor: viewportCanInput ? cursor : "default",
            "--browser-touch-scale": transform.scale,
            "--browser-touch-x": `${transform.x}px`,
            "--browser-touch-y": `${transform.y}px`,
          } as CSSProperties
        }
        data-live-page=""
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            cancelVideoGesture();
            cancelInput(activeSurfaceId);
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={pointerDown}
        onPointerCancel={pointerCancel}
        onLostPointerCapture={(event) => {
          if (
            fingers.current.has(event.pointerId) ||
            pointerPress.current?.id === event.pointerId ||
            videoGesture.current?.pointer === event.pointerId
          )
            pointerCancel(event);
        }}
        onPointerLeave={pointerLeave}
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
        {contact ? (
          <div
            aria-hidden="true"
            className="browser-touch-contact"
            style={{
              left: contact.x - (stage?.left ?? 0) - 12,
              top: contact.y - (stage?.top ?? 0) - 12,
            }}
          />
        ) : null}
        <BrowserCropCue />
        {frame || frames.video?.selected() ? (
          <BrowserFrameImage
            frames={frames}
            sessionId={sessionId}
            surfaceId={activeSurfaceId!}
            targeted={targeted}
            onPresented={markFramePresented}
          />
        ) : null}
      </div>
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
