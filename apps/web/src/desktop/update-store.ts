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
