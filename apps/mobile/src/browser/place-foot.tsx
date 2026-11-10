import type { VoiceSnapshot } from "@opensteer/client/voice";
import { useEffect, type ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { color, controlFontScaleLimit, space, type as textType, touchTarget } from "../theme.js";
import { GlassSurface } from "../ui/glass.js";
import { appear, duration, exit } from "../ui/motion.js";
import { VoiceDock } from "../voice/controls.js";
import { useVoiceValue } from "../voice/use-voice-value.js";
import { usePlaceBarStatus } from "./place-bar.js";

/**
 * The status row's whole height: its controls' touch target, or, at large
 * text, its words and the Answer pill that grow with them, both capped at the
 * controls' text scale. It is known before the row is drawn, so the page can
 * make room for it first.
 */
export function statusRowHeight(fontScale: number): number {
  const line = Math.ceil(
    textType.secondaryMedium.lineHeight * Math.min(fontScale, controlFontScaleLimit),
  );
  return Math.max(touchTarget, line + 2 * space[6]);
}

/**
 * Room for the status row at the foot of a place, eased in and out on the UI
 * thread: the page shrinks into `reserve` as the row fades up into it, so the
 * row never stands over the page and nothing jumps. `hidden` while the place's
 * keyboard or address editor has the foot, which keeps the room.
 */
export function usePlaceStatus(hidden: boolean): {
  /** The row's height while it is shown, for what sizes against the resting place. */
  readonly height: number;
  readonly reserve: SharedValue<number>;
  /** The row, to stand at the foot of the place's stage. */
  readonly row: ReactNode;
} {
  const status = usePlaceBarStatus();
  const { fontScale } = useWindowDimensions();
  // The room stays while the foot is taken, so the page keeps its size under the keyboard.
  const height = status !== null ? statusRowHeight(fontScale) : 0;
  const shown = status !== null && !hidden;
  const reserve = useSharedValue(height);
  useEffect(() => {
    reserve.value = withTiming(height, { duration: duration.enter });
  }, [height, reserve]);
  return {
    height,
    reserve,
    row: shown ? (
      <Animated.View entering={appear} exiting={exit} style={[styles.slot, { height }]}>
        {status}
      </Animated.View>
    ) : null,
  };
}

/**
 * The status row over a page on this phone, which runs under its controls: on the bar's own
 * glass, so its words stay legible over whatever the page shows there.
 */
export function FloatingPlaceStatus(): ReactNode {
  const status = usePlaceBarStatus();
  const { fontScale } = useWindowDimensions();
  if (status === null) return null;
  return (
    <Animated.View entering={appear} exiting={exit} style={styles.floating}>
      <GlassSurface
        shape="capsule"
        style={[styles.glass, { height: statusRowHeight(fontScale) }]}
        tint={color.floatTint}
      >
        {status}
      </GlassSurface>
    </Animated.View>
  );
}

const selectShowing = ({ notice, phase }: VoiceSnapshot) => phase !== "idle" || notice !== null;

/**
 * A call's bar, docked over the place's own bar rather than floating over the
 * page: a page cannot leave room for what it does not know is there, and the
 * status row stands where the floating bar would rest.
 */
export function PlaceVoiceDock(): ReactNode {
  const showing = useVoiceValue(selectShowing);
  return (
    <View style={showing ? styles.voice : null}>
      <VoiceDock />
    </View>
  );
}

const styles = StyleSheet.create({
  floating: { paddingHorizontal: space[12] },
  glass: { flexDirection: "row" },
  slot: { bottom: 0, end: 0, position: "absolute", start: 0 },
  voice: { paddingHorizontal: space[12], paddingTop: space[8] },
});
