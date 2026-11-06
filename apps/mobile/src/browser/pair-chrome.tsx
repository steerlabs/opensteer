import type { PlaceAgent } from "@opensteer/client/host";
import { memo, type ReactNode } from "react";
import { Image, Platform, Pressable, StyleSheet, View } from "react-native";
import {
  color,
  controlFontScaleLimit,
  headerFontScaleLimit,
  space,
  touchTarget,
} from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { GlassSurface } from "../ui/glass.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { AgentMarks } from "./agent-marks.js";
import type { OpenTabSuggestion } from "./address-bar.js";

/** Android's touch target is Material's 48dp; iOS's is 44pt. */
const target = Platform.OS === "android" ? 48 : touchTarget;
/** At most this many of a task's other tabs stand beside the address; the rest are in the sheet. */
const maxChips = 2;
const chipGap = space[8];

/**
 * How many of a task's other tabs fit in the room the bar leaves, and whether
 * they keep their titles. Titled chips give way to favicon-only ones before
 * any is dropped, so the row never wraps; what does not fit is in the tab
 * sheet the count opens.
 */
export function chipFit(
  room: number,
  count: number,
  fontScale: number,
): { readonly labeled: boolean; readonly shown: number } {
  const titled = titledChipWidth(fontScale);
  for (const [labeled, width] of [
    [true, titled],
    [false, target],
  ] as const)
    for (let shown = Math.min(count, maxChips); shown > 0; shown -= 1)
      if (shown * (width + chipGap) <= room) return { labeled, shown };
  return { labeled: false, shown: 0 };
}

function titledChipWidth(fontScale: number): number {
  return Math.round(124 * Math.min(fontScale, controlFontScaleLimit));
}

/**
 * The task's other tabs in this browser, as Safari's compact tab bar shows
 * them on iPad: each a small capsule with its icon and a short title, a tap
 * away. The tab in front is the address beside them.
 */
export const TaskTabChips = memo(function TaskTabChips(props: {
  readonly fontScale: number;
  readonly onSelect: (tabId: string) => void;
  readonly room: number;
  readonly tabs: readonly OpenTabSuggestion[];
}): ReactNode {
  const { labeled, shown } = chipFit(props.room, props.tabs.length, props.fontScale);
  if (shown === 0) return null;
  return (
    <View style={styles.chips}>
      {props.tabs.slice(0, shown).map((tab) => (
        <Pressable
          accessibilityHint="Switches to this tab"
          accessibilityLabel={tab.title}
          accessibilityRole="button"
          key={tab.id}
          onPress={() => props.onSelect(tab.id)}
          style={({ pressed }) => [
            styles.chipSlot,
            labeled ? { maxWidth: titledChipWidth(props.fontScale) } : null,
            pressed && styles.pressed,
          ]}
        >
          <GlassSurface interactive shape="capsule" style={[styles.chip, !labeled && styles.bare]}>
            {tab.favicon === null ? (
              <Symbol name="globe" size={13} tint={color.textSoft} />
            ) : (
              <Image
                accessibilityIgnoresInvertColors
                source={{ uri: tab.favicon }}
                style={styles.favicon}
              />
            )}
            {labeled ? (
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="caption"
                style={styles.chipTitle}
                tone="soft"
              >
                {tab.title}
              </AppText>
            ) : null}
          </GlassSurface>
        </Pressable>
      ))}
    </View>
  );
});

/**
 * Where the agent is while the person looks at another tab: a slim band under
 * the bar, inside the page's chrome so it never covers the streamed page, and
 * one tap back to following it.
 */
export function FollowBand(props: {
  readonly agent: PlaceAgent | null;
  readonly onFollow: () => void;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.band} testID="follow-band">
      {props.agent === null ? null : <AgentMarks agents={[props.agent]} size={16} />}
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.bandWords}
        tone="muted"
      >
        {`Agent is on ${props.title}`}
      </AppText>
      <Pressable
        accessibilityHint="Shows the tab the agent is on, and keeps up with it"
        accessibilityLabel="Follow"
        accessibilityRole="button"
        hitSlop={{ bottom: space[4], top: space[4] }}
        onPress={props.onFollow}
        style={({ pressed }) => [styles.follow, pressed && styles.pressed]}
      >
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="ember">
          Follow
        </AppText>
      </Pressable>
    </View>
  );
}

/**
 * The pill over a pane beside a page while it has no Thread's own pill to
 * show — a task still being written, or a Thread whose name is on its way —
 * with the same menu place for putting the pane away.
 */
export function CompanionCapsule(props: {
  readonly actions: readonly NativeMenuOption[];
  readonly title: string;
}): ReactNode {
  return (
    <GlassSurface interactive shape="capsule" style={styles.capsule}>
      <NativeMenu
        accessibilityHint="Shows what you can do with this pane"
        accessibilityLabel={props.title === "" ? "Actions" : `${props.title}. Actions`}
        options={props.actions}
        triggerStyle={styles.capsuleTrigger}
      >
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          numberOfLines={1}
          role="secondaryMedium"
          style={styles.capsuleTitle}
        >
          {props.title}
        </AppText>
        <Symbol name="chevron.down" size={11} tint={color.muted} weight="bold" />
      </NativeMenu>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  band: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: 36,
    paddingEnd: space[8],
    paddingStart: space[16],
  },
  bandWords: { flex: 1, minWidth: 0 },
  capsule: { maxWidth: 320, paddingHorizontal: space[12] },
  capsuleTitle: { flexShrink: 1, fontWeight: "600" },
  capsuleTrigger: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: space[4],
    minHeight: target,
  },
  bare: { justifyContent: "center", paddingHorizontal: 0, width: 34 },
  chip: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[6],
    height: 34,
    maxWidth: "100%",
    paddingHorizontal: space[10],
  },
  chipSlot: { alignItems: "center", justifyContent: "center", minHeight: target, minWidth: target },
  chipTitle: { flexShrink: 1 },
  chips: { flexDirection: "row", flexShrink: 0, gap: chipGap },
  favicon: { borderRadius: 3, height: 14, width: 14 },
  follow: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 36,
    minWidth: target,
    paddingHorizontal: space[8],
  },
  pressed: { opacity: 0.6 },
});
