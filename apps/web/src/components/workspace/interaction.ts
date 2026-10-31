import { observePageVisibility, pageVisible } from "../../page-visibility.js";

/**
 * What the person has done since a moment was captured. Every explicit choice
 * of conversation or place (the same one again, Back, Settings), every modal
 * opened, every edit and every press or key into a live page counts, as does
 * the window going away; an agent's presentation and the Host's own rewrites
 * of the address do not. A presentation captured before any of them is stale,
 * and stays stale after the modal closes or the edit ends.
 */
let revision = 0;

export function interactionRevision(): number {
  return revision;
}

export function interact(): void {
  revision += 1;
}

let observers = 0;
let stopObserving: (() => void) | null = null;

/**
 * Counts the interactions no navigation call sees: edits anywhere, input into
 * a live page, Back and Forward before the router renders them, and leaving
 * the window. Each listener only bumps a number; nothing re-renders.
 */
export function observeInteraction(): () => void {
  observers += 1;
  if (observers === 1) {
    const live = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-live-page]")) interact();
    };
    const visibility = () => {
      if (!pageVisible()) interact();
    };
    document.addEventListener("input", interact, true);
    document.addEventListener("pointerdown", live, true);
    document.addEventListener("keydown", live, true);
    window.addEventListener("popstate", interact);
    const stopVisibility = observePageVisibility(visibility);
    stopObserving = () => {
      document.removeEventListener("input", interact, true);
      document.removeEventListener("pointerdown", live, true);
      document.removeEventListener("keydown", live, true);
      window.removeEventListener("popstate", interact);
      stopVisibility();
    };
  }
  return () => {
    observers -= 1;
    if (observers === 0) {
      stopObserving?.();
      stopObserving = null;
    }
  };
}

/**
 * Whether the person is in the middle of something a presentation must not
 * take away: the window is away, a modal is open, text is selected, or a
 * focused field holds words. An empty focused composer is not an edit.
 */
export function interactionBusy(): boolean {
  if (!pageVisible()) return true;
  if (document.querySelector('[aria-modal="true"]')) return true;
  if (document.getSelection()?.type === "Range") return true;
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return !active.readOnly && active.value !== "";
  if (active instanceof HTMLInputElement)
    return !active.readOnly && textInputs.has(active.type) && active.value !== "";
  return active instanceof HTMLElement && active.isContentEditable && active.textContent !== "";
}

const textInputs = new Set(["text", "search", "url", "email", "tel", "password", "number"]);
