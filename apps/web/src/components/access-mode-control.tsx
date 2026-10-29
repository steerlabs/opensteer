import { useRef, useState } from "react";
import type { ThreadAccessMode } from "@opensteer/core";
import { accessModeOptions, accessModeUnavailableReason } from "@opensteer/client/host";
import { composerFold } from "./fold-to-fit.js";
import { Icon, type IconName } from "./icon.js";
import { Popover } from "./popover.js";

/** The engine a mode would be asked of, and what it says it can enforce. */
export interface AccessModeEngine {
  readonly accessModes: readonly ThreadAccessMode[] | null;
  readonly engineName: string;
}

interface AccessModeControlProps {
  disabled?: boolean;
  /** Null while no engine is chosen: nothing is ruled out yet. */
  engine: AccessModeEngine | null;
  mode: ThreadAccessMode;
  onApply: (mode: ThreadAccessMode) => Promise<void> | void;
}

/**
 * Each mode's own mark, so the pill still says which mode is in force once a
 * narrow composer has folded its words away: a raised hand asks first, a
 * pencil lets edits through, a shield lets a guard decide, an open lock lets
 * everything through. The menu draws the same marks beside the names, which
 * is where they are learned. Every mode is drawn in the same ink: Full access
 * is the default, so a warning tone on it would be on almost always and would
 * stop meaning anything.
 */
export const accessModeGlyph: Record<ThreadAccessMode, IconName> = {
  "approval-required": "hand",
  "auto-accept-edits": "pencil",
  auto: "shield",
  "full-access": "unlock",
};

export function AccessModeControl({
  disabled = false,
  engine,
  mode,
  onApply,
}: AccessModeControlProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const current = accessModeOptions.find((option) => option.mode === mode);
  const label = current?.label ?? mode;
  // A mode the chosen engine cannot enforce stays named, marked, and explained:
  // the composer will not start work in it until another mode is chosen.
  const conflict = engine ? accessModeUnavailableReason(mode, engine) : null;

  const apply = async (nextMode: ThreadAccessMode) => {
    if (nextMode === mode) {
      setOpen(false);
      return;
    }
    setPending(true);
    try {
      await onApply(nextMode);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={conflict ? `Access mode: ${label} (unavailable)` : `Access mode: ${label}`}
        className={conflict ? "exec-pill is-unavailable" : "exec-pill"}
        data-fold={composerFold.access}
        disabled={disabled || pending}
        onClick={() => setOpen((value) => !value)}
        ref={anchorRef}
        title={conflict ?? (current ? `${current.label}\n${current.description}` : label)}
        type="button"
      >
        <Icon name={accessModeGlyph[mode]} />
        <span className="exec-pill__label">{label}</span>
        <Icon className="exec-pill__chevron" name="chevron-down" />
      </button>
      {open && anchorRef.current ? (
        <Popover
          anchor={anchorRef.current}
          className="access-mode-popover"
          label="Access mode"
          onClose={() => setOpen(false)}
        >
          <AccessModePanel
            engine={engine}
            mode={mode}
            onSelect={(nextMode) => void apply(nextMode)}
          />
        </Popover>
      ) : null}
    </>
  );
}

export function AccessModePanel({
  engine,
  mode,
  onSelect,
}: {
  engine: AccessModeEngine | null;
  mode: ThreadAccessMode;
  onSelect: (mode: ThreadAccessMode) => void;
}) {
  return (
    <div aria-label="Access mode" className="picker__section" role="group">
      <span className="picker__heading">Access</span>
      {accessModeOptions.map((option) => {
        const selected = option.mode === mode;
        // A mode the engine does not enforce is refused by the Host, so it is
        // offered as unusable with the reason rather than silently downgraded.
        const unavailable = engine ? accessModeUnavailableReason(option.mode, engine) : null;
        return (
          <button
            aria-checked={selected}
            // Not `disabled`: a disabled button cannot take focus, and the
            // reason it is unusable is the one thing the row has to say.
            aria-disabled={unavailable !== null}
            className="picker__row"
            key={option.mode}
            onClick={() => {
              if (unavailable === null) onSelect(option.mode);
            }}
            role="menuitemradio"
            type="button"
          >
            <span className="picker__check">{selected ? <Icon name="check" /> : null}</span>
            <span className="picker__glyph">
              <Icon name={accessModeGlyph[option.mode]} />
            </span>
            <span className="picker__label-stack">
              <span className="picker__label">{option.label}</span>
              <span className="picker__detail">{unavailable ?? option.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
