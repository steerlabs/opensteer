import type { BrowserFrameStore, BrowserFrameView } from "@opensteer/client/host";
import { browserCropCue } from "@opensteer/shared/browserPresentation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { NativePicture, PictureMetadata } from "../computers/phone-display-native.js";
import { mobileBrowserFrameMaxBytes } from "./browser-frame.js";

/**
 * The geometry a picture is aimed with. A newer delivery under another fence
 * supersedes a decode in progress; one under the same fence lets it finish.
 */
export function browserPictureFence(frame: BrowserFrameView): string {
  const { header } = frame;
  return [
    header.surfaceId,
    header.viewportWidth,
    header.viewportHeight,
    header.geometryRevision ?? "",
    header.capture?.revision ?? "",
  ].join(":");
}

export function browserPictureMetadata(
  frame: BrowserFrameView,
  generation: number,
): PictureMetadata {
  const { header } = frame;
  const region = header.capture ?? { width: header.rasterWidth, height: header.rasterHeight };
  return {
    generation,
    fence: browserPictureFence(frame),
    width: header.rasterWidth,
    height: header.rasterHeight,
    regionWidth: region.width,
    regionHeight: region.height,
    upscale: header.capture === undefined,
    cornerRadius: header.capture ? browserCropCue.radius : 0,
  };
}

/**
 * Feeds one tab's deliveries straight from the frame store to the native
 * picture view, without a render per delivery. Each delivery's receipt is
 * returned exactly once: when the view settles it, when it is never sent
 * because the tab is not on screen, or when the view goes away first. The
 * picture that drives input is the one the view reported drawn, never merely
 * the newest received.
 */
export function useNativeBrowserPicture(input: {
  readonly enabled: boolean;
  /** The view is on screen and its page is ready; anything else clears it. */
  readonly visible: boolean;
  readonly frames: BrowserFrameStore;
  readonly sessionId: string;
  readonly tabId: string;
  /** Returns one delivery's receipt. */
  readonly settle: (delivery: BrowserFrameView) => void;
}) {
  const { enabled, visible, frames, sessionId, tabId, settle } = input;
  const view = useRef<NativePicture | null>(null);
  const generation = useRef(0);
  // Native clear events and presentation promises can reach JS in either order.
  const clearVersion = useRef(0);
  // The newest delivery whose receipt this view has taken, so none is returned twice.
  const handled = useRef<BrowserFrameView | null>(null);
  const [drawn, setDrawn] = useState<BrowserFrameView | null>(null);
  // Re-renders only when this tab's picture appears or goes, not per delivery.
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? frames.subscribe(sessionId, listener, tabId) : () => undefined,
    [enabled, frames, sessionId, tabId],
  );
  const getPresent = useCallback(
    () => enabled && frames.get(sessionId, tabId)?.header.surfaceId === tabId,
    [enabled, frames, sessionId, tabId],
  );
  const present = useSyncExternalStore(subscribe, getPresent, getPresent);

  // Pixels and the input they aim go in the same layout pass that loses them.
  const shown = enabled && visible && present;
  useLayoutEffect(() => {
    if (!enabled || !shown) return;
    const owned = new Set<BrowserFrameView>();
    const current = ++generation.current;
    // Native calls run in order, so the view takes this generation before any picture.
    void view.current?.clear(current).catch(() => undefined);
    const release = (delivery: BrowserFrameView) => {
      if (owned.delete(delivery)) settle(delivery);
    };
    const pump = () => {
      const latest = frames.get(sessionId, tabId);
      if (latest === null || latest === handled.current) return;
      handled.current = latest;
      owned.add(latest);
      if (latest.header.watchToken) frames.claim?.(sessionId, tabId, latest.header.watchToken);
      const native = view.current;
      const size = latest.data.byteLength;
      if (
        native === null ||
        latest.header.surfaceId !== tabId ||
        size < 1 ||
        size > mobileBrowserFrameMaxBytes
      ) {
        release(latest);
        return;
      }
      const bytes = latest.data instanceof Uint8Array ? latest.data : new Uint8Array(latest.data);
      const beforeClear = clearVersion.current;
      native
        .present(bytes, browserPictureMetadata(latest, current))
        .then(
          (outcome) => {
            if (
              outcome === "presented" &&
              owned.has(latest) &&
              generation.current === current &&
              clearVersion.current === beforeClear
            )
              setDrawn(latest);
          },
          () => undefined,
        )
        .finally(() => release(latest));
    };
    const unsubscribe = frames.subscribe(sessionId, pump, tabId);
    pump();
    return () => {
      unsubscribe();
      generation.current++;
      void view.current?.clear(generation.current).catch(() => undefined);
      for (const delivery of owned) release(delivery);
      // The store's newest delivery was never this view's to draw now.
      const latest = frames.get(sessionId, tabId);
      if (latest !== null && latest !== handled.current) {
        handled.current = latest;
        settle(latest);
      }
      setDrawn(null);
    };
  }, [enabled, frames, sessionId, settle, shown, tabId]);

  // Whatever the store holds that this view will not draw is returned at once:
  // everything while hidden, and another tab's picture while shown.
  useEffect(() => {
    if (!enabled || shown) return;
    const discard = () => {
      const latest = frames.get(sessionId, tabId);
      if (latest === null || latest === handled.current) return;
      // This tab's picture makes the view present, which then takes it.
      if (visible && latest.header.surfaceId === tabId) return;
      handled.current = latest;
      settle(latest);
    };
    discard();
    return frames.subscribe(sessionId, discard, tabId);
  }, [enabled, frames, sessionId, settle, shown, tabId, visible]);

  const cleared = useCallback((event: { nativeEvent: { generation: number } }) => {
    if (event.nativeEvent.generation === generation.current) {
      clearVersion.current++;
      setDrawn(null);
    }
  }, []);
  return {
    view,
    present,
    drawn: shown && drawn?.header.surfaceId === tabId ? drawn : null,
    cleared,
  };
}
