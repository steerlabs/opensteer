import { integrationMark } from "@opensteer/client/integrations";
import { bundledIntegrationArt } from "./bundled-icons.js";
import { integrationHue } from "./helpers.js";

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
  readonly size?: "lg" | "md" | undefined;
}) {
  const className = `intg-icon ${size === "lg" ? "intg-icon--lg" : ""}`;
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
      style={{ ["--intg-hue" as string]: integrationHue(id) }}
    >
      {name.slice(0, 2).toLocaleUpperCase()}
    </span>
  );
}
