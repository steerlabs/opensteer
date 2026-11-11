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
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getBrowserLastPicture,
  rememberBrowserLastPicture,
  pageSiteLabel,
  placeActivityPoint,
  runPlaceActing,
  type BrowserFrameView,
  type HostClient,
  type SurfaceDestination,
} from "@opensteer/client/host";
import {
  useBrowserTabAwake,
  useHostSelector,
  useRunPlace,
  useRunPlaceBinding,
} from "@opensteer/client/react";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { placeIdentityKey } from "@opensteer/protocol";
import { useMediaQuery } from "../../ui-utils.js";
import { ComputerWatchView } from "../computer-watch.js";
import { Icon } from "../icon.js";
import { AgentCursors } from "./agent-cursors.js";
import { destinationPlaceKey } from "./navigation.js";
import { useWorkspace } from "./workspace-context.js";

export interface RunPlaceView {
  readonly placeKey: string;
  readonly destination: SurfaceDestination | null;
  readonly binding?: SurfaceDestination | null;
  /** The Run's session in a native place, whose picture the tile shows. */
  readonly sessionId?: string | null;
  readonly title: string;
  readonly site: string | null;
  readonly kind: "browser" | "app" | "phone";
}

/** A conversation's Run place as both of its pictures show it, with whether its agent acts there now. */
export function useRunPlaceView(hostClient: HostClient, runId: string | null, threadId: string) {
  const entry = useRunPlace(hostClient, runId);
  const { destination, binding, sessionId } = useRunPlaceBinding(hostClient, entry);
  const acting = useHostSelector(hostClient, (snapshot) =>
    entry === null ? false : runPlaceActing(entry, snapshot, threadId),
  );
  const place = useMemo<RunPlaceView | null>(
    () =>
      entry === null
        ? null
        : {
            placeKey:
              (destination ? destinationPlaceKey(destination) : null) ??
              placeIdentityKey(entry.data.place),
            destination,
            binding,
            sessionId,
            kind: entry.data.place.kind,
            title: entry.data.title,
            site: entry.data.site,
          },
    [binding, destination, entry, sessionId],
  );
  return { acting, entry, place };
}

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
 * that place in the middle and changes nothing else. Only a picture arriving
 * now is drawn at full strength; one kept from earlier is dimmed, and with no
 * picture at all it shows the kind of place.
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
  // A conversation put away is not on screen, whatever its geometry says: its
  // picture lets go of its watch until it is shown again. A hidden page only
  // pauses it in the client, which keeps the last picture.
  const live = inView && conversationShown;
  const [pictureLive, setPictureLive] = useState(false);
  const name = placeName(place);
  return (
    <button
      aria-expanded={onUnfold === null ? undefined : false}
      aria-label={`Show ${name}${acting ? ", agent working" : ""}`}
      className={[
        "viewfinder",
        place.kind === "browser" ? "" : "viewfinder--native",
        acting ? "viewfinder--acting" : "",
        pictureLive ? "" : "viewfinder--still",
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
        {hasPlacePicture(place) ? (
          <PlacePicture
            enabled={live}
            hiddenReason={!inView ? "not-in-view" : "conversation-hidden"}
            hostClient={hostClient}
            onLive={setPictureLive}
            place={place}
            threadId={threadId}
          />
        ) : (
          <PlaceGlyph kind={place.kind} />
        )}
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
      name={kind === "browser" ? "globe" : kind === "phone" ? "phone" : "desktop"}
    />
  );
}

function pictureSource(place: RunPlaceView) {
  const { destination } = place;
  const binding = place.binding ?? destination;
  const sessionId =
    place.sessionId ?? (binding?.kind === "app" ? (binding.computerSessionId ?? null) : null);
  if (destination?.kind === "browser" && destination.tabId)
    return { kind: "browser", sessionId: destination.sessionId, tabId: destination.tabId } as const;
  if (binding && (binding.kind === "app" || binding.kind === "phone") && sessionId !== null)
    return { kind: "native", binding, sessionId } as const;
  return null;
}

/** Whether the place has a picture to ask for: a tab, or a Mac app's or phone's session. */
export function hasPlacePicture(place: RunPlaceView): boolean {
  return pictureSource(place) !== null;
}

/**
 * A Run place's picture, filling the frame it is put in: the tab's, or the
 * Mac app's or phone's. `onShape` hears the shape of each picture there is to
 * show, kept or live.
 */
export function PlacePicture({
  enabled,
  hiddenReason,
  hostClient,
  onLive,
  onShape,
  place,
  threadId,
}: {
  readonly enabled: boolean;
  readonly hiddenReason: "not-in-view" | "conversation-hidden";
  readonly hostClient: HostClient;
  readonly onLive: (live: boolean) => void;
  readonly onShape?: (aspect: number) => void;
  readonly place: RunPlaceView;
  readonly threadId: string;
}) {
  const hostConnected =
    useHostSelector(hostClient, (snapshot) => snapshot.connection) === "connected";
  const source = pictureSource(place);
  const reportRatio = useCallback(
    (ratio: string) => {
      const [width, height] = ratio.split("/").map(Number);
      if (width && height) onShape?.(width / height);
    },
    [onShape],
  );
  if (source?.kind === "browser")
    return (
      <BrowserFinder
        key={`${source.sessionId}:${source.tabId}`}
        onLive={onLive}
        onShape={onShape}
        enabled={enabled}
        hostClient={hostClient}
        placeKey={place.placeKey}
        sessionId={source.sessionId}
        tabId={source.tabId}
        threadId={threadId}
      />
    );
  if (source?.kind === "native") {
    const { binding } = source;
    return (
      <span className="viewfinder__native">
        <ComputerWatchView
          key={`${binding.machineId}:${binding.kind === "app" ? binding.appKey : "main"}`}
          appKey={binding.kind === "app" ? binding.appKey : null}
          compact
          preserveLastFrame
          onPictureLive={onLive}
          onPictureRatio={reportRatio}
          hostClient={hostClient}
          hostConnected={hostConnected}
          machineId={binding.machineId || null}
          machines={hostClient.getSnapshot().machines}
          sessionId={source.sessionId}
          visible={enabled && place.destination !== null}
          hiddenReason={enabled ? "destination-changed" : hiddenReason}
        />
      </span>
    );
  }
  return null;
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
  onLive,
  onShape,
  enabled,
  hostClient,
  placeKey,
  sessionId,
  tabId,
  threadId,
}: {
  readonly onLive: (live: boolean) => void;
  readonly onShape: ((aspect: number) => void) | undefined;
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
  // A sleeping tab shows its last picture: watching it would wake it.
  const awake = useBrowserTabAwake(hostClient, sessionId, tabId);
  useEffect(
    () =>
      enabled && awake && surfaceId
        ? hostClient.retainBrowserWatch(sessionId, tabId, {
            captureRegion: true,
            frameWindow: true,
            rasterDemand: true,
          })
        : undefined,
    [awake, hostClient, sessionId, tabId, surfaceId, enabled],
  );
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const imageRef = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(false);
  useSyncExternalStore(
    useCallback(
      (listener) => hostClient.browserWatchFrames.subscribe(sessionId, listener, tabId),
      [hostClient, sessionId, tabId],
    ),
    useCallback(
      () => hostClient.browserWatchFrames.invalidationKey?.(sessionId, tabId) ?? 0,
      [hostClient, sessionId, tabId],
    ),
  );
  const cached = getBrowserLastPicture(hostClient.browserWatchFrames, sessionId, tabId);
  const cachedAspect = cached ? frameAspect(cached.frame.header) : 0;
  useEffect(() => {
    if (cachedAspect > 0) onShape?.(cachedAspect);
  }, [cachedAspect, onShape]);
  const reportShape = useRef(onShape);
  reportShape.current = onShape;
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
      (frame) => {
        rememberBrowserLastPicture(hostClient.browserWatchFrames, sessionId, tabId, frame);
        setShown(true);
      },
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
      reportShape.current?.(frameAspect(shown.header));
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

function frameAspect(header: BrowserFrameView["header"]): number {
  const region = header.capture ?? { width: header.rasterWidth, height: header.rasterHeight };
  return region.height > 0 ? region.width / region.height : 0;
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
