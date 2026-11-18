import type { BrowserFrameView, BrowserWatchState, HostClient } from "@opensteer/client/host";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whether the picture drawn is one this viewer's current connection sent.
 *
 * The viewer goes live as a frame arrives, before it is decoded and painted,
 * so until a frame that arrived on this connection is drawn the canvas still
 * shows the last picture. `presented` is the canvas's own report of a draw.
 */
export function useFreshPicture(
  hostClient: HostClient,
  sessionId: string,
  surfaceId: string,
  viewer: BrowserWatchState,
): { readonly fresh: boolean; readonly presented: (frame: BrowserFrameView) => void } {
  // Which connection each recent frame arrived on, by its delivery token.
  const arrivals = useRef(new Map<string, string>());
  const [drawnOn, setDrawnOn] = useState<string | null>(null);
  useEffect(() => {
    const seen = arrivals.current;
    seen.clear();
    const note = () => {
      const token = hostClient.browserFrames.get(sessionId, surfaceId)?.header.watchToken;
      const state = hostClient.browserViewerState(sessionId, surfaceId);
      if (!token || state.status !== "live" || seen.has(token)) return;
      seen.set(token, state.admissionId ?? "");
      // Frames past the receipt window can no longer be drawn.
      if (seen.size > 16) seen.delete(seen.keys().next().value!);
    };
    note();
    return hostClient.browserFrames.subscribe(sessionId, note, surfaceId);
  }, [hostClient, sessionId, surfaceId]);
  const presented = useCallback((frame: BrowserFrameView) => {
    const token = frame.header.watchToken;
    const admission = token ? arrivals.current.get(token) : undefined;
    if (admission !== undefined) setDrawnOn(admission);
  }, []);
  return {
    // A feed without admissions (the mock Host) is one connection.
    fresh: viewer.status === "live" && drawnOn === (viewer.admissionId ?? ""),
    presented,
  };
}
