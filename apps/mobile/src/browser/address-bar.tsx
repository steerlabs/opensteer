import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { ToolbarCapsule } from "./toolbar.js";

/** How far the address is dragged before letting go moves to the next tab. */
const switchDistance = 56;

/**
 * The page's address, as Safari's bar shows it: the site alone, centred, with
 * its icon. Tapping it edits the address; dragging it sideways moves to the
 * browser's next or previous tab, as Safari's does. A line along its bottom
 * edge says what is happening in the page: the page loading, or an agent
 * acting in it.
 */
export const AddressCapsule = memo(function AddressCapsule(props: {
  readonly acting: boolean;
  readonly favicon: string | null;
  readonly loading: boolean;
  readonly onEdit: () => void;
  readonly onReload: () => void;
  /** Given while there is a tab that way to move to. */
  readonly onSwitch: ((direction: -1 | 1) => void) | null;
  readonly reloadable: boolean;
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
  const site = props.site ?? "Search or enter address";
  return (
    <GestureDetector gesture={swipe}>
      <View style={styles.slot}>
        <ToolbarCapsule>
          <Pressable
            accessibilityHint={
              canSwitch
                ? "Edits the address. Swipe sideways for the next tab."
                : "Edits the address"
            }
            accessibilityLabel={props.site === null ? "Address" : `Address, ${props.site}`}
            accessibilityRole="button"
            onPress={props.onEdit}
            style={({ pressed }) => [styles.address, pressed && styles.pressed]}
          >
            <Animated.View style={[styles.site, moved]}>
              {props.favicon !== null ? (
                <Image
                  accessibilityIgnoresInvertColors
                  source={{ uri: props.favicon }}
                  style={styles.favicon}
                />
              ) : props.secure ? (
                <Symbol name="lock" size={12} tint={color.muted} weight="semibold" />
              ) : null}
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
          <Pressable
            accessibilityLabel="Reload"
            accessibilityRole="button"
            accessibilityState={{ disabled: !props.reloadable }}
            disabled={!props.reloadable}
            hitSlop={space[4]}
            onPress={props.onReload}
            style={({ pressed }) => [styles.reload, pressed && styles.pressed]}
          >
            <Symbol
              name="arrow.clockwise"
              size={16}
              tint={props.reloadable ? color.textSoft : color.mutedDim}
              weight="medium"
            />
          </Pressable>
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
    // As wide as Reload on the other side, so the site sits in the middle.
    paddingStart: touchTarget - space[4],
  },
  cancel: { justifyContent: "center", minHeight: touchTarget, paddingHorizontal: space[4] },
  editRow: { alignItems: "center", flexDirection: "row", gap: space[8] },
  editor: {
    gap: space[8],
    paddingBottom: space[4],
    paddingHorizontal: space[12],
    paddingTop: space[8],
  },
  favicon: { borderRadius: 3, height: 15, width: 15 },
  grow: { flex: 1, minWidth: 0 },
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
  reload: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget - space[4],
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
