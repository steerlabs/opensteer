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
  as = "div",
  checked,
  children,
  detail,
  icon,
  onClick,
  role,
  title,
  tone = "idle",
  trailing,
}: {
  /** A row that is itself the action — a choice, or a door to more — is a button. */
  readonly as?: "button" | "div";
  /** For a choice: whether it is the chosen one. */
  readonly checked?: boolean;
  /** Content the row opens to show: choices, a code to scan. */
  readonly children?: ReactNode;
  readonly detail?: ReactNode;
  /** Absent for a row with no mark, such as a choice of how to connect. */
  readonly icon?: ReactNode;
  readonly onClick?: () => void;
  readonly role?: "radio";
  readonly title: ReactNode;
  readonly tone?: SetupRowTone;
  readonly trailing?: ReactNode;
}) {
  const content = (
    <>
      {icon ? (
        <span aria-hidden className="setup-row__icon">
          {icon}
        </span>
      ) : null}
      <span className="setup-row__text">
        <span className="setup-row__title">{title}</span>
        {detail ? <span className="setup-row__detail">{detail}</span> : null}
      </span>
      {trailing ? <span className="setup-row__trailing">{trailing}</span> : null}
    </>
  );
  return (
    <li
      className={`setup-row setup-row--${tone}${children ? " setup-row--open" : ""}${
        checked ? " setup-row--checked" : ""
      }`}
    >
      {as === "button" ? (
        <button
          aria-checked={role === "radio" ? checked === true : undefined}
          className="setup-row__main setup-row__main--button"
          onClick={onClick}
          role={role}
          type="button"
        >
          {content}
        </button>
      ) : (
        <div className="setup-row__main">{content}</div>
      )}
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
