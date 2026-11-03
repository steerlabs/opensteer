import type { ReactNode } from "react";
import { Icon } from "../icon.js";

/**
 * The three things a person sets up, drawn the same way wherever they appear:
 * the first-run screen, the window before the app has started, and the
 * computer menu afterwards. A row names a real thing — this Mac, the AI that
 * does the work, a phone — says how it stands in a word or two, and offers at
 * most one action. Anything longer than that opens inside the row.
 */
export function SetupList({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <ul aria-label={label} className="setup-list">
      {children}
    </ul>
  );
}

export type SetupRowTone = "attention" | "idle" | "missing" | "ready" | "waiting";

export function SetupRow({
  children,
  detail,
  icon,
  title,
  tone = "idle",
  trailing,
}: {
  /** Content the row opens to show: choices, a code to scan. */
  readonly children?: ReactNode;
  readonly detail?: ReactNode;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly tone?: SetupRowTone;
  readonly trailing?: ReactNode;
}) {
  return (
    <li className={`setup-row setup-row--${tone}${children ? " setup-row--open" : ""}`}>
      <div className="setup-row__main">
        <span aria-hidden className="setup-row__icon">
          {icon}
        </span>
        <span className="setup-row__text">
          <span className="setup-row__title">{title}</span>
          {detail ? <span className="setup-row__detail">{detail}</span> : null}
        </span>
        {trailing ? <span className="setup-row__trailing">{trailing}</span> : null}
      </div>
      {children ? <div className="setup-row__more">{children}</div> : null}
    </li>
  );
}

/** How a row stands, in one word: a lit chip when it is done, a spinner while it works. */
export function SetupStatus({
  label,
  state,
}: {
  readonly label: string;
  readonly state: "attention" | "ready" | "working";
}) {
  if (state === "working") {
    return (
      <span className="setup-status" role="status">
        <span aria-hidden className="spinner" />
        <span className="visually-hidden">{label}</span>
      </span>
    );
  }
  return (
    <span className={`chip ${state === "ready" ? "chip--ok" : "chip--warn"} setup-status__chip`}>
      {state === "ready" ? <Icon name="check" /> : null}
      {label}
    </span>
  );
}
