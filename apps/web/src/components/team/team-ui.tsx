import type { ReactNode } from "react";
import {
  accessPreviewHeadline,
  accessPreviewLines,
  initialsOf,
  levelLabel,
  teamErrorText,
  teamReasonOf,
  teamReasonText,
  type AccessPreviewLine,
} from "@opensteer/client/host";
import { useTeam } from "@opensteer/client/react";
import type { AccessPreview, Can, Level } from "@opensteer/protocol";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";

export function useShellTeam() {
  const { hostClient } = useShell();
  return useTeam(hostClient);
}

export function TeamAvatar({
  name,
  group = false,
}: {
  readonly name: string;
  readonly group?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={`card__row-glyph team-avatar${group ? " team-avatar--group" : ""}`}
    >
      {group ? <Icon name="users" /> : initialsOf(name)}
    </span>
  );
}

/** The team's own mark: its initial on a quiet tile, as the phone's place mark draws it. */
export function TeamMark({
  name,
  size = "small",
}: {
  readonly name: string;
  readonly size?: "small" | "large";
}) {
  return (
    <span aria-hidden className={`team-mark team-mark--${size}`}>
      {initialsOf(name).slice(0, 1)}
    </span>
  );
}

export function LevelPicker({
  disabled = false,
  label,
  onChange,
  value,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (level: Level) => void;
  readonly value: Level;
}) {
  return (
    <div aria-label={label} className="settings-segmented team-level" role="group">
      {(["use", "manage"] as const).map((level) => (
        <button
          aria-pressed={value === level}
          disabled={disabled}
          key={level}
          onClick={() => onChange(level)}
          type="button"
        >
          {levelLabel(level)}
        </button>
      ))}
    </div>
  );
}

/** The Host's no, in words, where a person would otherwise look for the button. */
export function CanNote({ can, team }: { readonly can: Can | undefined; readonly team?: string }) {
  if (!can || can.allowed || !can.reason) return null;
  return <p className="settings-footnote team-can-note">{teamReasonText(can.reason, team)}</p>;
}

export function TeamError({
  error,
  onRetry,
  team,
}: {
  readonly error: unknown;
  readonly onRetry?: (() => void) | undefined;
  readonly team?: string;
}) {
  if (!error) return null;
  return (
    <p aria-live="assertive" className="notice notice--error" role="alert">
      <Icon name="alert-circle" />
      <span>{teamErrorText(error, team)}</span>
      {onRetry ? (
        <button className="link-btn" onClick={onRetry} type="button">
          {teamReasonOf(error) === "access-revision-changed" ? "Review again" : "Try again"}
        </button>
      ) : null}
    </p>
  );
}

/** Where a person stands with the team, when the Host says they can't be here at all. */
export function TeamStateNotice({
  error,
  team = "the team",
}: {
  readonly error: unknown;
  readonly team?: string;
}) {
  const reason = teamReasonOf(error);
  if (reason !== "member-suspended" && reason !== "member-removed") return null;
  return (
    <div className="notice notice--warn team-state" role="status">
      <Icon name="alert-circle" />
      <div>
        <strong>
          {reason === "member-suspended"
            ? `Your access to ${team} is paused`
            : `You’re no longer in ${team}`}
        </strong>
        <p>
          {reason === "member-suspended"
            ? "Ask an admin to turn it back on. Your own Opensteer still works."
            : "Its projects are gone from here. Your own Opensteer still works."}
        </p>
      </div>
    </div>
  );
}

const toneIcon: Record<
  AccessPreviewLine["tone"],
  "plus" | "close" | "repeat" | "check" | "alert-circle"
> = {
  gain: "plus",
  lose: "close",
  change: "repeat",
  keep: "check",
  blocked: "alert-circle",
};

/** Who gains and loses what, and which paths survive, before anything is saved. */
export function AccessPreviewPanel({
  names,
  preview,
  team,
}: {
  readonly names?: ReadonlyMap<string, string> | undefined;
  readonly preview: AccessPreview | null;
  readonly team?: string;
}) {
  if (!preview)
    return <p className="team-preview team-preview--loading">Checking who this changes…</p>;
  const lines = accessPreviewLines(preview, names, team);
  return (
    <div className={`team-preview${preview.allowed ? "" : " team-preview--blocked"}`} role="status">
      <p className="team-preview__headline">
        {preview.allowed ? accessPreviewHeadline(preview) : "This can’t be saved."}
      </p>
      {lines.length ? (
        <ul className="team-preview__lines">
          {lines.map((line) => (
            <li
              className={`team-preview__line team-preview__line--${line.tone}`}
              key={`${line.tone}:${line.text}`}
            >
              <Icon name={toneIcon[line.tone]} />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TeamSection({
  action,
  children,
  hint,
  id,
  title,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly hint?: ReactNode;
  readonly id: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={id} className="section">
      <div className="section__head">
        <h2 className="section__title" id={id}>
          {title}
        </h2>
        {action}
      </div>
      {hint ? <p className="section__hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function formatDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
    new Date(value),
  );
}
