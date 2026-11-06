import { heldWords } from "@opensteer/client/voice";
import { useLayoutEffect, useRef } from "react";
import { useWindowDimensions, type LayoutChangeEvent } from "react-native";
import {
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { space } from "../theme.js";
import { duration } from "../ui/motion.js";

const wordsGap = space[8];
// Critically damped: a new target picks up the edge's speed, so tokens read as one movement.
const settle = { damping: 34, mass: 1, overshootClamping: true, stiffness: 290 };

export interface PillFit {
  /** How far the pill's left edge stands from the lane's. Everything on that edge rides it. */
  readonly cut: SharedValue<number>;
  /** The lane's width, which the pill's width is `cut` short of. */
  readonly lane: SharedValue<number>;
  /** How far the words stop short of the lane's right end: the trailing controls and a gap. */
  readonly tail: SharedValue<number>;
  /** 1 while the words are wider than the widest pill. */
  readonly clipped: SharedValue<number>;
  readonly onLane: (event: LayoutChangeEvent) => void;
  readonly onTrailing: (event: LayoutChangeEvent) => void;
  readonly onWords: (event: LayoutChangeEvent) => void;
}

/**
 * Sizes the pill from `onLayout`, which fires when a size changes: a token that
 * widens the words moves the spring's target, and nothing here renders. `lead` is
 * the room ahead of the words; `turn` changes when the speaker does. Within a
 * turn the pill only grows, so words that are rewritten never make it twitch.
 */
export function usePillFit(lead: number, turn: string | null): PillFit {
  const reduceMotion = useReducedMotion();
  // Past the lane's end until measured, so no frame draws a full-width pill.
  const cut = useSharedValue(useWindowDimensions().width);
  const lane = useSharedValue(0);
  const tail = useSharedValue<number>(wordsGap);
  const clipped = useSharedValue(0);
  const room = useRef({
    held: 0,
    lane: 0,
    lead,
    newTurn: false,
    overflowing: false,
    target: null as number | null,
    trailing: 0,
    words: 0,
  }).current;

  const place = (): void => {
    if (room.lane === 0 || room.trailing === 0) return;
    const fixed = room.lead + room.trailing;
    const overflowing = room.words + fixed + wordsGap > room.lane;
    if (overflowing !== room.overflowing) {
      room.overflowing = overflowing;
      clipped.value = withTiming(overflowing ? 1 : 0, { duration: duration.exit });
    }
    const target = Math.max(0, room.lane - fixed - (room.held > 0 ? room.held + wordsGap : 0));
    if (target === room.target) return;
    cut.value = room.target === null || reduceMotion ? target : withSpring(target, settle);
    room.target = target;
  };

  // Runs in the commit, ahead of the `onLayout` that commit's new words send.
  useLayoutEffect(() => {
    room.newTurn = true;
  }, [room, turn]);
  useLayoutEffect(() => {
    room.lead = lead;
    place();
  });

  return {
    clipped,
    cut,
    lane,
    onLane: ({ nativeEvent }) => {
      room.lane = nativeEvent.layout.width;
      lane.value = room.lane;
      place();
    },
    onTrailing: ({ nativeEvent }) => {
      room.trailing = nativeEvent.layout.width;
      tail.value = room.trailing + wordsGap;
      place();
    },
    onWords: ({ nativeEvent }) => {
      room.words = nativeEvent.layout.width;
      room.held = heldWords(room.words, room.held, room.newTurn);
      room.newTurn = false;
      place();
    },
    tail,
  };
}
