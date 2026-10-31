import { surfaceDestination, type SurfaceItem, type ThreadPlace } from "@opensteer/client/host";
import { sameDestination } from "./surface-route.js";

/** What a conversation's tab or app is, drawn as the symbol its control carries. */
export type SurfaceGlyph = "globe" | "laptopcomputer" | "smartphone";

/**
 * The tab or app a conversation's agent is in: one it acts in now, else the
 * one the Host last named for the conversation, else its newest. Never one the
 * conversation does not use. `threads` is the conversation and the work it
 * handed out (`conversationThreadIds`).
 */
export function agentSurface(
  items: readonly SurfaceItem[],
  threads: ReadonlySet<string>,
  latest: ThreadPlace | null,
): SurfaceItem | null {
  const acting = items.find((item) => actingFor(item, threads));
  if (acting !== undefined) return acting;
  const place = latest?.destination ?? null;
  const named =
    place === null
      ? undefined
      : items.find((item) => sameDestination(surfaceDestination(item), place));
  return named ?? items.at(-1) ?? null;
}

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
