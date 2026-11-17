import type { ReactNode } from "react";

/*
 * DOM stand-ins for the action line and placeholders, for
 * `vi.mock("../ui/action-line.js", () => import(...))`: the words, the link
 * as a button, and a tap that dismisses. Placeholders read "Not loaded yet".
 */

type Line = {
  readonly text: string;
  readonly link?: { readonly label: string; readonly onPress: () => void } | null;
};

function Words(props: { readonly line: Line; readonly onDismiss?: (() => void) | undefined }) {
  return (
    <p data-role="action-line">
      {props.onDismiss ? (
        <button onClick={props.onDismiss}>{props.line.text}</button>
      ) : (
        props.line.text
      )}
      {props.line.link ? (
        <button aria-label={props.line.link.label} onClick={props.line.link.onPress}>
          {props.line.link.label}
        </button>
      ) : null}
    </p>
  );
}

export const actionLine = {
  ActionLine: Words,
  ActionLineSlot: (props: { readonly line: Line | null; readonly onDismiss?: () => void }) =>
    props.line === null ? null : <Words line={props.line} onDismiss={props.onDismiss} />,
  RowSubtitle: (props: { readonly subtitle: ReactNode; readonly line: Line | null }) =>
    props.line === null ? <span>{props.subtitle}</span> : <Words line={props.line} />,
};

export const placeholder = {
  PlaceholderRows: () => <div aria-label="Not loaded yet" />,
  PlaceholderValue: () => <span aria-label="Not loaded yet" />,
  UnknownToggle: (props: { readonly accessibilityLabel: string }) => (
    <span aria-label={props.accessibilityLabel} data-value="unknown" />
  ),
  UnknownValue: () => <span aria-label="Not loaded yet">–</span>,
};
