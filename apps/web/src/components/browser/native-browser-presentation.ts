import { observeResize } from "@opensteer/shared/resizeObserver";
import { BrowserSessionIdSchema, type BrowserSurfaceId } from "@opensteer/core";
import type { HostClient } from "@opensteer/client/host";
import type {
  DesktopBrowserPresentationEvent,
  DesktopBrowserPresentationTarget,
  DesktopWindowRect,
} from "@opensteer/protocol/desktop";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import {
  nativeBrowserPresented,
  nativeBrowserPresentationPending,
} from "../native-browser-overlays.js";

export type BrowserHandoff = "pending" | "admitted" | "terminal";

export type NativeBrowserPlacement = Extract<DesktopBrowserPresentationEvent, { type: "placed" }>;
type FindResult = Extract<DesktopBrowserPresentationEvent, { type: "find" }>;

export function useBrowserPresentationMode(
  hostClient: HostClient,
  sessionId: string,
  sessionReady: boolean,
) {
  const bridge = desktopBridge()?.browserPresentation;
  const [result, setResult] = useState<{
    hostClient: HostClient;
    sessionId: string;
    mode: "native" | "streamed" | "pending";
    error: string | null;
  }>({ hostClient, sessionId, mode: bridge ? "pending" : "streamed", error: null });
  useEffect(() => {
    if (
      !bridge ||
      !sessionReady ||
      (result.hostClient === hostClient &&
        result.sessionId === sessionId &&
        (result.mode !== "pending" || result.error !== null))
    )
      return;
    let current = true;
    void bridge
      .isLocal({ sessionId: BrowserSessionIdSchema.parse(sessionId) })
      .then(async (local) => {
        const capable = local
          ? ((await hostClient.browserTargetControlAvailable?.()) ?? null)
          : false;
        if (current && capable !== null)
          setResult({
            hostClient,
            sessionId,
            mode: capable ? "native" : "streamed",
            error: null,
          });
      })
      .catch(() => {
        if (current)
          setResult({ hostClient, sessionId, mode: "pending", error: "This tab can’t be shown." });
      });
    return () => {
      current = false;
    };
  }, [bridge, hostClient, sessionId, sessionReady, result]);
  return result.hostClient === hostClient && result.sessionId === sessionId
    ? result
    : {
        sessionId,
        mode: bridge ? ("pending" as const) : ("streamed" as const),
        error: null,
      };
}

