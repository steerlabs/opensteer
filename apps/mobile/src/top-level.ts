import { CommonActions, StackActions, type NavigationAction } from "@react-navigation/native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { isRecord } from "@opensteer/shared/isRecord";
import { presentedFrom } from "./navigation-presentations.js";

/**
 * Top-level screens and drill-ins: what a screen's leading control and its
 * edge swipe mean.
 *
 * A Deployment's stack is always `[Home, top-level?, ...drill-ins]`, with
 * sheets over any of them. Home, the New task composer, is the root and stays
 * mounted under everything. The top-level screen is Home itself or the one
 * screen directly on it: a task, a team, Automations, Tabs, a tab, Done or
 * Search, chosen from the sidebar, a notification or a link. It has the Menu
 * where Back would be, and its edge swipe opens the sidebar. Whatever is opened
 * from inside it is a drill-in with the native Back and its swipe.
 *
 * Position decides, not the route's name: the same task is top-level from the
 * sidebar and a drill-in from the task that started it.
 */

/** Screens that may be top-level. Anything else on Home, such as phone setup, is a drill-in. */
const topLevelRoutes: ReadonlySet<string> = new Set([
  "DoneTasks",
  "Home",
  "Schedules",
  "Tabs",
  "TaskSearch",
  "Teams",
  "TeamHome",
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

/**
 * Params that say where in a screen to land. A screen spends its landing once
 * it is shown, so landing again needs a fresh screen.
 */
const landingParams: ReadonlySet<string> = new Set(["messageId", "requestId"]);

/**
 * The action that makes `target` top-level, or null when it already is and is in front.
 *
 * The same screen keeps its mount: drill-ins over it close. Anything else,
 * including a new landing in it, replaces it and everything over it, over the
 * same mounted Home, so moving around the sidebar never grows the stack and
 * Home keeps its draft.
 */
export function openTopLevel(state: StackView, target: TopLevelTarget): NavigationAction | null {
  const index = topLevelIndex(state);
  const home = state.routes[0];
  if (index === null || home === undefined) return null;
  if (target.name === "Home") return state.index === 0 ? null : StackActions.popToTop();
  const current = state.routes[index];
  if (index === 1 && current !== undefined && sameScreen(current, target))
    return state.index === 1 ? null : StackActions.pop(state.index - 1);
  // Home's own route, key and all, so the router keeps it mounted.
  const action = CommonActions.reset({ index: 1, routes: [home, target] });
  return { payload: action.payload ?? {}, type: action.type };
}

function sameScreen(route: StackRoute, target: TopLevelTarget): boolean {
  const current = isRecord(route.params) ? route.params : {};
  return (
    route.name === target.name &&
    Object.entries(target.params).every(
      ([key, value]) => !landingParams.has(key) && current[key] === value,
    )
  );
}
