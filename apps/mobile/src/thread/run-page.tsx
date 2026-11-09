import {
  pageSiteLabel,
  runPageActed,
  runPageFolded,
  runPageSize,
  runPageShown,
  type HostClient,
  type SurfaceDestination,
} from "@opensteer/client/host";
import { useHostSelector, useRunPlace, useRunPlaceBinding } from "@opensteer/client/react";
import type { PlaceEnteredEventView } from "@opensteer/core";
import { placeIdentityKey } from "@opensteer/protocol";
import { useNavigationState } from "@react-navigation/native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, { FadeOutUp } from "react-native-reanimated";
import { agentWorkingLabel } from "../browser/acting-dot.js";
import { paramsDestination, sameDestination } from "../browser/surface-route.js";
import { layoutRoute } from "../navigation-presentations.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { useCellular } from "../ui/cellular.js";
import { useAppForeground } from "../ui/foreground.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { descend, duration, move } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { useLayout } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import {
  ActingRing,
  PlaceGlyph,
  PlaceSurface,
  pictureRadius,
  usePicture,
  useRunPlaceActing,
} from "./live-place.js";
import { useRunPageView } from "./run-page-memory.js";

/** The edge between the page and the conversation, which folds the page. */
const handleHeight = space[20];
/** A page with no picture to show is a row this tall, never a large empty box. */
const rowHeight = 52;
const rowPicture = { height: 30, width: 46 } as const;
/** Before a picture says otherwise, a page is the shape of a desktop browser. */
const desktopAspect = 1.6;
/** How much of the conversation stays in view under the page, at standard text size. */
const keptTranscript = 132;

const selectAuthorized = (snapshot: {
  readonly session: string;
  readonly user: { readonly id: string } | null;
}) => snapshot.session === "authenticated" && snapshot.user !== null;

/**
 * The page a conversation's Run is in, above the conversation and under its
 * bar, while that Run works there. It follows this conversation's Run only.
 *
 * It opens by itself on the agent's first action unless the person is reading
 * back, typing, on cellular or folded it here, and folds by itself when the
 * conversation would have too little room. Folded, the bar carries a small
 * picture of it. It only watches: a tap opens the full tab. The transcript is
 * told how far down it starts, so it scrolls clear of the page.
 */