/** Keeps the presentation identity across tab changes; only main places the actual page. */
export function useNativeBrowserPresentation({
  active,
  handoff,
  admissionId,
  sessionId,
  surfaceId,
  stageRef,
}: {
  readonly active: boolean;
  readonly handoff: BrowserHandoff;
  readonly admissionId: string | undefined;
  readonly sessionId: string;
  readonly surfaceId: BrowserSurfaceId;
  readonly stageRef: RefObject<HTMLDivElement | null>;
}) {
  const bridge = desktopBridge()?.browserPresentation;
  const target = useRef<DesktopBrowserPresentationTarget | null>(null);
  const [placement, setPlacement] = useState<NativeBrowserPlacement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [findResult, setFindResult] = useState<FindResult | null>(null);
  const desired = useRef({ active, handoff, admissionId, sessionId, surfaceId, generation: 0 });
  const previous = desired.current;
  desired.current = {
    active,
    handoff,
    admissionId,
    sessionId,
    surfaceId,
    generation:
      previous.generation +
      Number(
        previous.active !== active ||
          previous.handoff !== handoff ||
          previous.admissionId !== admissionId ||
          previous.sessionId !== sessionId ||
          previous.surfaceId !== surfaceId,
      ),
  };
  const schedule = useRef(() => {});

  useLayoutEffect(() => {
    if (!bridge || !active) return;
    setError(null);
    let disposed = false;
    let frame = 0;
    let queued = false;
    let busy = false;
    let pending: (() => void) | null = null;
    const finishPending = () => {
      pending?.();
      pending = null;
    };
    let dirty = false;
    let showingSession: string | null = null;
    let showingSurface: BrowserSurfaceId | null = null;
    let lastRect = "";
    let showingGeneration: number | null = null;
    let blockedGeneration: number | null = null;
    let pendingEvents: DesktopBrowserPresentationEvent[] = [];
    const event = (event: DesktopBrowserPresentationEvent, buffer = true) => {
      if (event.type === "key" || event.type === "window-focus") return;
      if (busy && buffer && event.type !== "ended") {
        pendingEvents.push(event);
        return;
      }
      const current = target.current;
      if (!current) {
        if (busy && buffer) pendingEvents.push(event);
        return;
      }
      if (event.presentationId !== current.presentationId) {
        if (busy && buffer) pendingEvents.push(event);
        return;
      }
      if (event.type !== "ended" && showingGeneration !== desired.current.generation) return;
      if ("revision" in event && event.revision < current.revision) return;
      if ("revision" in event) target.current = { ...current, revision: event.revision };
      if (event.type === "placed") {
        setPlacement(event);
        nativeBrowserPresented({ presentationId: event.presentationId, revision: event.revision });
        finishPending();
      } else if (event.type === "find") setFindResult(event);
      else if (event.type === "fullscreen") setFullscreen(event.active);
      else if (event.type === "ended") {
        finishPending();
        blockedGeneration = showingGeneration;
        target.current = null;
        setPlacement(null);
        nativeBrowserPresented(null);
        if (showingGeneration === desired.current.generation && event.reason !== "released") {
          setError(
            event.reason === "access-ended"
              ? "Access to this tab ended."
              : "This tab can’t be shown.",
          );
        }
        schedule.current();
      }
    };
    const unsubscribe = bridge.onEvent(event);
    const release = () => {
      finishPending();
      const current = target.current;
      target.current = null;
      setPlacement(null);
      setFullscreen(false);
      setFindResult(null);
      nativeBrowserPresented(null);
      if (current) void bridge.release(current).catch(() => undefined);
      showingSession = null;
      showingSurface = null;
      showingGeneration = null;
      lastRect = "";
    };
    const measure = async () => {
      frame = 0;
      queued = false;
      if (disposed) return;
      if (busy) {
        dirty = true;
        return;
      }
      const next = desired.current;
      if (!next.active || next.handoff !== "admitted") {
        blockedGeneration = null;
        setError(null);
        // A new tab keeps the old page until its own socket is admitted.
        if (
          next.active &&
          next.handoff === "pending" &&
          target.current &&
          (showingSession !== next.sessionId || showingSurface !== next.surfaceId)
        )
          return;
        release();
        return;
      }
      if (blockedGeneration === next.generation) return;
      const element = stageRef.current;
      if (!element) return;
      const box = element.getBoundingClientRect();
      const rect: DesktopWindowRect = { x: box.x, y: box.y, width: box.width, height: box.height };
      if (!rect.width || !rect.height) {
        release();
        return;
      }
      const serialized = JSON.stringify(rect);
      if (
        target.current &&
        showingSession === next.sessionId &&
        showingSurface === next.surfaceId &&
        lastRect === serialized &&
        showingGeneration === next.generation
      )
        return;
      busy = true;
      finishPending();
      pending = nativeBrowserPresentationPending();
      try {
        if (!target.current || showingSession !== next.sessionId) {
          // New session admission precedes release of the previous session's presentation.
          const result = await bridge.present({
            sessionId: BrowserSessionIdSchema.parse(next.sessionId),
            surfaceId: next.surfaceId,
            rect,
          });
          if (disposed || desired.current.generation !== next.generation) {
            await bridge.release(result);
            return;
          }
          target.current = result;
        } else {
          const current = target.current;
          const result = await bridge.update({
            presentationId: current.presentationId,
            rect,
            surfaceId: next.surfaceId,
          });
          if (disposed || desired.current.generation !== next.generation) {
            release();
            return;
          }
          if (target.current?.presentationId === current.presentationId)
            target.current = {
              ...current,
              revision: Math.max(target.current.revision, result.revision),
            };
        }
        showingSession = next.sessionId;
        showingSurface = next.surfaceId;
        showingGeneration = next.generation;
        lastRect = serialized;
        setError(null);
        const buffered = pendingEvents;
        pendingEvents = [];
        for (const item of buffered) event(item, false);
      } catch {
        if (!disposed && desired.current.generation === next.generation) {
          release();
          blockedGeneration = next.generation;
          setError("This tab can’t be shown.");
        }
      } finally {
        // A successful request stays pending until placed arrives, even if IPC resolves first.
        if (disposed || !target.current) finishPending();
        busy = false;
        if (dirty || desired.current.generation !== next.generation) {
          dirty = false;
          queue();
        }
      }
    };
    const queue = () => {
      if (queued || disposed) return;
      queued = true;
      // Hidden windows keep their native page mounted; their animation frames may be suspended.
      if (document.visibilityState === "hidden") queueMicrotask(() => void measure());
      else frame = requestAnimationFrame(() => void measure());
    };
    const visibility = () => {
      if (document.visibilityState !== "hidden" || !frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
      queued = false;
      queue();
    };
    schedule.current = queue;
    const element = stageRef.current;
    const stopResize = observeResize(element ? [element] : [], queue);
    // Ancestor layout changes can move a same-sized stage without a ResizeObserver notification.
    const layout = new MutationObserver(queue);
    const scrollAncestors: EventTarget[] = [document];
    let ancestor: HTMLElement | null = element?.parentElement ?? null;
    if (element)
      layout.observe(element, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
    while (ancestor) {
      scrollAncestors.push(ancestor);
      layout.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
      ancestor = ancestor.parentElement;
    }
    window.addEventListener("resize", queue);
    for (const ancestor of scrollAncestors) ancestor.addEventListener("scroll", queue);
    document.addEventListener("visibilitychange", visibility);
    queue();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      stopResize();
      layout.disconnect();
      unsubscribe();
      window.removeEventListener("resize", queue);
      for (const ancestor of scrollAncestors) ancestor.removeEventListener("scroll", queue);
      document.removeEventListener("visibilitychange", visibility);
      release();
      schedule.current = () => {};
    };
  }, [active, bridge, stageRef]);
  useLayoutEffect(() => {
    schedule.current();
  }, [handoff, admissionId, sessionId, surfaceId]);
  const focusPage = () => {
    if (bridge && target.current) void bridge.focusPage(target.current).catch(() => undefined);
  };
  return {
    bridge,
    error: active ? error : null,
    findResult,
    focusPage,
    fullscreen,
    placement,
    target,
  };
}
/** All renderer crop and size affordances derive from this placement once. */
export function nativeBrowserGeometry(placement: NativeBrowserPlacement | null) {
  if (!placement) return null;
  const { bounds, stage, viewport, appZoomFactor } = placement;
  return {
    croppedBottom: placement.croppedBottom,
    croppedRight: placement.croppedRight,
    sized: bounds.width !== stage.width || bounds.height !== stage.height,
    fitAvailable:
      Math.abs(viewport.width / appZoomFactor - stage.width) > 1 ||
      Math.abs(viewport.height / appZoomFactor - stage.height) > 1,
  };
}
export type NativeBrowserGeometry = NonNullable<ReturnType<typeof nativeBrowserGeometry>>;
