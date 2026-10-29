import { useEffect, useRef } from "react";
import type { DesktopWorkspaceTabCommand } from "@opensteer/protocol/desktop";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import { useLocation } from "react-router";
import { taskList, type HostClient } from "@opensteer/client/host";
import { placeList } from "@opensteer/client/host";
import { actionErrorMessage, fromLivePage } from "../../ui-utils.js";
import { Dialog } from "../dialog.js";
import { destinationPlaceKey } from "./navigation.js";
import { useTabCloser } from "./tab-closer.js";
import { tabOrder } from "./tab-order.js";
import { useToast } from "../toast.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * Native menu accelerators and the web keyboard listener share one command
 * path. Desktop tab chords belong to the menu even while a field or the live
 * page owns focus; the web leaves browser-reserved chords to its browser.
 */
export function useWorkspaceShortcuts({
  desktop,
  hostClient,
  onNewTab,
  onShowShortcuts,
}: {
  readonly desktop: boolean;
  readonly hostClient: HostClient;
  readonly onNewTab: () => void;
  readonly onShowShortcuts: () => void;
}) {
  const { nav, selection, startPage } = useWorkspace();
  const requestClose = useTabCloser();
  const toast = useToast();
  const { pathname } = useLocation();
  const state = useRef({
    nav,
    onNewTab,
    onShowShortcuts,
    pathname,
    requestClose,
    selection,
    startPage,
  });
  state.current = { nav, onNewTab, onShowShortcuts, pathname, requestClose, selection, startPage };

  useEffect(() => {
    const execute = (command: DesktopWorkspaceTabCommand) => {
      const { nav, onNewTab, requestClose, selection, startPage } = state.current;
      const places = tabOrder(
        placeList(hostClient.getSnapshot()),
        hostClient.getSnapshot().browserTabGroups,
      );
      const shownKey =
        selection.kind === "place" ? destinationPlaceKey(selection.destination) : null;
      switch (command.type) {
        case "new-tab":
          onNewTab();
          return;
        case "reopen-closed-tab": {
          if (
            !hostClient.getSnapshot().workspaceTabReopenAvailable ||
            !hostClient.reopenWorkspaceTab
          )
            return;
          const show = nav.beginPlaceOperation();
          void hostClient.reopenWorkspaceTab().then(
            (result) =>
              show({
                kind: "browser",
                sessionId: result.group.session.id,
                tabId: result.tabId,
              }),
            (error) => toast.error(actionErrorMessage(error)),
          );
          return;
        }
        case "close-tab": {
          if (selection.kind === "launcher") startPage.leave();
          else {
            const place = placeList(hostClient.getSnapshot()).find((item) => item.key === shownKey);
            if (place?.closable) requestClose(place);
          }
          return;
        }
        case "next-tab":
        case "previous-tab": {
          if (places.length === 0) return;
          const at = places.findIndex((place) => place.key === shownKey);
          const step = command.type === "previous-tab" ? -1 : 1;
          const next =
            places[
              at < 0
                ? step < 0
                  ? places.length - 1
                  : 0
                : (at + step + places.length) % places.length
            ];
          if (next) nav.showPlace(next.destination);
          return;
        }
        case "select-tab": {
          const place = command.index === 9 ? places.at(-1) : places[command.index - 1];
          if (place) nav.showPlace(place.destination);
        }
      }
    };
    const nativeCommands = desktop ? desktopBridge()?.onWorkspaceTabCommand?.(execute) : undefined;
    const handle = (event: KeyboardEvent) => {
      // The menu consumes native tab chords before they reach Chromium. The
      // DOM path is for hosts without native accelerators and runs before a
      // field/page can interpret the same chord as editing or remote input.
      const tabCommand = desktop && !nativeCommands ? workspaceTabKey(event) : null;
      if (tabCommand) {
        event.preventDefault();
        event.stopPropagation();
        execute(tabCommand);
        return;
      }
      if (fromLivePage(event)) return;
      const { nav, onShowShortcuts, pathname, selection } = state.current;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLocaleLowerCase();
      const snapshot = hostClient.getSnapshot();

      // ⌘. — show or hide the computer, everywhere.
      if (command && !event.altKey && !event.shiftKey && key === ".") {
        event.preventDefault();
        if (selection.kind === "talk") {
          const keys = new Set(placeList(snapshot).map((place) => place.key));
          nav.showComputer((destination) => {
            const placeKey = destinationPlaceKey(destination);
            return placeKey !== null && keys.has(placeKey);
          });
        } else nav.hideComputer();
        return;
      }
      // ⌥⌘↑ / ⌥⌘↓ — the previous or next task; the place stays.
      if (command && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const list = taskList(snapshot);
        const order = [
          ...(list.chat ? [list.chat.threadId] : []),
          ...list.working.map((row) => row.threadId),
          ...list.ready.map((row) => row.threadId),
        ];
        const open =
          pathname === "/"
            ? snapshot.homeThreadId
            : pathname.startsWith("/threads/")
              ? decodeURIComponent(pathname.slice("/threads/".length))
              : null;
        const at = open ? order.indexOf(open) : -1;
        const next = order[at + (event.key === "ArrowUp" ? -1 : 1)];
        if (next === undefined) return;
        event.preventDefault();
        nav.openConversation(nav.threadPath(next));
        return;
      }
      // ? — this list, when nothing is being typed.
      if (event.key === "?" && !command && !event.altKey && !editable(event.target)) {
        event.preventDefault();
        onShowShortcuts();
        return;
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => {
      nativeCommands?.();
      window.removeEventListener("keydown", handle, true);
    };
  }, [desktop, hostClient, toast]);
}

export function workspaceTabKey(event: KeyboardEvent): DesktopWorkspaceTabCommand | null {
  const command = event.metaKey || event.ctrlKey;
  if (
    command &&
    event.altKey &&
    !event.shiftKey &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  )
    return { type: event.key === "ArrowLeft" ? "previous-tab" : "next-tab" };
  if (command && event.shiftKey && !event.altKey) {
    if (event.code === "BracketLeft" || event.key === "{" || event.key === "[")
      return { type: "previous-tab" };
    if (event.code === "BracketRight" || event.key === "}" || event.key === "]")
      return { type: "next-tab" };
  }
  if (event.altKey) return null;
  if (event.ctrlKey && !event.metaKey && event.key === "Tab")
    return { type: event.shiftKey ? "previous-tab" : "next-tab" };
  if (event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "t")
    return { type: "reopen-closed-tab" };
  if (event.shiftKey || !(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "t") return { type: "new-tab" };
  if (key === "w") return { type: "close-tab" };
  if (/^[1-9]$/u.test(key)) return { type: "select-tab", index: Number(key) };
  return null;
}

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select, [role=textbox]") !== null)
  );
}

const opensteerKeys: readonly (readonly [string, string])[] = [
  ["⌘K", "Search tasks"],
  ["⌘N", "New task"],
  ["⌥⌘↑  ⌥⌘↓", "Previous or next task"],
  ["⌘F", "Find in the page or the conversation you’re in"],
  ["⌘.", "Show or hide the computer"],
  ["⌘\\", "Collapse or expand the sidebar"],
  ["F6  ⇧F6", "Move between the page and the conversation"],
  ["Esc", "Close what is open"],
];

/** Chrome's tab and page keys, which only the Opensteer app for your computer can claim. */
const browserKeys: readonly (readonly [string, string])[] = [
  ["⌘T", "New tab"],
  ["⌘W", "Close the tab"],
  ["⌘⇧T", "Reopen the tab you closed"],
  ["⌃Tab  ⌃⇧Tab", "Next or previous tab"],
  ["⌘1 – ⌘9", "Go to that tab; ⌘9 is the last"],
  ["⌘L", "Go to the address bar"],
  ["⌘R  ⌘⇧R", "Reload, or reload without the cache"],
  ["⌘[  ⌘]", "Back or forward"],
];

/** Every shortcut, in one quiet list: the browser's keys beside Opensteer's own. */
export function ShortcutsHelp({
  desktop,
  onClose,
}: {
  readonly desktop: boolean;
  readonly onClose: () => void;
}) {
  const groups = desktop
    ? [
        { title: "Tabs and pages", rows: browserKeys },
        { title: "Opensteer", rows: opensteerKeys },
      ]
    : [{ title: null, rows: opensteerKeys }];
  return (
    <Dialog
      labelledBy="shortcuts-title"
      onClose={onClose}
      title="Keyboard shortcuts"
      wide={desktop}
    >
      <div className="shortcuts">
        {groups.map((group) => (
          <section className="shortcuts__group" key={group.title ?? "shortcuts"}>
            {group.title ? <h3 className="shortcuts__title">{group.title}</h3> : null}
            <dl className="shortcuts__list">
              {group.rows.map(([keys, what]) => (
                <div className="shortcuts__row" key={keys}>
                  <dt>
                    {keys.split("  ").map((chord) => (
                      <kbd key={chord}>{chord}</kbd>
                    ))}
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {desktop ? null : (
        <p className="shortcuts__note">
          The browser keeps ⌘T, ⌘W and its tab keys; the Opensteer app for your computer uses them
          for tabs here.
        </p>
      )}
    </Dialog>
  );
}
