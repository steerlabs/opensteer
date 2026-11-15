import { Icon } from "../icon.js";

/**
 * Where a link led to something this reader cannot see: the one state every
 * reference destination shows, instead of a silent redirect or nothing at
 * all. Offline is its own case, since trying again may work.
 */
export function Unavailable({
  backLabel = "Back",
  inline = false,
  offline = false,
  onBack,
  onRetry,
}: {
  readonly backLabel?: string;
  readonly inline?: boolean;
  readonly offline?: boolean;
  readonly onBack?: () => void;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      className={inline ? "ref-unavailable ref-unavailable--inline" : "ref-unavailable"}
      role={inline ? "status" : "alert"}
    >
      <Icon name={offline ? "cloud-off" : "help-circle"} />
      <p className="ref-unavailable__title">
        {offline ? "You're offline" : "This isn't available"}
      </p>
      <p className="ref-unavailable__body">
        {offline
          ? "Reconnect, then try again."
          : "It may have been deleted, or you don't have access."}
      </p>
      {onBack || (offline && onRetry) ? (
        <div className="ref-unavailable__actions">
          {offline && onRetry ? (
            <button className="btn btn--small" onClick={onRetry} type="button">
              <Icon name="reload" />
              Retry
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
