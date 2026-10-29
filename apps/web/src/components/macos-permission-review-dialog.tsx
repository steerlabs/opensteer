import {
  fullAccessDeclineLabel,
  fullDiskAccessBoundary,
  fullDiskAccessExplanation,
  fullDiskAccessLabel,
  fullDiskAccessSettingsLabel,
} from "@opensteer/client/host";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useState } from "react";
import { actionErrorMessage } from "../ui-utils.js";
import { Dialog } from "./dialog.js";
import { Icon } from "./icon.js";

/**
 * The one review step before this desktop opens macOS's Full Disk Access pane.
 * Opening the dialog changes no state. Only its final button calls the bridge,
 * so a Request, app connection, or computer setting is never mistaken for an
 * OS grant merely because somebody reviewed the explanation.
 */
export function MacOsPermissionReviewDialog({
  bridge,
  cancelLabel = "Cancel",
  onClose,
  onError,
}: {
  readonly bridge: Pick<OpensteerDesktopBridge, "requestFullDiskAccess">;
  readonly cancelLabel?: "Cancel" | typeof fullAccessDeclineLabel;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openSettings() {
    setOpening(true);
    setError(null);
    try {
      await bridge.requestFullDiskAccess();
      onClose();
    } catch (reason) {
      setError(actionErrorMessage(reason));
      onError?.(reason);
      setOpening(false);
    }
  }

  const context =
    "Turning this on does not enable an app integration or change what agents are allowed to do.";

  return (
    <Dialog
      footer={
        <>
          <button className="btn" disabled={opening} onClick={onClose} type="button">
            {cancelLabel}
          </button>
          <button
            className="btn btn--primary"
            disabled={opening}
            onClick={() => void openSettings()}
            type="button"
          >
            {opening ? "Opening…" : fullDiskAccessSettingsLabel}
          </button>
        </>
      }
      labelledBy="macos-permission-review-title"
      onClose={onClose}
      title={`Review ${fullDiskAccessLabel}`}
    >
      <p className="permission-review__kicker">{fullDiskAccessLabel}</p>
      <p className="section__hint">{fullDiskAccessExplanation}</p>
      <p className="section__hint">{context}</p>
      <div className="permission-review__facts">
        <p>
          <Icon name="check" />
          <span>{fullDiskAccessBoundary}</span>
        </p>
      </div>
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
