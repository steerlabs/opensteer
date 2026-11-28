/**
 * Where the menu bar opens the app: Home with Needs you showing (the shell's
 * `needsYouSearchParam`), or Settings.
 */
export const appRoutes = { needsYou: "/?needs-you", settings: "/settings" } as const;

/**
 * Moves the app window's page to one of its own routes without reloading it,
 * as its router does on Back: the window keeps its connection and its tabs.
 */
export function taskPath(threadId: string): `/tasks/${string}` {
  return `/tasks/${encodeURIComponent(threadId)}`;
}

export function appRouteScript(
  route: (typeof appRoutes)[keyof typeof appRoutes] | ReturnType<typeof taskPath>,
): string {
  return `history.pushState(null, "", ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent("popstate"));`;
}
