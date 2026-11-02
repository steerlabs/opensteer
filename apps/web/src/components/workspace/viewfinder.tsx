import {
  attachBrowserCanvas,
  drawnBrowserFrame,
  browserPicturePresentedEvent,
} from "../browser/browser-presenter.js";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { BrowserCropCue } from "../browser/browser-crop-cue.js";
import { browserFrameContentRect } from "@opensteer/shared/browserPresentation";
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  pageSiteLabel,
  placeActivityPoint,
  type HostClient,
  runPlaceDestination,
  type SurfaceDestination,
} from "@opensteer/client/host";
import { useHostSelector, useRunPlace } from "@opensteer/client/react";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { placeIdentityKey } from "@opensteer/protocol";
import { useMediaQuery } from "../../ui-utils.js";
import { ComputerWatchView } from "../computer-watch.js";
import { AgentCursors } from "./agent-cursors.js";
import { destinationPlaceKey } from "./navigation.js";
import { useWorkspace } from "./workspace-context.js";

interface RunPlaceView {
  readonly placeKey: string;
  readonly destination: SurfaceDestination | null;
  readonly title: string;
  readonly site: string | null;
  readonly kind: "browser" | "app" | "phone";
}

/**
 * A conversation's one live spot, over its composer: the place its working Run
 * acts in now. Where that place is already in the middle, the middle shows it.
 */
export function LivePlace({
  hostClient,
  runId,
  threadId,
}: {
  readonly hostClient: HostClient;
  readonly runId: string;
  readonly threadId: string;
}) {
  const entry = useRunPlace(hostClient, runId);
  const machines = useHostSelector(hostClient, (snapshot) => snapshot.machines);
  const { selection } = useWorkspace();
  if (entry === null) return null;
  const destination = runPlaceDestination(entry, { machines });
  const place: RunPlaceView = {
    placeKey:
      (destination ? destinationPlaceKey(destination) : null) ?? placeIdentityKey(entry.data.place),
    destination,
    kind: entry.data.place.kind,
    title: entry.data.title,
    site: entry.data.site,
  };
  if (selection.kind === "place" && destinationPlaceKey(selection.destination) === place.placeKey)
    return null;
  return (
    <div className="live-place">
      <Viewfinder hostClient={hostClient} place={place} threadId={threadId} />
    </div>
  );
}

/**
 * A working Run's live view of the place it is in, framed on its pointer,
 * with the agents' cursors, beside what the place is. Pressing it shows that
 * place in the middle and changes nothing else.
 */
export const Viewfinder = memo(function Viewfinder({
  hostClient,
  place,
  threadId,
}: {
  readonly hostClient: HostClient;
  readonly place: RunPlaceView;
  readonly threadId: string;
}) {
  const { conversationShown, highlight, hostConnected, nav } = useViewfinderContext(hostClient);
  const rootRef = useRef<HTMLButtonElement | null>(null);
  const inView = useInView(rootRef);
  const { destination } = place;
  // A conversation put away is not on screen, whatever its geometry says: its
  // picture lets go of its watch until it is shown again. A hidden page only
  // pauses it in the client, which keeps the last picture.
  const live = inView && conversationShown;
  const [pictureLive, setPictureLive] = useState(false);
  const site = place.site ? pageSiteLabel(place.site) : null;
  return (
    <button
      aria-label={`Open ${place.title}`}
      className={place.kind === "browser" ? "viewfinder" : "viewfinder viewfinder--native"}
      data-place-key={place.placeKey}
      onBlur={() => highlight.set(null)}
      onClick={() => {
        if (destination) nav.showPlace(destination);
      }}
      onFocus={() => highlight.set({ placeKey: place.placeKey, threadId: null, threadIds: [] })}
      onPointerEnter={() =>
        highlight.set({ placeKey: place.placeKey, threadId: null, threadIds: [] })
      }
      onPointerLeave={() => highlight.set(null)}
      ref={rootRef}
      title={place.title}
      type="button"
    >
      <span aria-hidden className="viewfinder__frame">
        {destination?.kind === "browser" && destination.tabId ? (
          <BrowserFinder
            key={destination.tabId}
            onLive={setPictureLive}
            enabled={live}
            hostClient={hostClient}
            placeKey={place.placeKey}
            sessionId={destination.sessionId}
            tabId={destination.tabId}
            threadId={threadId}
          />
        ) : destination &&
          destination.kind !== "browser" &&
          destination.computerSessionId !== undefined ? (
          <span className="viewfinder__native">
            <ComputerWatchView
              appKey={destination.kind === "app" ? destination.appKey : null}
              compact
              onPictureLive={setPictureLive}
              hostClient={hostClient}
              hostConnected={hostConnected}
              machineId={destination.machineId || null}
              machines={hostClient.getSnapshot().machines}
              sessionId={destination.computerSessionId}
              visible={live}
              hiddenReason={
                !inView
                  ? "not-in-view"
                  : !conversationShown
                    ? "conversation-hidden"
                    : "destination-changed"
              }
            />
          </span>
        ) : null}
      </span>
      <span className="viewfinder__words">
        <span className="viewfinder__title">
          {pictureLive ? <span aria-hidden className="live-dot" /> : null}
          <span className="viewfinder__name">{place.title}</span>
        </span>
        {site && site !== place.title ? <span className="viewfinder__site">{site}</span> : null}
      </span>
    </button>
  );
});

