import type { SurfaceItem } from "@opensteer/client/host";

/** What a conversation's tab or app is, drawn as the symbol its control carries. */
export type SurfaceGlyph = "globe" | "laptopcomputer" | "smartphone" | typeof opensteerAppGlyph;

/** An Opensteer App wherever it is listed: neither a site, a Mac app nor a phone. */
export const opensteerAppGlyph = "square.grid.2x2";

export function surfaceGlyph(item: Pick<SurfaceItem, "kind">): SurfaceGlyph {
  switch (item.kind) {
    case "page":
      return "globe";
    case "window":
      return "laptopcomputer";
    case "phone":
      return "smartphone";
    case "app":
      return opensteerAppGlyph;
  }
}
