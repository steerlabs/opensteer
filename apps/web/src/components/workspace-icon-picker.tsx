import { useMemo, useState, type KeyboardEvent } from "react";
import {
  markColors,
  workspaceIconNames,
  type MarkColor,
  type WorkspaceIconName,
} from "@opensteer/core";
import { markColorPaint, workspaceIconArt, workspaceMonogram } from "@opensteer/client/host";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { WorkspaceIconGlyph, WorkspaceOrb } from "./workspace-orb.js";

/**
 * A Workspace's mark as a button that opens the icon picker, for a reader who
 * may change it; anyone else sees only the mark.
 */
export function WorkspaceIconChooser({
  editable,
  icon,
  name,
  onChange,
  onColorChange,
  pending = false,
  color,
}: {
  editable: boolean;
  icon: WorkspaceIconName | null;
  name: string;
  onChange: (icon: WorkspaceIconName | null) => void;
  pending?: boolean;
  onColorChange?: ((color: MarkColor) => void) | undefined;
  color: MarkColor | null;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const orb = <WorkspaceOrb icon={icon} name={name} size="large" color={color} />;
  if (!editable) return orb;
  return (
    <>
      <button
        aria-busy={pending}
        // Not `disabled`: the popover returns focus here as it closes, and a
        // disabled button would drop keyboard focus while the change saves.
        aria-disabled={pending}
        aria-expanded={anchor !== null}
        aria-haspopup="dialog"
        aria-label={icon ? `Icon: ${workspaceIconArt[icon].label}. Change icon` : "Choose an icon"}
        className="workspace-icon-chooser"
        onClick={(event) => {
          if (pending) return;
          setAnchor(anchor ? null : event.currentTarget);
        }}
        type="button"
      >
        {orb}
        <span aria-hidden="true" className="workspace-icon-chooser__badge">
          <Icon name="pencil" />
        </span>
      </button>
      {anchor ? (
        <Popover
          anchor={anchor}
          label="Specialist icon"
          onClose={() => setAnchor(null)}
          role="dialog"
        >
          <WorkspaceIconPicker
            onColorChange={onColorChange}
            name={name}
            onChange={(next) => {
              setAnchor(null);
              if (next !== icon) onChange(next);
            }}
            color={color}
            value={icon}
          />
        </Popover>
      ) : null}
    </>
  );
}

export function WorkspaceIconPicker({
  name,
  onChange,
  onColorChange,
  task = false,
  color,
  value,
}: {
  name: string;
  onChange: (icon: WorkspaceIconName | null) => void;
  color: MarkColor | null;
  value: WorkspaceIconName | null;
  task?: boolean;
  onColorChange?: ((color: MarkColor) => void) | undefined;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return workspaceIconNames;
    return workspaceIconNames.filter(
      (icon) =>
        icon.includes(needle) || workspaceIconArt[icon].label.toLocaleLowerCase().includes(needle),
    );
  }, [query]);
  return (
    <div className="workspace-icon-picker">
      {onColorChange ? (
        <>
          <div className="workspace-icon-picker__label">Colour</div>
          <div className="workspace-icon-picker__colors" role="group" aria-label="Colour">
            {markColors.map((next) => (
              <button
                key={next}
                type="button"
                aria-label={next[0]!.toUpperCase() + next.slice(1)}
                aria-pressed={color === next}
                onClick={() => onColorChange(next)}
                style={{
                  background: `linear-gradient(140deg, ${markColorPaint[next].tile.join(", ")})`,
                }}
              />
            ))}
          </div>
          <div className="workspace-icon-picker__label">Icon</div>
        </>
      ) : null}
      <input
        aria-label="Search icons"
        // Opening the picker is a request to choose, so search is ready to type in.
        autoFocus
        data-autofocus
        className="text-input"
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Enter chooses the best match; inside a form it must not submit it.
          if (event.key !== "Enter") return;
          event.preventDefault();
          const first = matches[0];
          if (query.trim() && first) onChange(first);
        }}
        placeholder="Search icons"
        type="search"
        value={query}
      />
      {task ? (
        <button
          type="button"
          aria-label="Use default"
          aria-pressed={value === null || value === "document"}
          className="workspace-icon-picker__default"
          onClick={() => onChange(null)}
        >
          <WorkspaceIconGlyph icon="document" />
          <span>Use default</span>
        </button>
      ) : null}
      <div
        aria-label="Icons"
        className="workspace-icon-picker__grid"
        onKeyDown={moveThroughGrid}
        role="group"
      >
        {task ? null : (
          <button
            aria-label="Initials"
            aria-pressed={value === null}
            className="workspace-icon-picker__option"
            onClick={() => onChange(null)}
            title="Initials"
            type="button"
          >
            <span className="workspace-icon-picker__monogram">
              {workspaceMonogram(name) || "Aa"}
            </span>
          </button>
        )}
        {matches.map((icon) => (
          <button
            key={icon}
            aria-label={workspaceIconArt[icon].label}
            aria-pressed={value === icon}
            className="workspace-icon-picker__option"
            onClick={() => onChange(icon)}
            title={workspaceIconArt[icon].label}
            type="button"
          >
            <WorkspaceIconGlyph icon={icon} />
          </button>
        ))}
      </div>
      {matches.length === 0 ? (
        <p className="workspace-icon-picker__empty">No icons match “{query.trim()}”.</p>
      ) : null}
    </div>
  );
}

/** Arrow keys move by cell and by row, the way the grid is drawn. */
function moveThroughGrid(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
  const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const index = options.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const columns = getComputedStyle(event.currentTarget).gridTemplateColumns.split(" ").length;
  const delta =
    event.key === "ArrowDown"
      ? columns
      : event.key === "ArrowUp"
        ? -columns
        : event.key === "ArrowRight"
          ? 1
          : -1;
  const next = options[index + delta];
  // The popover's own arrows walk its controls in a line; inside the grid
  // they follow the grid instead.
  event.preventDefault();
  event.stopPropagation();
  next?.focus();
}
