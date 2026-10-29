import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Screen,
  WebPreferences,
} from "electron";
import { configureDesktopWindowNavigation } from "../app/electron-window.js";
import { DesktopAppOriginPolicy } from "../app/navigation-policy.js";

const setupPanelUrl = "app://opensteer/computer-app/setup";
const panelWidth = 312;
const panelHeight = 252;
const panelMargin = 24;

export interface ComputerAppSetupPanelOptions {
  /** The window went away by itself; setup ends as if the person closed it. */
  readonly onClosed: () => void;
  readonly platform?: NodeJS.Platform;
  readonly screen: Pick<Screen, "getPrimaryDisplay">;
  readonly webPreferences: WebPreferences;
  readonly windowFactory: (options: BrowserWindowConstructorOptions) => BrowserWindow;
}

/**
 * The window the setup guide is drawn in, floated beside System Settings.
 *
 * It sits in the bottom-right corner rather than over the middle of the
 * screen, where System Settings opens: the person drags from this window into
 * that one's list, and must be able to reach every row of it. It is shown
 * without taking the keyboard from whatever the person is in. The page owns
 * everything it shows; main owns the window.
 */
export class ComputerAppSetupPanel {
  readonly #options: ComputerAppSetupPanelOptions;
  #window: BrowserWindow | null = null;

  constructor(options: ComputerAppSetupPanelOptions) {
    this.#options = options;
  }

  async open(): Promise<void> {
    const existing = this.#window;
    if (existing && !existing.isDestroyed()) {
      existing.showInactive();
      existing.moveTop();
      return;
    }
    const workArea = this.#options.screen.getPrimaryDisplay().workArea;
    const platform = this.#options.platform ?? process.platform;
    const window = this.#options.windowFactory({
      alwaysOnTop: true,
      frame: false,
      fullscreenable: false,
      hasShadow: false,
      height: panelHeight,
      hiddenInMissionControl: true,
      maximizable: false,
      minimizable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      title: "Set up",
      transparent: true,
      ...(platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: this.#options.webPreferences,
      width: panelWidth,
      x: workArea.x + workArea.width - panelWidth - panelMargin,
      y: workArea.y + workArea.height - panelHeight - panelMargin,
    });
    this.#window = window;
    configureDesktopWindowNavigation(window.webContents, new DesktopAppOriginPolicy());
    window.setAlwaysOnTop(true, "floating");
    // A page that died draws nothing, yet its transparent window would still
    // float over everything; it goes, and setup ends as if it were closed.
    window.webContents.once("render-process-gone", () => {
      if (!window.isDestroyed()) window.destroy();
    });
    window.once("closed", () => {
      if (this.#window !== window) return;
      this.#window = null;
      this.#options.onClosed();
    });
    try {
      await window.loadURL(setupPanelUrl);
      if (!window.isDestroyed()) window.showInactive();
    } catch (error) {
      if (this.#window === window) this.#window = null;
      if (!window.isDestroyed()) window.destroy();
      throw new Error("The setup panel could not load the bundled application.", {
        cause: error,
      });
    }
  }

  close(): void {
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
