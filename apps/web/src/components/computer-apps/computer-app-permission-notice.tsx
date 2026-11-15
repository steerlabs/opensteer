import {
  computerAppPermissionNotice,
  type ComputerAppLiveState,
} from "@opensteer/client/integrations";
import type { MachineSummary } from "@opensteer/protocol";
import { Link } from "react-router";
import { Icon } from "../icon.js";

/**
 * A computer app's setup blocker, kept separate from its configured access.
 *
 * It names the grant and points at the app's own editor, where that computer's
 * setup is finished — the one place that knows, for each app, which grant it
 * needs and how to ask for it. The computer's platform decides whose Settings
 * hold the grant. A remedy the client does not know how to complete keeps the
 * provider's own words.
 */
export function ComputerAppPermissionNotice({
  appName,
  machine,
  managePath,
  state,
}: {
  readonly appName: string;
  readonly machine: Pick<MachineSummary, "device" | "name">;
  /** Where the app's own editor lives. */
  readonly managePath: string;
  readonly state: ComputerAppLiveState;
}) {
  if (state.kind !== "permission-required") return null;
  const machineName = machine.name;
  const notice = computerAppPermissionNotice({
    appName,
    machineName,
    platform: machine.device?.platform,
    state,
  });

  return (
    <div className="computer-apps__permission notice notice--warn" role="status">
      <Icon name="alert-circle" />
      <div className="computer-apps__permission-copy">
        <strong>{notice ? notice.title : `${appName} needs setup on ${machineName}`}</strong>
        {notice ? (
          <span>{notice.detail}</span>
        ) : (
          // A remedy this client does not implement is the provider's to
          // describe. Inventing steps for it would send somebody to the wrong
          // setting with confidence.
          <span>{state.detail}</span>
        )}
      </div>
      {notice ? (
        <Link className="btn btn--small" to={managePath}>
          Review setup
        </Link>
      ) : null}
    </div>
  );
}
