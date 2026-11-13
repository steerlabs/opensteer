import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import { useSyncExternalStore } from "react";
import type { PhoneBrowserPlatform } from "./platform.js";
import { PhoneBrowserManager } from "./manager.js";

let manager: PhoneBrowserManager | null = null;
let started = false;
const listeners = new Set<() => void>();
const publish = (value: PhoneBrowserManager | null) => {
  manager = value;
  for (const listener of listeners) listener();
};

export function startPhoneBrowserRuntime(platform: PhoneBrowserPlatform): void {
  if (started) return;
  started = true;
  let identity = "";
  let deploymentId = "";
  let foreground = AppState.currentState === "active";
  let generation = 0;
  let initializing: PhoneBrowserManager | null = null;
  let turn = Promise.resolve();
  const reconcile = () => {
    const enrollment = platform.getEnrollment();
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
    // Nothing runs in the background, so coming back starts it again, even after a failed start.
    identity = foreground ? next : "";
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
        const native = await platform.loadNativePort();
        if (revision !== generation || !foreground) return;
        const candidate = new PhoneBrowserManager({
          native,
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
  platform.subscribeEnrollment(reconcile);
  AppState.addEventListener("change", (state) => {
    foreground = state === "active";
    reconcile();
  });
  platform.subscribeErasure(async (erasedDeploymentId) => {
    if (erasedDeploymentId !== deploymentId) return;
    reconcile();
    await turn;
  });
  void platform.retryErasure().catch(() => undefined);
  reconcile();
}

export function usePhoneBrowserManager(): PhoneBrowserManager | null {
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
