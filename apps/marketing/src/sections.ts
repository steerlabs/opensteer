import { watchNav } from "./dom.js";

/** Fades each section in the first time it scrolls into view. */
function reveal(): void {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  document.querySelectorAll(".reveal").forEach((el) => seen.observe(el));
}

export function startSections(): void {
  document.documentElement.classList.add("js");
  watchNav();
  reveal();
}
