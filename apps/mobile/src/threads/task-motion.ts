import { useLayoutEffect, useRef } from "react";
import { Easing, LinearTransition, useReducedMotion } from "react-native-reanimated";

const slide = LinearTransition.duration(240).easing(Easing.out(Easing.cubic));

/** A fresh page appears at once; only changes to an already visible order slide. */
export function useTaskMotion(keys: readonly string[], signature = keys.join(",")) {
  const reduced = useReducedMotion();
  const previous = useRef({ keys: [] as readonly string[], signature: "" });
  const before = previous.current;
  const arrivals = keys.filter((key) => !before.keys.includes(key)).length;
  const retained = keys.some((key) => before.keys.includes(key));
  useLayoutEffect(() => {
    previous.current = { keys, signature };
  });
  return !reduced && before.signature !== signature && retained && arrivals <= 3
    ? slide
    : undefined;
}
