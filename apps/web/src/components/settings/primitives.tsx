import type { ReactNode } from "react";
import type { DeploymentDisplayKind } from "@opensteer/core";
import {
  deploymentStatusLabel,
  deploymentStatusTone,
  type DeploymentStatusInfo,
  type DeploymentStatusTone,
} from "@opensteer/protocol/deployment-status";
import type { DesktopDeploymentSummary } from "@opensteer/protocol/desktop";
import { Icon, type IconName } from "../icon.js";
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
  /** Whether this person may administer Deployment settings and devices. */
  readonly administrator: boolean;
  readonly deployment: DesktopDeploymentSummary | null;
  readonly kind: DeploymentDisplayKind;
  /**
   * True when this Deployment's only identity is the implicit machine owner.
   * This deployment-level fact is not evidence that this session is machine-local.
   */
  readonly machineOwner: boolean;
  readonly name: string;
  readonly facts: SettingsFacts;
  readonly statusInfo: DeploymentStatusInfo;
}

/** The glyph a kind of place wears, everywhere it is drawn. */
export function deploymentGlyph(kind: DeploymentDisplayKind): IconName {
  if (kind === "personal") return "home";
  return "server";
}

const toneClasses: Readonly<Record<DeploymentStatusTone, string>> = {
  busy: "chip--warn",
  muted: "",
  ok: "chip--ok",
  warn: "chip--warn",
};

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

/** Dot plus word, for a row's trailing slot. */
export function StatusLine({
  info,
  qualifier = null,
}: {
  readonly info: DeploymentStatusInfo;
  readonly qualifier?: string | null;
}) {
  return (
    <span className="status-line">
      <StatusDot info={info} />
      <span>
        {deploymentStatusLabel(info.status)}
        {qualifier ? <span className="status-line__qualifier"> · {qualifier}</span> : null}
      </span>
    </span>
  );
}

/** Dot plus word in a chip, for the identity strip at the top of a section. */
export function StatusChip({ info }: { readonly info: DeploymentStatusInfo }) {
  const tone = toneClasses[deploymentStatusTone(info.status)];
  return (
    <span className={tone ? `chip ${tone}` : "chip"} role="status">
      <StatusDot info={info} />
      {deploymentStatusLabel(info.status)}
    </span>
  );
}

/** The heading block each Settings section opens with. */
export function SectionHeader({
  lead,
  title,
}: {
  readonly lead: ReactNode;
  readonly title: string;
}) {
  return (
    <header className="settings-section__header">
      <h1 className="settings-section__title">{title}</h1>
      <p className="settings-section__lead">{lead}</p>
    </header>
  );
}

/**
 * One fact about this place: a glyph, what it is, what it means, and at most
 * one control. Every row in Settings is this row, so a reader never has to
 * work out which of two shapes they are looking at.
 */
export function SettingsRow({
  action,
  className,
  detail,
  icon,
  title,
}: {
  readonly action?: ReactNode;
  readonly className?: string;
  readonly detail?: ReactNode;
  readonly icon: IconName;
  readonly title: ReactNode;
}) {
  return (
    <div className={className ? `card__row ${className}` : "card__row"}>
      <span className="card__row-glyph">
        <Icon name={icon} />
      </span>
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
  readonly heading: string;
  readonly headingId: string;
  /** The sentence under the card: what turning this off would take with it. */
  readonly note?: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="settings-group">
      <h2 className="settings-group__title" id={headingId}>
        {heading}
      </h2>
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

export function formatWhen(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
