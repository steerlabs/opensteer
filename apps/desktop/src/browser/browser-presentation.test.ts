import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { WebContents } from "electron";
import type { NativePresentationSource, PresentedSurface } from "@opensteer/browser-runtime-core";
import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "@opensteer/protocol";
import type { ElectronAppWindow } from "../app/electron-window.js";
import type { DesktopBrowserSocketObservation } from "../connections/host-transport.js";
import type { NativePlacement } from "./electron-browser-launcher.js";
import { DesktopBrowserPresentationManager } from "./browser-presentation.js";

vi.mock("electron", () => ({
  clipboard: {},
  Menu: { getApplicationMenu: () => null, buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
}));
vi.mock("./electron-browser-launcher.js", () => ({
  electronPagePresentation: (page: { native: unknown }) => page.native,
}));
const glass = vi.hoisted(() => ({ update: vi.fn(), close: vi.fn() }));
vi.mock("./page-glass.js", () => ({
  PageGlass: class {
    update = glass.update;
    close = glass.close;
  },
}));
vi.mock("../app/electron-window.js", () => ({ desktopQuitShortcut: () => false }));
vi.mock("../app/application-menu.js", () => ({
  desktopBrowserAppShortcut: () => false,
  workspaceTabCommand: () => null,
}));

const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001");
const surfaceId = BrowserSurfaceIdSchema.parse("bsf_00000000-0000-4000-8000-000000000001");
const rect = { x: 0, y: 0, width: 800, height: 600 };
const managers: DesktopBrowserPresentationManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});
/** Glass is the macOS and Windows overlay; Linux marks the page in the app instead. */
function onPlatform(platform: NodeJS.Platform): void {
  const actual = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...actual, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, "platform", actual);
  });
}
function fixture() {
  let observe = (_event: DesktopBrowserSocketObservation) => {};
  let input = () => {};
  const passkeyConsumerToken = vi.fn<() => string | null>(() => null);
  const manager = new DesktopBrowserPresentationManager({
    transport: {
      passkeyConsumerToken,
      observeBrowserSockets: (fn) => {
        observe = fn;
        return () => {};
      },
      closeSocketsForOwner: vi.fn(),
      openBrowserSurface: vi.fn(),
    },
    glassPreload: "unused",
    onError: (error) => {
      throw error;
    },
    quit: vi.fn(),
  });
  managers.push(manager);
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn(),
    focus: vi.fn(),
    getZoomFactor: () => 1,
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    appView: {},
    isDestroyed: () => false,
    isFocused: () => true,
    contentView: { children: [] as unknown[], addChildView: vi.fn() },
  });
  manager.attachWindow(window as unknown as ElectronAppWindow);
  const pageContents = Object.assign(new EventEmitter(), {
    isCrashed: () => false,
    stopFindInPage: vi.fn(),
    isFocused: () => true,
    focus: vi.fn(),
    findInPage: vi.fn(),
  });
  const native = {
    view: { webContents: pageContents },
    mount: vi.fn(
      (_window: unknown, _stage: unknown, placed: (placement: NativePlacement) => void) =>
        placed({ bounds: rect, crop: { right: false, bottom: false }, emulation: null }),
    ),
    unmount: vi.fn(),
    setStage: vi.fn(),
    isFullscreen: () => false,
    inputOutstanding: vi.fn(() => false),
    takeContextMenuTrigger: vi.fn<() => "person" | "agent" | null>(() => null),
    waitForPaint: () => new Promise<void>(() => {}),
  };
  const surface = {
    sessionId,
    surfaceId,
    passkeyInput: vi.fn(),
    page: {
      native,
      isClosed: () => false,
      observePasskeyInput: (listener: () => void) => {
        input = listener;
        return () => {
          input = () => {};
        };
      },
    },
    onEvent: () => () => {},
    release: vi.fn(),
    follow: vi.fn(async () => undefined),
    geometry: () => null,
  };
  const source = {
    hasSession: (id: string) => id === sessionId,
    presentSurface: vi.fn(() => surface as unknown as PresentedSurface),
  };
  const unregister = manager.registerSource(source as unknown as NativePresentationSource);
  const sender = contents as unknown as WebContents;
  const request = { sessionId, surfaceId, rect };
  const socket = (type: "admitted" | "closed", connectionId = "control", ownerId = 1) =>
    observe({ type, connectionId, ownerId, sessionId, mode: "control" });
  return {
    manager,
    sender,
    request,
    socket,
    source,
    surface,
    native,
    contents,
    unregister,
    passkeyConsumerToken,
    input: () => input(),
  };
}

