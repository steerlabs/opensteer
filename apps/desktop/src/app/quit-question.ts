import { menuBarWords } from "@opensteer/client/computers";
import type { BrowserWindow, BrowserWindowConstructorOptions, MessageBoxOptions } from "electron";
import type { QuitConfirmation } from "./background-mode.js";

/** The transparent window Quit Opensteer's question hangs from as a sheet. */
export function quitQuestionParentOptions(title: string): BrowserWindowConstructorOptions {
  return {
    width: 420,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title,
  };
}

type ParentWindow = Pick<BrowserWindow, "center" | "show" | "isDestroyed" | "destroy">;

/**
 * Quit Opensteer's question. Parented, so macOS shows it as a sheet that waits
 * without blocking main and that the shutdown's signal can dismiss; an
 * unparented one cannot be. The parent goes with the question.
 */
export function parentedQuitQuestion(options: {
  readonly focus: () => void;
  readonly createParent: () => ParentWindow;
  readonly showMessageBox: (
    parent: ParentWindow,
    options: MessageBoxOptions,
  ) => Promise<{ readonly response: number }>;
  /** Told once the question is showing, for a journey that dismisses it. */
  readonly shown?: () => void;
}): (confirmation: QuitConfirmation, signal: AbortSignal) => Promise<boolean> {
  return async ({ message, detail }, signal) => {
    signal.throwIfAborted();
    options.focus();
    const parent = options.createParent();
    try {
      parent.center();
      parent.show();
      const answer = options.showMessageBox(parent, {
        type: "warning",
        buttons: [menuBarWords("menubar.quit"), menuBarWords("common.cancel")],
        defaultId: 1,
        cancelId: 1,
        message,
        detail,
        signal,
      });
      options.shown?.();
      const { response } = await answer;
      signal.throwIfAborted();
      return response === 0;
    } finally {
      if (!parent.isDestroyed()) parent.destroy();
    }
  };
}
