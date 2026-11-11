export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export function find<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
}

export function icon(id: string): string {
  return `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
}

/** Replays a CSS animation that is keyed to a class. */
export function restart(el: Element, className: string): void {
  el.classList.remove(className);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(className);
}

export const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));
