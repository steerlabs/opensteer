import type { Engine } from "./agents.js";

/**
 * Hovering never moves the rail: a highlight glides to the icon under the pointer and a caption
 * under the rail names it. Only the picked engine opens its label, so the row reflows on a pick,
 * never under the pointer.
 */
export function glideRail(
  set: HTMLElement,
  buttons: readonly HTMLElement[],
  engines: readonly Engine[],
): void {
  if (!matchMedia("(hover: hover)").matches) return;
  const glow = document.createElement("span");
  glow.className = "rail__glow";
  const tip = document.createElement("span");
  tip.className = "rail__tip";
  tip.setAttribute("aria-hidden", "true");
  set.prepend(glow);
  set.appendChild(tip);

  let hovered: HTMLElement | undefined;
  let following = 0;

  function place(): void {
    if (!hovered) return;
    glow.style.translate = `${hovered.offsetLeft}px 0`;
    glow.style.width = `${hovered.offsetWidth}px`;
    tip.style.translate = `${hovered.offsetLeft + hovered.offsetWidth / 2}px 0`;
  }

  function show(button: HTMLElement, index: number): void {
    const engine = engines[index];
    if (!engine) return;
    // The first icon reached gets the highlight in place; later ones glide to it.
    set.classList.toggle("is-entering", !hovered);
    hovered = button;
    tip.innerHTML = `<b>${engine.name}</b>${engine.plan}`;
    place();
    void set.offsetWidth;
    set.classList.remove("is-entering");
    set.classList.add("is-hovering");
  }
  function hide(): void {
    hovered = undefined;
    set.classList.remove("is-hovering");
  }

  buttons.forEach((button, index) => {
    button.addEventListener("pointerenter", () => show(button, index));
    // Keyboard users get the same name caption; the row itself stays put.
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) show(button, index);
    });
  });
  set.addEventListener("pointerleave", () => {
    if (!set.contains(document.activeElement) || !set.querySelector(":focus-visible")) hide();
  });
  set.addEventListener("focusout", (event) => {
    if (!set.contains(event.relatedTarget as Node | null) && !set.matches(":hover")) hide();
  });

  // A pick reflows the row while its label opens, so the highlight tracks it frame by frame.
  // The demo rewrites aria-pressed on every update, so only a real change of pick counts.
  const picked = (): number => buttons.findIndex((b) => b.getAttribute("aria-pressed") === "true");
  let current = picked();
  new MutationObserver(() => {
    const now = picked();
    if (now === current) return;
    current = now;
    if (!hovered) return;
    cancelAnimationFrame(following);
    const until = performance.now() + 600;
    set.classList.add("is-following");
    const step = (now: number): void => {
      place();
      if (now < until) following = requestAnimationFrame(step);
      else set.classList.remove("is-following");
    };
    following = requestAnimationFrame(step);
  }).observe(set, { subtree: true, attributeFilter: ["aria-pressed"] });
}
