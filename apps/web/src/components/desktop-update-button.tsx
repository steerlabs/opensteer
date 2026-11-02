import { useEffect, type CSSProperties } from "react";
import type { DesktopUpdateState } from "@opensteer/protocol/desktop";
import { desktopBridge } from "../desktop/desktop-bridge.js";
import { subscribeUpdateDownloaded, useDesktopUpdate } from "../desktop/update-store.js";
import { Icon } from "./icon.js";
import { useToast } from "./toast.js";

/** What the place row offers for an update, or null while there is nothing to do. */
export function desktopUpdateButton(state: DesktopUpdateState): {
  readonly label: string;
  readonly action: "download" | "restart" | null;
  readonly tone: "quiet" | "ready" | "danger";
  readonly icon: "download" | "arrow-up" | "alert-circle";
  readonly progress: number | null;
} | null {
  const version = state.availableVersion ? ` ${state.availableVersion}` : "";
  switch (state.status) {
    case "available":
      return {
        label: `Download update${version}`,
        action: "download",
        tone: "quiet",
        icon: "download",
        progress: null,
      };
    case "downloading": {
      const percent = state.downloadPercent ?? 0;
      return {
        label: `Downloading update… ${percent}%`,
        action: null,
        tone: "quiet",
        icon: "download",
        progress: percent,
      };
    }
    case "downloaded":
      return {
        label: `Restart to update${version}`,
        action: "restart",
        tone: "ready",
        icon: "arrow-up",
        progress: null,
      };
    case "error":
      return state.failed === "download"
        ? {
            label: "Update failed. Try again",
            action: "download",
            tone: "danger",
            icon: "alert-circle",
            progress: null,
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

/**
 * A small mark inside the place row: an update is housekeeping, so it waits
 * there in the row's own ink and only the ready restart takes the ember. Its
 * name shows beside it on hover and focus instead of taking a row of its own.
 */
export function DesktopUpdateButton() {
  const update = useDesktopUpdate();
  const bridge = desktopBridge()?.updates;
  const button = update && bridge ? desktopUpdateButton(update) : null;
  if (!button || !bridge) return null;
  const { action, progress } = button;
  return (
    <button
      aria-disabled={action ? undefined : true}
      aria-label={button.label}
      className={`sidebar__update sidebar__update--${button.tone}`}
      onClick={() => {
        if (action) void (action === "restart" ? bridge.restart() : bridge.download());
      }}
      type="button"
    >
      {progress === null ? (
        <Icon name={button.icon} />
      ) : (
        <svg
          aria-hidden
          className="sidebar__update-ring"
          style={{ "--progress": progress } as CSSProperties}
          viewBox="0 0 16 16"
        >
          <circle cx="8" cy="8" pathLength="100" r="6" />
          <circle cx="8" cy="8" pathLength="100" r="6" />
        </svg>
      )}
      <span aria-hidden className="sidebar__update-tip">
        {button.label}
      </span>
    </button>
  );
}
