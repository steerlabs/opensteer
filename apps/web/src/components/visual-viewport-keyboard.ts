import { useEffect, useState } from "react";

interface VisualViewportLike {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

interface VisualViewportWindow {
  readonly innerHeight: number;
  readonly visualViewport: VisualViewportLike | null;
}

export function visualViewportKeyboardInset(windowLike: VisualViewportWindow): number {
  const viewport = windowLike.visualViewport;
  if (!viewport || viewport.scale !== 1) return 0;
  return Math.max(
    0,
    Math.round(windowLike.innerHeight - viewport.height - Math.max(0, viewport.offsetTop)),
  );
}

export function observeVisualViewportKeyboardInset(
  windowLike: VisualViewportWindow,
  listener: (inset: number) => void,
): () => void {
  const viewport = windowLike.visualViewport;
  if (!viewport) {
    listener(0);
    return () => undefined;
  }
  const update = () => listener(visualViewportKeyboardInset(windowLike));
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
  };
}

/** Keeps the Thread's flex layout above the software keyboard on mobile browsers. */
export function useVisualViewportKeyboardInset(): number {
  const [inset, setInset] = useState(() => visualViewportKeyboardInset(window));

  useEffect(() => observeVisualViewportKeyboardInset(window, setInset), []);

  return inset;
}
