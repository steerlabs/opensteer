/**
 * The first eligible page whose target id is `targetId`. Every candidate is
 * asked at once, so one page whose metadata hangs or fails never delays the
 * answer for another, and eligibility is checked again once its id arrives;
 * with no match the answer is null by `withinMs`.
 */
export function pageWithTarget<Page extends { targetId(): Promise<string> }>(
  pages: Iterable<Page>,
  targetId: string,
  withinMs: number,
  eligible: (page: Page) => boolean,
): Promise<Page | null> {
  const candidates = [...pages].filter(eligible);
  if (candidates.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = candidates.length;
    const timer = setTimeout(() => resolve(null), withinMs);
    timer.unref?.();
    const settle = (page: Page | null) => {
      if (page) {
        clearTimeout(timer);
        resolve(page);
      } else if (--pending === 0) {
        clearTimeout(timer);
        resolve(null);
      }
    };
    for (const page of candidates)
      void Promise.resolve()
        .then(() => page.targetId())
        .then(
          (id) => settle(id === targetId && eligible(page) ? page : null),
          () => settle(null),
        );
  });
}
