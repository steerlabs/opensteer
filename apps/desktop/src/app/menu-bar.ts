import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMain,
  IpcMainInvokeEvent,
  NativeImage,
  Rectangle,
  Screen,
  Tray,
  WebContents,
  WebPreferences,
} from "electron";
import {
  MenuBarRowTargetSchema,
  MenuBarStatusSchema,
  MenuBarSwitchInputSchema,
  type MenuBarStatus,
  type MenuBarRowTarget,
} from "@opensteer/client/computers";
import { z } from "zod";
import { menuBarChannels, menuBarPopoverUrl } from "./menu-bar-channels.js";
import type { DesktopMenuBarService } from "./menu-bar-service.js";
import type { ShutdownLog } from "./desktop-shutdown.js";

export { menuBarPopoverUrl };

/** Only the popover's own top frame, showing its one document, may call main. */
export function menuBarSenderAllowed(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  popover: Pick<BrowserWindow, "isDestroyed" | "webContents"> | null,
): boolean {
  if (!popover || popover.isDestroyed()) return false;
  const frame = event.senderFrame;
  return (
    event.sender === popover.webContents &&
    frame !== null &&
    frame === popover.webContents.mainFrame &&
    frame.url === menuBarPopoverUrl
  );
}

/** The popover never leaves its document: no navigation, redirect, window or webview. */
export function lockMenuBarNavigation(
  contents: Pick<WebContents, "on" | "setWindowOpenHandler">,
): void {
  contents.on("will-navigate", (event) => {
    if (event.url !== menuBarPopoverUrl) event.preventDefault();
  });
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || event.url !== menuBarPopoverUrl) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
export const menuBarPopoverSize = { width: 300, height: 560 } as const;
const glyphPoints = 16;

export type MenuBarIcon = MenuBarStatus["icon"];

/**
 * The menu bar mark as a template bitmap (BGRA, premultiplied black), so macOS
 * draws it in the menu bar's own colour: the brand's disc, a ring while agents
 * are stopped on this Mac, a slash when no Home can be reached and a small dot
 * when something needs the person. Each mark keeps a clear gap from the disc.
 */
export function menuBarGlyph(pixels: number, icon: MenuBarIcon): Buffer {
  const bitmap = Buffer.alloc(pixels * pixels * 4);
  const centre = pixels / 2;
  const outer = pixels * 0.36;
  const inner = icon.stopped ? outer - pixels * 0.12 : -1;
  const stroke = pixels * 0.07;
  const gap = pixels * 0.07;
  const dot = { x: pixels * 0.8, y: pixels * 0.8, radius: pixels * 0.15 };
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  for (let y = 0; y < pixels; y += 1)
    for (let x = 0; x < pixels; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const fromCentre = Math.hypot(px - centre, py - centre);
      let coverage = clamp(
        Math.min(outer + 0.5 - fromCentre, inner < 0 ? 1 : fromCentre - inner + 0.5),
      );
      if (icon.unreachable) {
        // The diagonal from top right to bottom left, within the disc's square.
        const fromLine = Math.abs(px + py - pixels) / Math.SQRT2;
        const within = Math.abs(px - py) / Math.SQRT2 <= outer + stroke;
        const line = within ? clamp(stroke / 2 + 0.5 - fromLine) : 0;
        coverage = Math.max(Math.min(coverage, clamp(fromLine - stroke / 2 - gap + 0.5)), line);
      }
      if (icon.attention) {
        const fromDot = Math.hypot(px - dot.x, py - dot.y);
        coverage = Math.max(
          Math.min(coverage, clamp(fromDot - dot.radius - gap + 0.5)),
          clamp(dot.radius + 0.5 - fromDot),
        );
      }
      bitmap[(y * pixels + x) * 4 + 3] = Math.round(coverage * 255);
    }
  return bitmap;
}

