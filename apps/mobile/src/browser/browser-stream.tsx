import { getBrowserLastPicture, rememberBrowserLastPicture } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol/browser";
import { createBrowserTouchGesture } from "@opensteer/shared/browserTouch";
import { useBrowserPresentationWait, useBrowserTabAwake } from "@opensteer/client/react";
import type {
  BrowserCommand,
  BrowserFrameStore,
  BrowserFrameView,
  BrowserRasterDemand,
  BrowserSessionSummary,
  BrowserWatchState,
  HostClient,
} from "@opensteer/client/host";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Image,
  PanResponder,
  Platform,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { color, material, radius, space, type as textType } from "../theme.js";
import { usePaneGeometry } from "../ui/pane.js";
import {
  browserFrameContentRect,
  browserFrameCornerRadii,
  browserCropCue,
  browserRasterDensity,
} from "@opensteer/shared/browserPresentation";
import {
  mobileBrowserFrameKey,
  mobileBrowserPoint,
  nextMobileBrowserDecode,
  type MobileBrowserFrame,
} from "./browser-frame.js";
import { nativePictureView } from "../computers/phone-display-native.js";
import { browserPictureFence, useNativeBrowserPicture } from "./native-browser-picture.js";

export interface BrowserStreamProps {
  /** On screen in the foreground: pictures flow while it is. */
  readonly active: boolean;
  /**
   * An interactive view off screen keeps its viewer, without pictures, and its
   * last picture, so it shows again at once without asking the Host anew.
   */
  readonly held?: boolean;
  readonly hostClient: Pick<
    HostClient,
    | "browserPresentationDeadline"
    | "browserTabs"
    | "markBrowserPagePresented"
    | "acceptBrowserWatchFrame"
    | "browserFrames"
    | "browserWatchFrames"
    | "retainBrowserWatch"
    | "retainBrowserViewer"
    | "sendBrowserCommand"
    | "browserViewerState"
    | "browserWatchState"
    | "subscribeBrowserViewer"
    | "subscribeBrowserWatch"
  >;
  readonly interactive?: boolean;
  readonly inputEnabled?: boolean;
  readonly inputEpoch?: string;
  readonly dragSelect?: boolean;
  readonly onDragEnd?: () => void;
  readonly tabId: string;
  readonly documentId?: string | undefined;
  /** What the picture shows, in the page's own words: its title and site. */
  readonly label: string;
  /** The page's own size, as each new picture reports it, so a preview takes its shape. */
  readonly onPageSize?: (size: { readonly height: number; readonly width: number }) => void;
  readonly onPresentedGeometry?: (revision: number | null) => void;
  readonly onPointerDown?: () => void;
  /** The person tapped the page: a field may now have focus. */
  readonly onTap?: () => void;
  /** The person scrolled the page. */
  readonly onScroll?: () => void;
  readonly session: Pick<BrowserSessionSummary, "id" | "state">;
  /** Passive Run preview: retain the last presented picture of each recently visited tab. */
  readonly preserveLastFrame?: boolean;
  /** Original Run session identity when its tab is rebound to a replacement session. */
  readonly previewSessionId?: string;
  readonly style?: StyleProp<ViewStyle>;
  /**
   * How far this phone has pinched the picture in. A drag is measured on the
   * screen, so it scrolls the page by that much less at a larger zoom.
   */
  readonly zoom?: { readonly value: number };
}

interface FrameSlot {
  readonly frame: MobileBrowserFrame;
  /** The feed's delivery, whose token says the view is done with it. */
  readonly source: BrowserFrameView;
  readonly invalidation: string | number;
  readonly frames: BrowserFrameStore;
  readonly settle: () => void;
}

interface FrameSlots {
  readonly decoding: FrameSlot | null;
  readonly displayed: FrameSlot | null;
}

const emptySlots: FrameSlots = { decoding: null, displayed: null };

/**
 * Native presentation without changing page geometry. Tile previews use the
 * passive feed; an opened page uses one interactive feed for both its picture
 * and the person's input. When it
 * drops a picture — another tab, a closed browser, a lost connection — the
 * screen empties.
 *
 * Each picture returns its delivery credit once it is drawn, failed or
 * dropped. One that cannot be decoded leaves the last picture on screen
 * until a newer one arrives. A binary with the native
 * picture view decodes off the main thread there; an older one decodes
 * base64 data URIs through Image.
 *
 * A picture on screen says nothing over itself: whether an agent is acting is
 * the caller's to show, and a picture arriving is not news. Words appear only
 * while there is no picture to show.
 */
