import { integrationMark } from "@opensteer/client/integrations";
import { usePluginIcon } from "@opensteer/client/react";
import { useState } from "react";
import { useShell } from "./app-shell.js";
import { bundledIntegrationArt } from "./integration-art.js";

type IconSize = "lg" | "md";
const tileClass = (size: IconSize | undefined) =>
  `intg-icon ${size === "lg" ? "intg-icon--lg" : ""}`;

/** Local artwork and vector marks share the same tile treatment on every client. */
export function IntegrationIcon({
  icon,
  id,
  name,
  size = "md",
}: {
  readonly icon?: string | undefined;
  readonly id: string;
  readonly name: string;
  readonly size?: IconSize | undefined;
}) {
  const className = tileClass(size);
  const mark = integrationMark(id);
  if (mark?.kind === "art" || mark?.kind === "logo")
    return (
      <span
        className={`${className} ${mark.kind === "art" ? "intg-icon--art" : "intg-icon--mark"}`}
      >
        <img alt="" decoding="async" src={bundledIntegrationArt[mark.art]} />
      </span>
    );
  if (mark)
    return (
      <span aria-hidden className={`${className} intg-icon--mark`}>
        <svg viewBox="0 0 24 24">
          {mark.kind === "brand" ? (
            <path d={mark.d} fill={mark.color} />
          ) : (
            <path
              d={mark.d}
              fill="none"
              stroke={mark.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
            />
          )}
        </svg>
      </span>
    );
  if (icon?.startsWith("data:image/")) {
    return (
      <span className={className}>
        <img alt="" src={icon} />
      </span>
    );
  }
  if (icon && !/^[\x20-\x7E]*$/u.test(icon)) {
    return (
      <span aria-hidden className={className}>
        {icon}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`${className} intg-icon--monogram`}
      style={{ ["--intg-hue" as string]: integrationHue(id) }}
    >
      {name.slice(0, 2).toLocaleUpperCase()}
    </span>
  );
}

/**
 * A plugin's own icon, read from its Host and drawn on a light tile in both
 * themes. An empty tile holds its place while it is read; a plugin with none,
 * or one this browser can't draw, wears its integration mark or initials.
 */
export function PluginIcon({
  iconRef,
  id,
  name,
  size = "md",
}: {
  readonly iconRef: string | null | undefined;
  readonly id: string;
  readonly name: string;
  readonly size?: IconSize | undefined;
}) {
  const image = usePluginIcon(useShell().hostClient, iconRef);
  const [broken, setBroken] = useState<string | null>(null);
  if (image === undefined) return <span aria-hidden className={tileClass(size)} />;
  if (image === null || image === broken)
    return <IntegrationIcon id={id} name={name} size={size} />;
  return (
    <span aria-hidden className={`${tileClass(size)} intg-icon--mark`}>
      <img alt="" decoding="async" onError={() => setBroken(image)} src={image} />
    </span>
  );
}

/** Deterministic hue per id so monograms are tinted, never random. */
function integrationHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}
