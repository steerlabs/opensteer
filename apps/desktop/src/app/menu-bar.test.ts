import { EventEmitter } from "node:events";
import type { MenuBarStatus } from "@opensteer/client/computers";
import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  NativeImage,
  Screen,
  Tray,
} from "electron";
import { expect, it, vi } from "vitest";
import { appRoutes, appRouteScript } from "./app-route.js";
import { menuBarChannels } from "./menu-bar-channels.js";
import { DesktopMenuBar, menuBarPopoverUrl } from "./menu-bar.js";

const status = (change: Partial<MenuBarStatus> = {}): MenuBarStatus => ({
  schemaVersion: 3,
  title: "Opensteer",
  homes: [],
  moreHomes: null,
  noHome: "This Mac isn’t connected to a Home yet.",
  needsYou: null,
  rightNow: [],
  thisMac: null,
  thisMacNote: null,
  stop: { phase: "running", stoppedAt: null, offline: null, problem: null },
  openAtLogin: { on: true, available: true },
  icon: { attention: false, unreachable: false, stopped: false },
  ...change,
});

function fixture() {
  let current = status();
  let icon = current.icon;
  const listeners = new Set<() => void>();
  const service = {
    changed: () => {
      for (const listener of listeners) listener();
    },
    icon: vi.fn(() => icon),
    refresh: vi.fn(async () => undefined),
    setSwitch: vi.fn(async () => undefined),
    status: vi.fn(async () => current),
    stopRow: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const tray = Object.assign(new EventEmitter(), {
    setToolTip: vi.fn(),
    setImage: vi.fn(),
    getBounds: () => ({ x: 1000, y: 0, width: 24, height: 24 }),
    destroy: vi.fn(),
  });
  const mainFrame = { url: menuBarPopoverUrl };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    isDevToolsOpened: () => false,
  });
  let visible = false;
  const popover = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isVisible: () => visible,
    setBounds: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    show: () => {
      visible = true;
    },
    hide: () => {
      visible = false;
    },
    focus: vi.fn(),
    destroy: vi.fn(),
  });
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const actions = {
    stop: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    setOpenAtLogin: vi.fn(async () => undefined),
    openApp: vi.fn(async () => undefined),
    openNeedsYou: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
    quitCompletely: vi.fn(async () => undefined),
  };
  const log = vi.fn();
  const menuBar = new DesktopMenuBar({
    service,
    actions,
    ipcMain: {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
        handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as Pick<IpcMain, "handle" | "removeHandler">,
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }),
    } as unknown as Pick<Screen, "getDisplayMatching">,
    createTray: () => tray as unknown as Tray,
    createImage: () => ({ setTemplateImage: vi.fn() }) as unknown as NativeImage,
    createWindow: () => popover as unknown as BrowserWindow,
    webPreferences: {},
    log,
  });
  const call = (channel: string, input?: unknown, frame: object = mainFrame) =>
    handlers.get(channel)!(
      { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      input,
    );
  return {
    actions,
    call,
    contents,
    log,
    menuBar,
    service,
    set: (next: MenuBarStatus) => {
      current = next;
      icon = next.icon;
      service.changed();
    },
    tray,
  };
}

it("redraws the status item from main's own snapshot, reading no full status while the popover is closed", async () => {
  const { contents, menuBar, service, set, tray } = fixture();
  menuBar.start();
  expect(tray.setImage).not.toHaveBeenCalled();
  set(status({ icon: { attention: false, unreachable: false, stopped: true } }));
  expect(tray.setImage).toHaveBeenCalledTimes(1);
  set(status({ icon: { attention: false, unreachable: false, stopped: true } }));
  expect(tray.setImage).toHaveBeenCalledTimes(1);
  expect(service.status).not.toHaveBeenCalled();
  expect(contents.send).not.toHaveBeenCalled();
});

it("pushes each change to the open popover, one full status at a time, folding the rest into one", async () => {
  const { contents, menuBar, service, set } = fixture();
  menuBar.start();
  await menuBar.open();
  await vi.waitFor(() => expect(contents.send).toHaveBeenCalledTimes(1));
  const held = Promise.withResolvers<void>();
  const base = service.status.getMockImplementation()!;
  service.status.mockImplementation(async () => {
    await held.promise;
    return await base();
  });
  const next = status({ icon: { attention: true, unreachable: false, stopped: false } });
  set(next);
  await vi.waitFor(() => expect(service.status).toHaveBeenCalledTimes(2));
  set(next);
  set(next);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  // One full status in flight; the changes that arrive meanwhile wait for it.
  expect(service.status).toHaveBeenCalledTimes(2);
  held.resolve();
  await vi.waitFor(() =>
    expect(contents.send).toHaveBeenLastCalledWith(menuBarChannels.statusChanged, next),
  );
  // At most one more, for everything that arrived meanwhile.
  expect(service.status.mock.calls.length).toBeLessThanOrEqual(3);
});

it("logs a status that could not be worked out instead of rejecting", async () => {
  const { log, menuBar, service, set } = fixture();
  menuBar.start();
  await menuBar.open();
  service.status.mockRejectedValueOnce(new Error("The deployment route changed."));
  set(status());
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith("desktop.menu-bar.redraw-failed", {
      message: "The deployment route changed.",
    }),
  );
});

it("routes the popover's asks to the per-row Stop, Needs you and Settings, from its own frame only", async () => {
  const { actions, call, menuBar, service } = fixture();
  menuBar.start();
  await menuBar.open();
  await call(menuBarChannels.stopRow, { id: "apps:cus_1" });
  expect(service.stopRow).toHaveBeenCalledWith("apps:cus_1");
  await call(menuBarChannels.openNeedsYou, "dep_home");
  expect(actions.openNeedsYou).toHaveBeenCalledWith("dep_home");
  await call(menuBarChannels.openSettings);
  expect(actions.openSettings).toHaveBeenCalledOnce();
  await expect(
    call(menuBarChannels.stopRow, { id: "apps:cus_1" }, { url: menuBarPopoverUrl }),
  ).rejects.toThrow(/Only the Opensteer menu bar/);
});

it("opens the app's own routes in place, through its router", () => {
  expect(appRouteScript(appRoutes.settings)).toBe(
    'history.pushState(null, "", "/settings"); dispatchEvent(new PopStateEvent("popstate"));',
  );
  expect(appRoutes.needsYou).toBe("/?needs-you");
});
