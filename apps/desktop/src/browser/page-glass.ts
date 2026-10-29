import { BaseWindow, WebContentsView } from "electron";
import type { DesktopGlassScene, DesktopWindowRect } from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";
import { configureDesktopWindowNavigation } from "../app/electron-window.js";
import { DesktopAppOriginPolicy } from "../app/navigation-policy.js";

export class PageGlass {
  readonly #window: BaseWindow;
  readonly #view: WebContentsView;
  readonly #parent: BaseWindow;
  readonly #dispose: (() => void)[] = [];
  #bounds: DesktopWindowRect | null = null;
  #scene: DesktopGlassScene | null = null;
  #front = false;
  #ready = false;
  #appliedBounds: DesktopWindowRect | null = null;
  #appliedScene: string | null = null;
  #visible = false;
  /** Whether the shown glass is its parent's child, ordering and moving with it. */
  #attached = false;

  constructor(parent: BaseWindow, preload: string, onError: (error: unknown) => void) {
    this.#parent = parent;
    this.#window = new BaseWindow({
      parent,
      transparent: true,
      frame: false,
      focusable: false,
      hasShadow: false,
      show: false,
      skipTaskbar: true,
      backgroundColor: "#00000000",
    });
    this.#window.setIgnoreMouseEvents(true);
    this.#view = new WebContentsView({
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        navigateOnDragDrop: false,
        devTools: false,
        zoomFactor: 1,
        zoomMode: "isolated",
      },
    });
    this.#view.setBackgroundColor("#00000000");
    this.#window.contentView.addChildView(this.#view);
    configureDesktopWindowNavigation(this.#view.webContents, new DesktopAppOriginPolicy());
    const events: NodeJS.EventEmitter = parent;
    for (const event of [
      "move",
      "resize",
      "show",
      "hide",
      "minimize",
      "restore",
      "focus",
    ] as const) {
      const sync = () => this.#sync();
      events.on(event, sync);
      this.#dispose.push(() => {
        events.off(event, sync);
      });
    }
    void this.#view.webContents
      .loadURL("app://opensteer/glass.html")
      .then(() => {
        this.#ready = true;
        this.#sync();
      })
      .catch(onError);
  }

  update(bounds: DesktopWindowRect | null, scene: DesktopGlassScene | null, front: boolean): void {
    this.#bounds = bounds;
    this.#scene = scene;
    this.#front = front;
    this.#sync();
  }

  close(): void {
    for (const dispose of this.#dispose.splice(0)) dispose();
    if (!this.#view.webContents.isDestroyed())
      this.#view.webContents.close({ waitForBeforeUnload: false });
    if (!this.#window.isDestroyed()) this.#window.destroy();
  }

  #sync(): void {
    if (this.#window.isDestroyed() || this.#parent.isDestroyed()) return;
    const bounds = this.#bounds;
    const scene = this.#scene;
    const visible = !!(
      this.#ready &&
      bounds &&
      this.#front &&
      scene &&
      (scene.cursors.length || scene.croppedBottom || scene.croppedRight) &&
      this.#parent.isVisible() &&
      !this.#parent.isMinimized()
    );
    if (!visible || !bounds) {
      if (this.#visible) this.#window.hide();
      this.#visible = false;
      this.#attached = false;
      // A hidden glass lets its scene go, so every reshow draws afresh rather than
      // gliding cursors on from where they were when it hid.
      if (this.#ready && this.#appliedScene !== null) {
        this.#view.webContents.send(desktopBridgeChannels.glassScene, null);
        this.#appliedScene = null;
      }
      return;
    }
    const origin = this.#parent.getContentBounds();
    const target = { ...bounds, x: origin.x + bounds.x, y: origin.y + bounds.y };
    const previous = this.#appliedBounds;
    if (
      !previous ||
      previous.x !== target.x ||
      previous.y !== target.y ||
      previous.width !== target.width ||
      previous.height !== target.height
    )
      this.#window.setBounds(target);
    if (!previous || previous.width !== target.width || previous.height !== target.height)
      this.#view.setBounds({ x: 0, y: 0, width: target.width, height: target.height });
    this.#appliedBounds = target;
    const serialized = JSON.stringify(scene);
    if (this.#appliedScene !== serialized) {
      this.#view.webContents.send(desktopBridgeChannels.glassScene, scene);
      this.#appliedScene = serialized;
    }
    // Desired bounds and the newest scene land before a hidden glass is shown.
    // AppKit orders a child window's whole group front, which would raise the
    // person's background Opensteer window above the app they are using. Until
    // its parent is focused, and so already in front, the glass is ordered in
    // just above the parent instead of becoming its child.
    if (process.platform !== "darwin" || this.#parent.isFocused()) {
      if (!this.#attached) this.#window.showInactive();
      this.#attached = true;
    } else if (!this.#visible) this.#window.moveAbove(this.#parent.getMediaSourceId());
    this.#visible = true;
  }
}
