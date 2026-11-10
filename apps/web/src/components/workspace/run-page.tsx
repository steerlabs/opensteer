import {
  changeRunPageMemory,
  pageSiteLabel,
  runPageActed,
  runPageFolded,
  runPageMemory,
  runPageOpened,
  runPageShown,
  runPageSize,
  subscribeRunPageMemory,
  type HostClient,
  type RunPageMoment,
} from "@opensteer/client/host";
import { useRunPlace } from "@opensteer/client/react";
import { observeResize } from "@opensteer/shared/resizeObserver";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Icon } from "../icon.js";
import {
  hasPlacePicture,
  PlaceGlyph,
  PlacePicture,
  placeName,
  useRunPlaceView,
} from "./viewfinder.js";
import { useWorkspace } from "./workspace-context.js";

/** The edge between the page and the conversation, which folds the page. */
const handleHeight = 20;
/** A page with no picture to show is a row this tall, never a large empty box. */
const rowHeight = 52;
/** Before a picture says otherwise, a page is the shape of a desktop browser. */
const desktopAspect = 1.6;
/** How much of the conversation stays in view under the page. */
const keptTranscript = 132;

/**
 * Whether the browser says this connection costs the person data: cellular,
 * or they asked to save data. A browser that cannot say is not known to.
 */
function meteredConnection(): boolean {
  const connection = (
    navigator as { readonly connection?: { readonly type?: string; readonly saveData?: boolean } }
  ).connection;
  return connection?.saveData === true || connection?.type === "cellular";
}

/**
 * A conversation's Run page on a phone-width screen: whether it stands open
 * above the conversation, decided once on the agent's first action by the
 * shared rules, and the ways to fold and unfold it. `runId` is the
 * conversation's working Run, or null where no page stands above it.
 */
export function useRunPage(
  hostClient: HostClient,
  threadId: string,
  runId: string | null,
  moment: () => Omit<RunPageMoment, "cellular">,
) {
  const memory = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeRunPageMemory(hostClient, threadId, listener),
      [hostClient, threadId],
    ),
    useCallback(() => runPageMemory(hostClient, threadId), [hostClient, threadId]),
  );
  const entry = useRunPlace(hostClient, runId);
  const placeRunId = entry?.runId ?? null;
  const [fits, setFits] = useState(true);
  const momentRef = useRef(moment);
  momentRef.current = moment;
  useEffect(() => {
    if (placeRunId === null) return;
    changeRunPageMemory(hostClient, threadId, (current) =>
      runPageActed(current, placeRunId, { ...momentRef.current(), cellular: meteredConnection() }),
    );
  }, [hostClient, placeRunId, threadId]);
  // Pressing the folded picture hands focus to the page it opens.
  const focusPage = useRef(false);
  const unfold = useCallback(() => {
    if (placeRunId === null) return;
    focusPage.current = document.activeElement?.closest(".viewfinder") != null;
    changeRunPageMemory(hostClient, threadId, () => runPageOpened(placeRunId));
  }, [hostClient, placeRunId, threadId]);
  const fold = useCallback(
    () => changeRunPageMemory(hostClient, threadId, runPageFolded),
    [hostClient, threadId],
  );
  return {
    fits,
    fold,
    focusPage,
    placeRunId,
    setFits,
    shown: runPageShown(memory, placeRunId, fits),
    /** Null where there is no room: the folded picture opens the full tab instead. */
    unfold: placeRunId !== null && fits ? unfold : null,
  };
}

/**
 * The page a conversation's Run is in, above the conversation, while that Run
 * works there. It only watches: pressing it shows the full tab. It measures
 * the room left even while folded, so the folded picture knows whether it can
 * open here. The transcript keeps every line where it was as it opens or folds.
 */
