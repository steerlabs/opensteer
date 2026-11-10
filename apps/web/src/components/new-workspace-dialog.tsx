import { useRef, useState } from "react";
import { markColors, type MarkColor, type WorkspaceIconName } from "@opensteer/core";
import { markColorPaint, workspaceIconArt } from "@opensteer/client/host";
import { Dialog } from "./dialog.js";
import { WorkspaceIconPicker } from "./workspace-icon-picker.js";
import { WorkspaceIconGlyph, WorkspaceOrb } from "./workspace-orb.js";

export interface NewWorkspaceDialogProps {
  /** The Host can keep a Project's colour (`task-marks-v1`). */
  readonly colors?: boolean;
  /** A team project has a name and a colour, and no icon. */
  readonly team?: string | null;
  readonly creating: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onCreate: (input: {
    readonly color: MarkColor | null;
    readonly icon: WorkspaceIconName | null;
    readonly name: string;
  }) => void;
}

/**
 * A Project is a name and a mark; everything else — who is in it, what it
 * may use, which plugins it runs — is decided later, on its own page, by
 * whoever needs it. So this asks for nothing more.
 */
export function NewWorkspaceDialog({
  colors = false,
  team = null,
  creating,
  error,
  onClose,
  onCreate,
}: NewWorkspaceDialogProps) {
  const [icon, setIcon] = useState<WorkspaceIconName | null>(null);
  const [color, setColor] = useState<MarkColor | null>(null);
  const [choosingIcon, setChoosingIcon] = useState(false);
  const iconButton = useRef<HTMLButtonElement | null>(null);
  const [name, setName] = useState("");
  const submittable = name.trim().length > 0 && !creating;
  return (
    <Dialog labelledBy="new-workspace-title" onClose={onClose} title="New project">
      <form
        className="card__form new-project"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submittable) return;
          onCreate({
            color: colors || team ? color : null,
            icon: team ? null : icon,
            name: name.trim(),
          });
        }}
      >
        <p className="section__hint">
          {team
            ? `A shared project in ${team}. You’ll manage it: choose who can use it and how it runs on ${team}’s computer.`
            : "A folder inside Main with its own chat, tasks and instructions. It can use only what you allow it."}
        </p>
        <div className="new-project__identity">
          <WorkspaceOrb
            color={colors || team ? color : null}
            icon={team ? null : icon}
            name={name.trim()}
            size="large"
          />
          <label className="field new-project__name">
            <span className="field__label">Name</span>
            <input
              autoFocus
              className="text-input"
              maxLength={160}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Research"
              value={name}
            />
          </label>
        </div>

        {team ? (
          <div className="field">
            <span className="field__label">Colour</span>
            <div className="workspace-icon-picker__colors" role="group" aria-label="Colour">
              {markColors.map((next) => (
                <button
                  aria-label={next[0]!.toUpperCase() + next.slice(1)}
                  aria-pressed={color === next}
                  key={next}
                  onClick={() => setColor(next)}
                  style={{
                    background: `linear-gradient(140deg, ${markColorPaint[next].tile.join(", ")})`,
                  }}
                  type="button"
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="field">
            <span className="field__label">{colors ? "Icon and colour" : "Icon"}</span>
            <button
              aria-expanded={choosingIcon}
              className="btn btn--small new-workspace-icon"
              onClick={() => setChoosingIcon(!choosingIcon)}
              ref={iconButton}
              type="button"
            >
              {icon ? <WorkspaceIconGlyph icon={icon} /> : null}
              {icon ? workspaceIconArt[icon].label : "Initials"}
            </button>
            {/* Inline rather than a popover, so it stays inside the dialog's
              focus trap and accessible subtree. */}
            {choosingIcon ? (
              <WorkspaceIconPicker
                color={colors ? color : null}
                name={name}
                onChange={(next) => {
                  setIcon(next);
                  setChoosingIcon(false);
                  // The chosen option leaves with the picker; focus goes back to
                  // the field it belongs to rather than to the page.
                  iconButton.current?.focus();
                }}
                onColorChange={colors ? setColor : undefined}
                value={icon}
              />
            ) : null}
          </div>
        )}

        {error ? (
          <p aria-live="polite" className="notice notice--warn">
            {error}
          </p>
        ) : null}

        <div className="form-actions">
          <button className="btn" disabled={creating} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!submittable} type="submit">
            {creating ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
