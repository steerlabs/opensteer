import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DesktopBrowserPresentationTarget } from "@opensteer/protocol/desktop";
import { desktopBridge } from "../desktop/desktop-bridge.js";

interface Overlay {
  readonly notify: (ready: boolean) => void;
  release: (() => void) | null;
  ready: boolean;
  open: boolean;
}
const overlays = new Set<Overlay>();
const listeners = new Set<() => void>();
const pointers = new Set<number>();
const pendingReleases = new Set<() => void>();
let observingPointers = false;
let consumeClick = false;
function observePointers() {
  if (observingPointers) return;
  observingPointers = true;
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (state.live) pointers.add(event.pointerId);
    },
    true,
  );
  const finish = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size) return;
    requestAnimationFrame(() => {
      for (const release of pendingReleases) release();
      pendingReleases.clear();
      consumeClick = false;
    });
  };
  document.addEventListener("pointerup", finish, true);
  document.addEventListener("pointercancel", finish, true);
  document.addEventListener(
    "click",
    (event) => {
      if (!consumeClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      consumeClick = false;
    },
    true,
  );
  window.addEventListener("blur", () => {
    pointers.clear();
    consumeClick = false;
    for (const release of pendingReleases) release();
    pendingReleases.clear();
  });
}
let state = { live: false, raised: false, placement: 0 };
let pendingPresentations = 0;
function publish() {
  const raised = state.live && overlays.size > 0;
  state = { ...state, raised };
  document.documentElement.classList.toggle("native-browser-live", state.live);
  for (const listener of listeners) listener();
}
function acquire(overlay: Overlay) {
  const bridge = desktopBridge()?.browserPresentation;
  if (!bridge) {
    overlay.ready = true;
    overlay.notify(true);
    return;
  }
  const immediate = !state.live && pendingPresentations === 0;
  const overlayId = crypto.randomUUID();
  let current = true;
  overlay.release = () => {
    current = false;
    void bridge.releaseOverlay({ overlayId }).catch(() => undefined);
  };
  const acquired = bridge.acquireOverlay({ overlayId });
  if (immediate) {
    overlay.ready = true;
    overlay.notify(true);
  }
  void acquired
    .then(() => {
      if (!current || !overlay.open) return;
      overlay.ready = true;
      overlay.notify(true);
    })
    .catch(() => {
      if (current) {
        overlay.ready = false;
        overlay.notify(false);
      }
    });
}

/** Register pending work before sending present/update, after existing overlay acquisitions. */
export function nativeBrowserPresentationPending(): () => void {
  pendingPresentations++;
  return () => {
    pendingPresentations--;
  };
}

/** Tokens belong to overlays and survive presentation switches and placement revisions. */
export function nativeBrowserPresented(target: DesktopBrowserPresentationTarget | null) {
  const live = target !== null;
  if (live) observePointers();
  else {
    pointers.clear();
    consumeClick = false;
    for (const release of pendingReleases) release();
    pendingReleases.clear();
  }
  state = { ...state, live, placement: state.placement + (live ? 1 : 0) };
  publish();
}

export function useNativeBrowserLayer() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}

/** A closing drawer retains its token until its actual exit animations settle. */
export function useNativeBrowserOverlay(
  open = true,
  exitElement?: () => HTMLElement | null,
): boolean {
  const [ready, setReady] = useState(() => !desktopBridge()?.browserPresentation);
  const held = useRef<Overlay | null>(null);
  const release = (overlay: Overlay, animations: readonly Animation[] = []) => {
    overlay.open = false;
    const finish = () => {
      overlay.release?.();
      overlays.delete(overlay);
      publish();
    };
    if (state.live && pointers.size) consumeClick = true;
    const afterExit = () => {
      if (state.live && pointers.size) pendingReleases.add(finish);
      else finish();
    };
    if (animations.length)
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(afterExit);
    else afterExit();
  };
  useLayoutEffect(() => {
    if (open && !held.current) {
      const overlay: Overlay = { notify: setReady, release: null, ready: false, open: true };
      held.current = overlay;
      overlays.add(overlay);
      acquire(overlay);
      publish();
    } else if (!open && held.current) {
      const overlay = held.current;
      held.current = null;
      release(overlay, exitElement?.()?.getAnimations() ?? []);
      setReady(false);
    }
  }, [exitElement, open]);
  useLayoutEffect(
    () => () => {
      if (held.current) release(held.current);
      held.current = null;
    },
    [],
  );
  return ready;
}

export function NativeBrowserOverlay({ children }: { readonly children: ReactNode }) {
  const ready = useNativeBrowserOverlay();
  return ready ? children : null;
}
