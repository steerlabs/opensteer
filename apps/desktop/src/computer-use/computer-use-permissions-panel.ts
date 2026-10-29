import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Screen,
  WebPreferences,
} from "electron";
import type { DesktopComputerUseSettingsPane } from "@opensteer/protocol/desktop";
import { configureDesktopWindowNavigation } from "../app/electron-window.js";
import { DesktopAppOriginPolicy } from "../app/navigation-policy.js";

const permissionsPanelUrl = "app://opensteer/computer-use/permissions";
const panelWidth = 500;
const panelHeight = 380;
const panelBottomMargin = 32;

/**
 * The two panes, each named as macOS names it. They are main-process
 * constants for the same reason the Full Disk Access pane is: `openExternalUrl`
 * refuses anything but HTTPS, and a renderer that could name an
 * `x-apple.systempreferences:` target would hold a general way to launch
 * system panes.
 */
const settingsPaneUrls: Readonly<Record<DesktopComputerUseSettingsPane, string>> = {
  accessibility:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
  "screen-recording":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
};

export interface ComputerUsePermissionsPanelOptions {
  readonly openExternal: (url: string, options: { readonly activate: boolean }) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly screen: Pick<Screen, "getPrimaryDisplay">;
  readonly webPreferences: WebPreferences;
  readonly windowFactory: (options: BrowserWindowConstructorOptions) => BrowserWindow;
}

/**
 * The panel floated over System Settings while a person turns the helper's two
 * switches on.
 *
 * The page owns the permission steps, status polling and completion. Main owns
 * only this window and the two fixed System Settings destinations.
 */
export class ComputerUsePermissionsPanel {
  readonly #options: ComputerUsePermissionsPanelOptions;
  #window: BrowserWindow | null = null;

  constructor(options: ComputerUsePermissionsPanelOptions) {
    this.#options = options;
  }

  async open(): Promise<{ readonly opened: true }> {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.focus();
      return { opened: true };
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
      title: "Computer use permissions",
      transparent: true,
      ...(platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: this.#options.webPreferences,
      width: panelWidth,
      x: workArea.x + Math.round((workArea.width - panelWidth) / 2),
      y: workArea.y + workArea.height - panelHeight - panelBottomMargin,
    });
    this.#window = window;
    configureDesktopWindowNavigation(window.webContents, new DesktopAppOriginPolicy());
    window.setAlwaysOnTop(true, "floating");
    window.once("closed", () => {
      if (this.#window === window) this.close();
    });
    try {
      await window.loadURL(permissionsPanelUrl);
      if (!window.isDestroyed()) window.showInactive();
    } catch (error) {
      if (this.#window === window) this.#window = null;
      if (!window.isDestroyed()) window.destroy();
      throw new Error(
        "The Computer use permissions panel could not load the bundled application.",
        { cause: error },
      );
    }
    return { opened: true };
  }

  /** Opens the exact pane, and brings System Settings forward to it. */
  async openSystemSettings(pane: DesktopComputerUseSettingsPane): Promise<void> {
    await this.#options.openExternal(settingsPaneUrls[pane], { activate: true });
  }

  close(): void {
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
