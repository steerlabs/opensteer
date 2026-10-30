import {
  Menu,
  type BaseWindow,
  type Input,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import type { DesktopForwardedKey, DesktopWorkspaceTabCommand } from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";
import { desktopQuitShortcut } from "./electron-window.js";

type ShortcutInput = Pick<Input, "alt" | "control" | "key" | "meta" | "shift">;

/** The workspace tab command a chord names, matching the Tabs and File menu accelerators. */
export function workspaceTabCommand(input: ShortcutInput): DesktopWorkspaceTabCommand | null {
  const command = process.platform === "darwin" ? input.meta : input.control;
  const key = input.key.toLowerCase();
  if (command && input.alt && !input.shift && ["arrowleft", "arrowright"].includes(key))
    return { type: key === "arrowleft" ? "previous-tab" : "next-tab" };
  if (command && input.shift && !input.alt) {
    if (key === "[" || key === "{") return { type: "previous-tab" };
    if (key === "]" || key === "}") return { type: "next-tab" };
  }
  if (input.alt) return null;
  if (input.control && key === "tab") return { type: input.shift ? "previous-tab" : "next-tab" };
  if (command && input.shift && key === "t") return { type: "reopen-closed-tab" };
  if (!command || input.shift) return null;
  if (key === "t") return { type: "new-tab" };
  if (key === "w") return { type: "close-tab" };
  const index = Number(key);
  return Number.isInteger(index) && index >= 1 && index <= 9 ? { type: "select-tab", index } : null;
}

/** Chords a natively shown page never receives, as in a browser. */
export function desktopBrowserAppShortcut(input: Input): boolean {
  const command = process.platform === "darwin" ? input.meta : input.control;
  const key = input.key.toLowerCase();
  return (
    workspaceTabCommand(input) !== null ||
    desktopQuitShortcut(input, process.platform) ||
    key === "f6" ||
    (input.control && key === "tab") ||
    (command &&
      ((!input.alt &&
        ["t", "w", "n", "l", ".", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(key)) ||
        (input.alt && ["arrowup", "arrowdown"].includes(key))))
  );
}

export function desktopBrowserAppFocusShortcut(input: DesktopForwardedKey): boolean {
  return (
    input.key === "F6" ||
    ((process.platform === "darwin" ? input.meta : input.ctrl) &&
      !input.alt &&
      ["l", "f", "k", "n", "t"].includes(input.key.toLowerCase()))
  );
}

/**
 * Workspace tab accelerators reach the workspace even when a field or live
 * page has focus. Browser accelerators run after Chromium gives the focused
 * page first refusal.
 */
export function createDesktopApplicationMenu(options: {
  readonly restartToUpdate?: () => void;
  readonly workspaceContents: (window: BaseWindow) => WebContents | null;
  readonly browserKey?: (key: DesktopForwardedKey) => void;
}): Menu {
  const mac = process.platform === "darwin";
  const command = (
    label: string,
    accelerator: string,
    value: DesktopWorkspaceTabCommand,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: (_item, window) => {
      const contents = window && !window.isDestroyed() ? options.workspaceContents(window) : null;
      if (contents && !contents.isDestroyed())
        contents.send(desktopBridgeChannels.workspaceTabCommand, value);
    },
  });
  const browserKey = options.browserKey;
  const browser = (
    label: string,
    accelerator: string,
    key: string,
    code: string,
    shift = false,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () =>
      browserKey?.({
        key,
        code,
        shift,
        meta: mac && key !== "Escape",
        ctrl: !mac && key !== "Escape",
        alt: false,
      }),
  });
  return Menu.buildFromTemplate([
    ...(mac
      ? [
          {
            role: "appMenu" as const,
            ...(options.restartToUpdate
              ? {
                  submenu: [
                    { role: "about" as const },
                    {
                      id: "restart-to-update",
                      label: "Restart to Update",
                      visible: false,
                      click: () => options.restartToUpdate?.(),
                    },
                    { type: "separator" as const },
                    { role: "services" as const },
                    { type: "separator" as const },
                    { role: "hide" as const },
                    { role: "hideOthers" as const },
                    { role: "unhide" as const },
                    { type: "separator" as const },
                    { role: "quit" as const },
                  ],
                }
              : {}),
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        command("New Tab", "CommandOrControl+T", { type: "new-tab" }),
        {
          ...command("Reopen Closed Tab", "CommandOrControl+Shift+T", {
            type: "reopen-closed-tab",
          }),
          id: "reopen-closed-tab",
          visible: false,
          enabled: false,
        },
        command("Close Tab", "CommandOrControl+W", { type: "close-tab" }),
        ...(mac ? [] : [{ role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    ...(browserKey
      ? [
          {
            label: "Browser",
            submenu: [
              browser("Reload", "CommandOrControl+R", "r", "KeyR"),
              {
                ...browser("Reload Without Cache", "CommandOrControl+Shift+R", "R", "KeyR", true),
                id: "browser-hard-reload",
                enabled: false,
              },
              browser("Back", "CommandOrControl+[", "[", "BracketLeft"),
              browser("Forward", "CommandOrControl+]", "]", "BracketRight"),
              browser("Find", "CommandOrControl+F", "f", "KeyF"),
              browser("Find Next", "CommandOrControl+G", "g", "KeyG"),
              browser("Find Previous", "CommandOrControl+Shift+G", "G", "KeyG", true),
              browser("Search", "CommandOrControl+K", "k", "KeyK"),
              browser("Toggle Sidebar", "CommandOrControl+\\", "\\", "Backslash"),
              browser("Stop", "Escape", "Escape", "Escape"),
            ],
          },
        ]
      : []),
    {
      label: "Tabs",
      submenu: [
        command("Next Tab", "Control+Tab", { type: "next-tab" }),
        command("Previous Tab", "Control+Shift+Tab", { type: "previous-tab" }),
        command("Next Tab", "CommandOrControl+Alt+Right", { type: "next-tab" }),
        command("Previous Tab", "CommandOrControl+Alt+Left", { type: "previous-tab" }),
        command("Next Tab", "CommandOrControl+Shift+]", { type: "next-tab" }),
        command("Previous Tab", "CommandOrControl+Shift+[", { type: "previous-tab" }),
        { type: "separator" },
        ...Array.from({ length: 9 }, (_, offset) => {
          const index = offset + 1;
          return command(index === 9 ? "Last Tab" : `Tab ${index}`, `CommandOrControl+${index}`, {
            type: "select-tab",
            index,
          });
        }),
      ],
    },
    { role: "windowMenu" },
  ]);
}