export function BrowserStream(props: BrowserStreamProps) {
  const reader = useRef({ client: props.hostClient, epoch: 0 });
  if (reader.current.client !== props.hostClient)
    reader.current = { client: props.hostClient, epoch: reader.current.epoch + 1 };
  return (
    <BrowserStreamView
      key={`${reader.current.epoch}:${props.preserveLastFrame && !props.interactive ? (props.previewSessionId ?? props.session.id) : props.session.id}`}
      {...props}
    />
  );
}

function BrowserStreamView({
  active: requestedActive,
  hostClient,
  label,
  onPageSize,
  onPresentedGeometry,
  onScroll,
  onTap,
  onPointerDown,
  session,
  style,
  interactive = false,
  inputEnabled = true,
  inputEpoch,
  dragSelect = false,
  onDragEnd,
  preserveLastFrame = false,
  held = false,
  tabId,
  documentId,
  zoom,
}: BrowserStreamProps) {
  // Asking again takes the feed anew: a fresh subscription, fresh pictures.
  const [attempt, setAttempt] = useState(0);
  const ready = session.state === "ready";
  const {
    error: presentationError,
    presented: presentationPresented,
    retry: retryPresentation,
  } = useBrowserPresentationWait(
    hostClient,
    session.id,
    tabId ?? "",
    requestedActive && ready && interactive,
  );
  const active = requestedActive && !presentationError;
  const kept = interactive && held;
  // What is drawn: the live picture, or the last one while the view is kept off screen.
  const drawn = active || kept;
  const preserve = preserveLastFrame && !interactive;
  const frames = interactive ? hostClient.browserFrames : hostClient.browserWatchFrames;
  // Fixed for the binary's lifetime, so one presenter owns this view's receipts.
  const [Picture] = useState(nativePictureView);
  const native = Picture !== null;
  const invalidation = useSyncExternalStore(
    useCallback(
      (listener) => frames.subscribe(session.id, listener, tabId),
      [frames, session.id, tabId],
    ),
    useCallback(
      () => frames.invalidationKey?.(session.id, tabId) ?? 0,
      [frames, session.id, tabId],
    ),
  );
  const received = useBrowserFrame(frames, session.id, tabId, drawn && !native);
  const [slots, setSlots] = useState<FrameSlots>(emptySlots);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  // The delivery this view last finished with, so one that could not be
  // decoded is not tried again while the feed still holds it.
  const settledKey = useRef<string | null>(null);
  const feed = useBrowserFeedState(hostClient, session.id, tabId, interactive);
  const feedState =
    feed.status === "live"
      ? "synchronized"
      : feed.status === "connecting"
        ? "connecting"
        : "disconnected";
  const feedError = feed.status === "unavailable" ? feed.error : null;

  // A Watch of a sleeping tab shows its last picture: watching it would wake it.
  const awake = useBrowserTabAwake(hostClient, session.id, tabId);
  // The client bounds how many browser targets it holds; past that it refuses, and says so.
  const [leaseError, setLeaseError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    try {
      const release = interactive
        ? hostClient.retainBrowserViewer(session.id, tabId, {
            captureRegion: true,
            rasterDemand: true,
            frameWindow: native,
          })
        : awake
          ? hostClient.retainBrowserWatch(session.id, tabId, {
              captureRegion: true,
              rasterDemand: true,
              frameWindow: native,
            })
          : undefined;
      setLeaseError(null);
      return release;
    } catch (error) {
      setLeaseError(error instanceof Error ? error.message : "This page can’t be shown.");
      return;
    }
  }, [active, attempt, awake, hostClient, interactive, native, session.id, tabId]);
  // Held apart from the picture, so the picture coming and going reuses this socket.
  useEffect(() => {
    if (!kept) return;
    try {
      return hostClient.retainBrowserViewer(session.id, tabId, { picture: false });
    } catch {
      // A Host without pictureless control reconnects when the picture returns.
      return;
    }
  }, [hostClient, kept, session.id, tabId]);

  const finish = useCallback(
    (delivery: BrowserFrameView) => {
      settledKey.current = mobileBrowserFrameKey(delivery);
      const token = delivery.header.watchToken;
      if (token) hostClient.acceptBrowserWatchFrame(session.id, token, tabId);
    },
    [hostClient, session.id, tabId],
  );
  const picture = useNativeBrowserPicture({
    enabled: native,
    visible: drawn && ready,
    frames,
    sessionId: session.id,
    tabId,
    settle: finish,
    preserveLastFrame: preserve,
  });
  const frame = native
    ? picture.drawn
    : received !== null && received.header.surfaceId === tabId
      ? received
      : null;

  useLayoutEffect(
    () => () => {
      if (native) return;
      const delivery = frames.get(session.id, tabId);
      if (delivery) finish(delivery);
      const decoding = slotsRef.current.decoding;
      if (decoding) decoding.settle();
    },
    [finish, frames, native, session.id, tabId],
  );

  // A layout effect, so pixels are gone before the next paint; they are also
  // hidden in render below.
  useLayoutEffect(() => {
    if (native) return;
    if (!drawn || !ready || (frame === null && !preserve)) {
      const decoding = slotsRef.current.decoding;
      if (decoding) decoding.settle();
      const discarded = received ?? frames.get(session.id, tabId);
      if (discarded) finish(discarded);
      setSlots(emptySlots);
      return;
    }
    // Another tab's picture never stands in for the one now in front.
    const decoding = slotsRef.current.decoding;
    if (
      decoding &&
      (decoding.source.header.surfaceId !== tabId || decoding.invalidation !== invalidation)
    )
      decoding.settle();
    setSlots((current) => ({
      decoding:
        current.decoding?.source.header.surfaceId === tabId &&
        current.decoding.invalidation === invalidation &&
        current.decoding.frames === frames
          ? current.decoding
          : null,
      displayed:
        current.displayed?.source.header.surfaceId === tabId &&
        current.displayed.invalidation === invalidation &&
        current.displayed.frames === frames
          ? current.displayed
          : null,
    }));
  }, [
    drawn,
    finish,
    frame,
    frames,
    invalidation,
    native,
    preserve,
    ready,
    received,
    session.id,
    tabId,
  ]);

  // Only convert when the native decoder slot is free. With one picture in
  // flight at a time, the feed's value once the slot frees is the latest.
  const decodingBusy = slots.decoding !== null;
  useEffect(() => {
    if (native || !drawn || !ready || frame === null || decodingBusy) return;
    const next = nextMobileBrowserDecode({
      active: drawn,
      activeSurfaceId: frame.header.surfaceId,
      frame,
      inFlightFrameKey: null,
      settledFrameKey: settledKey.current,
    });
    if (next !== null) {
      setSlots((current) => ({
        ...current,
        decoding: { frame: next, source: frame, invalidation, frames, settle: () => finish(frame) },
      }));
    } else if (mobileBrowserFrameKey(frame) !== settledKey.current) {
      // Too large to convert here: dropped, so the feed can move on.
      finish(frame);
    }
  }, [drawn, decodingBusy, finish, frame, frames, invalidation, native, ready]);

  const loaded = (slot: FrameSlot) => {
    if (slotsRef.current.decoding !== slot) return;
    // The interactive feed may paint again during a native decode. Showing
    // that completed picture avoids starvation while retaining exact tab and
    // geometry identity; the next decode takes the newest picture.
    const latest = frames.get(session.id, tabId);
    const current = interactive
      ? latest !== null &&
        latest.header.surfaceId === slot.source.header.surfaceId &&
        latest.header.viewportWidth === slot.source.header.viewportWidth &&
        latest.header.viewportHeight === slot.source.header.viewportHeight &&
        latest.header.geometryRevision === slot.source.header.geometryRevision &&
        latest.header.capture?.revision === slot.source.header.capture?.revision
      : latest === slot.source;
    setSlots((previous) => ({ decoding: null, displayed: current ? slot : previous.displayed }));
    slot.settle();
  };
  const failed = (slot: FrameSlot) => {
    if (slotsRef.current.decoding !== slot) return;
    setSlots((previous) => ({ ...previous, decoding: null }));
    slot.settle();
  };

  // Hidden in the render that loses the feed's picture, not an effect later.
  const visible = drawn && ready && (frame !== null || preserve);
  const displayedSlot =
    visible &&
    !native &&
    slots.displayed?.source.header.surfaceId === tabId &&
    slots.displayed.invalidation === invalidation &&
    slots.displayed.frames === frames
      ? slots.displayed
      : null;
  const liveDisplayed: { readonly source: BrowserFrameView } | null = native
    ? picture.drawn && { source: picture.drawn }
    : displayedSlot;
  const cached =
    preserve && active && ready ? getBrowserLastPicture(frames, session.id, tabId) : null;
  const restored = liveDisplayed === null ? cached : null;
  const displayed = liveDisplayed ?? (restored ? { source: restored.frame } : null);
  const cacheInvalidation = useRef(invalidation);
  // An opened page keeps one picture as it leaves the screen, not one per frame.
  const leaving = useRef<{
    readonly source: BrowserFrameView;
    readonly invalidation: string | number;
  } | null>(null);
  useEffect(() => {
    const unchanged = cacheInvalidation.current === invalidation;
    cacheInvalidation.current = invalidation;
    if (!unchanged) leaving.current = null;
    if (!liveDisplayed || !unchanged) return;
    if (preserve) rememberBrowserLastPicture(frames, session.id, tabId, liveDisplayed.source);
    else if (interactive) leaving.current = { source: liveDisplayed.source, invalidation };
  }, [interactive, preserve, liveDisplayed?.source, frames, invalidation, session.id, tabId]);
  useEffect(() => {
    if (!interactive || !active) return;
    return () => {
      const last = leaving.current;
      leaving.current = null;
      if (last && frames.invalidationKey?.(session.id, tabId) === last.invalidation)
        rememberBrowserLastPicture(frames, session.id, tabId, last.source);
    };
  }, [active, frames, interactive, session.id, tabId]);
  const decoding =
    visible &&
    !native &&
    slots.decoding?.invalidation === invalidation &&
    slots.decoding.frames === frames
      ? slots.decoding
      : null;
  useEffect(() => {
    if (displayed !== null) presentationPresented();
  }, [displayed, presentationPresented]);
  const size = useRef({ width: 0, height: 0 });
  const origin = useRef({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState(size.current);
  const rasterDemand = useRef<BrowserRasterDemand | null>(null);
  const drawnHeader = displayed?.source.header;
  const geometryRevision = drawnHeader?.geometryRevision ?? null;
  useEffect(() => onPresentedGeometry?.(geometryRevision), [geometryRevision, onPresentedGeometry]);
  const contentRect = drawnHeader
    ? browserFrameContentRect(
        { ...stageSize, left: 0, top: 0 },
        drawnHeader.rasterWidth,
        drawnHeader.rasterHeight,
        drawnHeader.capture,
        "center",
      )
    : null;
  const density = browserRasterDensity(
    contentRect?.width ?? 0,
    drawnHeader?.capture?.width ?? drawnHeader?.viewportWidth ?? 0,
    PixelRatio.get(),
  );
  useLayoutEffect(() => {
    const demand = active ? frames.rasterDemand?.(session.id, tabId) : undefined;
    rasterDemand.current = demand ?? null;
    return () => {
      demand?.release();
      rasterDemand.current = null;
    };
  }, [active, frames, session.id, tabId]);
  useLayoutEffect(() => {
    rasterDemand.current?.update(density);
  }, [active, density, frames, session.id, tabId]);

  const input = useRef({
    active,
    ready,
    interactive,
    inputEnabled,
    displayed,
    frame,
    feedState,
    onScroll,
    onTap,
    onPointerDown,
    zoom,
    dragSelect,
    onDragEnd,
  });
  input.current = {
    active,
    ready,
    interactive,
    inputEnabled,
    displayed,
    frame,
    feedState,
    onScroll,
    onTap,
    onPointerDown,
    zoom,
    dragSelect,
    onDragEnd,
  };
  const [pointerCursor, setPointerCursor] = useState<"auto" | "pointer">("auto");
  const cursorSequence = useRef(0);
  const cursorPointSequence = useRef(0);
  const hoverPoint = useRef<ReturnType<typeof mobileBrowserPoint>>(null);
  const touchContacts = useRef(0);
  const cursorExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorFrame = useRef<number | null>(null);
  const resetCursor = useCallback(() => {
    if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
    cursorFrame.current = null;
    hoverPoint.current = null;
    cursorSequence.current++;
    setPointerCursor("auto");
    if (cursorExpiry.current) clearTimeout(cursorExpiry.current);
    if (frames.cursor && tabId)
      submitBrowserCommand(hostClient, session.id, {
        type: "cursor.reset",
        surfaceId: BrowserSurfaceIdSchema.parse(tabId),
      });
  }, [frames.cursor, hostClient, session.id, tabId]);
  const [contact, setContact] = useState<{ x: number; y: number } | null>(null);
  const touchOrigin = useRef({ x: 0, y: 0 });
  const touchGesture = useMemo(() => {
    const send = (command: BrowserCommand) => submitBrowserCommand(hostClient, session.id, command);
    return createBrowserTouchGesture<NonNullable<ReturnType<typeof mobileBrowserPoint>>>({
      platform: Platform.OS === "android" ? "android" : "ios",
      usable: () => {
        const current = input.current;
        return (
          current.active &&
          current.ready &&
          current.interactive &&
          current.inputEnabled &&
          current.feedState === "synchronized" &&
          current.displayed !== null &&
          current.frame?.header.surfaceId === current.displayed.source.header.surfaceId
        );
      },
      pointer: (point, action, button) =>
        send({ type: "input.pointer", ...point, action, button, clickCount: 1 }),
      wheel: (point, deltaX, deltaY) => send({ type: "input.wheel", ...point, deltaX, deltaY }),
      cancelPointer: (point) => {
        resetCursor();
        send({ type: "input.cancel", surfaceId: point.surfaceId });
      },
      contact: setContact,
      onTap: () => input.current.onTap?.(),
      onScroll: () => input.current.onScroll?.(),
      onDragEnd: () => input.current.onDragEnd?.(),
    });
  }, [hostClient, session.id, resetCursor]);
  const trackContacts = useCallback(
    (count: number) => {
      touchContacts.current = count;
      touchGesture.contacts(count);
    },
    [touchGesture],
  );
  const geometry = usePaneGeometry();
  const drawnGeometry = displayed ? browserPictureFence(displayed.source) : null;
  useLayoutEffect(() => {
    touchGesture.cancel();
    if (!active || !inputEnabled || feedState !== "synchronized") trackContacts(0);
  }, [
    geometry,
    drawnGeometry,
    active,
    inputEnabled,
    interactive,
    feed.admissionId,
    feedState,
    inputEpoch,
    dragSelect,
    session.id,
    tabId,
    touchGesture,
    trackContacts,
  ]);
  const cursorDocument = documentId;
  useEffect(() => {
    resetCursor();
    if (
      !interactive ||
      !active ||
      !inputEnabled ||
      feedState !== "synchronized" ||
      !tabId ||
      !frames.cursor
    )
      return;
    const unsubscribe = frames.cursor.subscribe(session.id, tabId, (hint) => {
      const point = hoverPoint.current;
      if (
        !point ||
        hint.cursorSequence !== cursorSequence.current ||
        hint.documentId !== cursorDocument ||
        hint.geometryRevision !== point.geometryRevision ||
        hint.captureRevision !== (point.captureRevision ?? 0)
      )
        return;
      // RN 0.88 offers only iOS auto/pointer hover effects. Other shapes,
      // and Android's native pointer, need a platform cursor adapter.
      setPointerCursor(Platform.OS === "ios" && hint.cursor === "pointer" ? "pointer" : "auto");
      if (cursorExpiry.current) clearTimeout(cursorExpiry.current);
      cursorExpiry.current = setTimeout(() => setPointerCursor("auto"), 750);
    });
    const refresh = setInterval(() => {
      if (hoverPoint.current)
        submitBrowserCommand(hostClient, session.id, {
          type: "cursor.query",
          surfaceId: BrowserSurfaceIdSchema.parse(tabId),
          cursorSequence: cursorSequence.current,
          pointSequence: cursorPointSequence.current,
        });
    }, 300);
    return () => {
      unsubscribe();
      clearInterval(refresh);
      resetCursor();
    };
  }, [
    active,
    inputEnabled,
    interactive,
    feedState,
    feed.admissionId,
    cursorDocument,
    drawnGeometry,
    geometry,
    stageSize.height,
    stageSize.width,
    frames.cursor,
    hostClient,
    session.id,
    tabId,
    resetCursor,
  ]);

  useEffect(() => () => touchGesture.cancel(), [touchGesture]);
  const gestures = useMemo(() => {
    const usable = () => {
      const current = input.current;
      return (
        current.active &&
        current.ready &&
        current.interactive &&
        current.inputEnabled &&
        current.feedState === "synchronized" &&
        current.displayed !== null
      );
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: usable,
      onMoveShouldSetPanResponder: usable,
      onPanResponderStart: (event) => trackContacts(event.nativeEvent.touches?.length ?? 1),
      onPanResponderEnd: (event) => trackContacts(event.nativeEvent.touches?.length ?? 0),
      onPanResponderGrant: (event) => {
        if (frames.cursor) resetCursor();
        const count = event.nativeEvent.touches?.length ?? 1;
        trackContacts(count);
        if (count > 1) return;
        touchGesture.cancel();
        const current = input.current;
        const source = usable() ? (current.displayed?.source ?? null) : null;
        const { locationX: x, locationY: y } = event.nativeEvent;
        const point = mobileBrowserPoint({ frame: source, ...size.current, x, y });
        if (!point || !source) return;
        current.onPointerDown?.();
        touchOrigin.current = { x, y };
        const rect = browserFrameContentRect(
          { ...size.current, left: 0, top: 0 },
          source.header.rasterWidth,
          source.header.rasterHeight,
          source.header.capture,
          "center",
        );
        touchGesture.start({
          point,
          x,
          y,
          drag: current.dragSelect,
          scale:
            (source.header.capture?.height ?? source.header.viewportHeight) /
            (rect?.height ?? 1) /
            Math.max(1, current.zoom?.value ?? 1),
        });
      },
      onPanResponderMove: (event, state) => {
        trackContacts(event.nativeEvent.touches?.length ?? 1);
        if ((event.nativeEvent.touches?.length ?? 1) > 1) return;
        const source = input.current.displayed?.source ?? null;
        const x = touchOrigin.current.x + state.dx;
        const y = touchOrigin.current.y + state.dy;
        const pinched = Math.max(1, input.current.zoom?.value ?? 1);
        const point = mobileBrowserPoint({
          frame: source,
          ...size.current,
          x: touchOrigin.current.x + state.dx / pinched,
          y: touchOrigin.current.y + state.dy / pinched,
          clampOutside: true,
        });
        if (point) touchGesture.move({ point, x, y });
      },
      onPanResponderRelease: () => {
        touchGesture.release();
        trackContacts(0);
      },
      onPanResponderTerminate: (event) => {
        touchGesture.cancel();
        trackContacts(event.nativeEvent.touches?.length ?? 0);
      },
    });
  }, [touchGesture, trackContacts, frames.cursor, resetCursor]);
  const shownWidth =
    displayed?.source.header.capture?.width ?? displayed?.source.header.viewportWidth ?? null;
  const shownHeight =
    displayed?.source.header.capture?.height ?? displayed?.source.header.viewportHeight ?? null;
  useEffect(() => {
    if (shownWidth !== null && shownHeight !== null)
      onPageSize?.({ height: shownHeight, width: shownWidth });
  }, [onPageSize, shownHeight, shownWidth]);
  if (!requestedActive && !kept) return null;
  const words =
    presentationError ??
    leaseError ??
    (displayed === null ? streamLabel(session.state, feedState, feedError) : null);

  return (
    <View
      accessibilityLabel={label}
      onTouchStart={(event) => trackContacts(event.nativeEvent.touches.length)}
      onTouchEnd={(event) => trackContacts(event.nativeEvent.touches.length)}
      onTouchCancel={(event) => {
        touchGesture.cancel();
        trackContacts(event.nativeEvent.touches.length);
      }}
      accessibilityHint={
        interactive
          ? dragSelect
            ? "Drag to select or move content. Two fingers zoom."
            : "Tap to click. Drag to scroll. Hold for page actions. Two fingers zoom."
          : undefined
      }
      onLayout={(event) => {
        const { height, width, x, y } = event.nativeEvent.layout;
        if (
          size.current.width !== width ||
          size.current.height !== height ||
          origin.current.x !== x ||
          origin.current.y !== y
        ) {
          resetCursor();
          touchGesture.cancel();
        }
        size.current = { width, height };
        origin.current = { x, y };
        setStageSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }}
      style={[styles.stage, style]}
    >
      {Picture === null ? null : (
        <View
          key={preserve ? tabId : `${session.id}:${tabId}`}
          pointerEvents="none"
          style={[styles.image, { opacity: picture.drawn ? 1 : 0 }]}
        >
          <Picture
            accessibilityElementsHidden={liveDisplayed === null}
            accessibilityIgnoresInvertColors
            accessibilityLabel={liveDisplayed === null ? undefined : label}
            importantForAccessibility={liveDisplayed === null ? "no-hide-descendants" : "auto"}
            onCleared={picture.cleared}
            onShown={picture.shownAgain}
            ref={picture.view}
            style={styles.image}
          />
          {displayed?.source.header.capture ? (
            <View
              pointerEvents="none"
              style={[styles.frame, framePlacement(stageSize, displayed.source.header)]}
            >
              <CropCues header={displayed.source.header} />
            </View>
          ) : null}
        </View>
      )}
      {restored ? (
        <View
          pointerEvents="none"
          style={[styles.frame, framePlacement(stageSize, restored.frame.header)]}
        >
          <Image
            accessibilityLabel={label}
            fadeDuration={0}
            resizeMode="stretch"
            source={{ uri: restored.uri }}
            style={styles.image}
          />
          <CropCues header={restored.frame.header} />
        </View>
      ) : null}
      {/* One list, so the picture that finishes decoding stays mounted as it is shown. */}
      {[displayedSlot, decoding].map((slot) => {
        if (!slot) return null;
        const { header } = slot.source;
        return (
          <View
            key={slot.frame.key}
            pointerEvents="none"
            style={[
              styles.frame,
              framePlacement(stageSize, header),
              slot !== displayedSlot ? styles.hidden : null,
            ]}
          >
            <Image
              accessibilityElementsHidden={slot !== displayedSlot}
              accessibilityIgnoresInvertColors
              accessibilityLabel={slot === displayedSlot ? label : undefined}
              fadeDuration={0}
              importantForAccessibility={slot === displayedSlot ? "auto" : "no-hide-descendants"}
              onError={() => failed(slot)}
              onLoad={() => loaded(slot)}
              resizeMode="stretch"
              source={{ uri: slot.frame.uri }}
              style={styles.image}
            />
            {slot === displayedSlot ? <CropCues header={header} /> : null}
          </View>
        );
      })}
      {interactive ? (
        <View
          style={[styles.image, { cursor: pointerCursor }]}
          onPointerMove={(event) => {
            const pointer = event.nativeEvent;
            if (
              !frames.cursor ||
              Platform.OS !== "ios" ||
              pointer.pointerType === "touch" ||
              pointer.buttons !== 0 ||
              touchContacts.current > 0 ||
              !input.current.active ||
              !input.current.inputEnabled ||
              input.current.feedState !== "synchronized"
            )
              return;
            const point = mobileBrowserPoint({
              frame: input.current.displayed?.source ?? null,
              ...size.current,
              x: pointer.offsetX,
              y: pointer.offsetY,
            });
            if (!point) {
              resetCursor();
              return;
            }
            hoverPoint.current = point;
            cursorPointSequence.current = ++cursorSequence.current;
            if (cursorFrame.current !== null) return;
            cursorFrame.current = requestAnimationFrame(() => {
              cursorFrame.current = null;
              const point = hoverPoint.current;
              if (point)
                submitBrowserCommand(hostClient, session.id, {
                  ...point,
                  type: "input.pointer",
                  action: "move",
                  button: "none",
                  cursorSequence: cursorPointSequence.current,
                });
            });
          }}
          onPointerLeave={(event) => {
            const point = hoverPoint.current;
            resetCursor();
            if (
              point &&
              event.nativeEvent.buttons === 0 &&
              touchContacts.current === 0 &&
              input.current.active &&
              input.current.inputEnabled &&
              input.current.feedState === "synchronized"
            )
              submitBrowserCommand(hostClient, session.id, {
                ...point,
                type: "input.pointer",
                action: "leave",
                button: "none",
              });
          }}
          onPointerCancel={() => {
            resetCursor();
            touchGesture.cancel();
          }}
          {...gestures.panHandlers}
        />
      ) : null}
      {contact ? (
        <View
          pointerEvents="none"
          testID="browser-touch-contact"
          style={[styles.contact, { left: contact.x - 12, top: contact.y - 12 }]}
        />
      ) : null}
      {words === null ? null : (
        <View pointerEvents="box-none" style={styles.status}>
          <Text numberOfLines={3} style={styles.label}>
            {words}
          </Text>
          {feedError !== null || presentationError !== null || leaseError !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try again"
              accessibilityHint="Reconnects this page"
              onPress={() => {
                retryPresentation();
                setAttempt((current) => current + 1);
              }}
              style={styles.retry}
            >
              <Text style={styles.retryLabel}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

/**
 * Hands one command to the page and says whether it was taken.
 *
 * The client refuses synchronously, for instance when the feed went away
 * after the view last drew, and an exception that escapes a touch or press
 * handler ends a Release app. A refused gesture is dropped; a refused action
 * is the caller's to report.
 */
export function submitBrowserCommand(
  hostClient: Pick<HostClient, "sendBrowserCommand">,
  sessionId: string,
  command: BrowserCommand,
): boolean {
  try {
    hostClient.sendBrowserCommand(sessionId, command);
    return true;
  } catch {
    return false;
  }
}

/** Fades the edges where a native capture is cut short of the page. */
/** Where a picture sits in the stage, round only at the corners where it floats free. */
function framePlacement(
  stage: { readonly width: number; readonly height: number },
  header: BrowserFrameView["header"],
): ViewStyle | null {
  const box = { ...stage, left: 0, top: 0 };
  const rect = browserFrameContentRect(
    box,
    header.rasterWidth,
    header.rasterHeight,
    header.capture,
    "center",
  );
  if (!rect) return null;
  const [topLeft, topRight, bottomRight, bottomLeft] = browserFrameCornerRadii(box, rect);
  return {
    ...rect,
    borderTopLeftRadius: topLeft,
    borderTopRightRadius: topRight,
    borderBottomRightRadius: bottomRight,
    borderBottomLeftRadius: bottomLeft,
  };
}

function CropCues({ header }: { readonly header: BrowserFrameView["header"] }) {
  const { capture } = header;
  return (
    <>
      {capture && capture.width < header.viewportWidth ? <View style={styles.cropRight} /> : null}
      {capture && capture.height < header.viewportHeight ? (
        <View style={styles.cropBottom} />
      ) : null}
    </>
  );
}

/** What stands in for the picture while there is none. */
function streamLabel(
  sessionState: BrowserSessionSummary["state"],
  feedState: NonNullable<BrowserSessionSummary["watchViewerState"]>,
  feedError: string | null,
): string {
  if (feedError !== null) return feedError;
  if (sessionState === "closing") return "Closing page…";
  if (sessionState === "starting") return "Opening page…";
  return feedState === "synchronized" ? "Loading the page…" : "Connecting…";
}

function useBrowserFrame(
  frames: BrowserFrameStore,
  sessionId: string,
  tabId: string,
  active: boolean,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      active ? frames.subscribe(sessionId, listener, tabId) : () => undefined,
    [active, frames, sessionId, tabId],
  );
  const getSnapshot = useCallback(
    () => (active ? frames.get(sessionId, tabId) : null),
    [active, frames, sessionId, tabId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Targeted channels publish their own readiness, independently of the session's
 * active page. Readers see the same state until something other than the
 * picture changes, so a page does not render again for every delivery.
 */
export function useBrowserFeedState(
  hostClient: Pick<
    HostClient,
    | "browserViewerState"
    | "browserWatchState"
    | "subscribeBrowserViewer"
    | "subscribeBrowserWatch"
    | "browserFrames"
  >,
  sessionId: string,
  tabId: string,
  interactive = true,
): BrowserFeedState {
  const subscribe = useCallback(
    (listener: () => void) =>
      interactive
        ? (hostClient.subscribeBrowserViewer?.(sessionId, tabId, listener) ??
          hostClient.browserFrames.subscribe(sessionId, listener, tabId))
        : hostClient.subscribeBrowserWatch(sessionId, tabId, listener),
    [hostClient, interactive, sessionId, tabId],
  );
  const last = useRef<BrowserFeedState | null>(null);
  const get = useCallback(() => {
    const { frame: _picture, ...state } = interactive
      ? hostClient.browserViewerState(sessionId, tabId)
      : hostClient.browserWatchState(sessionId, tabId);
    const previous = last.current;
    const keys = Object.keys(state) as (keyof BrowserFeedState)[];
    if (
      previous !== null &&
      keys.length === Object.keys(previous).length &&
      keys.every((key) => Object.is(previous[key], state[key]))
    )
      return previous;
    last.current = state;
    return state;
  }, [hostClient, interactive, sessionId, tabId]);
  return useSyncExternalStore(subscribe, get, get);
}

export type BrowserFeedState = Omit<BrowserWatchState, "frame">;

const styles = StyleSheet.create({
  contact: {
    position: "absolute",
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(127,127,127,0.18)",
    borderWidth: 1,
    borderColor: "rgba(127,127,127,0.35)",
  },
  stage: {
    alignItems: "center",
    backgroundColor: color.surfaceCode,
    flex: 1,
    justifyContent: "center",
    minHeight: 0,
    overflow: "hidden",
    position: "relative",
    width: "100%",
  },
  image: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
  frame: {
    position: "absolute",
    overflow: "hidden",
  },
  hidden: { opacity: 0 },
  cropRight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: browserCropCue.size,
    experimental_backgroundImage: browserCropCue.right,
  },
  cropBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: browserCropCue.size,
    experimental_backgroundImage: browserCropCue.bottom,
  },
  status: {
    alignItems: "center",
    bottom: 0,
    gap: space[10],
    justifyContent: "center",
    left: 0,
    paddingHorizontal: space[16],
    position: "absolute",
    right: 0,
    top: 0,
  },
  label: { ...textType.caption, color: color.muted, textAlign: "center" },
  retry: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: space[16],
  },
  retryLabel: { ...textType.secondaryMedium, color: color.text },
});
