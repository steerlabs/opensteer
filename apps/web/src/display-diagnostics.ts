import type { DisplayClientDiagnostic } from "@opensteer/protocol";
import type { NativeViewerSource } from "@opensteer/client/host";
import { desktopBridge } from "./desktop/desktop-bridge.js";

let windowAt = 0;
let count = 0;
let suppressed = 0;

export function reportDisplayDiagnostic(record: DisplayClientDiagnostic): void {
  const bridge = desktopBridge();
  if (!bridge?.reportDisplayDiagnostic) return;
  const now = Date.now();
  if (now - windowAt >= 10_000) {
    windowAt = now;
    count = 0;
  }
  if (count++ >= 120) {
    suppressed++;
    return;
  }
  try {
    void bridge.reportDisplayDiagnostic({ ...record, suppressed }).catch(() => undefined);
    suppressed = 0;
  } catch {
    /* Older desktop bridges and logging failures cannot affect viewing. */
  }
}

export function displayDiagnosticSource(
  source: NativeViewerSource,
): Pick<DisplayClientDiagnostic, "kind" | "sessionId" | "viewId" | "generation"> {
  return source.kind === "task-session"
    ? { kind: source.kind, sessionId: source.sessionId }
    : { kind: source.kind, viewId: source.viewId, generation: source.generation };
}
