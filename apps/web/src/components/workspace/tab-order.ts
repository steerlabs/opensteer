import type { BrowserTabLayout, MachineSummary } from "@opensteer/protocol";
import { browserTabSections, browserTabStrip, type PlaceItem } from "@opensteer/client/host";

/**
 * Browser tabs and native places keep their own succession families,
 * retaining the device sections' order within each family.
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
  machines: readonly MachineSummary[] = [],
  hereId: string | null = null,
): readonly PlaceItem[] {
  const strip = browserTabStrip(places, layout);
  const visible = new Set(strip.visible.map((place) => place.key));
  return browserTabSections({ strip, machines, hereId }).ordered.filter((place) =>
    visible.has(place.key),
  );
}