/** Below the item, centred on it, kept on the display that holds it. */
export function menuBarPopoverBounds(item: Rectangle, workArea: Rectangle): Rectangle {
  const { width, height } = menuBarPopoverSize;
  const x = Math.round(item.x + item.width / 2 - width / 2);
  return {
    x: Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - width - 8),
    y: Math.max(workArea.y, item.y + item.height + 4),
    width,
    height,
  };
}

export interface DesktopMenuBarOptions {
  readonly service: Pick<
    DesktopMenuBarService,
    "changed" | "icon" | "refresh" | "setSwitch" | "status" | "subscribe"
  >;
  readonly actions: {
    stop(): Promise<void>;
    resume(): Promise<void>;
    setOpenAtLogin(on: boolean): Promise<void>;
    openApp(): Promise<void>;
    openRow(target: MenuBarRowTarget): Promise<void>;
    openNeedsYou(deploymentId: string): Promise<void>;
    openSettings(): Promise<void>;
    quitCompletely(): Promise<void>;
  };
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly screen: Pick<Screen, "getDisplayMatching">;
  readonly createTray: (image: NativeImage) => Tray;
  readonly createImage: (bitmap: Buffer, size: number) => NativeImage;
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  readonly webPreferences: WebPreferences;
  readonly log: ShutdownLog;
}

/**
 * The status item and its popover: one small frameless window of the bundled
 * UI, created on first open and kept hidden between opens so it shows at once.
 * Only that window's page may call the handlers registered here.
 */
export class DesktopMenuBar {
  readonly #options: DesktopMenuBarOptions;
  #tray: Tray | null = null;
  #popover: BrowserWindow | null = null;
  #loaded: Promise<void> | null = null;
  #glyph = "";
  #detach: (() => void) | null = null;