export const RunPage = memo(function RunPage({
  focusPage,
  hostClient,
  onFits,
  onFold,
  open,
  runId,
  scrollRef,
  threadId,
  threadRef,
}: {
  readonly focusPage: RefObject<boolean>;
  readonly hostClient: HostClient;
  readonly onFits: (fits: boolean) => void;
  readonly onFold: () => void;
  readonly open: boolean;
  readonly runId: string;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly threadId: string;
  readonly threadRef: RefObject<HTMLElement | null>;
}) {
  const { nav } = useWorkspace();
  const { acting, place } = useRunPlaceView(hostClient, runId, threadId);
  const room = useRoom(threadRef);
  const placeKey = place?.placeKey ?? null;
  const [shape, setShape] = useState<{ readonly key: string | null; readonly aspect: number }>({
    key: null,
    aspect: desktopAspect,
  });
  const onShape = useCallback(
    (aspect: number) =>
      setShape((current) =>
        current.key === placeKey && Math.abs(current.aspect - aspect) < 0.005
          ? current
          : { key: placeKey, aspect },
      ),
    [placeKey],
  );
  // Only a picture arriving now stands for the page: until one has, it is the named row.
  const [live, setLive] = useState(false);
  const [liveKey, setLiveKey] = useState<string | null>(null);
  const onLive = useCallback(
    (now: boolean) => {
      setLive(now);
      if (now) setLiveKey(placeKey);
    },
    [placeKey],
  );
  const seen = placeKey !== null && shape.key === placeKey && liveKey === placeKey;
  const page =
    room === null
      ? null
      : runPageSize({
          aspect: seen ? shape.aspect : desktopAspect,
          room: room.height,
          transcript: keptTranscript,
          width: room.width,
        });
  const fits = page !== null;
  useLayoutEffect(() => {
    if (room !== null) onFits(fits);
  }, [fits, onFits, room]);

  // One stream for the place through every form: the folded picture and the
  // page hand it over without the watch ever closing between them.
  const destination = place?.destination ?? null;
  const tab =
    destination?.kind === "browser" && destination.tabId
      ? { sessionId: destination.sessionId, tabId: destination.tabId }
      : null;
  useEffect(
    () =>
      tab
        ? hostClient.retainBrowserWatch(tab.sessionId, tab.tabId, {
            captureRegion: true,
            frameWindow: true,
            rasterDemand: true,
          })
        : undefined,
    [hostClient, tab?.sessionId, tab?.tabId],
  );

  const shown = open && place !== null;
  const asPage = shown && seen && page !== null;
  const height = shown ? (asPage ? page.height : rowHeight) + handleHeight : 0;
  useHeldLines(scrollRef, height);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLButtonElement | null>(null);
  const focusFolded = useRef(false);
  const fold = useCallback(() => {
    focusFolded.current = panelRef.current?.contains(document.activeElement) ?? false;
    onFold();
  }, [onFold]);
  useLayoutEffect(() => {
    if (shown && focusPage.current) viewRef.current?.focus({ preventScroll: true });
    focusPage.current = false;
    if (!shown && focusFolded.current)
      threadRef.current
        ?.querySelector<HTMLElement>(".conv-header .viewfinder")
        ?.focus({ preventScroll: true });
    focusFolded.current = false;
  }, [focusPage, shown, threadRef]);

  const drag = useRef<number | null>(null);
  const dragged = useRef(false);
  if (!shown) return null;
  const site = place.site ? pageSiteLabel(place.site) : null;
  return (
    <div className="run-page" ref={panelRef}>
      <button
        aria-label={`Show ${placeName(place)}${acting ? ", agent working" : ""}`}
        className={[
          "run-page__view",
          asPage ? "run-page__view--page" : "run-page__view--row",
          asPage && room !== null && page.width >= room.width ? "run-page__view--full" : "",
          acting ? "run-page__view--acting" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        disabled={destination === null}
        onClick={() => {
          if (destination) nav.showPlace(destination);
        }}
        ref={viewRef}
        title={placeName(place)}
        type="button"
      >
        <span
          aria-hidden
          className="run-page__frame"
          style={asPage ? { width: page.width, height: page.height } : undefined}
        >
          {hasPlacePicture(place) ? (
            <span
              className={
                live ? "run-page__picture" : "run-page__picture run-page__picture--still"
              }
            >
              <PlacePicture
                enabled
                hiddenReason="not-in-view"
                hostClient={hostClient}
                onLive={onLive}
                onShape={onShape}
                place={place}
                threadId={threadId}
              />
            </span>
          ) : null}
          {seen ? null : <PlaceGlyph kind={place.kind} />}
        </span>
        {asPage ? null : (
          <>
            <span className="run-page__words">
              <span className="run-page__title">{place.title}</span>
              {site && site !== place.title ? (
                <span className="run-page__site">{site}</span>
              ) : null}
            </span>
            <Icon className="run-page__chevron" name="chevron-right" />
          </>
        )}
      </button>
      <button
        aria-label="Fold page"
        className="run-page__handle"
        onClick={() => {
          // The drag that ended here already folded it.
          if (dragged.current) dragged.current = false;
          else fold();
        }}
        onPointerDown={(event) => {
          drag.current = event.clientY;
          dragged.current = false;
        }}
        onPointerUp={(event) => {
          const from = drag.current;
          drag.current = null;
          if (from === null || from - event.clientY < 24) return;
          dragged.current = true;
          fold();
        }}
        type="button"
      >
        <span aria-hidden className="run-page__grip" />
      </button>
    </div>
  );
});

/**
 * The room a page may take: from under the conversation's head to the top of
 * its dock and whatever waits on the reader there, keyboard and all, less the
 * handle. Null until measured.
 */
function useRoom(threadRef: RefObject<HTMLElement | null>) {
  const [room, setRoom] = useState<{ readonly height: number; readonly width: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const thread = threadRef.current;
    const body = thread?.querySelector<HTMLElement>(":scope > .thread__body");
    if (!thread || !body) return;
    const measure = () => {
      let taken = 0;
      for (const child of thread.querySelectorAll<HTMLElement>(
        ":scope > .conv-header, :scope > .thread-find, :scope > .composer-dock",
      ))
        taken += child.offsetHeight;
      for (const child of body.children)
        if (!child.classList.contains("thread__conversation"))
          taken += (child as HTMLElement).offsetHeight;
      const height = thread.clientHeight - taken - handleHeight;
      const width = thread.clientWidth;
      setRoom((current) =>
        current?.height === height && current.width === width ? current : { height, width },
      );
    };
    measure();
    let stop = () => undefined as void;
    const watch = () => {
      stop();
      stop = observeResize(
        [thread, ...thread.querySelectorAll(":scope > *"), ...body.children],
        measure,
      );
      measure();
    };
    watch();
    // A question docking or a search opening adds what the page must leave room for.
    const changes = new MutationObserver(watch);
    changes.observe(thread, { childList: true });
    changes.observe(body, { childList: true });
    return () => {
      changes.disconnect();
      stop();
    };
  }, [threadRef]);
  return room;
}

/**
 * Keeps every line of the transcript where it is on screen while the page
 * above it changes height: the scroller's top moves by that much, so its
 * position moves with it.
 */
function useHeldLines(scrollRef: RefObject<HTMLElement | null>, height: number) {
  const held = useRef(0);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const change = height - held.current;
    held.current = height;
    if (scroller && change !== 0) scroller.scrollTop += change;
  }, [height, scrollRef]);
  useLayoutEffect(
    () => () => {
      const scroller = scrollRef.current;
      if (scroller && held.current !== 0) scroller.scrollTop -= held.current;
    },
    [scrollRef],
  );
}
