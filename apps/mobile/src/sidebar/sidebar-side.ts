import type { SideId } from "../side-memory.js";
import { isRecord } from "@opensteer/shared/isRecord";

/** Which side of the sidebar's switch shows: the person's own tasks, or one team by its id. */
export type SidebarSide = SideId;

/** Top-level screens that belong to the Tasks side. */
const tasksScreens: ReadonlySet<string> = new Set([
  "DoneTasks",
  "Home",
  "NeedsYou",
  "Schedules",
  "Tabs",
  "TaskSearch",
  "Thread",
  "WorkspaceBrowser",
]);

/** The side a top-level screen belongs to, or null for one that belongs to neither, such as Teams. */
export function sideOfScreen(
  route: { readonly name: string; readonly params?: object | undefined } | undefined,
): SidebarSide | null {
  if (route === undefined) return null;
  const teamId = isRecord(route.params) ? route.params["teamId"] : undefined;
  if (typeof teamId === "string") return teamId;
  return tasksScreens.has(route.name) ? "tasks" : null;
}
