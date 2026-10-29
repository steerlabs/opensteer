import {
  canRespondToRequests,
  conversationThreadIds,
  type BrowserSurfaceItem,
  type HostClient,
  type HostSnapshot,
  type ThreadPlace,
} from "@opensteer/client/host";
import { useConversationSurfaces, useHostSelector, useThreadPlace } from "@opensteer/client/react";
import { StackActions, useIsFocused, useNavigation } from "@react-navigation/native";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { ActingDot, agentWorkingLabel } from "../browser/acting-dot.js";
import { BrowserStream } from "../browser/browser-stream.js";
import { surfaceRoute } from "../browser/surface-route.js";
import { tabSiteLabel } from "../browser/tab-tiles.js";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { appear, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { useAppForeground } from "../ui/foreground.js";

/**
 * How long a picture holds before the preview follows an agent to another
 * tab, as the web's viewfinder holds it: long enough to see what changed, so
 * a busy agent does not make the preview flicker. A tab that ends goes at once.
 */
const pictureHoldMs = 2_000;

const selectAssignments = (snapshot: HostSnapshot) => snapshot.assignments;
const selectConnected = (snapshot: HostSnapshot) => canRespondToRequests(snapshot);

/**
 * One compact live tab above the composer: the conversation's tab an agent of
 * it — its own or one it handed work to — acts in now, newest first; else the
 * tab the Host last named for it; else its newest tab. It never moves anything
 * else: a press opens exactly the tab the finger landed on, and "+N" opens the
 * conversation's whole collection.
 *
 * It reads only the conversation's tabs and the Host's latest place, so a
 * streamed token never re-renders it, and it takes a picture only while the
 * conversation is in front, connected and in the foreground.
 */
export const TabPreview = memo(function TabPreview(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const { deploymentId, hostClient, threadId } = props;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const connected = useHostSelector(hostClient, selectConnected);
  const surfaces = useConversationSurfaces(hostClient, threadId);
  const assignments = useHostSelector(hostClient, selectAssignments);
  const threads = useMemo(
    () => conversationThreadIds({ assignments }, threadId),
    [assignments, threadId],
  );
  const latest = useThreadPlace(hostClient, threadId);
  const browsers = useMemo(
    () => surfaces.filter((item): item is BrowserSurfaceItem => item.kind === "browser"),
    [surfaces],
  );
  const wanted = previewTab(browsers, threads, latest);
  const shown = useHeldTab(browsers, wanted);
  const pressedOn = useRef<BrowserSurfaceItem | null>(null);
  if (shown === null) return null;

  const acting = actingIn(shown, threads);
  const others = surfaces.length - 1;
  const site = tabSiteLabel(shown.site);
  const label = [shown.title, site, acting ? agentWorkingLabel.toLowerCase() : null]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
  const open = () => {
    const item = pressedOn.current ?? shown;
    pressedOn.current = null;
    navigation.dispatch(
      StackActions.push(
        "WorkspaceBrowser",
        surfaceRoute(deploymentId, threadId, {
          kind: "browser",
          sessionId: item.session.id,
          tabId: item.tabId,
        }),
      ),
    );
  };
  return (
    <Animated.View entering={appear} exiting={exit} style={styles.row}>
      <Pressable
        accessibilityHint="Opens this tab"
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={open}
        // The tab under the finger as it lands is the one opened, even if the
        // agent moves the preview before it lifts.
        onPressIn={() => {
          pressedOn.current = shown;
        }}
        style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
        testID={`tab-preview:${acting ? "acting" : "idle"}`}
      >
        <View pointerEvents="none" style={[styles.picture, acting ? styles.acting : styles.idle]}>
          <BrowserStream
            active={focused && foreground && connected}
            hostClient={hostClient}
            key={shown.key}
            label={label}
            session={shown.session}
            tabId={shown.tabId}
          />
        </View>
        <View style={styles.words}>
          <View style={styles.line}>
            {acting ? <ActingDot grouped /> : null}
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="secondaryMedium"
              style={styles.shrink}
            >
              {shown.title}
            </AppText>
          </View>
          {site === null ? null : (
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="caption"
              tone="muted"
            >
              {site}
            </AppText>
          )}
        </View>
      </Pressable>
      {others <= 0 ? null : (
        <Pressable
          accessibilityHint="Shows this conversation's tabs and apps"
          accessibilityLabel={others === 1 ? "1 more tab" : `${others} more tabs`}
          accessibilityRole="button"
          onPress={() =>
            navigation.dispatch(StackActions.push("WorkspaceBrowser", { deploymentId, threadId }))
          }
          style={({ pressed }) => [styles.more, pressed && styles.pressed]}
        >
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium" tone="soft">
            {`+${others}`}
          </AppText>
        </Pressable>
      )}
    </Animated.View>
  );
});

/**
 * The tab the preview should show now: where an agent of the conversation
 * acted last, else the Host's latest place when it is one of these tabs, else
 * the newest tab. Never one the conversation does not use.
 */
function previewTab(
  browsers: readonly BrowserSurfaceItem[],
  threads: ReadonlySet<string>,
  latest: ThreadPlace | null,
): BrowserSurfaceItem | null {
  let best: { readonly at: string; readonly item: BrowserSurfaceItem } | null = null;
  for (const item of browsers)
    for (const occupant of occupantsOf(item))
      if (
        occupant.acting &&
        threads.has(occupant.threadId) &&
        (best === null || occupant.lastActiveAt > best.at)
      )
        best = { at: occupant.lastActiveAt, item };
  if (best !== null) return best.item;
  const place = latest?.destination;
  if (place?.kind === "browser") {
    const named = browsers.find(
      (item) => item.session.id === place.sessionId && item.tabId === place.tabId,
    );
    if (named !== undefined) return named;
  }
  return browsers.at(-1) ?? null;
}

function occupantsOf(item: BrowserSurfaceItem) {
  if (item.session.state !== "ready") return [];
  return item.session.tabCatalog?.tabs.find((tab) => tab.id === item.tabId)?.occupants ?? [];
}

function actingIn(item: BrowserSurfaceItem, threads: ReadonlySet<string>): boolean {
  return occupantsOf(item).some((occupant) => occupant.acting && threads.has(occupant.threadId));
}

/**
 * The tab shown, following `wanted` only after it has held for
 * `pictureHoldMs`. A shown tab that is no longer listed gives way at once.
 */
function useHeldTab(
  browsers: readonly BrowserSurfaceItem[],
  wanted: BrowserSurfaceItem | null,
): BrowserSurfaceItem | null {
  const wantedKey = wanted?.key ?? null;
  const [shownKey, setShownKey] = useState<string | null>(wantedKey);
  const pendingSince = useRef<number | null>(null);
  const held = browsers.find((item) => item.key === shownKey) ?? null;
  const present = held !== null;
  useEffect(() => {
    if (wantedKey === shownKey) {
      pendingSince.current = null;
      return;
    }
    if (!present) {
      pendingSince.current = null;
      setShownKey(wantedKey);
      return;
    }
    // Later activity shares the first move's deadline instead of delaying it.
    pendingSince.current ??= Date.now();
    const timer = setTimeout(
      () => {
        pendingSince.current = null;
        setShownKey(wantedKey);
      },
      Math.max(0, pictureHoldMs - (Date.now() - pendingSince.current)),
    );
    return () => clearTimeout(timer);
  }, [present, shownKey, wantedKey]);
  return held ?? wanted;
}

const styles = StyleSheet.create({
  // An agent at work: the same green ring a tile has.
  acting: { borderColor: color.green, borderWidth: 2 },
  idle: { borderColor: color.line, borderWidth: StyleSheet.hairlineWidth },
  line: { alignItems: "center", flexDirection: "row", gap: space[6] },
  more: {
    alignItems: "center",
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
    paddingHorizontal: space[8],
  },
  // A fixed shape, so a new picture never changes the row's height.
  picture: {
    aspectRatio: 4 / 3,
    backgroundColor: color.surfaceCode,
    borderRadius: radius.sm,
    overflow: "hidden",
    width: 64,
  },
  pressed: { opacity: 0.7 },
  row: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[4],
    paddingEnd: space[4],
  },
  shrink: { flexShrink: 1 },
  tab: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    padding: space[6],
  },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
