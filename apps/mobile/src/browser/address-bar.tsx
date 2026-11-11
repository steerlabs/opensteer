import type { TaskMark as TaskMarkValue } from "@opensteer/client/host";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import type { ComputerSymbol } from "../screens/settings-model.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { AgentOrb } from "../team/team-marks.js";
import { appear, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { ToolbarCapsule } from "./toolbar.js";

/** How far the address is dragged before letting go moves to the next tab. */
const switchDistance = 56;

/**
 * The page itself, in the bar: where the page is wide, the way back through its
 * history, then its address as Safari's bar shows it, the site alone with its
 * icon. Tapping the site edits the address; dragging it sideways moves to the
 * browser's next or previous tab, as Safari's does. A line along its bottom
 * edge says what is happening in the page: the page loading, or an agent
 * acting in it.
 *
 * While the page keeps up with an agent's tab, a green ring and the agent's
 * mark say so: the one sign that this is what the agent sees. A page that runs
 * on another device ends with that device's shape, which names it when tapped;
 * the site keeps every other point.
 */
export const AddressCapsule = memo(function AddressCapsule(props: {
  readonly acting: boolean;
  /** Given where the page's history has room beside the address; otherwise it is in the page's menu. */
  readonly back: { readonly enabled: boolean; readonly onPress: () => void } | null;
  /** Arrived here from another tab, so the address fades in as the page does. */
  readonly arriving?: boolean;
  /** The device the page runs on, where that is not this one; tapping it names it. */
  readonly device?: PageDevice | null;
  /** Keeping up with this Thread's agent: its task mark, or null for Chat's orb. */
  readonly following?: { readonly mark: TaskMarkValue | null } | null;
  readonly favicon: string | null;
  /** Given where Forward has room beside Back; otherwise it is in the page's menu. */
  readonly forward: { readonly enabled: boolean; readonly onPress: () => void } | null;
  readonly loading: boolean;
  readonly onEdit: () => void;
  /** Given while there is a tab that way to move to. */
  readonly onSwitch: ((direction: -1 | 1) => void) | null;
  readonly secure: boolean;
  readonly site: string | null;
}): ReactNode {
  const latest = useRef(props.onSwitch);
  latest.current = props.onSwitch;
  const switchTab = useCallback((direction: -1 | 1) => latest.current?.(direction), []);
  const canSwitch = props.onSwitch !== null;
  const drag = useSharedValue(0);
  const swipe = usePanGesture({
    activeOffsetX: [-12, 12],
    enabled: canSwitch,
    failOffsetY: [-10, 10],
    onDeactivate: (event) => {
      "worklet";
      if (Math.abs(event.translationX) > switchDistance)
        scheduleOnRN(switchTab, event.translationX < 0 ? 1 : -1);
      drag.value = withSpring(0, { damping: 22, stiffness: 260 });
    },
    onUpdate: (event) => {
      "worklet";
      // Resisted, so the address follows the finger but never leaves the bar.
      drag.value = event.translationX * 0.55;
    },
  });
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: drag.value }] }));
  const reduceMotion = useReducedMotion();
  const site = props.site ?? "Search or enter address";
  const following = props.following ?? null;
  const device = props.device ?? null;
  const address = props.site === null ? "Address" : `Address, ${props.site}`;
  const fade = reduceMotion ? {} : { entering: appear, exiting: exit };
  const glyph = following ? (
    following.mark === null ? (
      <AgentOrb size={16} />
    ) : (
      <TaskMark mark={following.mark} size={16} />
    )
  ) : props.favicon !== null ? (
    <Image
      accessibilityIgnoresInvertColors
      source={{ uri: props.favicon }}
      style={styles.favicon}
    />
  ) : props.secure ? (
    <Symbol name="lock" size={12} tint={color.muted} weight="semibold" />
  ) : null;
  return (
    <GestureDetector gesture={swipe}>
      <View style={styles.slot}>
        <ToolbarCapsule>
          {props.back === null ? null : (
            <PageHistoryButton
              enabled={props.back.enabled}
              label="Previous page"
              onPress={props.back.onPress}
              symbol="chevron.left"
            />
          )}
          {props.forward === null ? null : (
            <PageHistoryButton
              enabled={props.forward.enabled}
              label="Next page"
              onPress={props.forward.onPress}
              symbol="chevron.right"
            />
          )}
          <Pressable
            accessibilityHint={
              canSwitch
                ? "Edits the address. Swipe sideways for the next tab."
                : "Edits the address"
            }
            accessibilityLabel={following === null ? address : `${address}. Following the agent`}
            accessibilityRole="button"
            onPress={props.onEdit}
            style={({ pressed }) => [
              styles.address,
              props.back === null && styles.addressLeading,
              device !== null && styles.addressBeforeDevice,
              pressed && styles.pressed,
            ]}
          >
            <Animated.View
              {...(props.arriving === true && !reduceMotion ? { entering: arrive } : {})}
              style={[styles.site, moved]}
            >
              {/* Following fades the agent's mark in over the site's, and back; a page draws its own at once. */}
              <LayoutAnimationConfig skipEntering>
                {glyph === null ? null : (
                  <Animated.View key={following ? "agent" : "site"} {...fade}>
                    {glyph}
                  </Animated.View>
                )}
              </LayoutAnimationConfig>
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="secondaryMedium"
                style={styles.siteText}
                tone={props.site === null ? "muted" : "default"}
              >
                {site}
              </AppText>
            </Animated.View>
          </Pressable>
          {device === null ? null : <DeviceGlyph device={device} />}
          <LayoutAnimationConfig skipEntering>
            {following === null ? null : (
              <Animated.View {...fade} pointerEvents="none" style={styles.ring} />
            )}
          </LayoutAnimationConfig>
          {props.loading ? (
            <ActivityLine tone="loading" />
          ) : props.acting ? (
            <ActivityLine tone="acting" />
          ) : null}
        </ToolbarCapsule>
      </View>
    </GestureDetector>
  );
});

