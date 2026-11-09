import type { PlaceAgent } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
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

/** Android's touch target is Material's 48dp; iOS's is 44pt. */
const target = Platform.OS === "android" ? 48 : touchTarget;

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
  follow: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 36,
    minWidth: target,
    paddingHorizontal: space[8],
  },
  pressed: { opacity: 0.6 },
});
