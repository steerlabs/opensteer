import type { SurfaceItem } from "@opensteer/client/host";

/** What a conversation's tab or app is, drawn as the symbol its control carries. */
export type SurfaceGlyph = "globe" | "laptopcomputer" | "smartphone" | typeof opensteerAppGlyph;

/** An Opensteer App wherever it is listed: neither a site, a Mac app nor a phone. */
export const opensteerAppGlyph = "square.grid.2x2";

export function surfaceGlyph(item: SurfaceItem): SurfaceGlyph {
  return item.kind === "browser" ? "globe" : item.kind === "app" ? "laptopcomputer" : "smartphone";
}

/**
 * An agent of this conversation acts in the item now. A browser can be shared,
 * and its own `acting` names whoever acted last, so a page counts only when one
 * of the conversation's threads is the one acting in that tab. A Mac app or a
 * phone is already listed only for the conversation's own sessions.
 */
export function actingFor(item: SurfaceItem, threads: ReadonlySet<string>): boolean {
  if (item.kind !== "browser") return item.acting;
  if (item.session.state !== "ready") return false;
  const tab = item.session.tabCatalog?.tabs.find(({ id }) => id === item.tabId);
  return (
    tab?.occupants?.some((occupant) => occupant.acting && threads.has(occupant.threadId)) ?? false
  );
}
