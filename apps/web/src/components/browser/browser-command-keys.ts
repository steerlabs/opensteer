import { useEffect, useRef, type RefObject } from "react";
import type { BrowserCommand } from "@opensteer/client/host";
import type { BrowserSurfaceId } from "@opensteer/core";
import { desktopBridge } from "../../desktop/desktop-bridge.js";

interface BrowserCommandKeys {
  visible: boolean;
  live: boolean;
  native: boolean;
  loading: boolean;
  hardReload: boolean;
  canGoBack: boolean | undefined;
  canGoForward: boolean | undefined;
  stageRef: RefObject<HTMLDivElement | null>;
  surfaceId: BrowserSurfaceId;
  finding: boolean;
  findQuery: string;
  setFinding: (finding: boolean) => void;
  find: (query: string, forward: boolean, next: boolean) => void;
  closeFind: () => void;
  stopFind: () => void;
  fullscreen: boolean;
  exitFullscreen: () => void;
  onLeavePage: () => void;
  /** The toolbar's Stop, which also forgets the person's pending visit. */
  stop: () => void;
  send: (command: BrowserCommand) => void;
  onReportError: (error: unknown) => void;
}

/** DOM keys and native menu keys enter once, before streamed-page input. */
export function useBrowserCommandKeys(options: BrowserCommandKeys): void {
  const current = useRef(options);
  current.current = options;
  const bridge = desktopBridge()?.browserPresentation;
  const desktop = desktopBridge() !== null;
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const state = current.current;
      if (!state.visible || event.defaultPrevented || event.isComposing) return;
      const stage = state.stageRef.current;
      const view = stage?.closest(".browser-view");
      if (!(event.target instanceof Node) || !view?.contains(event.target)) return;
      const inPage =
        event.target === stage ||
        (event.target instanceof Element && event.target.closest("[data-live-page]") !== null);
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      const focusField = (label: string) =>
        requestAnimationFrame(() => {
          const field = view.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
          field?.focus();
          field?.select();
        });
      const command = (event.metaKey || event.ctrlKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (desktop && command && !event.shiftKey && key === "l") {
        consume();
        if (state.finding) state.stopFind();
        state.setFinding(false);
        focusField("Search or enter address");
      } else if (desktop && state.native && command && !event.shiftKey && key === "f") {
        consume();
        state.setFinding(true);
        focusField("Find in page");
      } else if (desktop && state.native && command && key === "g" && state.finding) {
        consume();
        state.find(state.findQuery, !event.shiftKey, true);
      } else if (desktop && command && key === "r") {
        consume();
        if (state.live && (!event.shiftKey || state.hardReload))
          state.send({
            surfaceId: state.surfaceId,
            type: "navigation.reload",
            ...(event.shiftKey ? { ignoreCache: true } : {}),
          });
      } else if (desktop && command && !event.shiftKey && (key === "[" || key === "]")) {
        consume();
        if (state.live && (key === "[" ? state.canGoBack : state.canGoForward) !== false)
          state.send({
            surfaceId: state.surfaceId,
            type: key === "[" ? "navigation.back" : "navigation.forward",
          });
      } else if (event.key === "Escape") {
        if (state.native && state.fullscreen) {
          consume();
          state.exitFullscreen();
        } else if (state.native && state.finding) {
          consume();
          state.closeFind();
        } else if (inPage && state.live && state.loading) {
          consume();
          state.stop();
        }
      } else if (desktop && inPage && event.key === "F6" && !event.shiftKey) {
        consume();
        state.onLeavePage();
      }
    };
    const unsubscribe = bridge?.onEvent((event) => {
      if (event.type !== "key" || !current.current.visible) return;
      const key = event.key;
      const stage = current.current.stageRef.current;
      const view = stage?.closest(".browser-view");
      const focused =
        document.hasFocus() && document.activeElement && view?.contains(document.activeElement)
          ? document.activeElement
          : stage;
      focused?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: key.key,
          code: key.code,
          altKey: key.alt,
          ctrlKey: key.ctrl,
          metaKey: key.meta,
          shiftKey: key.shift,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    window.addEventListener("keydown", handle, true);
    return () => {
      unsubscribe?.();
      window.removeEventListener("keydown", handle, true);
    };
  }, [bridge, desktop]);
  useEffect(() => {
    if (!options.visible) return;
    void bridge
      ?.setNavigationAvailable?.({ hardReload: options.live && options.hardReload })
      .catch(current.current.onReportError);
    return () => {
      void bridge
        ?.setNavigationAvailable?.({ hardReload: false })
        .catch(current.current.onReportError);
    };
  }, [bridge, options.visible, options.live, options.hardReload]);
}
