import { reportDisplayDiagnostic } from "./display-diagnostics.js";
import { desktopBridge } from "./desktop/desktop-bridge.js";

const listeners = new Set<() => void>();
let nativeVisible = false;
let stop: (() => void) | null = null;

/** The one local viewing decision, shared by transport and picture retainers. */
export function pageVisible(): boolean {
  return (
    (typeof document === "undefined" || document.visibilityState === "visible") &&
    (desktopBridge() === null || nativeVisible)
  );
}

export function observePageVisibility(listener: () => void): () => void {
  listeners.add(listener);
  if (stop === null) {
    let previous = pageVisible();
    let previousInputs = "";
    const changed = () => {
      const visible = pageVisible();
      const documentVisibility = document.visibilityState;
      const inputs = `${documentVisibility}:${nativeVisible}:${visible}`;
      if (inputs !== previousInputs) {
        previousInputs = inputs;
        reportDisplayDiagnostic({
          transition: "visibility",
          documentVisibility,
          nativeVisible,
          visible,
        });
      }
      if (visible === previous) return;
      previous = visible;
      for (const notify of listeners) notify();
    };
    changed();
    document.addEventListener("visibilitychange", changed);
    const bridge = desktopBridge();
    let active = true;
    let receivedChange = false;
    const unsubscribe = bridge?.onLocalVisibilityChanged((visible) => {
      receivedChange = true;
      nativeVisible = visible;
      changed();
    });
    if (bridge) {
      void bridge
        .getLocalVisibility()
        .then((visible) => {
          // A lock delivered after the read began wins over its older reply.
          if (!active || receivedChange) return;
          nativeVisible = visible;
          changed();
        })
        .catch(() => undefined);
    }
    stop = () => {
      active = false;
      document.removeEventListener("visibilitychange", changed);
      unsubscribe?.();
      nativeVisible = false;
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}
