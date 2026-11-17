import {
  attachBrowserCanvas,
  drawnBrowserFrame,
  browserPicturePresentedEvent,
} from "../browser/browser-presenter.js";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { BrowserCropCue } from "../browser/browser-crop-cue.js";
import { browserFrameContentRect } from "@opensteer/shared/browserPresentation";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  browserTabPicture,
  pageSiteLabel,
  placeActivityPoint,
  type HostClient,
} from "@opensteer/client/host";
import { useRunPlaceView, type RunPlaceView } from "@opensteer/client/react";
export { useRunPlaceView, type RunPlaceView } from "@opensteer/client/react";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { useMediaQuery } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import { AgentCursors } from "./agent-cursors.js";
import { destinationPlaceKey } from "./navigation.js";
import { RunPlaceCanvas, useRunPlacePictures } from "./run-place-picture.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * A conversation's live page, folded small into its header: the place its
 * working Run acts in now. Where that place is already in the middle, the
 * middle shows it and this steps aside. Where the page can stand above the
 * conversation, pressing it unfolds the page there instead.
 */
export function LivePlace({
  hostClient,
  onUnfold = null,
  runId,
  threadId,
}: {
  readonly hostClient: HostClient;
  readonly onUnfold?: (() => void) | null;
  readonly runId: string;
  readonly threadId: string;
}) {
  const { acting, place } = useRunPlaceView(hostClient, runId, threadId);
  const { selection } = useWorkspace();
  if (place === null) return null;
  if (selection.kind === "place" && destinationPlaceKey(selection.destination) === place.placeKey)
    return null;
  return (
    <Viewfinder
      acting={acting}
      hostClient={hostClient}
      onUnfold={onUnfold}
      place={place}
      threadId={threadId}
    />
  );
}

/**
 * A working Run's live picture of the place it is in, framed on its pointer,
 * with the agents' cursors, ringed in green while it acts. Pressing it shows
 * that place in the middle and changes nothing else. It only reads the
 * conversation's one picture: a fresh one is drawn at full strength, one kept
 * from earlier is dimmed, and with none it shows the kind of place.
 */
