import { memo, type ReactNode } from "react";

import type { ActionLineValue } from "./use-action.js";
export type { ActionLineValue } from "./use-action.js";

/**
 * The answer to a click, in one short line next to where it happened: never a
 * box or a toast. Its link, such as Check or Try again, stays in view however
 * the words are cut.
 */
export const ActionLine = memo(function ActionLine({
  line,
  onDismiss,
  wrap = false,
}: {
  readonly line: ActionLineValue;
  /** A refusal is dismissed by clicking it. */
  readonly onDismiss?: (() => void) | undefined;
  /** Two lines where there is room (under buttons); one where a row's height must hold. */
  readonly wrap?: boolean;
}) {
  const link = line.link ?? null;
  const className = [
    "action-line",
    line.tone === "danger" ? "action-line--danger" : "",
    wrap ? "action-line--wrap" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className} key={line.key}>
      {onDismiss === undefined ? (
        <span className="action-line__words">{line.text}</span>
      ) : (
        <button
          aria-description="Dismisses"
          className="action-line__words action-line__dismiss"
          onClick={onDismiss}
          type="button"
        >
          {line.text}
        </button>
      )}
      {link === null ? null : (
        <button
          aria-label={link.accessibilityLabel ?? link.label}
          className="action-line__link"
          onClick={link.onPress}
          type="button"
        >
          {link.label}
        </button>
      )}
    </span>
  );
});

/**
 * A list row's secondary line: its own text, or the outcome of an action on
 * the row in its place, at the same one-line height, so the row never grows.
 */
export function RowSubtitle({
  line,
  subtitle,
}: {
  readonly line: ActionLineValue | null;
  readonly subtitle: ReactNode;
}) {
  return (
    <span className="row-subtitle">
      {/* Always mounted, holding only the outcome, so a ticking subtitle is never read out. */}
      <span aria-live="polite" className="row-subtitle__line">
        {line === null ? null : <ActionLine line={line} />}
      </span>
      {line === null ? subtitle : null}
    </span>
  );
}

/**
 * A dialog's one-line slot above its footer buttons, reserved whether or not it
 * holds a line, so the buttons never jump when an outcome arrives.
 */
export function ActionLineSlot({
  line,
  onDismiss,
}: {
  readonly line: ActionLineValue | null;
  readonly onDismiss?: (() => void) | undefined;
}) {
  return (
    <div aria-live="polite" className="action-line-slot">
      {line === null ? null : <ActionLine line={line} onDismiss={onDismiss} />}
    </div>
  );
}
