import {
  pageSiteLabel,
  runPageHandleHeight,
  runPageKeptTranscript,
  runPageRowHeight,
  type HostClient,
  type RunPlacePicture,
  type TabDestination,
} from "@opensteer/client/host";
import {
  useHostSelector,
  useRunPage,
  useRunPlaceView,
  type RunPlaceView,
  useRunPlacePicture,
} from "@opensteer/client/react";
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
import { paramsTabId } from "../browser/surface-route.js";
import { layoutRoute } from "../navigation-presentations.js";
import { color, pillHeight, radius, space, touchTarget } from "../theme.js";
import { useCellular } from "../ui/cellular.js";
import { useAppForeground } from "../ui/foreground.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { descend, duration, move } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { useLayout } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import {
  ActingRing,
  displayCapable,
  PictureCover,
  PlaceSurface,
  pictureRadius,
  pictureWords,
  usePainted,
} from "./live-place.js";

/** The row's picture: a pill's height, at about a desktop page's shape. */
const rowPicture = { height: pillHeight, width: 48 } as const;

const selectAuthorized = (snapshot: {
  readonly session: string;
  readonly user: { readonly id: string } | null;
}) => snapshot.session === "authenticated" && snapshot.user !== null;

interface SlotProps {
  /** The pane is in front of the person. */
  readonly active: boolean;
  /** Drawn beside a page: only the named row, and only for another place. */
  readonly beside: boolean;
  /** How much of the pane's foot the dock covers. */
  readonly clearance: number;
  readonly hostClient: HostClient;
  readonly onInset: (inset: number) => void;
  readonly onOpen: (destination: TabDestination) => void;
  /** The Run a Stop would reach: the conversation's own. */
  readonly runId: string | null;
  readonly scrolledUp: boolean;
  readonly threadId: string;
  /** What covers the pane's top: the bar, or a floating title beside a page. */
  readonly top: number;
  /**
   * A field in the conversation itself holds the keyboard, such as a waiting
   * message open in place: the page folds as it does when there is no room.
   */
  readonly yielding?: boolean;
}

/**
 * The page a conversation's Run is in, above the conversation and under its
 * bar, while that Run works there. It follows this conversation's Run only.
 *
 * Whether it shows, and how large, is the shared Run page's to say; this
 * draws it. Folded, the bar carries a small picture of it. It only watches: a
 * tap opens the full tab. The transcript is told how far down it starts, so
 * it scrolls clear of the page.
 */
export const RunPageSlot = memo(function RunPageSlot(props: SlotProps): ReactNode {
  const [size, setSize] = useState({ height: 0, width: 0 });
  const measure = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    setSize((current) =>
      current.height === height && current.width === width ? current : { height, width },
    );
  }, []);
  return (
    <View
      onLayout={measure}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
      testID="run-page-slot"
    >
      {props.beside ? <BesideRow {...props} /> : <PanePage {...props} size={size} />}
    </View>
  );
});

function PanePage(
  props: SlotProps & { readonly size: { readonly height: number; readonly width: number } },
): ReactNode {
  const { clearance, hostClient, onInset, size, threadId, top } = props;
  const authorized = useHostSelector(hostClient, selectAuthorized);
  const foreground = useAppForeground();
  const keyboard = useKeyboardVisible();
  const cellular = useCellular();
  const { fontScale } = useWindowDimensions();
  // As wide as the reading column and its gutters, so it lines up with the words under it.
  const column = useLayout().readingWidth + 2 * space[16];
  const yielding = props.yielding === true;
  const runId = authorized ? props.runId : null;
  const { acting, place } = useRunPlaceView(hostClient, runId, threadId);
  const run = useRunPage({
    hostClient,
    threadId,
    runId,
    paneVisible: props.active,
    displayCapable: displayCapable(place),
    visible: props.active && foreground,
    typing: keyboard || yielding,
    scrolledUp: props.scrolledUp,
    cellular,
    room:
      size.height === 0 || yielding
        ? null
        : {
            height: size.height - top - clearance - runPageHandleHeight,
            width: Math.min(size.width, column),
          },
    headHasRoom: true,
    transcript: Math.round(runPageKeptTranscript * Math.min(fontScale, 2)),
  });
  const { page, shown } = run;
  const open = (shown === "page" || shown === "row") && place !== null;
  useEffect(() => {
    if (!open) onInset(0);
  }, [onInset, open]);
  if (!open) return null;
  // The size is whole points; Android lays out in fractions, so a page as wide as the pane
  // falls short of it by less than one.
  const fullWidth = page !== null && page.width >= Math.floor(size.width);
  return (
    <RunPagePanel
      key={place.placeKey}
      active={props.active && foreground}
      column={column}
      acting={acting}
      place={place}
      hostClient={hostClient}
      onFold={run.fold}
      onInset={onInset}
      onOpen={props.onOpen}
      page={
        shown === "page" && page !== null
          ? { fullWidth, height: page.height, width: fullWidth ? size.width : page.width }
          : null
      }
      picture={run.picture}
      threadId={threadId}
      top={top}
    />
  );
}

