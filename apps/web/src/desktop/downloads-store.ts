import { useSyncExternalStore } from "react";
import {
  DesktopDownloadsSnapshotSchema,
  type DesktopDownload,
  type DesktopDownloadsSnapshot,
} from "@opensteer/protocol/desktop";
import { desktopBridge } from "./desktop-bridge.js";
import { appWindowFocused } from "./window-focus.js";

const empty: DesktopDownloadsSnapshot = { downloads: [] };
let snapshot = empty;
let started = false;
let hydrated = false;
const listeners = new Set<() => void>();
const feedback = new Set<(download: DesktopDownload) => void>();
const seenOutcomes = new Set<string>();

function receive(value: DesktopDownloadsSnapshot) {
  snapshot = DesktopDownloadsSnapshotSchema.parse(value);
  for (const download of snapshot.downloads) {
    if (download.state !== "completed" && download.state !== "failed") continue;
    const outcome = `${download.id}:${download.state}`;
    if (seenOutcomes.has(outcome)) continue;
    seenOutcomes.add(outcome);
    if (hydrated && appWindowFocused()) {
      for (const listener of feedback) listener(download);
    }
  }
  hydrated = true;
  for (const listener of listeners) listener();
}

function start() {
  const bridge = desktopBridge()?.downloads;
  if (started || !bridge) return;
  started = true;
  appWindowFocused();
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

export function useDesktopDownloads(): readonly DesktopDownload[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => empty,
  ).downloads;
}

/** Feedback observes the app-wide stream even when no browser toolbar is mounted. */
export function subscribeDownloadFeedback(listener: (download: DesktopDownload) => void) {
  feedback.add(listener);
  start();
  return () => {
    feedback.delete(listener);
  };
}
