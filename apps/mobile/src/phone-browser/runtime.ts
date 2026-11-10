import { AppState, Platform } from "react-native";
import { randomUUID } from "expo-crypto";
import { useSyncExternalStore } from "react";
import type { IphoneAppsBridge } from "../platform/iphone-apps.js";
import { createIphoneBrowserConnection } from "../iphone-apps/browser-transport.js";
import { composeIphoneBrowserPort } from "./iphone-port.js";
import { PhoneBrowserManager } from "./manager.js";

let manager: PhoneBrowserManager | null = null;
let started = false;
const listeners = new Set<() => void>();
const publish = (value: PhoneBrowserManager | null) => {
  manager = value;
  for (const listener of listeners) listener();
};

export function startIphoneBrowserRuntime(bridge: IphoneAppsBridge): void {
  if (started || Platform.OS !== "ios") return;
  const connection = createIphoneBrowserConnection();
  if (!connection) return;
  started = true;
  let identity = "";
  let deploymentId = "";
  let foreground = AppState.currentState === "active";
  let generation = 0;
  let initializing: PhoneBrowserManager | null = null;
  let turn = Promise.resolve();
  const reconcile = () => {
    const snapshot = bridge.getSnapshot();
    const enrollment =
      snapshot.supported && snapshot.enrollment?.state === "enrolled" ? snapshot.enrollment : null;
    const next = enrollment ? `${enrollment.deploymentId}:${enrollment.runnerId}` : "";
    if (next === identity && (manager || initializing)) {
      if (manager) {
        const current = manager;
        const active = foreground;
        const operation = active
          ? turn.then(() => current.setForeground(true))
          : current.setForeground(false);
        turn = operation.catch(() => undefined);
      } else if (!foreground && initializing) {
        ++generation;
        identity = "";
        void initializing.dispose().catch(() => undefined);
        initializing = null;
      }
      return;
    }
    if (next === identity && foreground) return;
    identity = next;
    const revision = ++generation;
    const old = manager ?? initializing;
    initializing = null;
    publish(null);
    const stopped = old?.dispose();
    turn = turn
      .catch(() => undefined)
      .then(async () => {
        await stopped;
        if (revision !== generation || !enrollment || !foreground) return;
        const { phoneBrowser } = await import("../../modules/phone-browser/index.js");
        if (revision !== generation || !foreground) return;
        const candidate = new PhoneBrowserManager({
          native: composeIphoneBrowserPort(phoneBrowser, connection),
          deploymentId: enrollment.deploymentId,
          runnerId: enrollment.runnerId,
          uuid: randomUUID,
        });
        deploymentId = enrollment.deploymentId;
        initializing = candidate;
        try {
          await candidate.initialize();
          if (revision !== generation || !foreground) {
            await candidate.dispose();
            return;
          }
          await candidate.setForeground(true);
          if (revision === generation && foreground) publish(candidate);
          else await candidate.dispose();
        } catch {
          await candidate.dispose();
          if (manager === candidate) publish(null);
        } finally {
          if (initializing === candidate) initializing = null;
        }
      });
    void turn.catch(() => undefined);
  };
  bridge.subscribe(reconcile);
  AppState.addEventListener("change", (state) => {
    foreground = state === "active";
    reconcile();
  });
  connection.onErasure(async (event) => {
    if (event.deploymentId === deploymentId && manager) await manager.eraseDeployment();
  });
  void import("../../modules/phone-browser/index.js")
    .then(() => connection.retryErasure())
    .catch(() => undefined);
  reconcile();
}

export function useIphoneBrowserManager(): PhoneBrowserManager | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => manager,
    () => null,
  );
}