const arrive = FadeIn.duration(180);

/** Where a page runs, when that is another device than the one in the person's hand. */
export interface PageDevice {
  readonly glyph: ComputerSymbol;
  readonly name: string;
  readonly online: boolean;
  /** That device's own page. */
  readonly onOpen: () => void;
}

/**
 * The device's shape alone, at the address's far end: the capsule has no room
 * for its name, so the name, and whether the device is offline, are what
 * tapping it says, with the way to that device's page.
 */
function DeviceGlyph(props: { readonly device: PageDevice }): ReactNode {
  const { glyph, name, online, onOpen } = props.device;
  const where = online ? name : `${name} · Offline`;
  return (
    <NativeMenu
      accessibilityHint="Shows the device this tab runs on"
      accessibilityLabel={`Runs on ${where}`}
      options={[{ icon: glyph, id: "device", label: where, onPress: onOpen }]}
      style={styles.device}
      title="This tab runs on"
      triggerStyle={styles.deviceFace}
    >
      <Symbol name={glyph} size={15} tint={online ? color.muted : color.amber} weight="medium" />
    </NativeMenu>
  );
}

function PageHistoryButton(props: {
  readonly enabled: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly symbol: "chevron.left" | "chevron.right";
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !props.enabled }}
      disabled={!props.enabled}
      hitSlop={{ left: space[8] }}
      onPress={props.onPress}
      style={({ pressed }) => [styles.history, pressed && styles.pressed]}
    >
      <Symbol
        name={props.symbol}
        size={16}
        tint={props.enabled ? color.text : color.mutedDim}
        weight="semibold"
      />
    </Pressable>
  );
}

/**
 * A short light running along the capsule's bottom edge: blue while the page
 * loads, as Safari's does, green while an agent acts in it. Under Reduce
 * Motion it holds still across the edge, which still says the same thing.
 */
function ActivityLine(props: { readonly tone: "acting" | "loading" }): ReactNode {
  const reduceMotion = useReducedMotion();
  const [track, setTrack] = useState(0);
  const run = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    run.value = 0;
    run.value = withRepeat(
      withTiming(1, {
        duration: props.tone === "loading" ? 1100 : 1800,
        easing: Easing.inOut(Easing.quad),
      }),
      -1,
    );
    return () => cancelAnimation(run);
  }, [props.tone, reduceMotion, run]);
  const width = track * 0.38;
  const light = useAnimatedStyle(() => ({
    transform: [{ translateX: -width + run.value * (track + width) }],
  }));
  const tint = props.tone === "loading" ? color.blue : color.green;
  return (
    <View
      onLayout={(event) => setTrack(event.nativeEvent.layout.width)}
      pointerEvents="none"
      style={styles.track}
    >
      {reduceMotion ? (
        <View style={[styles.light, { backgroundColor: tint, opacity: 0.6, width: "100%" }]} />
      ) : (
        <Animated.View style={[styles.light, { backgroundColor: tint, width }, light]} />
      )}
    </View>
  );
}

/** A tab this browser already has open, offered before going anywhere new. */
export interface OpenTabSuggestion {
  readonly favicon: string | null;
  readonly id: string;
  readonly site: string | null;
  readonly title: string;
}

/**
 * Editing the address, as Safari does: the field takes the bar's place above
 * the keyboard, and what is already open in this browser is offered over it,
 * so a page the agent has open is switched to rather than opened twice.
 */