  constructor(options: DesktopMenuBarOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#tray) return;
    const tray = this.#options.createTray(
      this.#image({ attention: false, unreachable: false, stopped: false }),
    );
    tray.setToolTip("Opensteer");
    tray.on("click", () => void this.toggle());
    tray.on("right-click", () => void this.toggle());
    this.#tray = tray;
    this.#register();
    this.#detach = this.#options.service.subscribe(() => this.#redraw());
    this.#redraw();
  }

  /** Opens the popover under the item, or closes it when it already shows. */
  async toggle(): Promise<void> {
    const popover = this.#popover;
    if (popover && !popover.isDestroyed() && popover.isVisible()) {
      popover.hide();
      return;
    }
    await this.open();
  }

  async open(): Promise<void> {
    const tray = this.#tray;
    if (!tray) return;
    const popover = this.#window();
    const item = tray.getBounds();
    popover.setBounds(
      menuBarPopoverBounds(item, this.#options.screen.getDisplayMatching(item).workArea),
    );
    try {
      await this.#loaded;
    } catch {
      return;
    }
    if (popover.isDestroyed()) return;
    popover.show();
    popover.focus();
    this.#redraw();
    void this.#options.service.refresh().catch(() => undefined);
  }

  dispose(): void {
    this.#detach?.();
    this.#detach = null;
    for (const channel of Object.values(menuBarChannels))
      if (channel !== menuBarChannels.statusChanged) this.#options.ipcMain.removeHandler(channel);
    const popover = this.#popover;
    this.#popover = null;
    if (popover && !popover.isDestroyed()) popover.destroy();
    this.#tray?.destroy();
    this.#tray = null;
  }

  #image(icon: MenuBarIcon): NativeImage {
    this.#glyph = JSON.stringify(icon);
    const image = this.#options.createImage(menuBarGlyph(glyphPoints * 2, icon), 2);
    image.setTemplateImage(true);
    return image;
  }

  #window(): BrowserWindow {
    const existing = this.#popover;
    if (existing && !existing.isDestroyed()) return existing;
    const popover = this.#options.createWindow({
      ...menuBarPopoverSize,
      alwaysOnTop: true,
      frame: false,
      fullscreenable: false,
      hiddenInMissionControl: true,
      maximizable: false,
      minimizable: false,
      movable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      title: "Opensteer",
      backgroundColor: "#101010",
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: this.#options.webPreferences,
    });
    lockMenuBarNavigation(popover.webContents);
    popover.on("blur", () => {
      if (!popover.isDestroyed() && !popover.webContents.isDevToolsOpened()) popover.hide();
    });
    popover.once("closed", () => {
      if (this.#popover === popover) {
        this.#popover = null;
        this.#loaded = null;
      }
    });
    this.#popover = popover;
    this.#loaded = popover.loadURL(menuBarPopoverUrl).catch((error: unknown) => {
      this.#options.log("desktop.menu-bar.load-failed", {
        message: error instanceof Error ? error.message : "failed",
      });
      if (!popover.isDestroyed()) popover.destroy();
      throw error;
    });
    return popover;
  }

  /**
   * Main redraws on change: the status item at once from what main holds, and
   * the popover, while it shows, with one full status at a time. Changes that
   * arrive meanwhile fold into one more, and a failure is logged, never thrown.
   */
  #redraw(): void {
    this.#drawIcon(this.#options.service.icon());
    const popover = this.#popover;
    if (!popover || popover.isDestroyed() || !popover.isVisible()) return;
    if (this.#pushing) {
      this.#pushAgain = true;
      return;
    }
    this.#pushing = true;
    void (async () => {
      do {
        this.#pushAgain = false;
        const status = MenuBarStatusSchema.parse(await this.#options.service.status());
        this.#drawIcon(status.icon);
        const shown = this.#popover;
        if (shown && !shown.isDestroyed() && shown.isVisible())
          shown.webContents.send(menuBarChannels.statusChanged, status);
      } while (this.#pushAgain);
    })()
      .catch((error: unknown) =>
        this.#options.log("desktop.menu-bar.redraw-failed", {
          message: error instanceof Error ? error.message : "failed",
        }),
      )
      .finally(() => {
        this.#pushing = false;
        // A change that landed after the last look still gets its push.
        if (this.#pushAgain) {
          this.#pushAgain = false;
          this.#redraw();
        }
      });
  }

  #pushing = false;
  #pushAgain = false;

  #drawIcon(icon: MenuBarIcon): void {
    if (this.#tray && this.#glyph !== JSON.stringify(icon)) this.#tray.setImage(this.#image(icon));
  }

  #register(): void {
    const handle = (channel: string, run: (input: unknown) => Promise<unknown>) =>
      this.#options.ipcMain.handle(channel, async (event: IpcMainInvokeEvent, input: unknown) => {
        if (!menuBarSenderAllowed(event, this.#popover))
          throw new Error("Only the Opensteer menu bar may ask this.");
        return await run(input);
      });
    const { actions, service } = this.#options;
    handle(menuBarChannels.status, async () => {
      void service.refresh().catch(() => undefined);
      return MenuBarStatusSchema.parse(await service.status());
    });
    handle(menuBarChannels.setSwitch, (input) =>
      service.setSwitch(MenuBarSwitchInputSchema.parse(input)),
    );
    handle(menuBarChannels.openRow, async (input) => {
      const target = MenuBarRowTargetSchema.parse(input);
      this.#popover?.hide();
      await actions.openRow(target);
    });
    handle(menuBarChannels.stop, () => actions.stop());
    handle(menuBarChannels.resume, () => actions.resume());
    handle(menuBarChannels.setOpenAtLogin, async (input) => {
      await actions.setOpenAtLogin(z.boolean().parse(input));
      service.changed();
    });
    handle(menuBarChannels.openApp, async () => {
      this.#popover?.hide();
      await actions.openApp();
    });
    handle(menuBarChannels.openNeedsYou, async (input) => {
      this.#popover?.hide();
      await actions.openNeedsYou(z.string().min(1).max(255).parse(input));
    });
    handle(menuBarChannels.openSettings, async () => {
      this.#popover?.hide();
      await actions.openSettings();
    });
    handle(menuBarChannels.quitCompletely, async () => {
      this.#popover?.hide();
      await actions.quitCompletely();
    });
  }
}
