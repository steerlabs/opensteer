import {
  failureNotice,
  type ClientNetworkState,
  type FailureNotice,
  type OperationFailure,
} from "@opensteer/client/host";
import { Icon, type IconName } from "../icon.js";

const icons: Record<FailureNotice["tone"], IconName> = {
  failed: "alert-circle",
  gone: "help-circle",
  offline: "cloud-off",
  "signed-out": "alert-circle",
  unreachable: "alert-circle",
};

/**
 * Where a link led to something this reader cannot see: the one state every
 * reference destination shows, instead of a silent redirect or nothing at
 * all. Only a failure that may pass offers Retry.
 */
export function Unavailable({
  backLabel = "Back",
  failure = "gone",
  inline = false,
  network = "unknown",
  onBack,
  onRetry,
}: {
  readonly backLabel?: string;
  readonly failure?: OperationFailure;
  readonly inline?: boolean;
  readonly network?: ClientNetworkState;
  readonly onBack?: () => void;
  readonly onRetry?: () => void;
}) {
  const notice = failureNotice(failure, network);
  const retry = notice.retry ? onRetry : undefined;
  return (
    <div
      className={inline ? "ref-unavailable ref-unavailable--inline" : "ref-unavailable"}
      role={inline ? "status" : "alert"}
    >
      <Icon name={icons[notice.tone]} />
      <p className="ref-unavailable__title">{notice.title}</p>
      <p className="ref-unavailable__body">{notice.body}</p>
      {onBack || retry ? (
        <div className="ref-unavailable__actions">
          {retry ? (
            <button className="btn btn--small" onClick={retry} type="button">
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
