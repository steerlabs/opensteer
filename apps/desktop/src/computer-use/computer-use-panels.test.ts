import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ComputerAppSetupPanel } from "./computer-app-setup-panel.js";
import { ComputerUsePermissionsPanel } from "./computer-use-permissions-panel.js";

describe("ComputerUsePermissionsPanel", () => {
  it("opens one inactive panel at the contract's size", async () => {
    const harness = permissionsHarness();

    await expect(harness.panel.open()).resolves.toEqual({ opened: true });

    expect(harness.options[0]).toMatchObject({
      alwaysOnTop: true,
      frame: false,
      height: 380,
      show: false,
      type: "panel",
      width: 500,
    });
    expect(harness.window.loadURL).toHaveBeenCalledWith("app://opensteer/computer-use/permissions");
    // It floats over System Settings; it never takes the keyboard.
    expect(harness.window.showInactive).toHaveBeenCalledOnce();
    expect(harness.window.focus).not.toHaveBeenCalled();
    harness.panel.close();
  });
});

describe("ComputerAppSetupPanel", () => {
  it("lets a page that died go rather than float an empty window over the screen", async () => {
    const harness = setupHarness();
    await harness.panel.open();

    harness.crashPage();

    expect(harness.window.destroy).toHaveBeenCalledOnce();
  });

  it("ends setup when its window goes away by itself, but not when setup closed it", async () => {
    const harness = setupHarness();
    await harness.panel.open();
    harness.closeWindow();
    expect(harness.onClosed).toHaveBeenCalledOnce();

    await harness.panel.open();
    harness.panel.close();
    harness.closeWindow();
    expect(harness.onClosed).toHaveBeenCalledOnce();
  });
});

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const pageListeners = new Map<string, () => void>();
  const window = {
    destroy: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async (_url: string) => undefined),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return window;
    }),
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    webContents: {
      on: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        pageListeners.set(event, listener);
      }),
      setWindowOpenHandler: vi.fn(),
    },
  };
  return { listeners, pageListeners, window };
}

function setupHarness() {
  const { listeners, pageListeners, window } = fakeWindow();
  const onClosed = vi.fn();
  const panel = new ComputerAppSetupPanel({
    onClosed,
    platform: "darwin",
    screen: {
      getPrimaryDisplay: () =>
        ({ workArea: { height: 900, width: 1_200, x: 100, y: 50 } }) as Electron.Display,
    },
    webPreferences: { contextIsolation: true, sandbox: true },
    windowFactory: () => window as unknown as BrowserWindow,
  });
  return {
    closeWindow: () => listeners.get("closed")?.(),
    crashPage: () => pageListeners.get("render-process-gone")?.(),
    onClosed,
    panel,
    window,
  };
}

function permissionsHarness() {
  const { window } = fakeWindow();
  const options: BrowserWindowConstructorOptions[] = [];
  const windowFactory = vi.fn((windowOptions: BrowserWindowConstructorOptions) => {
    options.push(windowOptions);
    return window as unknown as BrowserWindow;
  });
  const openExternal = vi.fn(
    async (_url: string, _options: { readonly activate: boolean }) => undefined,
  );
  const panel = new ComputerUsePermissionsPanel({
    openExternal,
    platform: "darwin",
    screen: {
      getPrimaryDisplay: () =>
        ({ workArea: { height: 900, width: 1_200, x: 100, y: 50 } }) as Electron.Display,
    },
    webPreferences: { contextIsolation: true, sandbox: true },
    windowFactory,
  });
  return {
    openExternal,
    options,
    panel,
    window,
    windowFactory,
  };
}