describe("native presentation authority (retired A01–A07)", () => {
  it("requires admitted control, rather than local membership, before exposing a page", async () => {
    const f = fixture();
    expect(f.manager.isLocal(sessionId)).toBe(true);
    await expect(f.manager.present(f.sender, f.request)).rejects.toThrow();
    expect(f.source.presentSurface).not.toHaveBeenCalled();
    f.socket("admitted");
    await expect(f.manager.present(f.sender, f.request)).resolves.toHaveProperty("presentationId");
  });
  it("ends authority synchronously at the last owner socket and rejects stale handles", async () => {
    const f = fixture();
    f.socket("admitted");
    f.socket("admitted", "other", 2);
    const target = await f.manager.present(f.sender, f.request);
    f.socket("closed");
    expect(f.native.unmount).toHaveBeenCalledOnce();
    expect(f.surface.release).toHaveBeenCalledOnce();
    await expect(f.manager.update(f.sender, { ...target, rect })).rejects.toThrow();
    await expect(f.manager.present(f.sender, f.request)).rejects.toThrow();
  });
  it.each(["did-start-navigation", "render-process-gone", "destroyed"])(
    "releases on renderer %s and rejects the retired token",
    async (event) => {
      const f = fixture();
      f.socket("admitted");
      const target = await f.manager.present(f.sender, f.request);
      f.contents.emit(event, {}, "https://example.test", false, true);
      expect(f.native.unmount).toHaveBeenCalledOnce();
      await expect(f.manager.update(f.sender, { ...target, rect })).rejects.toThrow();
    },
  );
  it("refuses a foreign sender and a nonlocal session before consulting a source", async () => {
    const f = fixture();
    f.socket("admitted");
    const target = await f.manager.present(f.sender, f.request);
    await expect(f.manager.update({ id: 2 } as WebContents, { ...target, rect })).rejects.toThrow();
    await expect(
      f.manager.present(f.sender, {
        ...f.request,
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000002"),
      }),
    ).rejects.toThrow();
    expect(f.source.presentSurface).toHaveBeenCalledOnce();
  });
  it("ends a retired runtime and refuses a failed native page without a streaming fallback", async () => {
    const f = fixture();
    f.socket("admitted");
    const target = await f.manager.present(f.sender, f.request);
    f.unregister();
    expect(f.native.unmount).toHaveBeenCalledOnce();
    await expect(f.manager.update(f.sender, { ...target, rect })).rejects.toThrow();
    f.manager.registerSource(f.source as unknown as NativePresentationSource);
    f.source.presentSurface.mockImplementation(() => {
      throw new Error("native unavailable");
    });
    await expect(f.manager.present(f.sender, f.request)).rejects.toThrow("native unavailable");
    expect(f.contents.send.mock.calls.at(-1)?.[1]).toMatchObject({
      type: "ended",
      reason: "page-closed",
    });
  });
  it("opens a native context menu only for a consumed person trigger with no outstanding agent input (C02)", async () => {
    const { Menu } = await import("electron");
    const menus = vi.mocked(Menu.buildFromTemplate);
    menus.mockClear();
    const f = fixture();
    f.native.waitForPaint = () => Promise.resolve();
    f.socket("admitted");
    await f.manager.present(f.sender, f.request);
    await Promise.resolve();
    const show = () =>
      f.native.view.webContents.emit(
        "context-menu",
        {},
        { linkURL: "https://example.test", mediaType: "none", selectionText: "" },
      );
    for (const origin of [null, "agent"] as const) {
      f.native.takeContextMenuTrigger.mockReturnValue(origin);
      show();
      expect(menus).not.toHaveBeenCalled();
    }
    f.native.takeContextMenuTrigger.mockReturnValue("person");
    f.native.inputOutstanding.mockReturnValue(true);
    show();
    expect(menus).not.toHaveBeenCalled();
    f.native.inputOutstanding.mockReturnValue(false);
    show();
    expect(menus).toHaveBeenCalledOnce();
  });
});

it.each(["socket", "did-start-navigation", "render-process-gone", "destroyed"])(
  "hides glass synchronously and refuses stale native actions after %s revocation",
  async (reason) => {
    onPlatform("darwin");
    const f = fixture();
    f.native.waitForPaint = () => Promise.resolve();
    f.socket("admitted");
    const target = await f.manager.present(f.sender, f.request);
    await Promise.resolve();
    const scene = {
      croppedBottom: true,
      croppedRight: false,
      cursors: [],
      geometryRevision: 0,
      reducedMotion: true,
    };
    f.manager.setGlass(f.sender, { ...target, scene });
    expect(glass.update).toHaveBeenLastCalledWith(rect, scene, true);
    f.manager.acquireOverlay(f.sender, { overlayId: "00000000-0000-4000-8000-000000000001" });
    if (reason === "socket") f.socket("closed");
    else f.contents.emit(reason, {}, "https://example.test", false, true);
    expect(f.native.unmount).toHaveBeenCalledOnce();
    expect(glass.update).toHaveBeenLastCalledWith(null, null, false);
    const calls = glass.update.mock.calls.length;
    f.manager.focusPage(f.sender, target);
    f.manager.find(f.sender, { ...target, query: "needle", forward: true, findNext: false });
    f.manager.setGlass(f.sender, { ...target, scene });
    f.manager.releaseOverlay(f.sender, { overlayId: "00000000-0000-4000-8000-000000000001" });
    expect(glass.update.mock.calls.slice(calls).every((call) => call[2] === false)).toBe(true);
    expect(f.native.view.webContents.focus).not.toHaveBeenCalled();
    expect(f.native.view.webContents.findInPage).not.toHaveBeenCalled();
    expect(f.native.mount).toHaveBeenCalledOnce();
  },
);

