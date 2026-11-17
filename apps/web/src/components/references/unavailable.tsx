import { presentClientIssue } from "@opensteer/client/feedback";
import { Icon } from "../icon.js";

/**
 * Where a link led to something this reader cannot see: the one state every
 * reference destination shows, instead of a silent redirect or nothing at
 * all. Given `unloaded`, the thing may well exist but its read did not
 * finish, so the way on is to try again; the connection is the pill's to explain.
 */
export function Unavailable({
  backLabel = "Back",
  inline = false,
  onBack,
  onRetry,
  unloaded = null,
}: {
  readonly backLabel?: string;
  readonly inline?: boolean;
  readonly onBack?: () => void;
  readonly onRetry?: () => void;
  /** What could not be read, as in "Couldn't load {this request}." */
  readonly unloaded?: string | null;
}) {
  const said = presentClientIssue(
    unloaded === null ? { code: "access-lost" } : { code: "read-failed", resource: unloaded },
  );
  return (
    <div
      className={inline ? "ref-unavailable ref-unavailable--inline" : "ref-unavailable"}
      role={inline ? "status" : "alert"}
    >
      <Icon name={unloaded === null ? "help-circle" : "reload"} />
      <p className="ref-unavailable__title">{said.title}</p>
      {said.detail ? <p className="ref-unavailable__body">{said.detail}</p> : null}
      {onBack || (unloaded !== null && onRetry) ? (
        <div className="ref-unavailable__actions">
          {unloaded !== null && onRetry ? (
            <button className="btn btn--small" onClick={onRetry} type="button">
              Try again
            </button>
          ) : null}
          {onBack ? (
            <button className="btn btn--small btn--ghost" onClick={onBack} type="button">
              {backLabel === "Back" ? <Icon name="arrow-left" /> : null}
              {backLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
