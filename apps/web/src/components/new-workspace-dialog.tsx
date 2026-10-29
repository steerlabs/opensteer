import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { WorkspaceIconName } from "@opensteer/core";
import {
  machineChoiceLabel,
  noWorkspaceStorageExplanation,
  workspaceIconArt,
  workspaceStorageMachines,
  type EnvironmentSummary,
} from "@opensteer/client/host";
import { Dialog } from "./dialog.js";
import { WorkspaceIconPicker } from "./workspace-icon-picker.js";
import { WorkspaceIconGlyph } from "./workspace-orb.js";

export interface NewWorkspaceStorageChoice {
  readonly backing: "local-directory" | "portablefs";
  readonly environmentId?: string;
}

export interface NewWorkspaceDialogProps {
  readonly creating: boolean;
  readonly defaultBacking: "local-directory" | "portablefs";
  readonly environments: readonly EnvironmentSummary[];
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onCreate: (input: {
    readonly icon: WorkspaceIconName | null;
    readonly name: string;
    readonly storage: NewWorkspaceStorageChoice;
  }) => void;
  readonly sharedStorageAvailable: boolean;
}

/**
 * Where a new Workspace's files go is only worth asking about when there is
 * more than one real answer. With one machine and no shared storage this is a
 * name field, which is all it was before machines could be lent.
 */
export function NewWorkspaceDialog({
  creating,
  defaultBacking,
  environments,
  error,
  onClose,
  onCreate,
  sharedStorageAvailable,
}: NewWorkspaceDialogProps) {
  const [icon, setIcon] = useState<WorkspaceIconName | null>(null);
  const [choosingIcon, setChoosingIcon] = useState(false);
  const iconButton = useRef<HTMLButtonElement | null>(null);
  const machines = useMemo(() => workspaceStorageMachines(environments), [environments]);
  // Creating a folder needs the machine that owns the disk to answer now: the
  // Host has no durable creation intent to fall back on, so an offline computer
  // is shown as a computer and refused as a choice rather than accepted and
  // then rejected by the Host.
  const availableMachines = useMemo(
    () => machines.filter((machine) => machine.connected),
    [machines],
  );
  const [name, setName] = useState("");
  const [backing, setBacking] = useState<"local-directory" | "portablefs">(
    sharedStorageAvailable && (defaultBacking === "portablefs" || availableMachines.length === 0)
      ? "portablefs"
      : "local-directory",
  );
  const [environmentId, setEnvironmentId] = useState(availableMachines[0]?.id ?? "");
  const offersBackingChoice =
    sharedStorageAvailable && (machines.length > 0 || backing === "local-directory");
  const chosenMachine = availableMachines.find((machine) => machine.id === environmentId);
  const offersMachineChoice =
    backing === "local-directory" && (machines.length > 1 || !chosenMachine);
  const submittable =
    name.trim().length > 0 &&
    !creating &&
    (backing === "portablefs" ? sharedStorageAvailable : chosenMachine !== undefined);

  if (!sharedStorageAvailable && availableMachines.length === 0) {
    return (
      <Dialog labelledBy="new-workspace-title" onClose={onClose} title="New specialist">
        <div className="card__form">
          <p className="section__hint">{noWorkspaceStorageExplanation(machines.length)}</p>
          <div className="form-actions">
            <button className="btn" onClick={onClose} type="button">
              Close
            </button>
            <Link className="btn btn--primary" onClick={onClose} to="/settings/computers">
              Go to Computers
            </Link>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog labelledBy="new-workspace-title" onClose={onClose} title="New specialist">
      <form
        className="card__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submittable) return;
          onCreate({
            icon,
            name: name.trim(),
            storage:
              backing === "local-directory"
                ? { backing: "local-directory", environmentId: chosenMachine?.id ?? "" }
                : { backing: "portablefs" },
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

        {offersBackingChoice ? (
          <div aria-label="Where its files live" className="check-list" role="radiogroup">
            <label className="check-item">
              <input
                checked={backing === "local-directory"}
                name="new-workspace-backing"
                onChange={() => setBacking("local-directory")}
                type="radio"
              />
              <span className="check-item__meta">
                <span className="check-item__label">On one computer</span>
                <span className="check-item__detail">
                  A folder on that machine&apos;s own disk. Agents run there.
                </span>
              </span>
            </label>
            <label className="check-item">
              <input
                checked={backing === "portablefs"}
                name="new-workspace-backing"
                onChange={() => setBacking("portablefs")}
                type="radio"
              />
              <span className="check-item__meta">
                <span className="check-item__label">Shared storage</span>
                <span className="check-item__detail">
                  Computers with shared storage enabled can mount it.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {offersMachineChoice ? (
          <label className="field">
            <span className="field__label">Computer</span>
            <select
              className="select-input"
              onChange={(event) => setEnvironmentId(event.currentTarget.value)}
              value={environmentId}
            >
              {!machines.some((machine) => machine.id === environmentId) ? (
                <option disabled value={environmentId}>
                  Choose a computer
                </option>
              ) : null}
              {machines.map((machine) => (
                <option disabled={!machine.connected} key={machine.id} value={machine.id}>
                  {machineChoiceLabel(machine, machines)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {backing === "local-directory" && machines.length > availableMachines.length ? (
          <p className="section__hint">
            An offline computer cannot be chosen: it has to be on to make the folder.
          </p>
        ) : null}

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
            {creating ? "Creating…" : "Create specialist"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