export const RunPageSlot = memo(function RunPageSlot(props: {
  /** The pane is in front of the person. */
  readonly active: boolean;
  /** Drawn beside a page: only the named row, and only for another place. */
  readonly beside: boolean;
  /** How much of the pane's foot the dock covers. */
  readonly clearance: number;
  readonly hostClient: HostClient;
  readonly onInset: (inset: number) => void;
  readonly onOpen: (destination: SurfaceDestination) => void;
  /** The Run a Stop would reach: the conversation's own. */
  readonly runId: string | null;
  readonly scrolledUp: boolean;
  readonly threadId: string;
  /** What covers the pane's top: the bar, or a floating title beside a page. */
  readonly top: number;
}): ReactNode {
  const { beside, clearance, hostClient, onInset, threadId, top } = props;
  const entry = useRunPlace(hostClient, props.runId);
  const binding = useRunPlaceBinding(hostClient, entry);
  const authorized = useHostSelector(hostClient, selectAuthorized);
  const foreground = useAppForeground();
  const typing = useKeyboardVisible();
  const cellular = useCellular();
  const { fontScale } = useWindowDimensions();
  // As wide as the reading column and its gutters, so it lines up with the words under it.
  const column = useLayout().readingWidth + 2 * space[16];
  const [view, update] = useRunPageView(hostClient, threadId);
  const [size, setSize] = useState({ height: 0, width: 0 });
  const measure = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    setSize((current) =>
      current.height === height && current.width === width ? current : { height, width },
    );
  }, []);
  const placeKey = entry === null ? null : placeIdentityKey(entry.data.place);
  const [aspect, setAspect] = useState<{ readonly key: string | null; readonly value: number }>({
    key: null,
    value: desktopAspect,
  });
  const pageAspect = aspect.key === placeKey ? aspect.value : desktopAspect;
  const onPageSize = useCallback(
    (page: { readonly height: number; readonly width: number }) => {
      if (page.width > 0 && page.height > 0)
        setAspect({ key: placeKey, value: page.width / page.height });
    },
    [placeKey],
  );
  const current = useNavigationState(layoutRoute);
  // Beside a page, the page in front already is the place.
  const inFront =
    beside &&
    current?.name === "WorkspaceBrowser" &&
    binding.destination !== null &&
    sameDestination(paramsDestination(current.params), binding.destination);
  const placeRunId = entry !== null && authorized && !inFront ? entry.runId : null;
  const scrolledUp = props.scrolledUp;

  useEffect(() => {
    if (beside || placeRunId === null) return;
    update((value) => {
      const memory = runPageActed(value.memory, placeRunId, { cellular, scrolledUp, typing });
      return memory === value.memory ? value : { ...value, memory };
    });
  }, [beside, cellular, placeRunId, scrolledUp, typing, update]);

  const page =
    size.height === 0
      ? null
      : runPageSize({
          aspect: pageAspect,
          room: size.height - top - clearance - handleHeight,
          transcript: Math.round(keptTranscript * Math.min(fontScale, 2)),
          width: Math.min(size.width, column),
        });
  const fits = page !== null;
  const shown = beside
    ? placeRunId === null
      ? "none"
      : "open"
    : runPageShown(view.memory, placeRunId, fits);
  useEffect(() => {
    if (beside) return;
    update((value) => ({ ...value, room: fits, runId: placeRunId, shown }));
  }, [beside, fits, placeRunId, shown, update]);
  // Leaving, the bar no longer has a page to stand for.
  useEffect(
    () => () => {
      if (!beside) update((value) => ({ ...value, runId: null, shown: "none" }));
    },
    [beside, update],
  );
  const open = shown === "open" && entry !== null;
  useEffect(() => {
    if (!open) onInset(0);
  }, [onInset, open]);
  const fold = useCallback(
    () => update((value) => ({ ...value, memory: runPageFolded(value.memory) })),
    [update],
  );

  return (
    <View
      onLayout={measure}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
      testID="run-page-slot"
    >
      {open ? (
        <RunPagePanel
          key={placeKey}
          active={props.active && foreground}
          destination={binding.destination}
          entry={entry}
          column={column}
          fullWidth={page !== null && page.width >= size.width}
          hostClient={hostClient}
          onFold={beside ? null : fold}
          onInset={onInset}
          onOpen={props.onOpen}
          onPageSize={onPageSize}
          pageHeight={beside || page === null ? null : page.height}
          pageWidth={page?.width ?? 0}
          sessionId={binding.sessionId}
          threadId={threadId}
          top={top}
        />
      ) : null}
    </View>
  );
});

/**
 * One place's page. Its picture is one view through every form: it grows out
 * of the row's small picture once live, so the stream never starts over.
 */
