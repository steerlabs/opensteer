import { useEffect } from "react";
import type { DesktopUpdateState } from "@opensteer/protocol/desktop";
import { desktopBridge } from "../desktop/desktop-bridge.js";
import { subscribeUpdateDownloaded, useDesktopUpdate } from "../desktop/update-store.js";
import { Icon } from "./icon.js";
import { useToast } from "./toast.js";

/** What the sidebar offers for an update, or null while there is nothing to do. */
export function desktopUpdateButton(state: DesktopUpdateState): {
  readonly label: string;
  readonly title: string;
  readonly action: "download" | "restart" | null;
  readonly tone: "primary" | "plain" | "danger";
} | null {
  const version = state.availableVersion ?? "";
  switch (state.status) {
    case "available":
      return {
        label: "Update available",
        title: `Download version ${version}`,
        action: "download",
        tone: "primary",
      };
    case "downloading":
      return {
        label: `Downloading update… ${state.downloadPercent ?? 0}%`,
        title: `Downloading version ${version}`,
        action: null,
        tone: "plain",
      };
    case "downloaded":
      return {
        label: "Restart to update",
        title: `Version ${version} is downloaded. Restart to install it.`,
        action: "restart",
        tone: "primary",
      };
    case "error":
      return state.failed === "download"
        ? {
            label: "Update failed. Try again",
            title: `Version ${version} didn't download. Try again.`,
            action: "download",
            tone: "danger",
          }
        : null;
    default:
      return null;
  }
}

/** Mounted for the app's life, so a sidebar hidden mid-download still confirms it. */
export function DesktopUpdateFeedback() {
  const toast = useToast();
  useEffect(
    () =>
      desktopBridge()?.updates
        ? subscribeUpdateDownloaded(() =>
            toast.success("Update downloaded. Restart to install it."),
          )
        : undefined,
    [toast],
  );
  return null;
}

export function DesktopUpdateButton() {
  const update = useDesktopUpdate();
  const bridge = desktopBridge()?.updates;
  const button = update && bridge ? desktopUpdateButton(update) : null;
  if (!button || !bridge) return null;
  const action = button.action;
  return (
    <button
      className={`btn btn--small sidebar__update${button.tone === "plain" ? "" : ` btn--${button.tone}`}`}
      disabled={!action}
      onClick={() => void (action === "restart" ? bridge.restart() : bridge.download())}
      title={button.title}
      type="button"
    >
      <Icon name={action === "restart" ? "reload" : "download"} />
      <span>{button.label}</span>
    </button>
  );
}
