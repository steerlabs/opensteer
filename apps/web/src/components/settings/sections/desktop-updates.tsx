import { useState } from "react";
import { DesktopUpdateChannelSchema } from "@opensteer/protocol/desktop";
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
  return (
    <SettingsRow
      title="Update channel"
      icon="download"
      detail={error ? "Couldn't change update channel. Try again." : desktopUpdateMessage(update)}
      action={
        <select
          aria-label="Update channel"
          value={update.channel}
          disabled={pending || update.status === "downloading" || update.status === "downloaded"}
          onChange={(event) => {
            const channel = DesktopUpdateChannelSchema.parse(event.target.value);
            setPending(true);
            setError(false);
            void setDesktopUpdateChannel(channel)
              .catch(() => setError(true))
              .finally(() => setPending(false));
          }}
        >
          <option value="stable">Stable</option>
          <option value="beta">Beta</option>
        </select>
      }
    />
  );
}
