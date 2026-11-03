import { useSyncExternalStore } from "react";
import { DesktopUpdateStateSchema, type DesktopUpdateState } from "@opensteer/protocol/desktop";
import { desktopBridge } from "./desktop-bridge.js";
import { appWindowFocused } from "./window-focus.js";

let state: DesktopUpdateState | null = null;
let started = false;
const listeners = new Set<() => void>();
const downloaded = new Set<() => void>();

function receive(value: DesktopUpdateState) {
  const was = state?.status;
  state = DesktopUpdateStateSchema.parse(value);
  if (was === "downloading" && state.status === "downloaded" && appWindowFocused()) {
    for (const listener of downloaded) listener();
  }
  for (const listener of listeners) listener();
}

function start() {
  const bridge = desktopBridge()?.updates;
  if (started || !bridge) return;
  started = true;
  let changed = false;
  const unsubscribe = bridge.onChanged((value) => {
    changed = true;
    receive(value);
  });
  // Subscribe before reading; a late initial response must not replace a newer broadcast.
  void bridge
    .get()
    .then((value) => {
      if (!changed) receive(value);
    })
    .catch(() => undefined);
  window.addEventListener("pagehide", unsubscribe, { once: true });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

/** This app's update state; null outside the desktop app and before its first read. */
export function useDesktopUpdate(): DesktopUpdateState | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
}

/** A download finishing while this window has focus, whatever the page shows. */
export function subscribeUpdateDownloaded(listener: () => void) {
  downloaded.add(listener);
  start();
  return () => {
    downloaded.delete(listener);
  };
}

/** Changes are broadcast by main, including a check that fails after saving. */
export async function setDesktopUpdateChannel(
  channel: import("@opensteer/protocol/desktop").DesktopUpdateChannel,
): Promise<void> {
  await desktopBridge()?.updates?.setChannel(channel);
}

export function desktopUpdateMessage(state: DesktopUpdateState): string {
  const channel = state.channel === "stable" ? "Stable" : "Beta";
  switch (state.status) {
    case "ahead":
      return `${channel} selected — you're on ${state.currentVersion}; latest is ${state.latestVersion}. Updates resume after ${channel} passes it.`;
    case "no-stable-release":
      return "No Stable release yet.";
    case "error":
      return state.failed === "download"
        ? "Download failed. Try again."
        : "Couldn't check for updates. Try again.";
    case "unavailable":
      return "Automatic updates unavailable for this copy.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Update ${state.availableVersion} available.`;
    case "downloading":
      return `Downloading update… ${state.downloadPercent ?? 0}%`;
    case "downloaded":
      return "Restart to install the update.";
    case "up-to-date":
      return `${channel} selected. You're up to date.`;
    default:
      return `${channel} selected.`;
  }
}