it("never creates glass on Linux, where transparent children draw black", async () => {
  onPlatform("linux");
  glass.update.mockClear();
  const f = fixture();
  f.native.waitForPaint = () => Promise.resolve();
  f.socket("admitted");
  const target = await f.manager.present(f.sender, f.request);
  await Promise.resolve();
  const scene = {
    croppedBottom: true,
    croppedRight: false,
    cursors: [],
    geometryRevision: 0,
    reducedMotion: true,
  };
  f.manager.setGlass(f.sender, { ...target, scene });
  expect(glass.update).not.toHaveBeenCalled();
});

it("rejects a failed surface replacement update and releases the old native page (A07)", async () => {
  const f = fixture();
  f.native.waitForPaint = () => Promise.resolve();
  f.socket("admitted");
  const target = await f.manager.present(f.sender, f.request);
  await Promise.resolve();
  f.source.presentSurface.mockImplementation(() => {
    throw new Error("native unavailable");
  });
  await expect(
    f.manager.update(f.sender, {
      presentationId: target.presentationId,
      surfaceId: BrowserSurfaceIdSchema.parse("bsf_00000000-0000-4000-8000-000000000002"),
    }),
  ).rejects.toThrow("native unavailable");
  expect(f.native.unmount).toHaveBeenCalledOnce();
  expect(f.contents.send.mock.calls.at(-1)?.[1]).toMatchObject({
    type: "ended",
    reason: "page-closed",
  });
});

it("attributes native page input only to the window's admitted presentation consumer", async () => {
  const f = fixture();
  const token = "00000000-0000-4000-8000-000000000003";
  f.native.waitForPaint = () => Promise.resolve();
  f.socket("admitted");
  await f.manager.present(f.sender, f.request);
  await Promise.resolve();
  f.passkeyConsumerToken.mockReturnValue(token);
  f.input();
  expect(f.surface.passkeyInput).toHaveBeenLastCalledWith(token);
  expect(f.passkeyConsumerToken).toHaveBeenLastCalledWith(f.sender.id, "control", surfaceId);
  f.passkeyConsumerToken.mockReturnValue(null);
  f.input();
  expect(f.surface.passkeyInput).toHaveBeenLastCalledWith(null);
  f.socket("closed");
  f.surface.passkeyInput.mockClear();
  f.input();
  expect(f.surface.passkeyInput).not.toHaveBeenCalled();
});

it.each(["release", "replacement", "failure", "zero-size"] as const)(
  "invalidates the actual passkey presentation on %s with control still admitted",
  async (ending) => {
    const f = fixture();
    f.native.waitForPaint = () => Promise.resolve();
    f.socket("admitted");
    const target = await f.manager.present(f.sender, f.request);
    await Promise.resolve();
    const binding = f.manager.passkeyBinding(f.sender.id, sessionId, surfaceId);
    expect(binding).not.toBeNull();
    expect(binding).not.toBe("streamed");
    const changed = vi.fn();
    const unsubscribe = f.manager.observePasskeyPresentation(changed);
    try {
      if (ending === "release") f.manager.release(f.sender, target);
      if (ending === "replacement") {
        f.source.presentSurface.mockReturnValueOnce({
          ...f.surface,
          surfaceId: BrowserSurfaceIdSchema.parse("other"),
          page: { ...f.surface.page, native: { ...f.native, view: { ...f.native.view } } },
        } as unknown as PresentedSurface);
        await f.manager.update(f.sender, {
          ...target,
          surfaceId: BrowserSurfaceIdSchema.parse("other"),
        });
      }
      if (ending === "failure") {
        f.source.presentSurface.mockImplementationOnce(() => {
          throw new Error("Presentation failed");
        });
        await expect(
          f.manager.update(f.sender, {
            ...target,
            surfaceId: BrowserSurfaceIdSchema.parse("other"),
          }),
        ).rejects.toThrow("Presentation failed");
      }
      if (ending === "zero-size")
        await f.manager.update(f.sender, { ...target, rect: { ...rect, width: 0 } });
      expect(changed).toHaveBeenCalled();
      expect(f.manager.passkeyBinding(f.sender.id, sessionId, surfaceId)).not.toBe(binding);
      await expect(f.manager.present(f.sender, f.request)).resolves.toHaveProperty(
        "presentationId",
      );
    } finally {
      unsubscribe();
    }
  },
);
