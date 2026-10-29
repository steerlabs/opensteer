import { createElement } from "react";
import type { MarkColor, WorkspaceIconName } from "@opensteer/core";
import { markColorPaint, workspaceIconArt, workspaceMonogram } from "@opensteer/client/host";

export function WorkspaceOrb({
  icon = null,
  name,
  size = "medium",
  color,
}: {
  icon?: WorkspaceIconName | null;
  name: string;
  size?: "large" | "medium" | "small" | "tiny";
  color: MarkColor | null;
}) {
  return (
    <span
      aria-hidden="true"
      className={`workspace-orb workspace-orb--${size}`}
      data-color={color ?? "neutral"}
      style={
        color === null
          ? undefined
          : { background: `linear-gradient(140deg, ${markColorPaint[color].tile.join(", ")})` }
      }
      title={name}
    >
      {icon ? <WorkspaceIconGlyph icon={icon} /> : <span>{workspaceMonogram(name)}</span>}
    </span>
  );
}

/** The shared 24×24 artwork, stroked in the surrounding text colour. */
export function WorkspaceIconGlyph({ icon }: { icon: WorkspaceIconName }) {
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
      {workspaceIconArt[icon].elements.map(([tag, attributes], index) =>
        createElement(tag, { ...attributes, key: index }),
      )}
    </svg>
  );
}
