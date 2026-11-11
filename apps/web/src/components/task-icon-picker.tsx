import { useMemo, useState, type KeyboardEvent } from "react";
import { iconNames, markColors, type IconName, type MarkColor } from "@opensteer/core";
import { iconArt, markColorPaint } from "@opensteer/client/host";
import { IconGlyph } from "./icon-glyph.js";

/** A task's icon: search, a default, and the grid. */
export function TaskIconPicker({
  onChange,
  onColorChange,
  color,
  value,
}: {
  onChange: (icon: IconName | null) => void;
  color: MarkColor | null;
  value: IconName | null;
  onColorChange?: ((color: MarkColor) => void) | undefined;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return iconNames;
    return iconNames.filter(
      (icon) => icon.includes(needle) || iconArt[icon].label.toLocaleLowerCase().includes(needle),
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
      <button
        type="button"
        aria-label="Use default"
        aria-pressed={value === null || value === "document"}
        className="workspace-icon-picker__default"
        onClick={() => onChange(null)}
      >
        <IconGlyph icon="document" />
        <span>Use default</span>
      </button>
      <div
        aria-label="Icons"
        className="workspace-icon-picker__grid"
        onKeyDown={moveThroughGrid}
        role="group"
      >
        {matches.map((icon) => (
          <button
            key={icon}
            aria-label={iconArt[icon].label}
            aria-pressed={value === icon}
            className="workspace-icon-picker__option"
            onClick={() => onChange(icon)}
            title={iconArt[icon].label}
            type="button"
          >
            <IconGlyph icon={icon} />
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
