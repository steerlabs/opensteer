import {
  pageSiteLabel,
  runPageHandleHeight,
  runPageRowHeight,
  type HostClient,
  type RunPageShown,
} from "@opensteer/client/host";
import { useRunPageView } from "@opensteer/client/react";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useMediaQuery } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import { LastPictureChip } from "../last-picture-chip.js";
import {
  PlaceGlyph,
  PlacePicture,
  placeName,
  usePlacePicture,
  useRunPlaceView,
} from "./viewfinder.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * Whether the browser says this connection costs the person data: cellular,
 * or they asked to save data. A browser that cannot say is not known to.
 */
export function meteredConnection(): boolean {
  const connection = (
    navigator as { readonly connection?: { readonly type?: string; readonly saveData?: boolean } }
  ).connection;
  return connection?.saveData === true || connection?.type === "cellular";
}

/**
 * Whether the person is writing in this conversation on a keyboard that takes
 * room from it, so a page opening now would push away the line they write. A
 * hardware keyboard takes none: only an on-screen one, or a field just focused
 * where one comes up, defers the page. A keyboard seen closing ends that
 * focus's claim, as Android's Back does without taking focus from the field.
 */
export function useTypingHere(threadRef: RefObject<HTMLElement | null>, keyboardInset: number) {
  const touch = useMediaQuery("(pointer: coarse)");
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || !touch) {
      setWriting(false);
      return;
    }
    const writable = (node: EventTarget | null) =>
      node instanceof HTMLElement &&
      thread.contains(node) &&
      (node.isContentEditable ||
        node.matches(
          "textarea, input:not([type=button], [type=checkbox], [type=radio], [type=submit])",
        ));
    const update = (event: FocusEvent) =>
      setWriting(writable(event.type === "focusin" ? event.target : event.relatedTarget));
    setWriting(writable(document.activeElement));
    thread.addEventListener("focusin", update);
    thread.addEventListener("focusout", update);
    return () => {
      thread.removeEventListener("focusin", update);
      thread.removeEventListener("focusout", update);
    };
  }, [threadRef, touch]);
  const keyboardUp = useRef(keyboardInset > 0);
  useEffect(() => {
    if (keyboardUp.current && keyboardInset === 0) setWriting(false);
    keyboardUp.current = keyboardInset > 0;
  }, [keyboardInset]);
  return keyboardInset > 0 || writing;
}

/**
 * The page a conversation's Run is in, above the conversation, while that Run
 * works there: the page itself at its own shape, or the named row that stands
 * for it before its first picture, where it can have none, or where the head
 * has no room for the folded picture. It only watches and only reads the
 * conversation's one picture: pressing it shows the full place. The
 * transcript keeps every line where it was throughout, and focus inside it is
 * never dropped when it folds or its Run ends.
 */