export const Viewfinder = memo(function Viewfinder({
  acting = false,
  hostClient,
  onUnfold = null,
  place,
  threadId,
}: {
  readonly acting?: boolean;
  readonly hostClient: HostClient;
  readonly onUnfold?: (() => void) | null;
  readonly place: RunPlaceView;
  readonly threadId: string;
}) {
  const { conversationShown, highlight, nav } = useViewfinderContext();
  const rootRef = useRef<HTMLButtonElement | null>(null);
  const inView = useInView(rootRef);
  const { destination } = place;
  // Off screen or put away, it draws nothing; the conversation decides what is watched.
  const live = inView && conversationShown;
  const { usable, fresh } = usePlacePicture(place);
  const [painted, setPainted] = useState(false);
  const name = placeName(place);
  return (
    <button
      aria-expanded={onUnfold === null ? undefined : false}
      aria-label={`Show ${name}${acting ? ", agent working" : ""}`}
      className={[
        "viewfinder",
        place.kind === "page" ? "" : "viewfinder--native",
        acting ? "viewfinder--acting" : "",
        usable && painted && !fresh ? "viewfinder--still" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-place-key={place.placeKey}
      disabled={destination === null && onUnfold === null}
      onBlur={() => highlight.set(null)}
      onClick={() => {
        if (onUnfold) onUnfold();
        else if (destination) nav.showPlace(destination);
      }}
      onFocus={() => highlight.set({ placeKey: place.placeKey, threadId: null, threadIds: [] })}
      onPointerEnter={() =>
        highlight.set({ placeKey: place.placeKey, threadId: null, threadIds: [] })
      }
      onPointerLeave={() => highlight.set(null)}
      ref={rootRef}
      title={name}
      type="button"
    >
      <span aria-hidden className="viewfinder__frame">
        <PlacePicture
          enabled={live}
          hostClient={hostClient}
          onPainted={setPainted}
          place={place}
          threadId={threadId}
          usable={usable}
        />
        {usable && painted ? null : <PlaceGlyph kind={place.kind} />}
      </span>
    </button>
  );
});

export function placeName(place: RunPlaceView): string {
  const site = place.site ? pageSiteLabel(place.site) : null;
  return site && site !== place.title ? `${place.title} — ${site}` : place.title;
}

export function PlaceGlyph({ kind }: { readonly kind: RunPlaceView["kind"] }) {
  return (
    <Icon
      className="viewfinder__glyph"
      name={
        kind === "page" ? "globe" : kind === "phone" ? "phone" : kind === "app" ? "app" : "desktop"
      }
    />
  );
}

/** The conversation's picture of this place: whether it has pixels, and whether they are current. */
export function usePlacePicture(place: RunPlaceView | null) {
  const { picture } = useRunPlacePictures();
  const usable = place !== null && picture.placeKey === place.placeKey && picture.usable;
  return { usable, fresh: usable && picture.fresh, aspect: usable ? picture.aspect : null };
}

/**
 * A Run place's picture, filling the frame it is put in: the tab's frames
 * from the watch store, or the Mac app's or phone's from the conversation's
 * one decoder. It holds no watch of its own. It says whether it has pixels
 * on screen, which a newly drawn form lacks until its first picture arrives.
 */
export function PlacePicture({
  enabled,
  hostClient,
  onPainted,
  place,
  threadId,
  usable,
}: {
  readonly enabled: boolean;
  readonly hostClient: HostClient;
  readonly onPainted: (painted: boolean) => void;
  readonly place: RunPlaceView;
  readonly threadId: string;
  readonly usable: boolean;
}) {
  const { destination } = place;
  if (place.kind === "page")
    return destination && place.pageSession ? (
      <BrowserFinder
        key={`${place.pageSession}:${destination.tabId}`}
        enabled={enabled}
        hostClient={hostClient}
        onPainted={onPainted}
        placeKey={place.placeKey}
        sessionId={place.pageSession}
        tabId={destination.tabId}
        threadId={threadId}
        usable={usable}
      />
    ) : null;
  return (
    <span className="viewfinder__native">
      <RunPlaceCanvas
        enabled={enabled}
        mac={place.kind === "window"}
        onPainted={onPainted}
        usable={usable}
      />
    </span>
  );
}

function useViewfinderContext() {
  const { dock, highlight, nav, phone, work } = useWorkspace();
  return { conversationShown: !work || phone || dock.open, highlight, nav };
}

/**
 * The tab's live picture, fitted to the frame's width and panned so the
 * task's pointer stays in the middle third. Panning is eased, clamped to the
 * picture's real overflow, and still under reduced motion.
 */
function BrowserFinder({
  enabled,
  hostClient,
  onPainted,
  placeKey,
  sessionId,
  tabId,
  threadId,
  usable,
}: {
  readonly enabled: boolean;
  readonly hostClient: HostClient;
  readonly onPainted: (painted: boolean) => void;
  readonly placeKey: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly threadId: string;
  /** The conversation still counts this tab's pixels; when it stops, they leave the screen. */
  readonly usable: boolean;
}) {
  const surfaceId = BrowserSurfaceIdSchema.safeParse(tabId).data ?? null;
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const imageRef = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(false);
  // The conversation counts a picture either store kept, an opened page's included.
  useSyncExternalStore(
    useCallback(
      (listener) => {
        const stops = [hostClient.browserWatchFrames, hostClient.browserFrames].map((frames) =>
          frames.subscribe(sessionId, listener, tabId),
        );
        return () => stops.forEach((stop) => stop());
      },
      [hostClient, sessionId, tabId],
    ),
    useCallback(
      () =>
        JSON.stringify(
          [hostClient.browserWatchFrames, hostClient.browserFrames].map(
            (frames) => frames.invalidationKey?.(sessionId, tabId) ?? 0,
          ),
        ),
      [hostClient, sessionId, tabId],
    ),
  );
  const cached = browserTabPicture(hostClient, tabId);
  const painted = shown || cached !== null;
  useLayoutEffect(() => onPainted(painted), [onPainted, painted]);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !surfaceId) return;
    return attachBrowserCanvas(
      hostClient.browserWatchFrames,
      sessionId,
      tabId,
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
    <span
      className={usable ? "viewfinder__picture" : "viewfinder__picture place-picture--gone"}
      ref={frameRef}
    >
      <span
        className={
          reducedMotion
            ? "viewfinder__image browser-frame viewfinder__image--still"
            : "viewfinder__image browser-frame"
        }
        ref={imageRef}
      >
        {!shown && cached ? (
          <img
            alt=""
            src={cached.uri}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", display: "block" }}
          />
        ) : null}
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
