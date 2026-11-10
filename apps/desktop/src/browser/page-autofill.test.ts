import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { BaseWindow, WebContents } from "electron";
import type { DesktopAutofillScene, DesktopWindowRect } from "@opensteer/protocol/desktop";
import { desktopBridgeChannels as channels } from "../bridge/desktop-bridge-channels.js";
import { PageAutofill } from "./page-autofill.js";

const fakes = vi.hoisted(() => ({
  window: null as { visible: boolean; bounds: DesktopWindowRect | null } | null,
  contents: null as (EventEmitter & { ipc: EventEmitter; mainFrame: object }) | null,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    BaseWindow: class {
      visible = false;
      bounds: DesktopWindowRect | null = null;
      contentView = { addChildView: () => {} };
      constructor() {
        fakes.window = this;
      }
      isDestroyed() {
        return false;
      }
      setBounds(bounds: DesktopWindowRect) {
        this.bounds = bounds;
      }
      showInactive() {
        this.visible = true;
      }
      hide() {
        this.visible = false;
      }
      destroy() {
        this.visible = false;
      }
    },
    WebContentsView: class {
      webContents = Object.assign(new EventEmitter(), {
        ipc: new EventEmitter(),
        mainFrame: {},
        loadURL: async () => {},
        send: () => {},
        setZoomFactor: () => {},
        isDestroyed: () => false,
        close: () => {},
      });
      constructor() {
        fakes.contents = this.webContents;
      }
      setBackgroundColor() {}
      setBounds() {}
    },
  };
});
vi.mock("../app/electron-window.js", () => ({ configureDesktopWindowNavigation: () => {} }));

const scene: DesktopAutofillScene = {
  sceneRevision: 1,
  accounts: [{ id: "00000000-0000-4000-8000-000000000001", username: "synthetic", label: null }],
  anchor: { x: 10, y: 20, width: 100, height: 20 },
  role: "username",
  highlighted: 0,
  reducedMotion: true,
};

it("shows only a main-frame measurement of the current scene and refuses stale popup choices", async () => {
  const parent = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => true,
    getContentBounds: () => ({ x: 100, y: 200, width: 800, height: 600 }),
  });
  const choose = vi.fn();
  const popup = new PageAutofill(parent as unknown as BaseWindow, "/autofill.cjs", {
    choose,
    dismiss: () => popup.update(null, null),
    onError: (error) => {
      throw error;
    },
  });
  try {
    const geometry = {
      page: { x: 0, y: 0, width: 800, height: 600 },
      stage: { x: 0, y: 0, width: 800, height: 600 },
      appZoom: 1,
      pageZoom: 1,
    };
    popup.update(scene, geometry);
    await Promise.resolve();
    const contents = fakes.contents!;
    const event = { senderFrame: contents.mainFrame, sender: contents as unknown as WebContents };
    const measured = (sceneRevision: number, sender = event) =>
      contents.ipc.emit(channels.autofillMeasured, sender, {
        sceneRevision,
        width: 200,
        height: 100,
      });
    expect(fakes.window!.visible).toBe(false);
    measured(0);
    measured(1, { ...event, senderFrame: {} });
    expect(fakes.window!.visible).toBe(false);
    measured(1);
    expect(fakes.window!.visible).toBe(true);
    expect(fakes.window!.bounds).toEqual({ x: 94, y: 228, width: 232, height: 132 });
    // A highlight move is a new revision of the same panel: it stays up, sized as measured.
    popup.update({ ...scene, sceneRevision: 2, highlighted: 1 }, geometry);
    expect(fakes.window!.visible).toBe(true);
    expect(fakes.window!.bounds).toEqual({ x: 94, y: 228, width: 232, height: 132 });
    measured(1);
    contents.ipc.emit(channels.autofillChoose, event, {
      sceneRevision: 1,
      accountId: scene.accounts[0]!.id,
    });
    contents.ipc.emit(channels.autofillChoose, event, {
      sceneRevision: 2,
      accountId: "00000000-0000-4000-8000-000000000002",
    });
    expect(choose).not.toHaveBeenCalled();
    contents.ipc.emit(channels.autofillChoose, event, {
      sceneRevision: 2,
      accountId: scene.accounts[0]!.id,
    });
    expect(choose).toHaveBeenCalledExactlyOnceWith(2, scene.accounts[0]!.id);
    popup.update({ ...scene, sceneRevision: 2, anchor: { ...scene.anchor, y: 1_000 } }, geometry);
    expect(fakes.window!.visible).toBe(false);
    // A closed list forgets its size: the next one waits for its own measurement.
    popup.update(null, geometry);
    popup.update({ ...scene, sceneRevision: 3 }, geometry);
    expect(fakes.window!.visible).toBe(false);
    measured(3);
    expect(fakes.window!.visible).toBe(true);
    parent.emit("blur");
    expect(fakes.window!.visible).toBe(false);
    expect(popup.shown).toBe(false);
  } finally {
    popup.close();
  }
});
