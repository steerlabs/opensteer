import { configureDesktopPermissions } from "./media-permissions.js";
import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import {
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  systemPreferences,
  type BaseWindowConstructorOptions,
  type Event,
  type OnBeforeRequestListenerDetails,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import path from "node:path";
import { desktopAppEntryUrl } from "./app-protocol.js";
import type { DesktopConfiguration } from "../config.js";
import type { DesktopWindowFactory } from "./desktop-main-process.js";
import { DesktopAppOriginPolicy } from "./navigation-policy.js";
import type { DesktopUsbDeviceAccess } from "./usb-device-access.js";

const desktopTitleBarHeight = 52;

type DesktopWindowChromeOptions = Pick<
  BaseWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

export function desktopWindowChromeOptions(platform: NodeJS.Platform): DesktopWindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    };
  }

  return {
    titleBarOverlay: {
      color: "#00000000",
      height: desktopTitleBarHeight,
      symbolColor: "#f5f4f2",
    },
    titleBarStyle: "hidden",
  };
}

export function desktopQuitShortcut(
  input: Pick<Electron.Input, "control" | "key" | "meta" | "type">,
  platform: NodeJS.Platform,
): boolean {
  const modifier = platform === "darwin" ? input.meta : input.control;
  return input.type === "keyDown" && modifier && input.key.toLowerCase() === "q";
}

export function configureDesktopSession(
  session: Session,
  policy: DesktopAppOriginPolicy,
  usbDevices: Pick<DesktopUsbDeviceAccess, "permitsRequest"> | null,
  downloads: Pick<DesktopDownloads, "accept">,
): void {
  configureDesktopPermissions(session, policy, usbDevices, () =>
    process.platform === "darwin"
      ? systemPreferences.askForMediaAccess("microphone")
      : Promise.resolve(true),
  );
  for (const preload of session.getPreloadScripts()) session.unregisterPreloadScript(preload.id);
  downloads.accept(session);
  session.webRequest.onBeforeRequest(
    {
      urls: ["<all_urls>"],
    },
    (details: OnBeforeRequestListenerDetails, callback) => {
      callback({ cancel: !policy.allowsNetworkRequest(details.url) });
    },
  );
}

export function desktopWebPreferences(
  config: Pick<DesktopConfiguration, "mode">,
  bridgeToken: string,
  preloadPath: string,
): WebPreferences {
  return {
    allowRunningInsecureContent: false,
    additionalArguments: [`--opensteer-desktop-bridge-token=${bridgeToken}`],
    contextIsolation: true,
    devTools: config.mode !== "production",
    navigateOnDragDrop: false,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    preload: path.resolve(preloadPath),
    safeDialogs: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  };
}

export function configureDesktopWindowNavigation(
  webContents: WebContents,
  policy: DesktopAppOriginPolicy,
): void {
  const guardNavigation = (event: Event, url: string) => {
    if (!policy.allowsNavigation(url)) event.preventDefault();
  };
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.on("will-navigate", guardNavigation);
  webContents.on("will-redirect", guardNavigation);
}

export class ElectronWindowFactory implements DesktopWindowFactory {
  readonly #windows = new WeakSet<BaseWindow>();
  readonly owns = (window: BaseWindow): window is ElectronAppWindow => this.#windows.has(window);
  readonly #config: DesktopConfiguration;
  readonly #policy: DesktopAppOriginPolicy;
  readonly #bridgeToken: string;
  readonly #preloadPath: string;
  readonly #quit: () => void;
  readonly #onCreated: (window: ElectronAppWindow) => void;

  constructor(
    config: DesktopConfiguration,
    options: {
      readonly bridgeToken: string;
      readonly preloadPath: string;
      readonly quit: () => void;
      readonly onCreated?: (window: ElectronAppWindow) => void;
    },
  ) {
    this.#config = config;
    this.#policy = new DesktopAppOriginPolicy();
    this.#bridgeToken = options.bridgeToken;
    this.#preloadPath = options.preloadPath;
    this.#quit = options.quit;
    this.#onCreated = options.onCreated ?? (() => undefined);
  }

  async create(
    onClosed: () => void,
    options: { readonly show: boolean },
  ): Promise<ElectronAppWindow> {
    const window = createElectronAppWindow(
      {
        backgroundColor: "#080808",
        height: 820,
        minHeight: 560,
        minWidth: 760,
        show: false,
        title: "Opensteer",
        ...desktopWindowChromeOptions(process.platform),
        width: 1_360,
      },
      desktopWebPreferences(this.#config, this.#bridgeToken, this.#preloadPath),
    );
    this.#windows.add(window);
    this.#onCreated(window);
    configureDesktopWindowNavigation(window.webContents, this.#policy);
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      process.stdout.write(
        `${JSON.stringify({ error: error.message, event: "desktop.preload.error", preloadPath })}\n`,
      );
    });
    window.webContents.on("before-input-event", (event, input) => {
      if (!desktopQuitShortcut(input, process.platform)) return;
      event.preventDefault();
      this.#quit();
    });
    window.webContents.once("did-finish-load", () => {
      if (options.show && !window.isDestroyed()) window.show();
    });
    // Closing hides: the page keeps receiving the person's notifications.
    // Quitting destroys the window, which emits no `close`.
    window.on("close", (event) => {
      event.preventDefault();
      window.hide();
    });
    window.once("closed", onClosed);
    try {
      await window.webContents.loadURL(desktopAppEntryUrl);
    } catch (error) {
      window.destroy();
      throw new Error("The desktop window could not load its bundled application.", {
        cause: error,
      });
    }
    return window;
  }
}

/** Explicit siblings let the application cover a live page when an overlay opens. */
export interface ElectronAppWindow extends BaseWindow {
  readonly appView: WebContentsView;
  readonly webContents: WebContents;
}
const appWindows = new WeakMap<WebContents, BaseWindow>();

export function createElectronAppWindow(
  options: BaseWindowConstructorOptions & { readonly backgroundColor: string },
  webPreferences: WebPreferences,
): ElectronAppWindow {
  const window = new BaseWindow(options);
  // On macOS the window colour is a layer outside Chromium, whose compositor
  // treats this opaque window's frame as opaque and redraws damaged regions
  // without clearing them. Painting the ground in the compositor makes that
  // true; otherwise translucent app pixels over transparent ones stack a coat
  // per redraw whenever Core Animation delegation is off.
  window.contentView.setBackgroundColor(options.backgroundColor);
  const appView = new WebContentsView({ webPreferences });
  const shell = Object.assign(window, { appView, webContents: appView.webContents });
  appWindows.set(shell.webContents, window);
  appView.setBackgroundColor("#00000000");
  window.contentView.addChildView(appView);
  const resize = () => {
    const { width, height } = window.getContentBounds();
    appView.setBounds({ x: 0, y: 0, width, height });
  };
  resize();
  window.on("resize", resize);
  window.once("closed", () => {
    appWindows.delete(shell.webContents);
    if (!shell.webContents.isDestroyed()) shell.webContents.close({ waitForBeforeUnload: false });
  });
  return shell;
}

export function desktopWindowForContents(contents: WebContents): BaseWindow | null {
  return appWindows.get(contents) ?? BrowserWindow.fromWebContents(contents);
}
