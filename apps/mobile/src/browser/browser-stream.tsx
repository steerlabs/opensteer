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
  /** True only while this viewer is focused, visible, and in the foreground. */
  readonly active: boolean;
  readonly hostClient: Pick<
    HostClient,
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
  readonly tabId: string;
  /** What the picture shows, in the page's own words: its title and site. */
  readonly label: string;
  /** The page's own size, as each new picture reports it, so a preview takes its shape. */
  readonly onPageSize?: (size: { readonly height: number; readonly width: number }) => void;
  readonly onPointerDown?: () => void;
  /** The person tapped the page: a field may now have focus. */
  readonly onTap?: () => void;
  /** The person scrolled the page. */
  readonly onScroll?: () => void;
  readonly session: BrowserSessionSummary;
  readonly style?: StyleProp<ViewStyle>;
}

interface FrameSlot {
  readonly frame: MobileBrowserFrame;
  /** The feed's delivery, whose token says the view is done with it. */
  readonly source: BrowserFrameView;
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
export function BrowserStream({
  active,
  hostClient,
  label,
  onPageSize,
  onScroll,
  onTap,
  onPointerDown,
  session,
  style,
  interactive = false,
  inputEnabled = true,
  tabId,
}: BrowserStreamProps) {
  // Asking again takes the feed anew: a fresh subscription, fresh pictures.
  const [attempt, setAttempt] = useState(0);
  const ready = session.state === "ready";
  const frames = interactive ? hostClient.browserFrames : hostClient.browserWatchFrames;
  // Fixed for the binary's lifetime, so one presenter owns this view's receipts.
  const [Picture] = useState(nativePictureView);
  const native = Picture !== null;
  const received = useBrowserFrame(frames, session.id, tabId, active && !native);
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

  useEffect(
    () =>
      active
        ? interactive
          ? hostClient.retainBrowserViewer(session.id, tabId, {
              captureRegion: true,
              rasterDemand: true,
              frameWindow: native,
            })
          : hostClient.retainBrowserWatch(session.id, tabId, {
              captureRegion: true,
              rasterDemand: true,
              frameWindow: native,
            })
        : undefined,
    [active, attempt, hostClient, interactive, native, session.id, tabId],
  );

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
    visible: active && ready,
    frames,
    sessionId: session.id,
    tabId,
    settle: finish,
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
      if (decoding) finish(decoding.source);
    },
    [finish, frames, native, session.id, tabId],
  );

  // A layout effect, so pixels are gone before the next paint; they are also
  // hidden in render below.
  useLayoutEffect(() => {
    if (native) return;
    if (!active || !ready || frame === null) {
      const decoding = slotsRef.current.decoding;
      if (decoding) finish(decoding.source);
      const discarded = received ?? frames.get(session.id, tabId);
      if (discarded) finish(discarded);
      setSlots(emptySlots);
      return;
    }
    // Another tab's picture never stands in for the one now in front.
    const decoding = slotsRef.current.decoding;
    if (decoding && decoding.source.header.surfaceId !== frame.header.surfaceId)
      finish(decoding.source);
    setSlots((current) => ({
      decoding:
        current.decoding?.source.header.surfaceId === frame.header.surfaceId
          ? current.decoding
          : null,
      displayed:
        current.displayed?.source.header.surfaceId === frame.header.surfaceId
          ? current.displayed
          : null,
    }));
  }, [active, finish, frame, frames, native, ready, received, session.id, tabId]);

  // Only convert when the native decoder slot is free. With one picture in
  // flight at a time, the feed's value once the slot frees is the latest.
  const decodingBusy = slots.decoding !== null;
  useEffect(() => {
    if (native || !active || !ready || frame === null || decodingBusy) return;
    const next = nextMobileBrowserDecode({
      active,
      activeSurfaceId: frame.header.surfaceId,
      frame,
      inFlightFrameKey: null,
      settledFrameKey: settledKey.current,
    });
    if (next !== null) {
      setSlots((current) => ({ ...current, decoding: { frame: next, source: frame } }));
    } else if (mobileBrowserFrameKey(frame) !== settledKey.current) {
      // Too large to convert here: dropped, so the feed can move on.
      finish(frame);
    }
  }, [active, decodingBusy, finish, frame, native, ready]);

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
    finish(slot.source);
  };
  const failed = (slot: FrameSlot) => {
    if (slotsRef.current.decoding !== slot) return;
    setSlots((previous) => ({ ...previous, decoding: null }));
    finish(slot.source);
  };

  // Hidden in the render that loses the feed's picture, not an effect later.
  const visible = active && ready && frame !== null;
  const displayedSlot = visible && !native ? slots.displayed : null;
  const displayed: { readonly source: BrowserFrameView } | null = native
    ? picture.drawn && { source: picture.drawn }
    : displayedSlot;
  const decoding = visible && !native ? slots.decoding : null;
  const size = useRef({ width: 0, height: 0 });
  const origin = useRef({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState(size.current);
  const rasterDemand = useRef<BrowserRasterDemand | null>(null);
  const drawnHeader = displayed?.source.header;
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
    interactive,
    inputEnabled,
    displayed,
    frame,
    feedState,
    onScroll,
    onTap,
    onPointerDown,
  });
  input.current = {
    active,
    interactive,
    inputEnabled,
    displayed,
    frame,
    feedState,
    onScroll,
    onTap,
    onPointerDown,
  };
  // The touch under the finger, aimed at the picture as it was drawn when it
  // began. A resize — a fold, a window narrowing, a pane appearing beside this
  // one — redraws the picture somewhere else, so the touch is dropped there.
  const held = useRef<{
    point: NonNullable<ReturnType<typeof mobileBrowserPoint>>;
    dx: number;
    dy: number;
    moved: boolean;
    scale: number;
  } | null>(null);
  // The surface rearranging around the stage moves it on screen even where
  // its own frame is unchanged.
  const geometry = usePaneGeometry();
  const drawnGeometry = displayed ? browserPictureFence(displayed.source) : null;
  useLayoutEffect(() => {
    held.current = null;
  }, [
    geometry,
    drawnGeometry,
    active,
    inputEnabled,
    interactive,
    feed.admissionId,
    feedState,
    session.id,
    tabId,
  ]);
  const gestures = useMemo(() => {
    const send = (command: BrowserCommand) => submitBrowserCommand(hostClient, session.id, command);
    const usable = () => {
      const current = input.current;
      return (
        current.active &&
        current.interactive &&
        current.inputEnabled &&
        current.feedState === "synchronized" &&
        current.displayed !== null &&
        current.frame?.header.surfaceId === current.displayed.source.header.surfaceId
      );
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: usable,
      onMoveShouldSetPanResponder: usable,
      onPanResponderStart: (event) => {
        if (event.nativeEvent.touches.length > 1) held.current = null;
      },
      onPanResponderGrant: (event) => {
        if (event.nativeEvent.touches?.length > 1) {
          held.current = null;
          return;
        }
        const current = input.current;
        const source = usable() ? (current.displayed?.source ?? null) : null;
        const point = mobileBrowserPoint({
          frame: source,
          ...size.current,
          x: event.nativeEvent.locationX,
          y: event.nativeEvent.locationY,
        });
        if (point && source) current.onPointerDown?.();
        held.current =
          point && source
            ? {
                point,
                dx: 0,
                dy: 0,
                moved: false,
                scale:
                  (source.header.capture?.height ?? source.header.viewportHeight) /
                  (browserFrameContentRect(
                    { ...size.current, left: 0, top: 0 },
                    source.header.rasterWidth,
                    source.header.rasterHeight,
                    source.header.capture,
                    "center",
                  )?.height ?? 1),
              }
            : null;
      },
      onPanResponderMove: (event, state) => {
        if (event.nativeEvent.touches?.length > 1) {
          held.current = null;
          return;
        }
        const gesture = held.current;
        if (
          !gesture ||
          !usable() ||
          input.current.frame?.header.surfaceId !== gesture.point.surfaceId
        )
          return;
        if (!gesture.moved && Math.abs(state.dx) + Math.abs(state.dy) > 6) {
          gesture.moved = true;
          input.current.onScroll?.();
        }
        if (!gesture.moved) return;
        const scrolled = send({
          type: "input.wheel",
          ...gesture.point,
          deltaX: Math.max(-100000, Math.min(100000, -(state.dx - gesture.dx) * gesture.scale)),
          deltaY: Math.max(-100000, Math.min(100000, -(state.dy - gesture.dy) * gesture.scale)),
        });
        // A refused scroll ends the drag rather than replaying it on reconnection.
        if (!scrolled) {
          held.current = null;
          return;
        }
        gesture.dx = state.dx;
        gesture.dy = state.dy;
      },
      onPanResponderRelease: () => {
        const tap = held.current;
        held.current = null;
        if (
          !tap ||
          tap.moved ||
          !usable() ||
          input.current.frame?.header.surfaceId !== tap.point.surfaceId
        )
          return;
        const click = {
          type: "input.pointer",
          ...tap.point,
          button: "left",
          clickCount: 1,
        } as const;
        if (!send({ ...click, action: "down" })) return;
        // A press the page took but whose release it refused must not stay held.
        if (send({ ...click, action: "up" })) input.current.onTap?.();
        else send({ type: "input.cancel", surfaceId: tap.point.surfaceId });
      },
      onPanResponderTerminate: () => {
        held.current = null;
      },
    });
  }, [hostClient, session.id]);
  const shownWidth =
    displayed?.source.header.capture?.width ?? displayed?.source.header.viewportWidth ?? null;
  const shownHeight =
    displayed?.source.header.capture?.height ?? displayed?.source.header.viewportHeight ?? null;
  useEffect(() => {
    if (shownWidth !== null && shownHeight !== null)
      onPageSize?.({ height: shownHeight, width: shownWidth });
  }, [onPageSize, shownHeight, shownWidth]);
  if (!active) return null;
  const words = displayed === null ? streamLabel(session.state, feedState, feedError) : null;

  return (
    <View
      accessibilityLabel={label}
      accessibilityHint={interactive ? "Tap to click. Drag to scroll the page." : undefined}
      onLayout={(event) => {
        const { height, width, x, y } = event.nativeEvent.layout;
        if (
          size.current.width !== width ||
          size.current.height !== height ||
          origin.current.x !== x ||
          origin.current.y !== y
        )
          held.current = null;
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
          key={`${session.id}:${tabId}`}
          pointerEvents="none"
          style={[styles.image, { opacity: active && ready && picture.present ? 1 : 0 }]}
        >
          <Picture
            accessibilityElementsHidden={displayed === null}
            accessibilityIgnoresInvertColors
            accessibilityLabel={displayed === null ? undefined : label}
            importantForAccessibility={displayed === null ? "no-hide-descendants" : "auto"}
            onCleared={picture.cleared}
            ref={picture.view}
            style={styles.image}
          />
          {displayed?.source.header.capture ? (
            <View
              pointerEvents="none"
              style={[
                styles.frame,
                styles.nativeFrame,
                browserFrameContentRect(
                  { ...stageSize, left: 0, top: 0 },
                  displayed.source.header.rasterWidth,
                  displayed.source.header.rasterHeight,
                  displayed.source.header.capture,
                  "center",
                ),
              ]}
            >
              <CropCues header={displayed.source.header} />
            </View>
          ) : null}
        </View>
      )}
      {/* One list, so the picture that finishes decoding stays mounted as it is shown. */}
      {[displayedSlot, decoding].map((slot) => {
        if (!slot) return null;
        const { header } = slot.source;
        const rect = browserFrameContentRect(
          { ...stageSize, left: 0, top: 0 },
          header.rasterWidth,
          header.rasterHeight,
          header.capture,
          "center",
        );
        return (
          <View
            key={slot.frame.key}
            pointerEvents="none"
            style={[
              styles.frame,
              rect,
              header.capture ? styles.nativeFrame : null,
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
      {interactive ? <View style={styles.image} {...gestures.panHandlers} /> : null}
      {words === null ? null : (
        <View pointerEvents="box-none" style={styles.status}>
          <Text numberOfLines={3} style={styles.label}>
            {words}
          </Text>
          {feedError !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try again"
              accessibilityHint="Reconnects this page"
              onPress={() => setAttempt((current) => current + 1)}
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
  nativeFrame: { borderRadius: browserCropCue.radius },
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
