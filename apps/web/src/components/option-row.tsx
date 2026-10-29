import type { ReactNode } from "react";

/**
 * One selectable choice in a list.
 *
 * Every list of choices in the product is built from this — the placement
 * choice in Settings, the connection kinds on first run, the Deployment
 * directory — so a choice is the same size, rhythm and target wherever a
 * reader meets one.
 *
 * Four shapes, one row:
 *   radio   — one answer among several, and the row is its label
 *   button  — the row goes somewhere or does something
 *   content — neutral layout for controls contained inside the row
 *   static  — an answer that exists but cannot be taken right now
 *
 * `framed` gives the row its own card. Leave it off inside a `.card` or a
 * bordered list, where the container already draws the frame.
 */
interface OptionRowBase {
  readonly ariaExpanded?: boolean;
  readonly className?: string;
  readonly detail?: ReactNode;
  readonly framed?: boolean;
  /** Leading slot: a glyph tile or a letter mark. */
  readonly leading?: ReactNode;
  /** A third line, quieter than the detail — why a row is unavailable. */
  readonly note?: ReactNode;
  readonly selected?: boolean;
  readonly title: ReactNode;
  /** Trailing slot: a chip, a chevron, a status. */
  readonly trailing?: ReactNode;
}

type OptionRowProps = OptionRowBase &
  (
    | {
        readonly as: "button";
        readonly disabled?: boolean;
        readonly onClick: () => void;
      }
    | {
        readonly as: "radio";
        readonly checked: boolean;
        readonly disabled?: boolean;
        readonly name: string;
        readonly onSelect: () => void;
        readonly value: string;
      }
    | { readonly as: "content" }
    | { readonly as: "static" }
  );

export function OptionRow(props: OptionRowProps) {
  const { ariaExpanded, className, detail, framed, leading, note, selected, title, trailing } =
    props;
  const classes = [
    "option-row",
    framed ? "option-row--framed" : null,
    (selected ?? (props.as === "radio" ? props.checked : false)) ? "is-selected" : null,
    props.as === "static" ? "is-unavailable" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      {leading}
      <span className="option-row__body">
        <span className="option-row__title">{title}</span>
        {detail ? <span className="option-row__detail">{detail}</span> : null}
        {note ? <span className="option-row__note">{note}</span> : null}
      </span>
      {trailing ? <span className="option-row__trailing">{trailing}</span> : null}
    </>
  );

  if (props.as === "radio") {
    return (
      <label className={classes}>
        <input
          checked={props.checked}
          className="option-row__control"
          disabled={props.disabled}
          name={props.name}
          onChange={props.onSelect}
          type="radio"
          value={props.value}
        />
        {body}
      </label>
    );
  }

  if (props.as === "static") {
    return (
      <div aria-disabled className={classes}>
        {body}
      </div>
    );
  }

  if (props.as === "content") return <div className={classes}>{body}</div>;

  return (
    <button
      aria-expanded={ariaExpanded}
      className={classes}
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      {body}
    </button>
  );
}
