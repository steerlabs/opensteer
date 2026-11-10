import {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  LinearTransition,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";

/**
 * The app's motion, named once.
 *
 * Nothing here decorates. Each transition answers a change of state the
 * person needs to see: something arrived, something left, something is still
 * happening. They are Reanimated builders so they run on the UI thread, and
 * every one of them honours the system's Reduce Motion setting by default —
 * Reanimated resolves `ReduceMotion.System` per animation, so a person who
 * asked for less movement gets the end state and nothing in between.
 *
 * Two speeds. `duration.enter` is how long something takes to arrive or to
 * settle into a new size: long enough to be followed by the eye, short enough
 * never to be waited for. `duration.exit` is quicker, because what leaves is
 * already understood.
 */
export const duration = { enter: 220, exit: 150 } as const;

/** Something new on the screen: it fades in from a few points below its place. */
export const enter = FadeInDown.duration(duration.enter);

/** The same arrival for a thing that has a place already, so it does not move. */
export const appear = FadeIn.duration(duration.enter);

/** The same arrival for chrome at the top of the screen, from under the bar above it. */
export const descend = FadeInUp.duration(duration.enter);

export const exit = FadeOut.duration(duration.exit);

/**
 * Something with a place goes to a new one, such as a task a person just asked
 * for something rising to the top. It never runs when the thing first mounts,
 * so a list that loads appears at once.
 */
export const move = LinearTransition.duration(duration.enter);

/**
 * A bubble settles on a spring and stops without a visible bounce. Only
 * transform and opacity move, on the UI thread, so a bubble costs no layout.
 * `withSpring` honours Reduce Motion as the builders above do.
 */
const bubbleSpring = { dampingRatio: 0.84, duration: 420 } as const;

/** What the reader just sent: it rises out of the composer into its place. */
export function bubbleRise() {
  "worklet";
  return {
    animations: {
      opacity: withTiming(1, { duration: 120 }),
      transform: [{ translateY: withSpring(0, bubbleSpring) }],
    },
    initialValues: { opacity: 0, transform: [{ translateY: 36 }] },
  };
}

/** A reply taking the place of its typing: it grows out of that bubble. */
export function bubblePop() {
  "worklet";
  return {
    animations: {
      opacity: withTiming(1, { duration: 120 }),
      transform: [{ scale: withSpring(1, bubbleSpring) }],
    },
    initialValues: { opacity: 0.2, transform: [{ scale: 0.88 }] },
  };
}

/**
 * One of a row of choices arriving together, such as saved logins above the
 * keyboard: each rises a little and settles a beat after the one before it,
 * so the row reads as offered rather than switched on.
 */
export function enterInTurn(index: number) {
  const delay = Math.min(index, 4) * 45;
  return () => {
    "worklet";
    return {
      animations: {
        opacity: withDelay(delay, withTiming(1, { duration: 140 })),
        transform: [
          { translateY: withDelay(delay, withSpring(0, bubbleSpring)) },
          { scale: withDelay(delay, withSpring(1, bubbleSpring)) },
        ],
      },
      initialValues: { opacity: 0, transform: [{ translateY: 10 }, { scale: 0.9 }] },
    };
  };
}
