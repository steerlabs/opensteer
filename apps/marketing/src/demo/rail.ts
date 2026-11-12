/**
 * Hovering never moves the rail: a highlight glides to the icon under the pointer. Only the picked
 * engine opens its label, so the row reflows on a pick, never under the pointer.
 */
export function glideRail(set: HTMLElement, buttons: readonly HTMLElement[]): void {
  if (!matchMedia("(hover: hover)").matches) return;
  const glow = document.createElement("span");
  glow.className = "rail__glow";
  set.prepend(glow);

  let hovered: HTMLElement | undefined;
  /** Where a pick happened: the row reflows under a still pointer, so it isn't a new hover. */
  let pickedAt: readonly [number, number] | undefined;
  let following = 0;

  function place(): void {
    if (!hovered) return;
    glow.style.translate = `${hovered.offsetLeft}px 0`;
    glow.style.width = `${hovered.offsetWidth}px`;
  }

  function show(button: HTMLElement): void {
    // The first icon reached gets the highlight in place; later ones glide to it.
    set.classList.toggle("is-entering", !hovered);
    hovered = button;
    place();
    void set.offsetWidth;
    set.classList.remove("is-entering");
    set.classList.add("is-hovering");
  }
  function hide(): void {
    hovered = undefined;
    set.classList.remove("is-hovering");
  }

  buttons.forEach((button) => {
    button.addEventListener("pointerenter", () => {
      if (!pickedAt) show(button);
    });
    button.addEventListener("click", (event) => {
      pickedAt = [event.clientX, event.clientY];
      hovered = button;
    });
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) show(button);
    });
  });
  set.addEventListener("pointermove", (event) => {
    if (!pickedAt || (event.clientX === pickedAt[0] && event.clientY === pickedAt[1])) return;
    pickedAt = undefined;
    const under = buttons.find((b) => b.matches(":hover"));
    if (under && under !== hovered) show(under);
  });
  set.addEventListener("pointerleave", () => {
    pickedAt = undefined;
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
