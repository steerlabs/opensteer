import { threadMark, threadInDirectory } from "@opensteer/client/host";
import { drawnBrowserFrame, browserPicturePresentedEvent } from "../browser/browser-presenter.js";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeActivityPoint, type HostClient, type PlaceActivity } from "@opensteer/client/host";
import { browserFrameContentRect } from "@opensteer/shared/browserPresentation";
import { useMediaQuery } from "../../ui-utils.js";
import { taskCursorPaint } from "./task-mark.js";
import { CursorMark, CursorMotion } from "./cursor-motion.js";
import { useTaskDirectory } from "./task-directory.js";

interface CursorSet {
  readonly threadIds: readonly string[];
  /** Removed from the place, still fading out. */
  readonly leaving: ReadonlySet<string>;
}

const emptySet: CursorSet = { leaving: new Set(), threadIds: [] };

interface AgentCursorsProps {
  readonly hostClient: HostClient;
  readonly placeKey: string;
  readonly sessionId: string;
  readonly tabId: string;
  /**
   * `middle`: the picture is fitted into the layer as the viewport draws it.
   * `viewfinder`: the layer is exactly the picture.
   */
  readonly variant: "middle" | "viewfinder";
}

/**
 * Agents' cursors over one browser tab's picture. Each picture is a new
 * layer: a cursor never glides from one page to another.
 */
export const AgentCursors = memo(function AgentCursors(props: AgentCursorsProps) {
  return (
    <PictureCursors key={`${props.placeKey}\n${props.sessionId}\n${props.tabId}`} {...props} />
  );
});

/**
 * React draws which agents have a cursor here; the motion module moves them,
 * outside any render. Spring state is in fractions of the picture, so a
 * resize redraws a cursor in place instead of gliding it.
 */
function PictureCursors({ hostClient, placeKey, tabId, variant }: AgentCursorsProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [motion] = useState(() => new CursorMotion());
  const attachLayer = useCallback(
    (element: HTMLDivElement | null) => {
      layerRef.current = element;
      motion.layerRef(element);
    },
    [motion],
  );
  const [cursors, setCursors] = useState<CursorSet>(() =>
    withPresent(
      emptySet,
      hostClient.placeActivity(placeKey).map((record) => record.threadId),
    ),
  );
  const present = useRef(cursors);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const directory = useTaskDirectory(hostClient);
  const sync = useRef<() => void>(() => undefined);

  useEffect(() => {
    const update = () => {
      const threadIds = hostClient.placeActivity(placeKey).map((record) => record.threadId);
      setCursors((value) => withPresent(value, threadIds));
    };
    update();
    return hostClient.subscribePlaceActivity(placeKey, () => {
      update();
      sync.current();
    });
  }, [hostClient, placeKey]);

  useLayoutEffect(() => motion.setReducedMotion(reducedMotion), [motion, reducedMotion]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const pictureRoot = layer?.parentElement;
    if (!layer || !pictureRoot) return;
    // Cursors already here when this layer first draws them do not arrive.
    let drawn = false;
    const place = () => {
      for (const threadId of present.current.leaving)
        motion.leave(threadId, () => setCursors((value) => without(value, threadId)));
      // The picture's canvas comes and goes with its frames.
      const view = drawnBrowserFrame(pictureRoot.querySelector("canvas"));
      const picture =
        view?.header.surfaceId === tabId
          ? browserFrameContentRect(
              { height: layer.clientHeight, left: 0, top: 0, width: layer.clientWidth },
              view.header.rasterWidth,
              view.header.rasterHeight,
              view.header.capture,
              "top",
              variant === "viewfinder",
            )
          : null;
      // Without this tab's picture there is nothing to point at, and a cursor
      // placed on a guess would glide from it once the picture came.
      if (!view || !picture) {
        for (const threadId of present.current.threadIds)
          if (!present.current.leaving.has(threadId)) motion.place(threadId, "hidden");
        return;
      }
      motion.setSpace({ picture, unit: "fraction" });
      const records = new Map<string, PlaceActivity>(
        hostClient.placeActivity(placeKey).map((record) => [record.threadId, record]),
      );
      for (const threadId of present.current.threadIds) {
        if (present.current.leaving.has(threadId)) continue;
        const record = records.get(threadId);
        if (!record) continue;
        const at = placeActivityPoint(record, view.header);
        motion.place(threadId, at.kind === "point" ? at : at.kind === "hidden" ? "hidden" : null, {
          arrive: drawn,
        });
      }
      drawn = true;
    };
    sync.current = place;
    pictureRoot.addEventListener(browserPicturePresentedEvent, place);
    const stopResize = observeResize([layer], place);
    return () => {
      pictureRoot.removeEventListener(browserPicturePresentedEvent, place);
      stopResize();
      sync.current = () => undefined;
    };
  }, [hostClient, motion, placeKey, tabId, variant]);

  // A cursor that has just appeared is placed before it is painted.
  useLayoutEffect(() => {
    present.current = cursors;
    sync.current();
  });

  return (
    <div
      aria-hidden
      className={[
        "cursor-layer",
        `cursor-layer--${variant}`,
        reducedMotion ? "cursor-layer--still" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={attachLayer}
    >
      {cursors.threadIds.map((threadId) => {
        const home = threadId === directory.homeThreadId;
        return (
          <CursorMark
            color={taskCursorPaint(threadMark(threadId, directory.snapshot), home)}
            icon={home ? null : threadMark(threadId, directory.snapshot).icon}
            id={threadId}
            key={threadId}
            motion={motion}
            title={
              home
                ? "Opensteer"
                : (threadInDirectory(threadId, directory.snapshot)?.title ?? "Task")
            }
          />
        );
      })}
    </div>
  );
}

function withPresent(value: CursorSet, present: readonly string[]): CursorSet {
  const threadIds = [...value.threadIds, ...present.filter((id) => !value.threadIds.includes(id))];
  const leaving = new Set(threadIds.filter((id) => !present.includes(id)));
  return threadIds.length === value.threadIds.length &&
    leaving.size === value.leaving.size &&
    [...leaving].every((id) => value.leaving.has(id))
    ? value
    : { leaving, threadIds };
}

function without(value: CursorSet, threadId: string): CursorSet {
  if (!value.threadIds.includes(threadId)) return value;
  const leaving = new Set(value.leaving);
  leaving.delete(threadId);
  return { leaving, threadIds: value.threadIds.filter((id) => id !== threadId) };
}
