import type { NavigationAction } from "@react-navigation/native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { sideMemory } from "./side-memory.js";
import { presentedFrom } from "./navigation-presentations.js";

/**
 * Home stays mounted beneath one active side's route chain. Its first screen
 * owns the sidebar edge swipe; drill-ins keep native Back and its swipe.
 * Every non-presented screen can open Menu while the sidebar is a drawer.
 */

/** Screens that may be top-level. Anything else on Home, such as phone setup, is a drill-in. */
const topLevelRoutes: ReadonlySet<string> = new Set([
  "Apps",
  "DoneTasks",
  "Home",
  "NeedsYou",
  "Schedules",
  "Tabs",
  "TaskSearch",
  "Thread",
  "WorkspaceBrowser",
]);

/** Screens whose content takes horizontal drags from the edge, such as a streamed page. */
const edgeOwners: ReadonlySet<string> = new Set(["WorkspaceBrowser"]);

interface StackRoute {
  readonly key: string;
  readonly name: string;
  readonly params?: object | undefined;
}

/** As much of the stack's state as this reads. */
export interface StackView {
  readonly index: number;
  readonly routes: readonly StackRoute[];
}

/** A screen the sidebar can make top-level. */
export interface TopLevelTarget {
  readonly name: string;
  readonly params: object;
}

/** Where the top-level screen is, or null outside a Deployment's stack. */
export function topLevelIndex(state: StackView): 0 | 1 | null {
  if (state.routes[0]?.name !== "Home") return null;
  const above = state.routes[1];
  return above !== undefined && presentedFrom(state) !== 1 && topLevelRoutes.has(above.name)
    ? 1
    : 0;
}

/** The top-level screen's route, or undefined outside a Deployment's stack. */
export function topLevelRoute<T extends StackRoute>(state: {
  readonly index: number;
  readonly routes: readonly T[];
}): T | undefined {
  const index = topLevelIndex(state);
  return index === null ? undefined : state.routes[index];
}

export function isTopLevel(state: StackView, key: string): boolean {
  return topLevelRoute(state)?.key === key;
}

/** Whether the screen in front, sheets aside, is top-level and its edge swipe may open the sidebar. */
export function sidebarSwipes(focused: StackRoute | undefined, state: StackView): boolean {
  return focused !== undefined && isTopLevel(state, focused.key) && !edgeOwners.has(focused.name);
}

/**
 * A top-level screen's own transition and gestures. It fades rather than
 * slides, being beside the last one rather than deeper; there is nothing to
 * swipe back to; and iOS's default fade is twice as long as a switch should be.
 */
export const topLevelScreenOptions: NativeStackNavigationOptions = {
  animation: "fade",
  animationDuration: 220,
  gestureEnabled: false,
  headerBackVisible: false,
};

/** An explicit sidebar/link destination. */
export function openTopLevel(state: StackView, target: TopLevelTarget): NavigationAction | null {
  return sideMemory.enter(state, target);
}
