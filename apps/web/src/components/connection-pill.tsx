import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";

/** What the pill says about one connection while it is interrupted. */
export interface ConnectionPillNotice {
  /** Changes only when the meaning changes; it keys the cross-fade and the announcement. */
  readonly key: string;
  readonly label: string;
  readonly tone: "muted" | "amber";
  /** An attempt is in flight: the dot breathes only then. */
  readonly trying: boolean;
  readonly action: {
    readonly label: string;
    readonly accessibilityLabel?: string;
    readonly onPress: () => void;
  } | null;
}

export interface ConnectionDetailsSession {
  readonly key: string;
  readonly name: string;
  readonly state: string;
  readonly onPress: () => void;
}

export interface ConnectionDetailsProps {
  /** The place's or team's mark, drawn beside its name. */
  readonly mark: ReactNode;
  readonly name: string;
  readonly state: string;
  readonly explanation: string;
  readonly action: {
    readonly label: string;
    readonly onPress: () => void;
    readonly busy?: boolean;
  } | null;
  /** "Last connected 9:41 · via your network"; null when nothing is known. */
  readonly meta: string | null;
  /** Other places with trouble, listed after this one. */
  readonly others: readonly ConnectionDetailsSession[];
}

/**
 * Where an interrupted connection is said, once, over the main column (never
 * the sidebar). Its words are a button that opens the details; its action is
 * a button of its own. Screen readers hear a change of meaning once, and
 * "Connected" only after an interruption was heard.
 */
export const ConnectionPill = memo(function ConnectionPill({
  details = null,
  detailsHint = "Opens connection details.",
  gated = false,
  notice,
  recoveredLabel = "Connected",
}: {
  readonly notice: ConnectionPillNotice | null;
  readonly details?: ConnectionDetailsProps | null;
  /** A gate is explaining instead: the pill steps aside without announcing a recovery. */
  readonly gated?: boolean;
  readonly detailsHint?: string;
  readonly recoveredLabel?: string;
}) {
  const current = gated ? null : notice;
  const spoken = useSpokenConnection(gated ? undefined : current, recoveredLabel);
  // The last notice stays drawn while it leaves.
  const [drawn, setDrawn] = useState(current);
  if (current !== null && current !== drawn) setDrawn(current);
  const leaving = current === null && drawn !== null;
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (open && (current === null || details === null)) setOpen(false);
  const shown = current ?? drawn;
  return (
    <>
      <span aria-live="polite" className="visually-hidden">
        {spoken}
      </span>
      {shown === null ? null : (
        <div
          className={leaving ? "connection-pill connection-pill--leaving" : "connection-pill"}
          onAnimationEnd={(event) => {
            if (leaving && event.target === event.currentTarget) setDrawn(null);
          }}
        >
          <button
            aria-description={details === null ? undefined : detailsHint}
            aria-expanded={details === null ? undefined : open}
            className="connection-pill__words"
            disabled={details === null || leaving}
            onClick={() => setOpen((value) => !value)}
            ref={setAnchor}
            type="button"
          >
            <span
              className={[
                "connection-pill__dot",
                shown.tone === "amber" ? "connection-pill__dot--amber" : "",
                shown.trying ? "connection-pill__dot--trying" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
            <span className="connection-pill__label" key={shown.key}>
              {shown.label}
            </span>
          </button>
          {shown.action === null ? null : (
            <button
              aria-label={shown.action.accessibilityLabel ?? shown.action.label}
              className="connection-pill__action"
              disabled={leaving}
              onClick={shown.action.onPress}
              type="button"
            >
              {shown.action.label}
            </button>
          )}
        </div>
      )}
      {open && anchor !== null && details !== null ? (
        <Popover
          anchor={anchor}
          below
          className="popover--surface connection-details"
          label={details.name}
          onClose={() => setOpen(false)}
          role="dialog"
        >
          <ConnectionDetails {...details} />
        </Popover>
      ) : null}
    </>
  );
});

/** The pill's details: which connection, what is going on, and the one thing to do. */
export const ConnectionDetails = memo(function ConnectionDetails(props: ConnectionDetailsProps) {
  return (
    <div className="connection-details__body">
      <div className="connection-details__head">
        {props.mark}
        <span className="connection-details__name">{props.name}</span>
      </div>
      <p className="connection-details__state">{props.state}</p>
      <p className="connection-details__explanation">{props.explanation}</p>
      {props.action === null ? null : (
        <button
          aria-busy={props.action.busy === true}
          className="btn btn--primary btn--small"
          disabled={props.action.busy === true}
          onClick={props.action.onPress}
          type="button"
        >
          {props.action.label}
        </button>
      )}
      {props.meta === null ? null : <p className="connection-details__meta">{props.meta}</p>}
      {props.others.length === 0 ? null : (
        <ul className="connection-details__others">
          {props.others.map((session) => (
            <li key={session.key}>
              <button className="connection-details__other" onClick={session.onPress} type="button">
                <span className="connection-details__other-name">{session.name}</span>
                <span className="connection-details__other-state">{session.state}</span>
                <Icon name="chevron-right" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/**
 * The words a polite live region holds: the notice when its meaning changes,
 * "Connected" after a heard interruption ends. `undefined` (a gate explaining)
 * leaves them alone.
 */
function useSpokenConnection(
  notice: ConnectionPillNotice | null | undefined,
  recoveredLabel: string,
): string {
  const [spoken, setSpoken] = useState("");
  const announced = useRef(false);
  const label = useRef<string | null>(null);
  label.current = notice?.label ?? null;
  const key = notice === undefined ? undefined : (notice?.key ?? null);
  useEffect(() => {
    if (key === undefined) return;
    if (key !== null) {
      announced.current = true;
      setSpoken(label.current ?? "");
    } else if (announced.current) {
      announced.current = false;
      setSpoken(recoveredLabel);
    }
  }, [key, recoveredLabel]);
  return spoken;
}
