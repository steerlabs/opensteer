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
  stop: { phase: "running", stoppedAt: null, offline: null, problem: null, confirmed: null },
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
      popover.emit("show");
    },
    hide: () => {
      visible = false;
      popover.emit("hide");
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
    openRow: vi.fn(async () => undefined),
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
    popover,
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

it("pushes the Stop result on reopen even if the popover immediately blurs", async () => {
  const { contents, menuBar, popover, service, set } = fixture();
  const stopping = status({
    stop: { phase: "stopping", stoppedAt: null, offline: null, problem: null, confirmed: null },
  });
  const unconfirmed = status({
    stop: {
      phase: "stopped",
      stoppedAt: null,
      offline: null,
      problem: "Couldn’t confirm everything stopped",
      confirmed: null,
    },
    icon: { attention: false, unreachable: false, stopped: true },
  });
  try {
    menuBar.start();
    set(stopping);
    await menuBar.open();
    expect(contents.send).toHaveBeenLastCalledWith(menuBarChannels.statusChanged, stopping);

    await menuBar.toggle();
    expect(popover.isVisible()).toBe(false);
    set(unconfirmed);
    await vi.waitFor(() =>
      expect(contents.send).toHaveBeenLastCalledWith(menuBarChannels.statusChanged, unconfirmed),
    );
    expect(service.refresh).toHaveBeenCalledTimes(1);

    popover.focus.mockImplementationOnce(() => popover.emit("blur"));
    await menuBar.open();
    expect(popover.isVisible()).toBe(false);
    expect(contents.send).toHaveBeenLastCalledWith(menuBarChannels.statusChanged, unconfirmed);
  } finally {
    menuBar.dispose();
  }
});

it("advances the popover Stop state when a Stop fails after blur hides the popover", async () => {
  const { contents, menuBar, popover, service, set } = fixture();
  const stopping = status({
    stop: { phase: "stopping", stoppedAt: null, offline: null, problem: null, confirmed: null },
  });
  const unconfirmed = status({
    stop: {
      phase: "stopped",
      stoppedAt: null,
      offline: null,
      problem: "Couldn’t confirm everything stopped",
      confirmed: null,
    },
    icon: { attention: false, unreachable: false, stopped: true },
  });
  try {
    menuBar.start();
    set(stopping);
    await menuBar.open();
    await vi.waitFor(() =>
      expect(contents.send).toHaveBeenLastCalledWith(menuBarChannels.statusChanged, stopping),
    );

    await menuBar.toggle();
    expect(popover.isVisible()).toBe(false);

    // Reopen while Stop is still in flight; the window immediately loses focus and hides.
    popover.focus.mockImplementationOnce(() => popover.emit("blur"));
    await menuBar.open();
    expect(popover.isVisible()).toBe(false);

    // Proof fails to arrive after blur already hid the popover.
    set(unconfirmed);
    await vi.waitFor(() =>
      expect(contents.send).toHaveBeenLastCalledWith(menuBarChannels.statusChanged, unconfirmed),
    );
    expect(popover.isVisible()).toBe(false);
    expect(service.refresh).toHaveBeenCalledTimes(2);

    // Opening the popover later shows the failed Stop state immediately.
    await menuBar.open();
    expect(popover.isVisible()).toBe(true);
    await vi.waitFor(() =>
      expect(contents.send).toHaveBeenLastCalledWith(menuBarChannels.statusChanged, unconfirmed),
    );
  } finally {
    menuBar.dispose();
  }
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

it("routes the popover's asks to the task, Needs you and Settings, from its own frame only", async () => {
  const { actions, call, menuBar } = fixture();
  menuBar.start();
  await menuBar.open();
  const target = { deploymentId: "dep_home", threadId: "thr_test" };
  await call(menuBarChannels.openRow, target);
  expect(actions.openRow).toHaveBeenCalledWith(target);
  await call(menuBarChannels.openNeedsYou, "dep_home");
  expect(actions.openNeedsYou).toHaveBeenCalledWith("dep_home");
  await call(menuBarChannels.openSettings);
  expect(actions.openSettings).toHaveBeenCalledOnce();
  await expect(call(menuBarChannels.openRow, target, { url: menuBarPopoverUrl })).rejects.toThrow(
    /Only the Opensteer menu bar/,
  );
});

it("opens the app's own routes in place, through its router", () => {
  expect(appRouteScript(appRoutes.settings)).toBe(
    'history.pushState(null, "", "/settings"); dispatchEvent(new PopStateEvent("popstate"));',
  );
  expect(appRoutes.needsYou).toBe("/?needs-you");
});

it("refreshes attention while the popover is open and stops when the popover hides", async () => {
  vi.useFakeTimers();
  const { menuBar, service } = fixture();
  try {
    menuBar.start();
    await menuBar.open();
    expect(service.refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.refresh).toHaveBeenCalledTimes(2);
    await menuBar.toggle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.refresh).toHaveBeenCalledTimes(2);
  } finally {
    menuBar.dispose();
    vi.useRealTimers();
  }
});

it("refreshes the Home on reopen even when panel show reports hidden or does not emit", async () => {
  vi.useFakeTimers();
  const { menuBar, popover, service } = fixture();
  try {
    menuBar.start();
    await menuBar.open();
    expect(service.refresh).toHaveBeenCalledTimes(1);

    await menuBar.toggle();
    expect(popover.isVisible()).toBe(false);

    // macOS NSPanel can emit "show" before becoming visible (or while deactivated).
    const originalShow = popover.show;
    popover.show = () => {
      popover.emit("show");
    };
    await menuBar.open();
    expect(service.refresh).toHaveBeenCalledTimes(2);
    // Must not leak the 15s open-popover refresh timer when the window stayed hidden.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.refresh).toHaveBeenCalledTimes(2);

    // Or omit "show" entirely on reopen.
    popover.show = () => {};
    await menuBar.open();
    expect(service.refresh).toHaveBeenCalledTimes(3);
    popover.show = originalShow;
  } finally {
    menuBar.dispose();
    vi.useRealTimers();
  }
});

it("starts the 15s refresh timer from open() when the panel becomes visible without a visible show event, and stops on hide", async () => {
  vi.useFakeTimers();
  const { menuBar, popover, service } = fixture();
  try {
    menuBar.start();
    await menuBar.open();
    expect(service.refresh).toHaveBeenCalledTimes(1);

    await menuBar.toggle();
    expect(popover.isVisible()).toBe(false);

    // Case 1: "show" fires while isVisible() is still false, then focus() activates the panel.
    let visible = false;
    const originalShow = popover.show;
    const originalHide = popover.hide;
    const originalIsVisible = popover.isVisible;
    popover.isVisible = () => visible;
    popover.hide = () => {
      visible = false;
      popover.emit("hide");
    };
    popover.show = () => {
      popover.emit("show");
    };
    popover.focus.mockImplementationOnce(() => {
      visible = true;
    });
    await menuBar.open();
    expect(popover.isVisible()).toBe(true);
    expect(service.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.refresh).toHaveBeenCalledTimes(3);

    popover.hide();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.refresh).toHaveBeenCalledTimes(3);

    // Case 2: "show" does not fire at all on reopen, while the panel becomes visible.
    popover.show = () => {
      visible = true;
    };
    await menuBar.open();
    expect(popover.isVisible()).toBe(true);
    expect(service.refresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.refresh).toHaveBeenCalledTimes(5);

    popover.hide();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.refresh).toHaveBeenCalledTimes(5);

    popover.show = originalShow;
    popover.hide = originalHide;
    popover.isVisible = originalIsVisible;
  } finally {
    menuBar.dispose();
    vi.useRealTimers();
  }
});

it("refreshes the Home after Stop and Resume finish from the popover", async () => {
  const { actions, call, menuBar, service } = fixture();
  try {
    menuBar.start();
    await menuBar.open();
    expect(service.refresh).toHaveBeenCalledTimes(1);

    await call(menuBarChannels.stop);
    expect(actions.stop).toHaveBeenCalledOnce();
    expect(service.refresh).toHaveBeenCalledTimes(2);

    await call(menuBarChannels.resume);
    expect(actions.resume).toHaveBeenCalledOnce();
    expect(service.refresh).toHaveBeenCalledTimes(3);
  } finally {
    menuBar.dispose();
  }
});
