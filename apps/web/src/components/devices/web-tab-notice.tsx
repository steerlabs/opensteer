import { useState } from "react";
import { hostsDeployment } from "@opensteer/client/computers";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useOptionalShell } from "../app-shell.js";
import { Icon } from "../icon.js";

const dismissedKey = "opensteer.web-tab-notice.v1";
const macAppUrl = "https://opensteer.com/download";

const selectHomeName = (snapshot: HostSnapshot) =>
  snapshot.machines.find(hostsDeployment)?.name ?? null;

function dismissed(): boolean {
  try {
    return localStorage.getItem(dismissedKey) === "dismissed";
  } catch {
    return false;
  }
}

/** Said once where it first matters; Devices' "This browser window" row keeps the explanation. */
export function WebTabNotice({ hostClient }: { readonly hostClient: HostClient }) {
  const homeName = useHostSelector(hostClient, selectHomeName);
  const [hidden, setHidden] = useState(dismissed);
  const inDesktopApp = useOptionalShell()?.desktopBridge != null;
  if (hidden || inDesktopApp) return null;
  return (
    <div className="web-tab-notice" role="note">
      <Icon className="web-tab-notice__icon" name="help-circle" />
      <p className="web-tab-notice__text">
        You’re in a web browser, so this window runs nothing itself. Tabs run on{" "}
        {homeName ? `Home (${homeName})` : "Home"} and stream to you.
      </p>
      <a className="web-tab-notice__link" href={macAppUrl} rel="noreferrer" target="_blank">
        Get the Mac app
      </a>
      <button
        aria-label="Dismiss"
        className="icon-btn web-tab-notice__close"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(dismissedKey, "dismissed");
          } catch {
            // It shows again next time; nothing else depends on it.
          }
        }}
        type="button"
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
