import type { ViewerClipboardBridge } from "@opensteer/client/editing";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";

declare global {
  interface Window {
    readonly opensteerDesktop?: OpensteerDesktopBridge & Partial<ViewerClipboardBridge>;
  }
}

export function desktopBridge(): (OpensteerDesktopBridge & Partial<ViewerClipboardBridge>) | null {
  return typeof window === "undefined" ? null : (window.opensteerDesktop ?? null);
}
