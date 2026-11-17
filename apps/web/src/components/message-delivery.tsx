import {
  messageDeliveryActions,
  type MessageDeliveryAction,
  type MessageDeliveryPhase,
} from "@opensteer/client/host";
import { useQuietMoment } from "@opensteer/client/react";
import { memo, type ReactNode } from "react";

const defaultCopy = {
  delete: "Delete",
  edit: "Edit",
  sending: "Sending…",
  waiting: "Waiting to send",
};

/** How long a message being sent on a good connection says nothing at all. */
const quietMs = 1_000;

/**
 * A person's own message that is still on this device, drawn where the
 * delivered message will stand: delivery is a change of state in place, not a
 * second bubble. Waiting dims the bubble at once; sending only once a moment
 * has passed; a refusal outlines it, with Edit and Delete beneath. The bubble
 * is the caller's `.msg--user`.
 */
export const MessageDelivery = memo(function MessageDelivery(props: {
  readonly children: ReactNode;
  readonly phase: MessageDeliveryPhase;
  /** When this message was first shown, in epoch milliseconds: the quiet moment counts from it. */
  readonly since: number;
  readonly attempted: boolean;
  /** False for every waiting message of a run but the last. */
  readonly showStatus: boolean;
  /** The refusal in full, "Not sent. Message is too long."; shown only when rejected. */
  readonly rejection?: string | null;
  readonly onAction?: ((action: MessageDeliveryAction) => void) | undefined;
  readonly copy?: Partial<typeof defaultCopy>;
}) {
  const copy = { ...defaultCopy, ...props.copy };
  const quiet = useQuietMoment(props.phase === "sending" ? props.since : null, quietMs);
  const dimmed = props.phase === "waiting" || (props.phase === "sending" && !quiet);
  const onAction = props.onAction;
  // Inline only when refused; a waiting message is taken back from its own menu
  // (`messageDeliveryActions`), so a run of waiting bubbles reserves no line.
  const actions =
    onAction === undefined || props.phase !== "rejected"
      ? []
      : messageDeliveryActions(props.phase, props.attempted);
  const status =
    props.phase === "rejected"
      ? "rejected"
      : !props.showStatus || props.phase === "delivered"
        ? null
        : props.phase === "waiting"
          ? "waiting"
          : quiet
            ? null
            : "sending";
  return (
    <div
      className={[
        "delivery",
        dimmed ? "delivery--pending" : "",
        props.phase === "rejected" ? "delivery--rejected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {props.children}
      {status === null ? null : (
        <div className="delivery__status" key={status}>
          {status === "rejected" ? (
            <span className="delivery__reason">{props.rejection ?? null}</span>
          ) : (
            <span>{status === "waiting" ? copy.waiting : copy.sending}</span>
          )}
          {actions.length === 0 || onAction === undefined ? null : (
            <span className="delivery__actions">
              {actions.map((name) => (
                <button
                  className="delivery__action"
                  key={name}
                  onClick={() => onAction(name)}
                  type="button"
                >
                  {name === "edit" ? copy.edit : copy.delete}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