const RunPagePanel = memo(function RunPagePanel(props: {
  readonly active: boolean;
  readonly destination: SurfaceDestination | null;
  readonly column: number;
  readonly entry: PlaceEnteredEventView;
  readonly fullWidth: boolean;
  readonly hostClient: HostClient;
  readonly onFold: (() => void) | null;
  readonly onInset: (inset: number) => void;
  readonly onOpen: (destination: SurfaceDestination) => void;
  readonly onPageSize: (size: { readonly height: number; readonly width: number }) => void;
  /** The page's height, or null where only the row is drawn. */
  readonly pageHeight: number | null;
  readonly pageWidth: number;
  readonly sessionId: string | null;
  readonly threadId: string;
  readonly top: number;
}): ReactNode {
  const { destination, entry, onFold, onInset, top } = props;
  const [picture, report] = usePicture();
  const acting = useRunPlaceActing(props.hostClient, entry, props.threadId);
  const asPage = props.pageHeight !== null && picture.seen;
  const { title, site } = entry.data;
  const siteLabel = site ? pageSiteLabel(site) : null;
  const corner = asPage ? (props.fullWidth ? 0 : radius.md) : pictureRadius;
  const folding = useMemo(
    () =>
      onFold === null
        ? null
        : PanResponder.create({
            onMoveShouldSetPanResponder: (_event, gesture) =>
              Math.abs(gesture.dy) > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
            onPanResponderRelease: (_event, gesture) => {
              if (gesture.dy < -touchTarget / 2) onFold();
            },
          }),
    [onFold],
  );
  return (
    <Animated.View
      entering={descend}
      exiting={FadeOutUp.duration(duration.exit)}
      onLayout={(event) => onInset(Math.max(0, event.nativeEvent.layout.height - top))}
      style={[styles.panel, { paddingTop: top }]}
      testID="run-page"
    >
      <Pressable
        accessibilityActions={onFold === null ? undefined : [{ name: "fold", label: "Fold page" }]}
        accessibilityHint="Opens the page"
        accessibilityLabel={`${title}${siteLabel && siteLabel !== title ? `, ${siteLabel}` : ""}${acting ? `, ${agentWorkingLabel}` : ""}`}
        accessibilityRole="button"
        disabled={destination === null}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "fold") onFold?.();
        }}
        onPress={() => {
          if (destination) props.onOpen(destination);
        }}
        style={({ pressed }) => [
          asPage ? styles.page : [styles.row, { maxWidth: props.column }],
          pressed && (asPage ? styles.pagePressed : styles.rowPressed),
        ]}
      >
        <Animated.View
          layout={move}
          pointerEvents="none"
          style={[
            styles.picture,
            { borderRadius: corner },
            asPage && props.pageHeight !== null
              ? { height: props.pageHeight, width: props.pageWidth }
              : rowPicture,
          ]}
        >
          <PlaceSurface
            active={props.active}
            destination={destination}
            entry={entry}
            hostClient={props.hostClient}
            onPageSize={props.onPageSize}
            onPicture={report}
            sessionId={props.sessionId}
          />
          {asPage ? (
            picture.state === "live" ? null : (
              <View style={styles.waiting} />
            )
          ) : (
            <PlaceGlyph kind={entry.data.place.kind} size={15} />
          )}
          {acting ? <ActingRing radius={corner} /> : null}
        </Animated.View>
        {asPage ? null : (
          <>
            <View style={styles.words}>
              <AppText numberOfLines={1} role="secondaryMedium">
                {title}
              </AppText>
              {siteLabel && siteLabel !== title ? (
                <AppText numberOfLines={1} role="caption" tone="muted">
                  {siteLabel}
                </AppText>
              ) : null}
            </View>
            <Symbol name="chevron.right" size={12} tint={color.muted} />
          </>
        )}
      </Pressable>
      {onFold === null || folding === null ? null : (
        <View {...folding.panHandlers} style={styles.handle}>
          <Pressable
            accessibilityHint="Keeps a small picture of it in the bar"
            accessibilityLabel="Fold page"
            accessibilityRole="button"
            hitSlop={{ bottom: space[12], left: space[24], right: space[24], top: space[12] }}
            onPress={onFold}
            style={styles.grip}
            testID="run-page-fold"
          >
            <View style={styles.grabber} />
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  // Opaque under the bar too, so nothing scrolling beneath shows above the page.
  panel: {
    backgroundColor: color.background,
    borderBottomColor: color.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  page: { alignSelf: "center" },
  pagePressed: { opacity: 0.85 },
  row: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: space[10],
    minHeight: rowHeight,
    paddingHorizontal: space[16],
    paddingVertical: space[8],
    width: "100%",
  },
  rowPressed: { backgroundColor: color.surfacePressed },
  picture: { backgroundColor: color.surfaceCode, overflow: "hidden" },
  waiting: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(8, 8, 8, 0.45)" },
  words: { flex: 1, gap: space[2], minWidth: 0 },
  handle: { alignItems: "center", height: handleHeight, justifyContent: "center" },
  grip: { alignItems: "center", height: handleHeight, justifyContent: "center", width: 64 },
  grabber: {
    backgroundColor: color.lineHover,
    borderRadius: radius.full,
    height: 5,
    width: 36,
  },
});
