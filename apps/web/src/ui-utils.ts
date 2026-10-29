import { appWindowFocused, observeAppWindowFocus } from "./desktop/window-focus.js";
import { observePageVisibility, pageVisible } from "./page-visibility.js";
import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Whether a key belongs to a live page: pressed inside one, or already handled
 * by it. The person is typing into the page, so no shortcut of this app acts.
 */
export function fromLivePage(event: {
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
}): boolean {
  return (
    event.defaultPrevented ||
    (event.target instanceof Element && event.target.closest("[data-live-page]") !== null)
  );
}

export function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Opensteer couldn’t complete that action.";
}

/**
 * Whether this window is in front of the person: visible *and* holding focus.
 * A visible window behind another app or another window shows messages nobody
 * is looking at, so visibility alone is not an observation.
 */
export function windowInForeground(): boolean {
  if (typeof document === "undefined") return true;
  return pageVisible() && appWindowFocused();
}

export function useWindowInForeground(): boolean {
  const [foreground, setForeground] = useState(windowInForeground);
  useEffect(() => {
    const observe = () => setForeground(windowInForeground());
    observe();
    const stopFocus = observeAppWindowFocus(observe);
    const stopVisibility = observePageVisibility(observe);
    return () => {
      stopFocus();
      stopVisibility();
    };
  }, []);
  return foreground;
}

/**
 * Whether the page is on screen at all, focused or not. A live view keeps
 * painting beside another focused window, and stops, dropping what it holds,
 * once the tab or window is hidden.
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(observePageVisibility, pageVisible);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const update = () => setMatches(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/**
 * The time, refreshed as each minute turns while the page is on screen. Text
 * like "in 12 min" or "Today" stays true without a timer per row, and a hidden
 * page does no work.
 */
export function useMinuteClock(): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        60_000 - (Date.now() % 60_000),
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [visible]);
  return now;
}

/** Where a conversation opens: Chat at Home, any other at its Thread, at one message when named. */
export function conversationPath(
  threadId: string,
  homeThreadId: string | null,
  messageId?: string | null,
): string {
  const anchor = messageId ? `?messageId=${encodeURIComponent(messageId)}` : "";
  return threadId === homeThreadId
    ? `/${anchor}`
    : `/threads/${encodeURIComponent(threadId)}${anchor}`;
}

/** One automation's own page. */
export function automationPath(triggerId: string): string {
  return `/automations/${encodeURIComponent(triggerId)}`;
}
