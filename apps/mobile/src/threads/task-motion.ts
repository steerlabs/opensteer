import { Easing, LinearTransition, ReduceMotion } from "react-native-reanimated";

/**
 * How a task row moves to its new place. A layout transition never runs when
 * a row first mounts, so a list that loads appears at once; only a row whose
 * place changes slides there.
 */
export const taskSlide = LinearTransition.duration(240)
  .easing(Easing.out(Easing.cubic))
  .reduceMotion(ReduceMotion.System);
