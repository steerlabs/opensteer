import { createElement } from "react";
import type { IconName } from "@opensteer/core";
import { iconArt } from "@opensteer/client/host";

/** The shared 24×24 artwork, stroked in the surrounding text colour. */
export function IconGlyph({ icon }: { icon: IconName }) {
  return (
    <svg
      aria-hidden="true"
      className="workspace-icon-glyph"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      {iconArt[icon].elements.map(([tag, attributes], index) =>
        createElement(tag, { ...attributes, key: index }),
      )}
    </svg>
  );
}
