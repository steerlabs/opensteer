import { FadeIn, FadeInDown, FadeOut } from "react-native-reanimated";

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

export const exit = FadeOut.duration(duration.exit);
