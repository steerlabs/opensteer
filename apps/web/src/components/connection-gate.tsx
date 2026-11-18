import { memo, useState, type ReactNode } from "react";
import { BrandMark } from "./brand.js";

export interface ConnectionGateButton {
  readonly label: string;
  readonly onPress: () => void;
  /** Trying: the label stays and the button says it is busy. */
  readonly busy?: boolean;
}

/**
 * The one explanation while there is nothing usable to show: the app's splash
 * with a title and a way on, or the same inside the main column for a route.
 * Connecting is only a muted line, and it waits a moment before it is seen, so
 * a quick connect never flashes it.
 */
export const ConnectionGate = memo(function ConnectionGate(props: {
  /** Changes only when the meaning changes; it keys the cross-fade. */
  readonly stateKey: string;
  /** The whole window (with the brand mark) or the main column. */
  readonly scope: "app" | "route";
  /** Null for connecting: no title or buttons. */
  readonly title: string | null;
  readonly detail: string;
  readonly primary?: ConnectionGateButton | null;
  readonly secondary?: ConnectionGateButton | null;
}) {
  const Root = props.scope === "app" ? "main" : "div";
  return (
    <Root
      className={
        props.scope === "app" ? "splash connection-gate" : "connection-gate connection-gate--route"
      }
    >
      <div className="splash__inner connection-gate__inner" aria-live="polite" key={props.stateKey}>
        {props.scope === "app" ? <BrandMark large /> : null}
        {props.title === null ? null : <h1 className="connection-gate__title">{props.title}</h1>}
        {props.detail ? <p className="splash__detail">{props.detail}</p> : null}
        {props.primary || props.secondary ? (
          <div className="connection-gate__actions">
            {props.primary ? <GateButton button={props.primary} primary /> : null}
            {props.secondary ? <GateButton button={props.secondary} primary={false} /> : null}
          </div>
        ) : null}
      </div>
    </Root>
  );
});

function GateButton(props: { readonly button: ConnectionGateButton; readonly primary: boolean }) {
  const busy = props.button.busy === true;
  return (
    <button
      aria-busy={busy}
      aria-disabled={busy}
      className={props.primary ? "btn btn--primary" : "btn"}
      onClick={busy ? undefined : props.button.onPress}
      type="button"
    >
      {props.button.label}
    </button>
  );
}

/**
 * A view behind its gate. While `gate` is set only the gate is drawn; when it
 * clears, the content renders in that same frame under the gate, which fades
 * away over it, so there is never an empty state or a second swap between.
 */
export function Gated(props: { readonly children: ReactNode; readonly gate: ReactNode | null }) {
  const [leaving, setLeaving] = useState<ReactNode | null>(null);
  const [last, setLast] = useState<ReactNode | null>(props.gate);
  if (props.gate !== null && props.gate !== last) setLast(props.gate);
  if (props.gate === null && last !== null) {
    setLeaving(last);
    setLast(null);
  }
  if (props.gate !== null) return <div className="gated">{props.gate}</div>;
  return (
    <div className="gated">
      {props.children}
      {leaving === null ? null : (
        <div
          aria-hidden
          className="gated__leaving"
          inert
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setLeaving(null);
          }}
        >
          {leaving}
        </div>
      )}
    </div>
  );
}
