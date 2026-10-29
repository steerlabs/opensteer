import type { CSSProperties } from "react";
import { Icon } from "./icon.js";

/**
 * A site's icon: the one its browser fetched, when it has one, else the
 * site's first letter on a tint of its own, so two sites side by side are
 * told apart at a glance.
 */
export function SiteMark({
  favicon = null,
  site,
}: {
  /** The icon the browser fetched for the site's page, as a data URL. */
  readonly favicon?: string | null | undefined;
  readonly site: string | null;
}) {
  if (favicon) {
    return (
      <img
        alt=""
        aria-hidden
        className="site-mark site-mark--icon"
        decoding="async"
        draggable={false}
        src={favicon}
      />
    );
  }
  const name = site?.replace(/^www\./u, "") ?? "";
  const letter = name.charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className="site-mark"
      style={letter ? ({ "--site-hue": siteHue(name) } as CSSProperties) : undefined}
    >
      {letter || <Icon name="globe" />}
    </span>
  );
}

function siteHue(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return hash;
}
