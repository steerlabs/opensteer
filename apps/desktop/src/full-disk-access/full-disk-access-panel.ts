import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Screen,
  WebPreferences,
} from "electron";
import { fullDiskAccessLabel } from "@opensteer/client/host";
import { configureDesktopWindowNavigation } from "../app/electron-window.js";
import { DesktopAppOriginPolicy } from "../app/navigation-policy.js";

const fullDiskAccessSettingsUrl =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles";
const fullDiskAccessPanelUrl = "app://opensteer/full-access";
const panelWidth = 460;
const panelHeight = 176;
const panelBottomMargin = 32;

export interface FullDiskAccessPanelOptions {
  /** The app's display name, which is how the macOS list names it. */
  readonly appName: string;
  readonly openExternal: (url: string, options: { readonly activate: boolean }) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly screen: Pick<Screen, "getPrimaryDisplay">;
  readonly webPreferences: WebPreferences;
  readonly windowFactory: (options: BrowserWindowConstructorOptions) => BrowserWindow;
}

/**
 * The small window floated over System Settings' Full Disk Access pane while a
 * person turns the app's switch on.
 *
 * macOS offers no way to ask for that grant, and the app is already in the
 * list by the time anyone gets here — the helper's first denied probe is what
 * makes macOS add it. So the panel only shows which icon to look for and
 * watches for the grant; it never drags, registers, or writes anything.
 */
export class FullDiskAccessPanel {
  readonly #appName: string;
  readonly #openExternal: FullDiskAccessPanelOptions["openExternal"];
  readonly #platform: NodeJS.Platform;
  readonly #screen: Pick<Screen, "getPrimaryDisplay">;
  readonly #webPreferences: WebPreferences;
  readonly #windowFactory: FullDiskAccessPanelOptions["windowFactory"];
  #window: BrowserWindow | null = null;

  constructor(options: FullDiskAccessPanelOptions) {
    this.#appName = options.appName;
    this.#openExternal = options.openExternal;
    this.#platform = options.platform ?? process.platform;
    this.#screen = options.screen;
    this.#webPreferences = options.webPreferences;
    this.#windowFactory = options.windowFactory;
  }

  async open(): Promise<{ readonly opened: true }> {
    await this.#openExternal(fullDiskAccessSettingsUrl, { activate: true });
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.focus();
      return { opened: true };
    }

    const workArea = this.#screen.getPrimaryDisplay().workArea;
    const window = this.#windowFactory({
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
      title: fullDiskAccessLabel,
      transparent: true,
      ...(this.#platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: this.#webPreferences,
      width: panelWidth,
      x: workArea.x + Math.round((workArea.width - panelWidth) / 2),
      y: workArea.y + workArea.height - panelHeight - panelBottomMargin,
    });
    this.#window = window;
    configureDesktopWindowNavigation(window.webContents, new DesktopAppOriginPolicy());
    window.setAlwaysOnTop(true, "floating");
    window.once("closed", () => {
      if (this.#window === window) this.#window = null;
    });
    try {
      await window.loadURL(`${fullDiskAccessPanelUrl}?app=${encodeURIComponent(this.#appName)}`);
      if (!window.isDestroyed()) window.showInactive();
    } catch (error) {
      if (this.#window === window) this.#window = null;
      if (!window.isDestroyed()) window.destroy();
      throw new Error("The macOS Full Disk Access panel could not load the bundled application.", {
        cause: error,
      });
    }
    return { opened: true };
  }

  close(): void {
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
