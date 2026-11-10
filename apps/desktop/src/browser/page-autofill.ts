import { BaseWindow, WebContentsView } from "electron";
import type { DesktopAutofillScene, DesktopWindowRect } from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";
import { configureDesktopWindowNavigation } from "../app/electron-window.js";
import { DesktopAppOriginPolicy } from "../app/navigation-policy.js";
import {
  autofillChoiceSchema,
  autofillMeasurementSchema,
  autofillPlacement,
} from "./autofill-state.js";

interface Geometry {
  readonly page: DesktopWindowRect;
  readonly stage: DesktopWindowRect;
  readonly pageZoom: number;
  readonly appZoom: number;
}

export class PageAutofill {
  readonly #window: BaseWindow;
  readonly #view: WebContentsView;
  readonly #parent: BaseWindow;
  readonly #dismiss: () => void;
  readonly #dispose: (() => void)[] = [];
  #scene: DesktopAutofillScene | null = null;
  #geometry: Geometry | null = null;
  #panel: { width: number; height: number } | null = null;
  #ready = false;
  #visible = false;
  #appliedScene: string | null = null;

  constructor(
    parent: BaseWindow,
    preload: string,
    callbacks: {
      choose: (sceneRevision: number, accountId: string) => void;
      dismiss: () => void;
      onError: (error: unknown) => void;
    },
  ) {
    this.#parent = parent;
    this.#dismiss = callbacks.dismiss;
    this.#window = new BaseWindow({
      parent,
      transparent: true,
      frame: false,
      focusable: false,
      acceptFirstMouse: true,
      hasShadow: false,
      show: false,
      skipTaskbar: true,
      backgroundColor: "#00000000",
    });
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
    const contents = this.#view.webContents;
    configureDesktopWindowNavigation(contents, new DesktopAppOriginPolicy());
    contents.ipc.on(desktopBridgeChannels.autofillMeasured, (event, value: unknown) => {
      if (event.senderFrame !== contents.mainFrame) return;
      const result = autofillMeasurementSchema.safeParse(value);
      if (!result.success || result.data.sceneRevision !== this.#scene?.sceneRevision) return;
      this.#panel = result.data;
      this.#sync();
    });
    contents.ipc.on(desktopBridgeChannels.autofillChoose, (event, value: unknown) => {
      if (event.senderFrame !== contents.mainFrame || !this.#visible) return;
      const result = autofillChoiceSchema.safeParse(value);
      if (
        !result.success ||
        result.data.sceneRevision !== this.#scene?.sceneRevision ||
        !this.#scene.accounts.some((account) => account.id === result.data.accountId)
      )
        return;
      callbacks.choose(result.data.sceneRevision, result.data.accountId);
    });
    contents.on("render-process-gone", () => this.#dismiss());
    const events: NodeJS.EventEmitter = parent;
    for (const event of ["move", "resize"] as const) {
      const sync = () => this.#sync();
      events.on(event, sync);
      this.#dispose.push(() => {
        events.off(event, sync);
      });
    }
    for (const event of [
      "blur",
      "hide",
      "minimize",
      "close",
      "enter-full-screen",
      "leave-full-screen",
    ] as const) {
      const dismiss = () => this.#dismiss();
      events.on(event, dismiss);
      this.#dispose.push(() => {
        events.off(event, dismiss);
      });
    }
    void contents
      .loadURL("app://opensteer/autofill.html")
      .then(() => {
        this.#ready = true;
        this.#sync();
      })
      .catch(callbacks.onError);
  }

  get shown(): boolean {
    return this.#visible;
  }

  update(scene: DesktopAutofillScene | null, geometry: Geometry | null): void {
    if (scene?.sceneRevision !== this.#scene?.sceneRevision) {
      this.#panel = null;
      this.#hide();
    }
    this.#scene = scene;
    this.#geometry = geometry;
    this.#sync();
  }

  /** Glass can be ordered in after the chooser; restore this child's place above it. */
  orderAboveGlass(): void {
    if (this.#visible && !this.#window.isDestroyed()) this.#window.showInactive();
  }

  close(): void {
    for (const dispose of this.#dispose.splice(0)) dispose();
    if (!this.#view.webContents.isDestroyed())
      this.#view.webContents.close({ waitForBeforeUnload: false });
    if (!this.#window.isDestroyed()) this.#window.destroy();
  }

  #hide(): void {
    if (this.#visible && !this.#window.isDestroyed()) this.#window.hide();
    this.#visible = false;
  }

  #sync(): void {
    if (this.#window.isDestroyed() || this.#parent.isDestroyed()) return;
    const scene = this.#scene;
    const geometry = this.#geometry;
    if (
      !scene ||
      !geometry ||
      !this.#parent.isVisible() ||
      this.#parent.isMinimized() ||
      !this.#parent.isFocused()
    ) {
      this.#hide();
      if (this.#ready && this.#appliedScene !== null) {
        this.#view.webContents.send(desktopBridgeChannels.autofillScene, null);
        this.#appliedScene = null;
      }
      return;
    }
    if (!this.#ready) return;
    this.#view.webContents.setZoomFactor(geometry.appZoom);
    const serialized = JSON.stringify(scene);
    if (this.#appliedScene !== serialized) {
      this.#view.webContents.send(desktopBridgeChannels.autofillScene, scene);
      this.#appliedScene = serialized;
    }
    if (!this.#panel) return;
    const bounds = autofillPlacement({ ...geometry, anchor: scene.anchor, panel: this.#panel });
    if (!bounds) {
      this.#hide();
      this.#dismiss();
      return;
    }
    const origin = this.#parent.getContentBounds();
    this.#window.setBounds({ ...bounds, x: origin.x + bounds.x, y: origin.y + bounds.y });
    this.#view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    if (!this.#visible) this.#window.showInactive();
    this.#visible = true;
  }
}
