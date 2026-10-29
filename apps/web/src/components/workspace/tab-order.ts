import type { BrowserTabLayout } from "@opensteer/protocol";
import { browserTabStrip, type PlaceItem } from "@opensteer/client/host";

/**
 * The sidebar's tabs as a browser lists them: the web tabs first, then the
 * Mac apps and phones. Each group keeps the Host's order, so an opened tab stays
 * right after the tab that opened it.
 */
export function tabSections(places: readonly PlaceItem[]): {
  readonly web: readonly PlaceItem[];
  readonly native: readonly PlaceItem[];
} {
  return {
    web: places.filter((place) => place.kind === "browser"),
    native: places.filter((place) => place.kind !== "browser"),
  };
}

/** The order every "next tab" follows: ⌃Tab, ⌘1–9 and the composer's lists. */
export function tabOrder(
  places: readonly PlaceItem[],
  layout?: BrowserTabLayout,
): readonly PlaceItem[] {
  return browserTabStrip(places, layout).visible;
}
