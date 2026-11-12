export function observeTeamMessages(
  root: HTMLElement,
  rows: readonly HTMLElement[],
  seen: (id: string) => void,
): () => void {
  const visible = new Set<HTMLElement>();
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const clear = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
  const schedule = () => {
    clear();
    if (!document.hasFocus() || document.visibilityState === "hidden") return;
    for (const row of visible)
      timers.set(
        row,
        setTimeout(() => {
          timers.delete(row);
          if (
            visible.has(row) &&
            document.hasFocus() &&
            document.visibilityState !== "hidden" &&
            row.dataset.rowId
          )
            seen(row.dataset.rowId);
        }, 1000),
      );
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) visible.add(row);
        else visible.delete(row);
      }
      schedule();
    },
    { root, threshold: 0.6 },
  );
  for (const row of rows) observer.observe(row);
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", schedule);
  return () => {
    observer.disconnect();
    clear();
    window.removeEventListener("focus", schedule);
    window.removeEventListener("blur", clear);
    document.removeEventListener("visibilitychange", schedule);
  };
}
