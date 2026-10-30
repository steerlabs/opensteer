import { NativeBrowserOverlay, useNativeBrowserLayer } from "./native-browser-overlays.js";
import { observeResize } from "@opensteer/shared/resizeObserver";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const focusableSelector =
  'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** A submenu's panel, mapped to the panel it flies out of. */
const parents = new WeakMap<Element, HTMLElement>();
/** Whether `target` is inside `panel` or in a submenu flown out of it, at any depth. */
function withinPanel(panel: HTMLElement, target: Node): boolean {
  let current: Element | null =
    target instanceof Element
      ? target.closest(".popover")
      : (target.parentElement?.closest(".popover") ?? null);
  while (current) {
    if (current === panel) return true;
    current = parents.get(current) ?? null;
  }
  return panel.contains(target);
}

interface PopoverProps {
  /** The trigger element the panel anchors to. */
  anchor: HTMLElement;
  /**
   * A context menu's point: the panel hangs from it and opens downward, as a
   * system menu does, flipping up only when there is no room. Focus still
   * returns to `anchor`.
   */
  at?: { readonly x: number; readonly y: number } | undefined;
  children: ReactNode;
  className?: string;
  /** Names the panel for the control whose `aria-controls` points at it. */
  id?: string | undefined;
  label: string;
  onClose: () => void;
  onEscape?: (() => void) | undefined;
  /**
   * Where focus goes back to on close, when that is not the anchor: a panel
   * opened from a control elsewhere hangs where it belongs and still returns
   * the reader to what they pressed.
   */
  returnFocusTo?: HTMLElement | null;
  role?: "dialog" | "menu";
  /**
   * A submenu: the panel flies out beside `anchor` (a row of `parent`), as a
   * system menu's does, and a press inside it never closes the parent.
   */
  parent?: HTMLElement | null;
  /** Open under the anchor, flipping above only without room: a control at the top of a page. */
  below?: boolean;
  /** Line the panel's trailing edge up with the anchor's: a control at the end of a row. */
  align?: "end" | "start";
}

/**
 * The shared anchored overlay: renders into a portal so no scroll container
 * clips it, opens above its anchor (composer controls sit at the bottom of
 * the screen) and flips below when there is no room. Escape and outside
 * pointer-down close it, and so does its anchor leaving the layout (a
 * composer control folded away by a narrower composer); focus starts on the
 * checked item and returns to the anchor on close, unless the chosen item
 * sent it elsewhere; arrow keys rove through the items.
 */
export function Popover(props: PopoverProps) {
  return (
    <NativeBrowserOverlay>
      <PopoverContent {...props} />
    </NativeBrowserOverlay>
  );
}

function PopoverContent({
  anchor,
  at,
  children,
  className,
  id,
  label,
  onClose,
  onEscape,
  returnFocusTo = null,
  role = "menu",
  parent = null,
  below = false,
  align = "start",
}: PopoverProps) {
  const native = useNativeBrowserLayer().live;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const returnFocusRef = useRef(returnFocusTo);
  returnFocusRef.current = returnFocusTo;

  const atX = at?.x;
  const atY = at?.y;
  // Positions imperatively (not via state) so the panel is measured, placed,
  // and visible within the first commit — before the focus effect runs.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const position = () => {
      if (anchor.getClientRects().length === 0) {
        onCloseRef.current();
        return;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const margin = 10;
      const gap = 8;
      if (parent) {
        // Beside the row it came from, its first item level with that row;
        // to the left only when the right has no room.
        const right = parent.getBoundingClientRect().right + 2;
        const left =
          right + panelRect.width <= window.innerWidth - margin
            ? right
            : Math.max(margin, parent.getBoundingClientRect().left - panelRect.width - 2);
        panel.style.left = `${left}px`;
        panel.style.top = `${Math.max(margin, Math.min(anchorRect.top - 7, window.innerHeight - panelRect.height - margin))}px`;
        panel.style.visibility = "visible";
        return;
      }
      if (atX !== undefined && atY !== undefined) {
        const below = atY + 2;
        panel.style.left = `${Math.min(Math.max(atX, margin), Math.max(margin, window.innerWidth - panelRect.width - margin))}px`;
        panel.style.top = `${Math.max(margin, below + panelRect.height <= window.innerHeight - margin ? below : atY - panelRect.height - 2)}px`;
        panel.style.visibility = "visible";
        return;
      }
      const left = Math.min(
        Math.max(align === "end" ? anchorRect.right - panelRect.width : anchorRect.left, margin),
        Math.max(margin, window.innerWidth - panelRect.width - margin),
      );
      const above = anchorRect.top - panelRect.height - gap;
      const under = anchorRect.bottom + gap;
      const top = below
        ? under + panelRect.height <= window.innerHeight - margin || above < margin
          ? Math.min(under, window.innerHeight - panelRect.height - margin)
          : above
        : above >= margin
          ? above
          : Math.min(under, window.innerHeight - panelRect.height - margin);
      panel.style.left = `${left}px`;
      panel.style.top = `${Math.max(top, margin)}px`;
      panel.style.visibility = "visible";
    };
    position();
    const stopResize = observeResize([panel, anchor], position);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      stopResize();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [align, anchor, atX, atY, below, parent]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !parent) return;
    parents.set(panel, parent);
    return () => {
      parents.delete(panel);
    };
  }, [parent]);

  useEffect(() => {
    const panel = panelRef.current;
    const initial =
      panel?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      panel?.querySelector<HTMLElement>(focusableSelector);
    (initial ?? panel)?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if ((panel && withinPanel(panel, target)) || anchor.contains(target)) return;
      if (native) {
        event.preventDefault();
        event.stopPropagation();
      }
      onCloseRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      (onEscapeRef.current ?? onCloseRef.current)();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      // Focus comes back only from the panel, or from nowhere once the panel
      // has gone: an item that sent it on (a field it chose, a dialog) keeps
      // it there. A target or anchor no longer on the page is never focused.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !(panel && withinPanel(panel, active))
      )
        return;
      const back = returnFocusRef.current;
      (back?.isConnected ? back : anchor.isConnected ? anchor : null)?.focus();
    };
  }, [anchor, native]);

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "End", "Home"].includes(event.key)) return;
    // Home/End inside a text field move the caret, not the roving focus.
    if (event.target instanceof HTMLInputElement && (event.key === "Home" || event.key === "End")) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const items = [...panel.querySelectorAll<HTMLElement>(focusableSelector)];
    if (items.length === 0) return;
    event.preventDefault();
    // A submenu's keys are its own, never also its parent's.
    event.stopPropagation();
    const index =
      document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? index < 0
              ? 0
              : (index + 1) % items.length
            : index < 0
              ? items.length - 1
              : (index - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return createPortal(
    <div
      aria-label={label}
      className={className ? `popover ${className}` : "popover"}
      id={id}
      onKeyDown={handlePanelKeyDown}
      ref={panelRef}
      role={role}
      style={{ visibility: "hidden" }}
      tabIndex={-1}
    >
      {children}
    </div>,
    document.body,
  );
}