/**
 * Beside a page there is no bar to fold into and the page in front is the
 * subject: another place the Run is in is only named, never opened above.
 */
function BesideRow(props: SlotProps): ReactNode {
  const { hostClient, onInset, threadId } = props;
  const { acting, entry, place } = useRunPlaceView(hostClient, props.runId, threadId);
  const authorized = useHostSelector(hostClient, selectAuthorized);
  const foreground = useAppForeground();
  const column = useLayout().readingWidth + 2 * space[16];
  const current = useNavigationState(layoutRoute);
  const inFront =
    current?.name === "WorkspaceBrowser" &&
    place !== null &&
    paramsTabId(current.params) === place.placeKey;
  const shown = place !== null && authorized && !inFront;
  // Nothing else in this pane shows the place, so the row holds its picture itself.
  const picture = useRunPlacePicture(
    hostClient,
    threadId,
    entry?.runId ?? null,
    shown && props.active,
    displayCapable(place),
  );
  useEffect(() => {
    if (!shown) onInset(0);
  }, [onInset, shown]);
  if (!shown) return null;
  return (
    <RunPagePanel
      key={place.placeKey}
      active={props.active && foreground}
      column={column}
      acting={acting}
      place={place}
      hostClient={hostClient}
      onFold={null}
      onInset={onInset}
      onOpen={props.onOpen}
      page={null}
      picture={picture}
      threadId={threadId}
      top={props.top}
    />
  );
}

/**
 * One place's page. Its picture is one view through the row and the page: it
 * grows out of the row's small picture, so nothing draws it over again.
 */
const RunPagePanel = memo(function RunPagePanel(props: {
  readonly active: boolean;
  readonly column: number;
  readonly acting: boolean;
  readonly place: RunPlaceView;
  readonly hostClient: HostClient;
  readonly onFold: (() => void) | null;
  readonly onInset: (inset: number) => void;
  readonly onOpen: (destination: TabDestination) => void;
  /** The page's size, or null where only the row is drawn. */
  readonly page: {
    readonly fullWidth: boolean;
    readonly height: number;
    readonly width: number;
  } | null;
  readonly picture: RunPlacePicture;
  readonly threadId: string;
  readonly top: number;
}): ReactNode {
  const { acting, place, onFold, onInset, page, picture, top } = props;
  const { destination, title, site } = place;
  const [painted, setPainted] = usePainted(place);
  const siteLabel = site ? pageSiteLabel(site) : null;
  const corner = page === null ? pictureRadius : page.fullWidth ? 0 : radius.md;
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
        accessibilityLabel={`${title}${siteLabel && siteLabel !== title ? `, ${siteLabel}` : ""}${acting ? `, ${agentWorkingLabel}` : ""}${pictureWords(picture)}`}
        accessibilityRole="button"
        disabled={destination === null}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "fold") onFold?.();
        }}
        onPress={() => {
          if (destination) props.onOpen(destination);
        }}
        style={({ pressed }) => [
          page === null ? [styles.row, { maxWidth: props.column }] : styles.page,
          pressed && (page === null ? styles.rowPressed : styles.pagePressed),
        ]}
      >
        <Animated.View
          layout={move}
          pointerEvents="none"
          style={[
            styles.picture,
            { borderRadius: corner },
            page === null ? rowPicture : { height: page.height, width: page.width },
          ]}
          testID="run-page-picture"
        >
          <PlaceSurface
            active={props.active}
            place={place}
            hostClient={props.hostClient}
            onPainted={setPainted}
            threadId={props.threadId}
          />
          <PictureCover
            place={place}
            glyph={page === null ? 15 : null}
            painted={painted}
            picture={picture}
          />
          {acting ? <ActingRing radius={corner} /> : null}
        </Animated.View>
        {page === null ? (
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
        ) : null}
      </Pressable>
      {onFold === null || folding === null ? null : (
        <View {...folding.panHandlers} style={styles.handle}>
          <Pressable
            accessibilityHint="Keeps a small picture of it in the bar"
            accessibilityLabel="Fold page"
            accessibilityRole="button"
            // The handle is a slim edge; its target reaches the touch minimum.
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
  // Its picture, words and chevron sit on the transcript's own gutters.
  row: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: runPageRowHeight,
    paddingHorizontal: space[16],
    paddingVertical: space[8],
    width: "100%",
  },
  rowPressed: { backgroundColor: color.surfacePressed },
  picture: { backgroundColor: color.surfaceCode, overflow: "hidden" },
  words: { flex: 1, gap: space[2], minWidth: 0 },
  handle: { alignItems: "center", height: runPageHandleHeight, justifyContent: "center" },
  grip: { alignItems: "center", height: runPageHandleHeight, justifyContent: "center", width: 64 },
  grabber: {
    backgroundColor: color.lineHover,
    borderRadius: radius.full,
    height: 5,
    width: 36,
  },
});
