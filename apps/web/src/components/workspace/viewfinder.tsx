import {
  attachBrowserCanvas,
  drawnBrowserFrame,
  browserPicturePresentedEvent,
} from "../browser/browser-presenter.js";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { BrowserCropCue } from "../browser/browser-crop-cue.js";
import { browserFrameContentRect } from "@opensteer/shared/browserPresentation";
import { memo, useEffect, useRef, useState } from "react";
import {
  browserSiteLabel,
  placeActivityPoint,
  type HostClient,
  type ThreadPlace,
} from "@opensteer/client/host";
import { usePlaceList, useRunPlace } from "@opensteer/client/react";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { useMediaQuery } from "../../ui-utils.js";
import { ComputerWatchView } from "../computer-watch.js";
import { AgentCursors } from "./agent-cursors.js";
import { destinationPlaceKey } from "./navigation.js";
import { useWorkspace } from "./workspace-context.js";

/** How long the picture stays on a place before it may cut to another. */
const pictureHoldMs = 2_000;

/**
 * The place a working Run's picture shows: the one it acted in last, held
 * for `pictureHoldMs` before cutting to another, so a Run working across
 * several pages never strobes between them. A held place still has to be
 * there: the picture leaves one that ended at once, as it does when the Run
 * stops working. It never falls back to an older place.
 */
export function useRunPicture(
  hostClient: HostClient,
  threadId: string,
  runId: string,
): ThreadPlace | null {
  const latest = useRunPlace(hostClient, threadId, runId);
  const places = usePlaceList(hostClient);
  const [shown, setShown] = useState<{ readonly place: ThreadPlace; readonly since: number }>();
  const held =
    shown !== undefined &&
    latest !== null &&
    shown.place.placeKey !== latest.placeKey &&
    places.some((item) => item.key === shown.place.placeKey && item.taskDestination !== null)
      ? shown
      : undefined;
  useEffect(() => {
    if (latest === null) {
      setShown(undefined);
      return;
    }
    if (held === undefined) {
      if (shown?.place !== latest)
        setShown({
          place: latest,
          since: shown?.place.placeKey === latest.placeKey ? shown.since : Date.now(),
        });
      return;
    }
    const cut = () => setShown({ place: latest, since: Date.now() });
    const wait = held.since + pictureHoldMs - Date.now();
    if (wait <= 0) {
      cut();
      return;
    }
    const timer = window.setTimeout(cut, wait);
    return () => window.clearTimeout(timer);
  }, [held, latest, shown]);
  return latest === null ? null : (held?.place ?? latest);
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
  const place = useRunPicture(hostClient, threadId, runId);
  const { selection } = useWorkspace();
  if (place === null) return null;
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
  /** A live place: `useRunPicture` names none that has ended. */
  readonly place: ThreadPlace;
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
  // "www." says nothing a person reads a site by, and the line has little room.
  const site = place.site ? browserSiteLabel(place.site).replace(/^www\./u, "") : null;
  return (
    <button
      aria-label={`Open ${place.title}`}
      className={destination?.kind === "browser" ? "viewfinder" : "viewfinder viewfinder--native"}
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
          <span aria-hidden className="live-dot" />
          <span className="viewfinder__name">{place.title}</span>
        </span>
        {site && site !== place.title ? <span className="viewfinder__site">{site}</span> : null}
      </span>
    </button>
  );
});

function useViewfinderContext(hostClient: HostClient) {
  const { dock, highlight, nav, phone, work } = useWorkspace();
  const hostConnected = hostClient.getSnapshot().connection === "connected";
  return { conversationShown: !work || phone || dock.open, highlight, hostConnected, nav };
}

/**
 * The tab's live picture, fitted to the frame's width and panned so the
 * task's pointer stays in the middle third. Panning is eased, clamped to the
 * picture's real overflow, and still under reduced motion.
 */
function BrowserFinder({
  enabled,
  hostClient,
  placeKey,
  sessionId,
  tabId,
  threadId,
}: {
  readonly enabled: boolean;
  readonly hostClient: HostClient;
  readonly placeKey: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly threadId: string;
}) {
  const surfaceId = BrowserSurfaceIdSchema.safeParse(tabId).data ?? null;
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
    if (!canvas || !enabled || !surfaceId) return;
    return attachBrowserCanvas(
      hostClient.browserWatchFrames,
      sessionId,
      tabId,
      true,
      canvas,
      () => setShown(true),
      true,
    );
  }, [hostClient, sessionId, tabId, surfaceId, enabled]);

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
