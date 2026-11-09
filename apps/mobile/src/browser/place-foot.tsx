import type { VoiceSnapshot } from "@opensteer/client/voice";
import { useEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { space, touchTarget } from "../theme.js";
import { appear, duration, exit } from "../ui/motion.js";
import { VoiceDock } from "../voice/controls.js";
import { useVoiceValue } from "../voice/use-voice-value.js";
import { usePlaceBarStatus } from "./place-bar.js";

/**
 * The status row's whole height: its controls' touch target and no more. It is
 * fixed, its words being capped at the controls' text scale, so the page can
 * make room for it before it is drawn.
 */
export const statusRowHeight = touchTarget;

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
  // The room stays while the foot is taken, so the page keeps its size under the keyboard.
  const height = status !== null ? statusRowHeight : 0;
  const shown = status !== null && !hidden;
  const reserve = useSharedValue(height);
  useEffect(() => {
    reserve.value = withTiming(height, { duration: duration.enter });
  }, [height, reserve]);
  return {
    height,
    reserve,
    row: shown ? (
      <Animated.View entering={appear} exiting={exit} style={styles.slot}>
        {status}
      </Animated.View>
    ) : null,
  };
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
  slot: { bottom: 0, end: 0, position: "absolute", start: 0 },
  voice: { paddingHorizontal: space[12], paddingTop: space[8] },
});
