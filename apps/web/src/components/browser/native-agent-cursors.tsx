import { threadMark, threadInDirectory } from "@opensteer/client/host";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  placeActivityPoint,
  type HostClient,
  type PlaceActivity,
  type PlaceActivityGeometry,
} from "@opensteer/client/host";
import {
  type DesktopBrowserPresentationEvent,
  type DesktopGlassScene,
} from "@opensteer/protocol/desktop";
import type { NativeBrowserGeometry } from "./native-browser-presentation.js";
import { useMediaQuery } from "../../ui-utils.js";
import { useNativeBrowserLayer } from "../native-browser-overlays.js";
import { useTaskDirectory } from "../workspace/task-directory.js";
import { GlassScene } from "../workspace/glass-scene.js";
import { cursorFadeMs, neutralCursorPoint } from "../workspace/cursor-motion.js";
import { desktopBridge } from "../../desktop/desktop-bridge.js";

type Placement = Extract<DesktopBrowserPresentationEvent, { type: "placed" }>;

interface ShownCursor {
  readonly record: PlaceActivity;
  readonly point: { readonly x: number; readonly y: number } | null;
  readonly leaving: boolean;
}

export function NativeAgentCursors({
  hostClient,
  placeKey,
  placement,
  geometry,
}: {
  readonly hostClient: HostClient;
  readonly placeKey: string;
  readonly placement: Placement;
  readonly geometry: NativeBrowserGeometry;
}) {
  const { raised } = useNativeBrowserLayer();
  const glassSupported = placement.glass;
  const directory = useTaskDirectory(hostClient);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [records, setRecords] = useState<readonly ShownCursor[]>([]);
  useEffect(() => {
    const bridge = desktopBridge()?.browserPresentation;
    if (!bridge || !glassSupported) return;
    const target = { presentationId: placement.presentationId, revision: placement.revision };
    return () => bridge.setGlass({ ...target, scene: null });
  }, [glassSupported, placement.presentationId, placement.revision]);
  const view = useMemo<PlaceActivityGeometry>(
    () => ({
      geometryRevision: placement.geometryRevision,
      surfaceId: placement.surfaceId,
      viewportHeight: placement.viewport.height,
      viewportWidth: placement.viewport.width,
    }),
    [
      placement.geometryRevision,
      placement.surfaceId,
      placement.viewport.height,
      placement.viewport.width,
    ],
  );
  const currentView = useRef(view);
  const refresh = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    currentView.current = view;
    refresh.current();
  }, [view]);
  useEffect(() => {
    // Each thread's record and where its cursor was last known to be, as
    // fractions of the page's view: a record without a point keeps it there.
    const shown = new Map<string, Omit<ShownCursor, "leaving">>();
    // A removed cursor is still sent, as leaving, while the glass fades it out.
    const fading = new Map<string, ReturnType<typeof setTimeout>>();
    const publish = () =>
      setRecords(
        [...shown].map(([threadId, value]) => ({ ...value, leaving: fading.has(threadId) })),
      );
    const update = () => {
      const current = new Map<string, PlaceActivity>(
        hostClient.placeActivity(placeKey).map((record) => [record.threadId, record]),
      );
      for (const threadId of shown.keys())
        if (!current.has(threadId) && !fading.has(threadId))
          fading.set(
            threadId,
            setTimeout(() => {
              fading.delete(threadId);
              shown.delete(threadId);
              publish();
            }, cursorFadeMs),
          );
      for (const [threadId, record] of current) {
        clearTimeout(fading.get(threadId));
        fading.delete(threadId);
        // A native page has no captured region: a record places its cursor or says nothing.
        const at = placeActivityPoint(record, currentView.current);
        shown.set(threadId, {
          record,
          point: at.kind === "point" ? at : (shown.get(threadId)?.point ?? null),
        });
      }
      publish();
    };
    refresh.current = update;
    const unsubscribe = hostClient.subscribePlaceActivity(placeKey, update);
    update();
    return () => {
      refresh.current = () => undefined;
      unsubscribe();
      for (const timer of fading.values()) clearTimeout(timer);
    };
  }, [hostClient, placeKey]);
  const scene = useMemo<DesktopGlassScene>(
    () => ({
      croppedBottom: geometry.croppedBottom,
      croppedRight: geometry.croppedRight,
      geometryRevision: placement.geometryRevision,
      reducedMotion,
      cursors: records.slice(0, 32).map(({ record, point, leaving }) => {
        const at = point ?? neutralCursorPoint;
        const mark = threadMark(record.threadId, directory.snapshot);
        return {
          icon: record.home || mark.pending ? null : mark.icon,
          color: record.home ? null : mark.color,
          home: record.home,
          leaving,
          threadId: record.threadId,
          title: record.home
            ? "Opensteer"
            : (threadInDirectory(record.threadId, directory.snapshot)?.title ?? "Task"),
          x: at.x * placement.viewport.width,
          y: at.y * placement.viewport.height,
        };
      }),
    }),
    [
      geometry.croppedBottom,
      geometry.croppedRight,
      placement.geometryRevision,
      reducedMotion,
      records,
      placement.viewport.width,
      placement.viewport.height,
      directory.snapshot,
    ],
  );
  const visibleScene =
    scene.cursors.length || scene.croppedBottom || scene.croppedRight ? scene : null;
  useEffect(() => {
    const bridge = desktopBridge()?.browserPresentation;
    if (!bridge || !glassSupported) return;
    const target = { presentationId: placement.presentationId, revision: placement.revision };
    bridge.setGlass({
      ...target,
      scene: raised ? null : visibleScene,
    });
  }, [glassSupported, placement.presentationId, placement.revision, raised, visibleScene]);
  return raised && scene ? (
    <div
      className="native-app-cursors"
      style={{
        left: placement.bounds.x - placement.stage.x,
        top: placement.bounds.y - placement.stage.y,
        width: placement.bounds.width,
        height: placement.bounds.height,
      }}
    >
      <div
        style={{
          position: "absolute",
          width: placement.bounds.width * placement.appZoomFactor,
          height: placement.bounds.height * placement.appZoomFactor,
          transform: `scale(${1 / placement.appZoomFactor})`,
          transformOrigin: "top left",
        }}
      >
        <GlassScene
          scene={scene}
          width={placement.bounds.width * placement.appZoomFactor}
          height={placement.bounds.height * placement.appZoomFactor}
        />
      </div>
    </div>
  ) : null;
}
