import { surfaceDestination, type SurfaceItem, type ThreadPlace } from "@opensteer/client/host";
import { sameDestination } from "./surface-route.js";

/** What a conversation's tab or app is, drawn as the symbol its control carries. */
export type SurfaceGlyph = "globe" | "laptopcomputer" | "smartphone";

/**
 * The tab or app a conversation's agent is in: one it acts in now, else the
 * one the Host last named for the conversation, else its newest. Never one the
 * conversation does not use.
 */
export function agentSurface(
  items: readonly SurfaceItem[],
  latest: ThreadPlace | null,
): SurfaceItem | null {
  const acting = items.find((item) => item.acting);
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
