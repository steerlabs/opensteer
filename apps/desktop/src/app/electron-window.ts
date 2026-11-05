import { resolveDesktopAppBranding } from "@opensteer/protocol/desktop";
import { isAppNavigation, isAppOriginUrl } from "@opensteer/shared/appFrame";
import { configureDesktopPermissions } from "./media-permissions.js";
import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  systemPreferences,
  shell,
  type BaseWindowConstructorOptions,
  type Event,
  type OnBeforeRequestListenerDetails,
  type Session,
  type WebContents,
  type WebFrameMain,
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
  attachedHost?: () => Promise<string | null>,
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
      const source = details.initiatorOrigin ?? details.frame?.url ?? "";
      const decide = () =>
        callback({
          cancel: !policy.allowsNetworkRequest(details.url, {
            url: details.frame?.url ?? "",
            resourceType: details.resourceType,
            ...(details.initiatorOrigin === undefined
              ? {}
              : { initiatorOrigin: details.initiatorOrigin }),
          }),
        });
      // Resolving the attachment can wait on the route; the app's own files must not.
      if (!attachedHost || !(isAppOriginUrl(details.url) || isAppOriginUrl(source))) {
        decide();
        return;
      }
      void attachedHost().then(
        (host) => {
          policy.setAttachedHost(host);
          decide();
        },
        () => callback({ cancel: true }),
      );
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
  const pendingFrames = new WeakMap<WebFrameMain, string>();
  webContents.on("did-start-navigation", (event) => {
    if (!event.frame || event.isMainFrame) return;
    if (policy.isPublishedApp(event.url)) pendingFrames.set(event.frame, event.url);
    else pendingFrames.delete(event.frame);
  });
  const guardNavigation = (event: Event, url: string) => {
    if (!policy.allowsNavigation(url)) event.preventDefault();
  };
  webContents.setWindowOpenHandler(({ url }) => {
    // App responses suppress referrers; a clicked link's focused frame identifies its source.
    const source = webContents.focusedFrame?.url;
    if (source && policy.isPublishedApp(source) && /^https?:\/\//iu.test(url))
      void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  webContents.on("will-frame-navigate", (event) => {
    const source = event.frame?.url;
    if (source && policy.isPublishedApp(source) && !isAppNavigation(event.url, source)) {
      event.preventDefault();
      if (/^https?:\/\//iu.test(event.url))
        void shell.openExternal(event.url).catch(() => undefined);
    }
  });
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.on("will-navigate", guardNavigation);
  webContents.on("will-redirect", (event) => {
    if (event.isMainFrame) {
      guardNavigation(event, event.url);
      return;
    }
    // A frame an app embeds is that app's business; the network policy still applies to it.
    if (event.frame?.parent && policy.isPublishedApp(event.frame.parent.url)) return;
    const source =
      event.frame &&
      (policy.isPublishedApp(event.frame.url) ? event.frame.url : pendingFrames.get(event.frame));
    if (
      !source ||
      !policy.isPublishedApp(source) ||
      !isAppNavigation(event.url, source) ||
      !policy.allowsNavigation(event.url, source)
    ) {
      event.preventDefault();
      if (source && policy.isPublishedApp(source) && /^https?:\/\//iu.test(event.url))
        void shell.openExternal(event.url).catch(() => undefined);
    }
  });
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
      readonly policy?: DesktopAppOriginPolicy;
    },
  ) {
    this.#config = config;
    this.#policy = options.policy ?? new DesktopAppOriginPolicy();
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
        title: resolveDesktopAppBranding(app.getVersion()).displayName,
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
