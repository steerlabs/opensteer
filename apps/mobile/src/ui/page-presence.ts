import { useIsFocused, useNavigationState, useRoute } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform } from "react-native";
import { routesAbove, routeShown } from "../navigation-presentations.js";
import { useAppForeground } from "./foreground.js";

/**
 * How a screen's page is with the person. A sheet over it takes its input but
 * not its picture; a screen over it takes its picture but not its viewer, so
 * showing it again needs nothing of the Host.
 */
export interface PagePresence {
  /** In front, in the foreground: it takes input and moves with the agent. */
  readonly interactive: boolean;
  /** Drawn where the person can see it, under a sheet as well. */
  readonly shown: boolean;
  /** Near the top of its stack in the foreground: it keeps its viewer and its last picture. */
  readonly held: boolean;
}

/**
 * Each held page keeps one of the client's bounded browser targets, so only the
 * pages a few screens from the top keep theirs; a deeper one asks the Host again.
 */
const heldDepth = 4;

export function useScreenPresence(): PagePresence {
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const { key } = useRoute();
  const drawn = useNavigationState((state) => routeShown(state, key, Platform.OS));
  const near = useNavigationState((state) => (routesAbove(state, key) ?? 0) <= heldDepth);
  const shown = (focused || drawn) && foreground;
  const held = foreground && (focused || near);
  return useMemo(
    () => ({ interactive: focused && foreground, shown, held }),
    [focused, foreground, held, shown],
  );
}