export function AddressEditor(props: {
  readonly draft: string;
  readonly editable: boolean;
  readonly onCancel: () => void;
  readonly onChange: (text: string) => void;
  readonly onGo: () => void;
  readonly onSwitch: (tabId: string) => void;
  readonly tabs: readonly OpenTabSuggestion[];
  /** The field is over the page, so what is open is offered under it. */
  readonly under?: boolean;
}): ReactNode {
  const { fontScale } = useWindowDimensions();
  const query = props.draft.trim().toLowerCase();
  const matches = (
    query === ""
      ? props.tabs
      : props.tabs.filter(
          ({ site, title }) =>
            title.toLowerCase().includes(query) || (site?.toLowerCase().includes(query) ?? false),
        )
  ).slice(0, fontScale > 1.3 ? 2 : 4);
  const suggestions =
    matches.length === 0 ? null : (
      <View accessibilityLabel="Tabs in this browser" style={styles.suggestions}>
        {matches.map((tab) => (
          <Pressable
            accessibilityHint="Switches to this tab"
            accessibilityLabel={[tab.title, tab.site].filter(Boolean).join(", ")}
            accessibilityRole="button"
            key={tab.id}
            onPress={() => props.onSwitch(tab.id)}
            style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
          >
            {tab.favicon === null ? (
              <View style={styles.suggestionIcon}>
                <Symbol name="globe" size={15} tint={color.textSoft} />
              </View>
            ) : (
              <Image
                accessibilityIgnoresInvertColors
                source={{ uri: tab.favicon }}
                style={styles.suggestionIcon}
              />
            )}
            <View style={styles.suggestionWords}>
              <AppText numberOfLines={1} role="secondaryMedium">
                {tab.title}
              </AppText>
              <AppText numberOfLines={1} role="caption" tone="muted">
                {tab.site === null ? "Switch to tab" : `Switch to tab · ${tab.site}`}
              </AppText>
            </View>
            <Symbol name="square.on.square" size={15} tint={color.muted} />
          </Pressable>
        ))}
      </View>
    );
  const field = (
    <View style={styles.editRow}>
      <ToolbarCapsule style={styles.grow}>
        <View style={styles.searchGlyph}>
          <Symbol name="magnifyingglass" size={15} tint={color.muted} weight="medium" />
        </View>
        <TextInput
          accessibilityHint="Enter an address or search the web"
          accessibilityLabel="Website address"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          clearButtonMode="while-editing"
          editable={props.editable}
          enterKeyHint="go"
          keyboardAppearance="dark"
          keyboardType="web-search"
          maxFontSizeMultiplier={controlFontScaleLimit}
          onChangeText={props.onChange}
          onSubmitEditing={props.onGo}
          placeholder="Search or enter address"
          placeholderTextColor={color.muted}
          returnKeyType="go"
          selectTextOnFocus
          selectionColor={color.ember}
          style={styles.input}
          value={props.draft}
        />
      </ToolbarCapsule>
      <Pressable
        accessibilityHint="Keeps the current page address"
        accessibilityLabel="Cancel"
        accessibilityRole="button"
        hitSlop={space[6]}
        onPress={props.onCancel}
        style={styles.cancel}
      >
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium" tone="ember">
          Cancel
        </AppText>
      </Pressable>
    </View>
  );
  return (
    <View style={styles.editor}>
      {props.under === true ? field : suggestions}
      {props.under === true ? suggestions : field}
    </View>
  );
}

const styles = StyleSheet.create({
  address: {
    alignItems: "center",
    alignSelf: "stretch",
    flex: 1,
    justifyContent: "center",
    minWidth: 0,
    paddingEnd: space[8],
  },
  addressBeforeDevice: { paddingEnd: 0 },
  addressLeading: { paddingStart: space[14] },
  cancel: { justifyContent: "center", minHeight: touchTarget, paddingHorizontal: space[4] },
  device: { alignSelf: "stretch" },
  deviceFace: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    paddingEnd: space[14],
    paddingStart: space[8],
  },
  editRow: { alignItems: "center", flexDirection: "row", gap: space[8] },
  editor: {
    gap: space[8],
    paddingBottom: space[4],
    paddingHorizontal: space[12],
    paddingTop: space[8],
  },
  favicon: { borderRadius: 3, height: 15, width: 15 },
  grow: { flex: 1, minWidth: 0 },
  history: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget - space[12],
  },
  input: {
    alignSelf: "stretch",
    color: color.text,
    flex: 1,
    fontSize: 16,
    minWidth: 0,
    paddingEnd: space[12],
  },
  light: { borderRadius: 2, bottom: 0, position: "absolute", top: 0 },
  pressed: { opacity: 0.6 },
  ring: {
    ...StyleSheet.absoluteFill,
    borderColor: color.green,
    borderRadius: radius.full,
    borderWidth: 1.5,
  },
  searchGlyph: { paddingEnd: space[8], paddingStart: space[14] },
  site: { alignItems: "center", flexDirection: "row", gap: space[6], maxWidth: "100%" },
  siteText: { flexShrink: 1 },
  slot: { flex: 1, minWidth: 0 },
  suggestion: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 56,
    paddingHorizontal: space[14],
  },
  suggestionIcon: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  suggestionPressed: { backgroundColor: color.surfacePressed },
  suggestionWords: { flex: 1, minWidth: 0 },
  suggestions: {
    backgroundColor: color.surfaceElevated,
    borderColor: color.line,
    borderRadius: radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    paddingVertical: space[4],
  },
  track: {
    bottom: 3,
    end: space[18],
    height: 2.5,
    overflow: "hidden",
    position: "absolute",
    start: space[18],
  },
});
