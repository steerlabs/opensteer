import { bundledIntegrationIconUrl } from "./bundled-icons.js";
import { integrationHue } from "./helpers.js";

/**
 * Icon tile for one integration. An integration this tree ships artwork for
 * wears its own mark from this bundle; definitions may otherwise carry an emoji
 * or an image URL, and anything else falls back to a hue-tinted monogram so
 * unknown integrations still get a stable, distinguishable mark.
 */
export function IntegrationIcon({
  icon,
  id,
  name,
  size = "md",
}: {
  readonly icon?: string | undefined;
  readonly id: string;
  readonly name: string;
  readonly size?: "lg" | "md" | undefined;
}) {
  const className = `intg-icon ${size === "lg" ? "intg-icon--lg" : ""}`;
  const hue = integrationHue(id);
  const bundled = bundledIntegrationIconUrl(id);
  if (bundled) {
    // The mark is already a finished tile, so it fills the frame rather than
    // sitting inside the tinted one the fallbacks use.
    return (
      <span className={`${className} intg-icon--art`}>
        <img alt="" decoding="async" src={bundled} />
      </span>
    );
  }
  if (icon && /^https?:\/\//u.test(icon)) {
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
      style={{ ["--intg-hue" as string]: hue }}
    >
      {name.slice(0, 2).toLocaleUpperCase()}
    </span>
  );
}
