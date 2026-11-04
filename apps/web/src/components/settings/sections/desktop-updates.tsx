import { useState } from "react";
import { resolveDesktopAppBranding } from "@opensteer/protocol/desktop";
import { desktopBridge } from "../../../desktop/desktop-bridge.js";
import {
  desktopUpdateMessage,
  setDesktopUpdateChannel,
  useDesktopUpdate,
} from "../../../desktop/update-store.js";
import { SettingsRow } from "../primitives.js";
export function DesktopUpdatesRow() {
  const update = useDesktopUpdate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  if (!desktopBridge()?.updates?.setChannel || !update) return null;
  const change = (channel: "stable" | "beta") => {
    if (pending) return;
    setPending(true);
    setError(false);
    void setDesktopUpdateChannel(channel)
      .catch(() => setError(true))
      .finally(() => setPending(false));
  };
  const disabled = pending || update.status === "downloading" || update.status === "downloaded";
  return (
    <>
      <SettingsRow
        title={`${resolveDesktopAppBranding(update.currentVersion).displayName} ${update.currentVersion}`}
        icon="download"
        detail={desktopUpdateMessage(update)}
        action={
          <button
            type="button"
            className="btn"
            disabled={disabled || update.status === "checking"}
            onClick={() => change(update.channel)}
          >
            Check for updates
          </button>
        }
      />
      <SettingsRow
        title="Get Beta updates"
        icon="download"
        detail={
          error
            ? "Couldn’t change updates. Try again."
            : update.channel === "stable" && update.status === "ahead"
              ? `You'll move to Stable when a Stable version newer than ${update.currentVersion} comes out`
              : null
        }
        action={
          <input
            type="checkbox"
            className="switch"
            role="switch"
            aria-label="Get Beta updates"
            checked={update.channel === "beta"}
            disabled={disabled}
            onChange={(event) => change(event.currentTarget.checked ? "beta" : "stable")}
          />
        }
      />
    </>
  );
}
