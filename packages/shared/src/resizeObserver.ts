/// <reference lib="dom" />

/**
 * Resize delivery precedes paint. A layout write there can resize an already
 * delivered ancestor and leave notifications undelivered. Coalesce work into
 * the next frame, and cancel it with the observer's owner.
 */
export function observeResize(elements: readonly Element[], layout: () => void): () => void {
  let frame: number | null = null;
  let connected = true;
  const observer = new ResizeObserver(() => {
    if (!connected || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (connected) layout();
    });
  });
  for (const element of elements) observer.observe(element);
  return () => {
    connected = false;
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
