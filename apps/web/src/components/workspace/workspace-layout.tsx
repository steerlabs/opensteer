import { useNativeBrowserLayer } from "../native-browser-overlays.js";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  PaneResizeHandle,
  usePersistedPaneSize,
  type PaneSizeRange,
} from "../pane-resize-handle.js";
import { useVisualViewportKeyboardInset } from "../visual-viewport-keyboard.js";
import { useWorkspace } from "./workspace-context.js";
import { ToastToolbarContext, useToastPlacement } from "../toast.js";

const dockWidthKey = "opensteer.dock-width";
const dockWidthRange: PaneSizeRange = { defaultValue: 400, max: 560, min: 340, step: 20 };
/** The middle keeps at least this much beside the dock: a wide remembered dock gives way. */
const middleFloor = 240;
/** The card's inset on each side, and the divider between it and the dock. */
const cardGutter = 6 + 6 + 8;

/**
 * Talk is the conversation alone, in a column; Work puts a place in the
 * middle with the conversation docked beside it. On a desktop the
 * conversation never covers the place: opening or closing it slides it in
 * or out and the middle grows or shrinks to the room left, as a browser's
 * side panel does. The conversation is always the same element in the same
 * slot, so its draft, chip, scroll and focus survive every change of layout,
 * and only the person's choices change what shows.
 */
export function WorkspaceLayout({
  children,
  middle,
}: {
  readonly children: ReactNode;
  readonly middle: ReactNode;
}) {
  const { dock, layout, phone, work } = useWorkspace();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const setToastPlacement = useToastPlacement();
  const [width, setWidth] = useState<number | null>(null);
  const [dockPreference, setDockPreference, commitDockPreference] = usePersistedPaneSize(
    dockWidthKey,
    dockWidthRange,
  );
  const keyboardInset = useVisualViewportKeyboardInset();

  useLayoutEffect(() => {
    const element = layoutRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    const stopResize = observeResize([element], measure);
    measure();
    return stopResize;
  }, []);

  const docked = work && !phone;
  const dockMax =
    width === null
      ? dockWidthRange.max
      : Math.max(
          dockWidthRange.min,
          Math.min(dockWidthRange.max, width - middleFloor - cardGutter),
        );
  const dockWidth = Math.min(dockPreference, dockMax);
  const conversationHidden = docked && !dock.open;
  const [slotOpen, setSlotOpen] = useState(dock.open);
  const [entering, setEntering] = useState(false);
  const nativeLayer = useNativeBrowserLayer();
  const shownOpen = useRef(dock.open);
  const waitingForPlacement = useRef<{ count: number; glide: () => void } | null>(null);
  useLayoutEffect(() => {
    const waiting = waitingForPlacement.current;
    if (waiting && (!nativeLayer.live || nativeLayer.placement > waiting.count)) {
      waitingForPlacement.current = null;
      waiting.glide();
    }
  }, [nativeLayer.live, nativeLayer.placement]);

  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (!docked || !conversation || shownOpen.current === dock.open) {
      shownOpen.current = dock.open;
      setSlotOpen(dock.open);
      setEntering(false);
      layout.set("settled");
      return;
    }
    shownOpen.current = dock.open;
    let current = true;
    let animation: Animation | null = null;
    let frame = 0;
    layout.set("settling");
    const glide = () => {
      if (!current) return;
      setEntering(false);
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!conversation.animate || still) {
        setSlotOpen(dock.open);
        layout.set("settled");
        return;
      }
      animation = conversation.animate(
        dock.open
          ? [
              { opacity: 0, transform: "translateX(24px)" },
              { opacity: 1, transform: "translateX(0)" },
            ]
          : [
              { opacity: 1, transform: "translateX(0)" },
              { opacity: 0, transform: "translateX(24px)" },
            ],
        { duration: dock.open ? 200 : 160, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "both" },
      );
      void animation.finished
        .then(() => {
          if (!current) return;
          if (!dock.open) setSlotOpen(false);
          layout.set("settled");
        })
        .catch(() => {
          if (current) {
            setSlotOpen(dock.open);
            layout.set("settled");
          }
        });
    };
    if (dock.open) {
      setEntering(true);
      setSlotOpen(true);
      // The page takes its final width before the conversation enters its slot.
      if (nativeLayer.live && !slotOpen)
        waitingForPlacement.current = { count: nativeLayer.placement, glide };
      else frame = requestAnimationFrame(glide);
    } else if (slotOpen) frame = requestAnimationFrame(glide);
    else layout.set("settled");
    return () => {
      current = false;
      cancelAnimationFrame(frame);
      animation?.cancel();
      waitingForPlacement.current = null;
    };
  }, [dock.open, docked, layout, nativeLayer.live]);
  useLayoutEffect(() => () => layout.set("settled"), [layout]);
  useLayoutEffect(() => {
    const inToolbar = phone || !dock.open;
    const element = inToolbar ? toolbar : conversationRef.current;
    setToastPlacement?.(work && element ? { element, toolbar: inToolbar } : null);
    return () => setToastPlacement?.(null);
  }, [dock.open, phone, setToastPlacement, toolbar, work]);

  const classes = [
    "workspace",
    work ? "workspace--work" : "workspace--talk",
    !slotOpen && docked ? "workspace--dock-closed" : "",
    conversationHidden && slotOpen ? "workspace--dock-exiting" : "",
    work && phone ? "workspace--phone-stage" : "",
  ];
  return (
    <div
      className={classes.filter(Boolean).join(" ")}
      ref={layoutRef}
      style={
        {
          "--dock-width": `${dockWidth}px`,
          "--keyboard-inset": `${keyboardInset}px`,
        } as CSSProperties
      }
    >
      <div className="workspace__middle" hidden={!work}>
        <ToastToolbarContext.Provider value={setToolbar}>{middle}</ToastToolbarContext.Provider>
      </div>
      {docked ? (
        <PaneResizeHandle
          ariaControls="workspace-conversation"
          ariaLabel="Resize conversation"
          max={dockMax}
          min={dockWidthRange.min}
          onCommit={commitDockPreference}
          onDragChange={(dragging) => layout.set(dragging ? "dragging" : "settled")}
          onResize={setDockPreference}
          range={dockWidthRange}
          side="right"
          value={dockWidth}
        />
      ) : null}
      <section
        aria-hidden={conversationHidden}
        aria-label="Conversation"
        className={`workspace__conversation${entering ? " workspace__conversation--entering" : ""}`}
        id="workspace-conversation"
        inert={conversationHidden}
        ref={conversationRef}
      >
        {children}
      </section>
    </div>
  );
}
