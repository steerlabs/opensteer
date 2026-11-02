import { useRef, useState } from "react";
import type { WorkspaceIconName } from "@opensteer/core";
import { workspaceIconArt } from "@opensteer/client/host";
import { Dialog } from "./dialog.js";
import { WorkspaceIconPicker } from "./workspace-icon-picker.js";
import { WorkspaceIconGlyph } from "./workspace-orb.js";

export interface NewWorkspaceDialogProps {
  readonly creating: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onCreate: (input: {
    readonly icon: WorkspaceIconName | null;
    readonly name: string;
  }) => void;
}

export function NewWorkspaceDialog({
  creating,
  error,
  onClose,
  onCreate,
}: NewWorkspaceDialogProps) {
  const [icon, setIcon] = useState<WorkspaceIconName | null>(null);
  const [choosingIcon, setChoosingIcon] = useState(false);
  const iconButton = useRef<HTMLButtonElement | null>(null);
  const [name, setName] = useState("");
  const submittable = name.trim().length > 0 && !creating;
  return (
    <Dialog labelledBy="new-workspace-title" onClose={onClose} title="New project">
      <form
        className="card__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submittable) return;
          onCreate({
            icon,
            name: name.trim(),
          });
        }}
      >
        <p className="section__hint">
          An agent with its own files, browsers and sign-ins. Opensteer can hand it work, and you
          can start tasks in it yourself.
        </p>
        <label className="field">
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

        <div className="field">
          <span className="field__label">Icon</span>
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
              name={name}
              onChange={(next) => {
                setIcon(next);
                setChoosingIcon(false);
                // The chosen option leaves with the picker; focus goes back to
                // the field it belongs to rather than to the page.
                iconButton.current?.focus();
              }}
              color={null}
              value={icon}
            />
          ) : null}
        </div>

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
