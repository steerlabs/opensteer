import { useEffect, useRef } from "react";
import { fromLivePage } from "../../ui-utils.js";

/**
 * The team keys the app did not have, in the shortcut sheet's own form. ⌘K,
 * ⌘N, ⌥⌘↑/↓, ⌘\ and ⌘[ ⌘] are the app's already and work the same here;
 * ⌘⇧↵ and ↑ belong to the team composer itself.
 */
export const teamKeys: readonly (readonly [string, string])[] = [
  ["⌥⇧↑  ⌥⇧↓", "Previous or next unread channel or DM"],
  ["⌘⇧↵", "Send to my agent, from any team composer"],
  ["↑", "In an empty composer: edit your last message"],
  ["⌘F", "Search in this channel"],
  ["Esc", "Close the thread or Details; again, mark the channel read"],
];

export interface TeamShortcutHandlers {
  readonly onPreviousUnread?: (() => void) | undefined;
  readonly onNextUnread?: (() => void) | undefined;
  /** In a channel, ⌘F searches it; elsewhere it stays the app's find. */
  readonly onFindInChannel?: (() => void) | undefined;
  /** Esc that nothing nearer took: close the open pane, or mark the channel read. */
  readonly onEscape?: (() => void) | undefined;
}

/** Listens while a team screen is mounted; a key a field, menu or dialog took stays theirs. */
export function useTeamShortcuts(handlers: TeamShortcutHandlers) {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (fromLivePage(event)) return;
      const { onEscape, onFindInChannel, onNextUnread, onPreviousUnread } = current.current;
      const command = event.metaKey || event.ctrlKey;
      if (event.altKey && event.shiftKey && !command) {
        const run =
          event.key === "ArrowUp"
            ? onPreviousUnread
            : event.key === "ArrowDown"
              ? onNextUnread
              : null;
        if (run) {
          event.preventDefault();
          run();
        }
        return;
      }
      if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        if (!onFindInChannel) return;
        event.preventDefault();
        onFindInChannel();
        return;
      }
      if (event.key === "Escape" && onEscape && !insideOverlay(event.target)) {
        event.preventDefault();
        onEscape();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function insideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[role=dialog], .popover, .at-list") !== null;
}

/** The next channel or DM with something unread, in sidebar order, wrapping around. */
export function unreadNeighbour(
  rows: readonly { readonly id: string; readonly unread: boolean }[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (rows.length === 0) return null;
  const start = rows.findIndex((row) => row.id === currentId);
  for (let step = 1; step <= rows.length; step += 1) {
    const index = (start + direction * step + rows.length * 2) % rows.length;
    const row = rows[index];
    if (row?.unread && row.id !== currentId) return row.id;
  }
  return null;
}
