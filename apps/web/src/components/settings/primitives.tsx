import { Dialog } from "../dialog.js";
import { useState, type ReactNode } from "react";
import type { DeploymentDisplayKind } from "@opensteer/core";
import {
  deploymentStatusLabel,
  deploymentStatusTone,
  type DeploymentStatusInfo,
} from "@opensteer/protocol/deployment-status";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";
import { Icon } from "../icon.js";
import type { SettingsFacts } from "./copy.js";

/**
 * Everything every section of Settings needs to know about the place it is
 * describing, derived once by the shell.
 *
 * Sections used to each re-derive "which kind of place is this, and is it
 * reachable" from whatever was nearest to hand, which is how one screen came
 * to show two different statuses for one Deployment. There is one derivation,
 * it happens in the shell, and it arrives here.
 */
export interface SettingsView {
  readonly deployment: DesktopDeploymentSummary | null;
  readonly kind: DeploymentDisplayKind;
  /** True when this Deployment's only identity is the implicit machine owner. */
  readonly machineOwner: boolean;
  readonly name: string;
  readonly facts: SettingsFacts;
  readonly statusInfo: DeploymentStatusInfo;
}

/** The 7px dot every status wears; `starting` pulses, motion settings allowing. */
export function StatusDot({ info }: { readonly info: DeploymentStatusInfo }) {
  const tone = deploymentStatusTone(info.status);
  return (
    <span
      aria-hidden
      className={`status-dot status-dot--${tone}${info.status === "starting" ? " status-dot--pulse" : ""}`}
    />
  );
}

/** Dot plus word: a status read at a glance, never a control. */
export function StatusText({ info }: { readonly info: DeploymentStatusInfo }) {
  return (
    <span className="settings-status" role="status">
      <StatusDot info={info} />
      {deploymentStatusLabel(info.status)}
    </span>
  );
}

/** The heading block each Settings section opens with. */
export function SectionHeader({
  lead,
  title,
  action,
}: {
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
  readonly title: string;
}) {
  return (
    <header className="settings-section__header">
      <div className="settings-section__title-row">
        <h1 className="settings-section__title">{title}</h1>
        {action}
      </div>
      {lead ? <p className="settings-section__lead">{lead}</p> : null}
    </header>
  );
}

/**
 * One fact about this place: what it is, what it means, and at most one
 * control. Every row in Settings is this row, so a reader never has to work
 * out which of two shapes they are looking at.
 */
export function SettingsRow({
  action,
  className,
  detail,
  title,
}: {
  readonly action?: ReactNode;
  readonly className?: string;
  readonly detail?: ReactNode;
  readonly title: ReactNode;
}) {
  return (
    <div className={className ? `card__row ${className}` : "card__row"}>
      <span className="card__row-body">
        <span className="card__row-title">{title}</span>
        {detail ? <span className="card__row-detail">{detail}</span> : null}
      </span>
      {action ? <span className="card__row-actions">{action}</span> : null}
    </div>
  );
}

/** A titled card between sections' cards — "Devices with access", and friends. */
export function SettingsGroup({
  children,
  heading,
  headingId,
  note = null,
}: {
  readonly children: ReactNode;
  /** Null when the card's only row already names the group. */
  readonly heading: string | null;
  readonly headingId: string;
  /** The sentence under the card: what turning this off would take with it. */
  readonly note?: ReactNode;
}) {
  return (
    <section aria-labelledby={heading ? headingId : undefined} className="settings-group">
      {heading ? (
        <h2 className="settings-group__title" id={headingId}>
          {heading}
        </h2>
      ) : null}
      <div className="card">{children}</div>
      {note ? <p className="settings-footnote">{note}</p> : null}
    </section>
  );
}

/**
 * The one error shape in Settings. It renders inside the section whose control
 * produced it, directly under that card, so a reader never has to reconcile a
 * banner at the top of the page with a button three cards down.
 */
export function SettingsError({ message }: { readonly message: string | null }) {
  if (!message) return null;
  return (
    <p aria-live="assertive" className="notice notice--error" role="alert">
      <Icon name="alert-circle" />
      <span>{message}</span>
    </p>
  );
}

/** A small set of mutually exclusive choices, side by side. */
export function SettingsSegmented<T extends string>({
  disabled = false,
  label,
  onChange,
  options,
  value,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
}) {
  return (
    <div aria-label={label} className="settings-segmented" role="group">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function formatWhen(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

/** Shared, labelled on/off control with a generous hit area. */
export function SettingsSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-switch-target">
      <input
        className="switch"
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

/** A quiet "Sign out" on a device's row; the effect is spelled out before it happens. */
export function SettingsSignOut({
  label,
  warning,
  pending,
  onConfirm,
}: {
  readonly label: string;
  readonly warning: string;
  readonly pending: boolean;
  readonly onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        aria-label={label}
        className="settings-link"
        disabled={pending}
        onClick={() => setConfirming(true)}
        type="button"
      >
        Sign out
      </button>
      {confirming ? (
        <Dialog
          title="Sign out this device?"
          labelledBy="sign-out-device-title"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirming(false)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                type="button"
                disabled={pending}
                onClick={onConfirm}
              >
                {pending ? "Signing out…" : "Sign out"}
              </button>
            </>
          }
        >
          <p>{warning}</p>
        </Dialog>
      ) : null}
    </>
  );
}