function useViewfinderContext(hostClient: HostClient) {
  const { dock, highlight, nav, phone, work } = useWorkspace();
  const hostConnected =
    useHostSelector(hostClient, (snapshot) => snapshot.connection) === "connected";
  return { conversationShown: !work || phone || dock.open, highlight, hostConnected, nav };
}

/**
 * The tab's live picture, fitted to the frame's width and panned so the
 * task's pointer stays in the middle third. Panning is eased, clamped to the
 * picture's real overflow, and still under reduced motion.
 */
function BrowserFinder({
  onLive,
  enabled,
  hostClient,
  placeKey,
  sessionId,
  tabId,
  threadId,
}: {
  readonly onLive: (live: boolean) => void;
  readonly enabled: boolean;
  readonly hostClient: HostClient;
  readonly placeKey: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly threadId: string;
}) {
  const surfaceId = BrowserSurfaceIdSchema.safeParse(tabId).data ?? null;
  const status = useSyncExternalStore(
    useCallback(
      (listener: () => void) => hostClient.subscribeBrowserWatch(sessionId, tabId, listener),
      [hostClient, sessionId, tabId],
    ),
    useCallback(
      () => hostClient.browserWatchState(sessionId, tabId).status,
      [hostClient, sessionId, tabId],
    ),
  );
  useEffect(() => {
    onLive(enabled && status === "live");
    return () => onLive(false);
  }, [enabled, onLive, status]);
  useEffect(
    () =>
      enabled && surfaceId
        ? hostClient.retainBrowserWatch(sessionId, tabId, {
            captureRegion: true,
            frameWindow: true,
            rasterDemand: true,
          })
        : undefined,
    [hostClient, sessionId, tabId, surfaceId, enabled],
  );
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const imageRef = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(false);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !surfaceId) return;
    return attachBrowserCanvas(
      hostClient.browserWatchFrames,
      sessionId,
      tabId,
      true,
      canvas,
      () => setShown(true),
      true,
      { preservePixels: true, active: enabled },
    );
  }, [hostClient, sessionId, tabId, surfaceId, enabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => setShown(drawnBrowserFrame(canvas) !== null);
    canvas.addEventListener(browserPicturePresentedEvent, update);
    return () => canvas.removeEventListener(browserPicturePresentedEvent, update);
  }, []);

  // Framing follows this task's pointer, imperatively: motion is not a render.
  useEffect(() => {
    const box = frameRef.current;
    const image = imageRef.current;
    if (!box || !image) return;
    let pan = Number(image.dataset.pan ?? 0);
    const frameAt = () => {
      const shown = drawnBrowserFrame(canvasRef.current);
      if (!shown) return;
      const width = box.clientWidth;
      const height = box.clientHeight;
      const rect = browserFrameContentRect(
        { left: 0, top: 0, width, height: image.clientHeight },
        shown.header.rasterWidth,
        shown.header.rasterHeight,
        shown.header.capture,
        "top",
        true,
      );
      if (!rect) return;
      const imageHeight = rect.height;
      const overflow = Math.max(0, imageHeight - height);
      const record = hostClient
        .placeActivity(placeKey)
        .find((activity) => activity.threadId === threadId);
      const pointer = record ? placeActivityPoint(record, shown.header) : null;
      if (overflow === 0) pan = 0;
      else if (pointer?.kind === "point") {
        const y = pointer.y * imageHeight - pan;
        if (y < height / 3 || y > (height * 2) / 3)
          pan = Math.min(overflow, Math.max(0, pointer.y * imageHeight - height / 2));
      } else pan = Math.min(pan, overflow);
      image.dataset.pan = String(pan);
      image.style.transform = `translate3d(0, ${-Math.round(pan)}px, 0)`;
    };
    frameAt();
    const unsubscribe = hostClient.subscribePlaceActivity(placeKey, frameAt);
    box.addEventListener(browserPicturePresentedEvent, frameAt);
    const stopResize = observeResize([box], frameAt);
    return () => {
      unsubscribe();
      box.removeEventListener(browserPicturePresentedEvent, frameAt);
      stopResize();
    };
  }, [hostClient, placeKey, threadId]);

  return (
    <span className="viewfinder__picture" ref={frameRef}>
      <span
        className={
          reducedMotion
            ? "viewfinder__image browser-frame viewfinder__image--still"
            : "viewfinder__image browser-frame"
        }
        ref={imageRef}
      >
        <canvas className={shown ? "" : "viewfinder__canvas--empty"} ref={canvasRef} />
        <BrowserCropCue />
        {shown ? (
          <AgentCursors
            hostClient={hostClient}
            placeKey={placeKey}
            sessionId={sessionId}
            tabId={tabId}
            variant="viewfinder"
          />
        ) : null}
      </span>
    </span>
  );
}

/** Whether the element is on screen; nothing off screen holds a live picture. */
function useInView(ref: { readonly current: Element | null }): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setInView(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}