export const RunPage = memo(function RunPage({
  focusPage,
  foldedHere,
  hostClient,
  onFold,
  onUnfold,
  page,
  room,
  runId,
  scrollRef,
  shown,
  threadId,
  threadRef,
}: {
  readonly focusPage: RefObject<boolean>;
  /** The head has given up the folded picture for room, so folded stands here as the row. */
  readonly foldedHere: boolean;
  readonly hostClient: HostClient;
  readonly onFold: () => void;
  /** Null where there is no room to open it: the row then opens the full place. */
  readonly onUnfold: (() => void) | null;
  readonly page: { readonly height: number; readonly width: number } | null;
  readonly room: { readonly height: number; readonly width: number } | null;
  readonly runId: string;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly shown: RunPageShown;
  readonly threadId: string;
  readonly threadRef: RefObject<HTMLElement | null>;
}) {
  const { nav } = useWorkspace();
  const { acting, place } = useRunPlaceView(hostClient, runId, threadId);
  const [{ memory }] = useRunPageView(hostClient, threadId);
  const { usable, fresh } = usePlacePicture(place);
  const [painted, setPainted] = useState(false);
  // Open is the person's or the rules' choice; folded here, the row only stands in for the head.
  const open = memory.run?.runId === runId && memory.run.intent === "open";
  const visible = place !== null && (shown === "page" || shown === "row");
  const asPage = visible && shown === "page" && page !== null;
  const height = visible
    ? asPage
      ? page.height + runPageHandleHeight
      : runPageRowHeight + (open ? runPageHandleHeight : 0)
    : 0;
  useHeldLines(scrollRef, height);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (visible && focusPage.current) viewRef.current?.focus({ preventScroll: true });
    focusPage.current = false;
  }, [focusPage, visible]);
  useFocusKept(panelRef, threadRef, visible);

  const drag = useRef<number | null>(null);
  const dragged = useRef(false);
  const fold = () => {
    onFold();
    // Folded here, the handle goes and the row stays: focus stays on the row.
    if (foldedHere && panelRef.current?.contains(document.activeElement))
      viewRef.current?.focus({ preventScroll: true });
  };
  if (!visible) return null;
  const destination = place.destination;
  const site = place.site ? pageSiteLabel(place.site) : null;
  // A kept picture holds the page's place and size; it only steps back.
  const stale = usable && painted && !fresh;
  // Folded here, pressing it does what the folded picture does: open it when it fits.
  const unfoldsHere = !open && onUnfold !== null;
  return (
    <div className={open ? "run-page" : "run-page run-page--folded"} ref={panelRef}>
      <button
        aria-expanded={unfoldsHere ? false : undefined}
        aria-label={`Show ${placeName(place)}${acting ? ", agent working" : ""}${stale ? ", earlier picture" : ""}`}
        className={[
          "run-page__view",
          asPage ? "run-page__view--page" : "run-page__view--row",
          asPage && room !== null && page.width >= room.width ? "run-page__view--full" : "",
          acting ? "run-page__view--acting" : "",
          stale ? "run-page__view--stale" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        disabled={destination === null && !unfoldsHere}
        onClick={() => {
          if (unfoldsHere) onUnfold();
          else if (destination) nav.showPlace(destination);
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
          <span className="run-page__picture">
            <PlacePicture
              enabled
              hostClient={hostClient}
              onPainted={setPainted}
              place={place}
              threadId={threadId}
              usable={usable}
            />
          </span>
          {usable && painted ? null : <PlaceGlyph kind={place.kind} />}
          {stale && asPage ? <LastPictureChip /> : null}
        </span>
        {asPage ? null : (
          <>
            <span className="run-page__words">
              <span className="run-page__title">{place.title}</span>
              {site && site !== place.title ? <span className="run-page__site">{site}</span> : null}
            </span>
            <Icon className="run-page__chevron" name="chevron-right" />
          </>
        )}
      </button>
      {open ? (
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
      ) : null}
    </div>
  );
});

/**
 * The room a page may take: from under the conversation's head to the top of
 * its dock and whatever waits on the reader there, keyboard and all, less the
 * handle. Null until measured.
 */
export function useRoom(threadRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [room, setRoom] = useState<{ readonly height: number; readonly width: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const thread = threadRef.current;
    const body = thread?.querySelector<HTMLElement>(":scope > .thread__body");
    if (!enabled || !thread || !body) return;
    const measure = () => {
      let taken = 0;
      for (const child of thread.querySelectorAll<HTMLElement>(
        ":scope > .conv-header, :scope > .thread-find, :scope > .composer-dock",
      ))
        taken += child.offsetHeight;
      for (const child of body.children)
        if (!child.classList.contains("thread__conversation"))
          taken += (child as HTMLElement).offsetHeight;
      const height = thread.clientHeight - taken - runPageHandleHeight;
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
  }, [enabled, threadRef]);
  return enabled ? room : null;
}

/**
 * Focus inside the page is never dropped: when the page folds, gives way or
 * its Run ends, focus moves to what stands for it now, the folded picture or
 * the row, or else to the composer, where the conversation goes on.
 */
function useFocusKept(
  panelRef: RefObject<HTMLElement | null>,
  threadRef: RefObject<HTMLElement | null>,
  shown: boolean,
) {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!shown || !panel) return;
    // What had focus here, until focus moves somewhere else that is still drawn.
    let last = panel.contains(document.activeElement) ? document.activeElement : null;
    const enter = (event: FocusEvent) => (last = event.target as Element);
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !panel.contains(event.relatedTarget)) last = null;
    };
    panel.addEventListener("focusin", enter);
    panel.addEventListener("focusout", leave);
    return () => {
      panel.removeEventListener("focusin", enter);
      panel.removeEventListener("focusout", leave);
      const went = last;
      const thread = threadRef.current;
      // After the commit that removes the page, when what replaces it is drawn.
      queueMicrotask(() => {
        // Only focus that went away with the page: elsewhere it is the person's own.
        if (went === null || went.isConnected || !thread?.isConnected) return;
        const now = document.activeElement;
        if (now !== null && now !== document.body && now.isConnected) return;
        const next =
          [...thread.querySelectorAll<HTMLElement>(".conv-header .viewfinder")].find(
            (picture) => picture.closest("[data-yielded]") === null,
          ) ??
          thread.querySelector<HTMLElement>(".run-page__view") ??
          thread.querySelector<HTMLElement>(".composer-dock textarea");
        next?.focus({ preventScroll: true });
      });
    };
  }, [panelRef, shown, threadRef]);
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
